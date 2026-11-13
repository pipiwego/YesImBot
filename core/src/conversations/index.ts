import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { createEntry, createJsonlStorage, type AgentEntry, type AgentStorage } from "@yesimbot/agent-runtime";
import type { LanguageModel } from "ai";

import { executeCompact, filterEntriesForCompression } from "./compact.js";

export type CompactReason = "auto" | "idle" | "manual";

export type CompactResult = {
  readonly compacted: boolean;
  readonly reason?: string;
  /** 模型压缩不可用时是否已降级为「截断最老消息」 */
  readonly degraded?: boolean;
};

export type ConversationInfo = { filename: string; isActive: boolean; size: number; createdAt: string };

export type ConversationStatus = { active: ConversationInfo | null };

export interface CompactInput {
  model: LanguageModel;
  personaName: string;
  persona: string;
  signal?: AbortSignal;
  /** 单次压缩 LLM 调用上限（毫秒），默认由 executeCompact 决定 */
  timeoutMs?: number;
}

export interface ConversationCompactConfig {
  minMessages: number;
  maxFailures: number;
  threshold?: number;
  charTokenRatio?: number;
  /** 时钟注入（测试用），默认 Date.now */
  now?: () => number;
  /** 降级截断时保留的最近消息条数，默认 max(minMessages, 20) */
  degradeKeepMessages?: number;
}

/** 压缩连续失败达到上限后的退避台阶：5 分钟 → 15 分钟 → 封顶 1 小时。 */
export const COMPACT_BACKOFF_STEPS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

/** 归档策略：没有 compact 摘要时怎么办。 */
export interface ArchiveIfOversizeOptions {
  /** true = 没有摘要就不归档（交给压缩通道），而不是开一个空会话把历史静默丢掉 */
  requireSummary?: boolean;
}

export class Conversation {
  private readonly root: string;
  private readonly compactConfig;
  private storagePathValue: string | undefined;
  private fileStorageValue: AgentStorage<AgentEntry> | undefined;
  private failures = 0;
  /** 退避窗口结束时间（epoch ms）；0 表示随时可以再试 */
  private nextAttemptAt = 0;
  private memory = "";

  public constructor(root: string, compactConfig: ConversationCompactConfig = { minMessages: 20, maxFailures: 3 }) {
    this.root = root;
    this.compactConfig = compactConfig;
  }

  public get storage(): AgentStorage<AgentEntry> {
    if (!this.storagePathValue) throw new Error("Conversation has not been initialized");
    return {
      append: (...entries) => this.currentStorage().append(...entries),
      read: () => this.currentStorage().read(),
      clear: () => this.currentStorage().clear(),
    };
  }

  public async init(): Promise<void> {
    if (this.storagePathValue) return;
    this.setStorage(await this.createOrResolve());
    await this.restoreMemory();
  }

  public async list(): Promise<ConversationInfo[]> {
    const active = this.storagePathValue;
    return Promise.all(
      (await this.files()).reverse().map(async (filename) => ({
        filename,
        isActive: join(this.sessionsPath(), filename) === active,
        size: (await stat(join(this.sessionsPath(), filename))).size,
        createdAt: basename(filename, ".jsonl"),
      })),
    );
  }

  public async status(): Promise<ConversationStatus> {
    return { active: (await this.list()).find((item) => item.isActive) ?? null };
  }

  public failuresCount(): number {
    return this.failures;
  }

  /** 退避窗口结束时间（epoch ms），0 表示当前没有退避 */
  public nextCompactAttemptAt(): number {
    return this.nextAttemptAt;
  }

  /** 距离下次允许尝试压缩还有多久（毫秒） */
  public compactBackoffRemainingMs(): number {
    return Math.max(0, this.nextAttemptAt - this.now());
  }

  public async switch(id: string): Promise<void> {
    await this.init();
    const filename = id.endsWith(".jsonl") ? id : `${id}.jsonl`;
    if (!/^[0-9A-Za-zTZ_-]+\.jsonl$/.test(filename)) throw new Error("Invalid session id");
    const path = join(this.sessionsPath(), filename);
    await stat(path);
    this.setStorage(path);
    await this.restoreMemory();
  }

  public async archive(noSummary = false, input?: CompactInput): Promise<void> {
    await this.init();
    if ((await this.storage.read()).length === 0) throw new Error("Cannot archive an empty session");
    if (!noSummary && input) {
      const result = await this.compact("manual", input);
      if (result.compacted) {
        const compact = [...(await this.storage.read())].reverse().find((entry) => entry.type === "compact");
        this.setStorage(await this.createSession(compact ? [compact] : []));
        return;
      }
    }
    this.setStorage(await this.createSession());
  }

  public async archiveIfOversize(maxBytes: number, input?: CompactInput, options: ArchiveIfOversizeOptions = {}): Promise<boolean> {
    await this.init();
    if (maxBytes <= 0) return false;
    const active = (await this.status()).active;
    if (!active || active.size <= maxBytes) return false;
    const compact = [...(await this.storage.read())].reverse().find((entry) => entry.type === "compact");
    if (compact?.type === "compact") {
      this.setStorage(await this.createSession([compact]));
      return true;
    }
    if (options.requireSummary) {
      // 没有可继承的摘要：不在这里跑 LLM（会把入站锁堵住），也不开空会话把历史丢掉。
      return false;
    }
    await this.archive(!input, input);
    return true;
  }

  public async compact(reason: CompactReason, input: CompactInput): Promise<CompactResult> {
    await this.init();
    const now = this.now();
    if (this.failures >= this.compactConfig.maxFailures && now < this.nextAttemptAt) {
      // 退避窗口内：不再每条消息都打模型（保留「不要反复重试」的初衷），
      // 但也不再永久关闭 —— 到点会自动重试；窗口内若消息已经失控增长，降级截断保证上下文有界。
      const degraded = await this.degradeIfRunaway("failure_limit");
      return degraded ? { compacted: false, reason: "failure_limit", degraded: true } : { compacted: false, reason: "failure_limit" };
    }
    const entries = await this.storage.read();
    const lastCompactIndex = entries.reduce((last, entry, index) => (entry.type === "compact" ? index : last), -1);
    const sourceEntries = lastCompactIndex === -1 ? entries : entries.slice(lastCompactIndex + 1);
    const messages = sourceEntries.filter((entry) => entry.type === "message");
    if (messages.length < this.compactConfig.minMessages) return { compacted: false, reason: "minimum_messages" };
    const content = filterEntriesForCompression(sourceEntries);
    if (!content) return { compacted: false, reason: "empty_input" };
    try {
      const summary = (
        await executeCompact({
          model: input.model,
          personaName: input.personaName,
          persona: input.persona,
          previousMemory: this.memory,
          conversation: content,
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        })
      ).slice(0, 30_000);
      if (!summary) {
        this.recordFailure();
        return { compacted: false, reason: "empty_summary" };
      }
      const compact = createEntry("compact", { summary, lastEntryId: messages.at(-1)!.id, sourceSession: basename(this.storagePathValue!, ".jsonl") });
      await this.storage.append(compact);
      this.memory = summary;
      this.failures = 0;
      this.nextAttemptAt = 0;
      return { compacted: true };
    } catch (cause) {
      this.recordFailure();
      if (input.signal?.aborted) throw cause;
      const message = cause instanceof Error ? cause.message : "";
      const reason = message.startsWith("Compaction timed out") ? "timeout" : message === "Compaction produced an empty summary." ? "empty_summary" : "model_failure";
      return { compacted: false, reason };
    }
  }

  private now(): number {
    return this.compactConfig.now?.() ?? Date.now();
  }

  /** 记一次失败并把下次尝试时间往后推（未到上限时不退避，保持原有「下一次就重试」的行为）。 */
  private recordFailure(): void {
    this.failures += 1;
    this.nextAttemptAt = this.now() + compactBackoffMs(this.failures, this.compactConfig.maxFailures);
  }

  /**
   * 降级：模型压缩长期不可用时，把「自上次压缩以来的消息」截断到最近 N 条，
   * 并写一条 synthetic compact 边界（带 degraded 标记）。这样：
   *  - 送进模型的上下文有界（COMPACT_HISTORY_PLUGIN 只取最后一条 compact 之后的内容）
   *  - 会话文件不会再无限增长；下一次 archiveIfOversize 也能凭这条摘要安全换会话
   * 只在消息数达到 3 倍保留量（确实失控）时才动手，避免正常空闲压缩被误降级。
   */
  private async degradeIfRunaway(reason: string): Promise<boolean> {
    const entries = await this.storage.read();
    const lastCompactIndex = entries.reduce((last, entry, index) => (entry.type === "compact" ? index : last), -1);
    const sourceEntries = lastCompactIndex === -1 ? entries : entries.slice(lastCompactIndex + 1);
    const messages = sourceEntries.filter((entry) => entry.type === "message");
    const keep = Math.max(1, this.compactConfig.degradeKeepMessages ?? Math.max(this.compactConfig.minMessages, 20));
    if (messages.length < keep * 3) return false;

    const kept = messages.slice(-keep);
    const dropped = messages.length - kept.length;
    const note = `[自动降级] 模型压缩连续失败 ${this.failures} 次（原因：${reason}），为控制上下文体积已丢弃最早的 ${dropped} 条消息，只保留最近 ${kept.length} 条原始消息。`;
    const summary = [this.memory ? `<retained_memory>\n${this.memory}\n</retained_memory>` : "", note]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 30_000);
    await this.storage.append(
      createEntry("compact", {
        summary,
        lastEntryId: kept.at(-1)!.id,
        sourceSession: basename(this.storagePathValue!, ".jsonl"),
        degraded: true,
      }),
    );
    this.memory = summary;
    return true;
  }

  private setStorage(path: string): void {
    this.storagePathValue = path;
    this.fileStorageValue = createJsonlStorage(path);
  }

  private currentStorage(): AgentStorage<AgentEntry> {
    if (!this.fileStorageValue) throw new Error("Conversation has not been initialized");
    return this.fileStorageValue;
  }

  private async restoreMemory(): Promise<void> {
    const compact = [...(await this.storage.read())].reverse().find((entry) => entry.type === "compact");
    this.memory = compact?.type === "compact" ? compact.data.summary : "";
  }

  private async createOrResolve(): Promise<string> {
    await mkdir(this.sessionsPath(), { recursive: true });
    const files = await this.files();
    return files.at(-1) ? join(this.sessionsPath(), files.at(-1)!) : this.createSession();
  }

  private async createSession(entries: readonly AgentEntry[] = []): Promise<string> {
    await mkdir(this.sessionsPath(), { recursive: true });
    const payload = entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
    for (;;) {
      const path = join(this.sessionsPath(), `${formatTimestamp(new Date())}.jsonl`);
      try {
        await writeFile(path, payload, { flag: "wx" });
        return path;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
    }
  }

  private async files(): Promise<string[]> {
    try {
      return (await readdir(this.sessionsPath())).filter((name) => name.endsWith(".jsonl") && name !== "messages.jsonl").sort();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
  }

  private sessionsPath(): string {
    return join(this.root, "sessions");
  }
}

function compactBackoffMs(failures: number, failureLimit: number): number {
  const over = failures - failureLimit;
  if (over < 0) return 0;
  return COMPACT_BACKOFF_STEPS_MS[Math.min(over, COMPACT_BACKOFF_STEPS_MS.length - 1)];
}

function formatTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}
