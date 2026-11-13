import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname } from "node:path";

/**
 * 内部通知投递账本。
 *
 * 背景：hub 的 outbox 只认「HTTP 2xx = 已投递」，而一次模型回合要 10–60s，
 * 远超声明的 6s 超时。于是历史实现「先回 200、再 fire-and-forget」在模型失败时
 * 变成永久丢稿，改成「等模型跑完再回」又会超时重投导致重复播报。
 *
 * 这里把两者拆开：
 *  - `accept()` 立刻返回一条 `queued` 记录（produced_message:false，语义诚实）；
 *  - 后台按「模型回合 → 纯文本兜底 → 退避重试」推进状态机，结果写进账本；
 *  - 账本可查（HTTP status 端点）且落盘，进程重启后未完成记录会重新入队；
 *  - `dedupeKey` 让 hub 的重投变成幂等查询，而不是第二次播报。
 */

export type NotifyState = "queued" | "delivering" | "delivered" | "degraded" | "failed";

export interface NotifyPayload {
  readonly platform: string;
  readonly selfId: string;
  readonly channelId: string;
  readonly isDirect: boolean;
  readonly ticketId: string;
  readonly status: string;
  readonly messageToShion: string;
  readonly artifacts: readonly string[];
}

export interface NotifyRecord {
  readonly deliveryId: string;
  readonly dedupeKey: string;
  readonly platform: string;
  readonly selfId: string;
  readonly ticketId: string;
  readonly channelId: string;
  readonly isDirect: boolean;
  readonly status: string;
  readonly text: string;
  readonly artifacts: string[];
  readonly acceptedAt: number;
  state: NotifyState;
  produced: boolean;
  degraded: boolean;
  attempts: number;
  updatedAt: number;
  nextAttemptAt: number;
  error?: string;
}

export interface DeliveryOutcome {
  readonly produced: boolean;
  readonly degraded?: boolean;
  /** 已经真实发出的消息段数；> 0 表示「至少说了一半」，不能再走纯文本兜底（会重复）。 */
  readonly segments?: number;
  readonly error?: string;
}

export interface NotifyStore {
  load(): NotifyRecord[];
  save(records: readonly NotifyRecord[]): void;
}

export interface NotifyHandlers {
  /** 走完整模型回合（会真正“说话”）。 */
  deliver(record: NotifyRecord): Promise<DeliveryOutcome>;
  /** 模型没产出时的纯文本兜底。 */
  fallback(record: NotifyRecord): Promise<DeliveryOutcome>;
}

export interface NotifyDispatcherOptions {
  readonly now?: () => number;
  readonly dedupeTtlMs?: number;
  readonly maxRecords?: number;
  readonly maxAttempts?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly store?: NotifyStore;
  readonly schedule?: (task: () => void, delayMs: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
  readonly onEvent?: (code: string, data: Record<string, unknown>) => void;
}

export interface AcceptResult {
  readonly record: NotifyRecord;
  readonly duplicate: boolean;
}

/** 这些错误重试一万次也不会好，还每次都要跑一轮完整模型（实测会触发长循环），直接判死。 */
const PERMANENT_ERROR_PATTERN = /group not found|channel not found|unknown channel|invalid channel|no such group|chat not found/i;

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAYS = [15_000, 45_000, 120_000, 300_000];

/** 幂等键：同一工单 + 同一状态 + 同一频道 + 同一文本 = 同一次播报。 */
export function notifyDedupeKey(payload: NotifyPayload): string {
  const material = [payload.ticketId, payload.status, payload.channelId, payload.messageToShion].join("\u0000");
  return createHash("sha1").update(material).digest("hex").slice(0, 16);
}

/** 纯文本兜底内容：去掉内部引用链接等不该出现在群里的东西，截断到适合群聊的长度。 */
export function fallbackText(record: NotifyRecord): string {
  const text = record.text
    .split("\n")
    .filter((line) => !line.trim().startsWith("git:") && !line.includes("/persist/"))
    .join("\n")
    .trim();
  if (text.length <= 300) return text;
  return `${text.slice(0, 297)}...`;
}

export class NotifyDispatcher {
  private readonly records = new Map<string, NotifyRecord>();
  private readonly running = new Set<string>();
  private readonly timers = new Map<string, unknown>();
  private readonly now: () => number;
  private readonly dedupeTtlMs: number;
  private readonly maxRecords: number;
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly store: NotifyStore | undefined;
  private readonly scheduleFn: (task: () => void, delayMs: number) => unknown;
  private readonly cancelFn: ((handle: unknown) => void) | undefined;
  private readonly onEvent: ((code: string, data: Record<string, unknown>) => void) | undefined;
  private stopped = false;

  public constructor(options: NotifyDispatcherOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.dedupeTtlMs = options.dedupeTtlMs ?? DEFAULT_TTL_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    this.store = options.store;
    this.scheduleFn = options.schedule ?? ((task, delayMs) => setTimeout(task, delayMs));
    this.cancelFn = options.cancel;
    this.onEvent = options.onEvent;
    this.restore();
  }

  /** 未完成的记录数（含 queued / delivering）。 */
  public get pending(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.state === "queued" || record.state === "delivering") count += 1;
    }
    return count;
  }

  /**
   * 接收一条通知。重复请求（hub 重投）命中去重窗口时不会再排一次播报。
   * 唯一例外：上一条已经彻底失败（produced=false），此时幂等重投应当重新武装。
   */
  public accept(payload: NotifyPayload): AcceptResult {
    const dedupeKey = notifyDedupeKey(payload);
    const now = this.now();
    this.prune(now);

    const existing = this.findByKey(dedupeKey);
    if (existing) {
      const terminal = existing.state === "delivered" || existing.state === "degraded";
      const inflight = existing.state === "queued" || existing.state === "delivering";
      if (terminal || inflight) {
        this.emit("notify.duplicate", { deliveryId: existing.deliveryId, dedupeKey, state: existing.state });
        return { record: existing, duplicate: true };
      }
      // 硬不变量：已经真正说出口过（produced=true）的记录绝不允许重新武装。
      // 宁可少发一次，也绝不重复播报。
      if (existing.produced) {
        existing.state = existing.degraded ? "degraded" : "delivered";
        existing.updatedAt = now;
        this.persist();
        return { record: existing, duplicate: true };
      }
      // failed → 重新武装，仍复用同一条记录，避免账本膨胀
      existing.state = "queued";
      existing.attempts = 0;
      existing.error = undefined;
      existing.updatedAt = now;
      existing.nextAttemptAt = now;
      this.persist();
      return { record: existing, duplicate: true };
    }

    const record: NotifyRecord = {
      deliveryId: randomUUID(),
      dedupeKey,
      platform: payload.platform,
      selfId: payload.selfId,
      ticketId: payload.ticketId,
      channelId: payload.channelId,
      isDirect: payload.isDirect,
      status: payload.status,
      text: payload.messageToShion,
      artifacts: [...payload.artifacts],
      acceptedAt: now,
      state: "queued",
      produced: false,
      degraded: false,
      attempts: 0,
      updatedAt: now,
      nextAttemptAt: now,
    };
    this.records.set(record.deliveryId, record);
    this.persist();
    this.emit("notify.accepted", { deliveryId: record.deliveryId, dedupeKey, ticketId: record.ticketId });
    return { record, duplicate: false };
  }

  /** 启动（或重启）一条记录的投递流程。幂等：同一条记录不会并发两次。 */
  public run(record: NotifyRecord, handlers: NotifyHandlers): void {
    if (this.stopped || this.running.has(record.deliveryId)) return;
    this.running.add(record.deliveryId);
    void this.attempt(record, handlers);
  }

  public get(deliveryId: string): NotifyRecord | undefined {
    return this.records.get(deliveryId);
  }

  public findByTicket(ticketId: string): NotifyRecord[] {
    const hits: NotifyRecord[] = [];
    for (const record of this.records.values()) if (record.ticketId === ticketId) hits.push(record);
    return hits.sort((a, b) => b.acceptedAt - a.acceptedAt);
  }

  /** 长轮询：等到终态或超时。 */
  public async waitFor(deliveryId: string, timeoutMs: number): Promise<NotifyRecord | undefined> {
    const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 5_000));
    for (;;) {
      const record = this.records.get(deliveryId);
      if (!record) return undefined;
      if (record.state !== "queued" && record.state !== "delivering") return record;
      if (Date.now() >= deadline) return record;
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
    }
  }

  /** 进程停机：停掉重试定时器，排队中的记录保持 queued，落盘等下次启动恢复。 */
  public stop(): void {
    this.stopped = true;
    for (const [deliveryId, handle] of this.timers) {
      if (this.cancelFn) this.cancelFn(handle);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
      this.timers.delete(deliveryId);
    }
  }

  /** 供 HTTP 序列化：不含内部字段以外的敏感信息，text 截断。 */
  public describe(record: NotifyRecord): Record<string, unknown> {
    return {
      delivery_id: record.deliveryId,
      ticket_id: record.ticketId,
      channel_id: record.channelId,
      status: record.status,
      state: record.state,
      produced_message: record.produced,
      degraded: record.degraded,
      attempts: record.attempts,
      accepted_at: record.acceptedAt,
      updated_at: record.updatedAt,
      next_attempt_at: record.nextAttemptAt,
      error: record.error,
    };
  }

  /** 供 HTTP 回执体使用：诚实表达「收到」与「是否真的说出口」是两件事。 */
  public receipt(record: NotifyRecord, duplicate: boolean): Record<string, unknown> {
    return {
      ok: true,
      accepted: true,
      duplicate,
      produced_message: record.produced,
      state: record.state,
      ticket_id: record.ticketId,
      delivery_id: record.deliveryId,
      dedupe_key: record.dedupeKey,
      status_url: `/internal/worker-notify/status?delivery_id=${record.deliveryId}`,
    };
  }

  private async attempt(record: NotifyRecord, handlers: NotifyHandlers): Promise<void> {
    try {
      if (this.stopped) return;
      record.state = "delivering";
      record.attempts += 1;
      record.updatedAt = this.now();
      this.persist();

      let outcome: DeliveryOutcome;
      try {
        outcome = await handlers.deliver(record);
      } catch (cause) {
        outcome = { produced: false, error: cause instanceof Error ? cause.message : String(cause) };
      }

      const partial = !outcome.produced && (outcome.segments ?? 0) > 0;
      if (outcome.produced || partial) {
        record.state = partial ? "degraded" : "delivered";
        record.produced = true;
        record.degraded = partial;
        record.error = partial ? (outcome.error ?? "partial-delivery") : undefined;
        record.updatedAt = this.now();
        this.persist();
        this.emit(partial ? "notify.degraded" : "notify.delivered", {
          deliveryId: record.deliveryId,
          attempts: record.attempts,
          ...(partial ? { error: record.error, segments: outcome.segments } : {}),
        });
        return;
      }

      // 模型这一轮没产出：纯文本兜底，保证群里至少有一句话
      const modelError = outcome.error ?? "no-output";
      let fallback: DeliveryOutcome = { produced: false };
      try {
        fallback = await handlers.fallback(record);
      } catch (cause) {
        fallback = { produced: false, error: cause instanceof Error ? cause.message : String(cause) };
      }

      if (fallback.produced) {
        record.state = "degraded";
        record.produced = true;
        record.degraded = true;
        record.error = modelError;
        record.updatedAt = this.now();
        this.persist();
        this.emit("notify.degraded", { deliveryId: record.deliveryId, attempts: record.attempts, error: modelError });
        return;
      }

      record.produced = false;
      record.degraded = false;
      record.error = fallback.error ? `${modelError}; fallback: ${fallback.error}` : modelError;
      record.updatedAt = this.now();
      const permanent = PERMANENT_ERROR_PATTERN.test(record.error);
      if (permanent || record.attempts >= this.maxAttempts) {
        record.state = "failed";
        this.persist();
        this.emit("notify.failed", {
          deliveryId: record.deliveryId,
          attempts: record.attempts,
          error: record.error,
          ...(permanent ? { permanent: true } : {}),
        });
        return;
      }

      const delay = this.retryDelaysMs[Math.min(record.attempts - 1, this.retryDelaysMs.length - 1)] ?? 30_000;
      record.state = "queued";
      record.nextAttemptAt = this.now() + delay;
      this.persist();
      this.emit("notify.retry", { deliveryId: record.deliveryId, attempts: record.attempts, delayMs: delay, error: record.error });
      const handle = this.scheduleFn(() => {
        this.timers.delete(record.deliveryId);
        this.run(record, handlers);
      }, delay);
      this.timers.set(record.deliveryId, handle);
    } finally {
      this.running.delete(record.deliveryId);
    }
  }

  private restore(): void {
    if (!this.store) return;
    let loaded: NotifyRecord[] = [];
    try {
      loaded = this.store.load();
    } catch (cause) {
      this.emit("notify.restore_failed", { error: cause instanceof Error ? cause.message : String(cause) });
      return;
    }
    const now = this.now();
    for (const record of loaded) {
      if (!record?.deliveryId || !record.dedupeKey) continue;
      if (record.state === "delivering") record.state = "queued";
      // 同上：落盘时若已 produced，一律按终态恢复，不再重投
      if (record.produced) record.state = record.degraded ? "degraded" : "delivered";
      this.records.set(record.deliveryId, record);
    }
    this.prune(now);
  }

  /** 重启后把未完成的记录交回给调用方重新入队。 */
  public pendingRecords(): NotifyRecord[] {
    const out: NotifyRecord[] = [];
    for (const record of this.records.values()) {
      if (record.state === "queued" && !record.produced) out.push(record);
    }
    return out;
  }

  private findByKey(dedupeKey: string): NotifyRecord | undefined {
    let hit: NotifyRecord | undefined;
    for (const record of this.records.values()) {
      if (record.dedupeKey !== dedupeKey) continue;
      if (!hit || record.acceptedAt > hit.acceptedAt) hit = record;
    }
    return hit;
  }

  private prune(now: number): void {
    const expired: string[] = [];
    for (const [deliveryId, record] of this.records) {
      const inflight = record.state === "queued" || record.state === "delivering";
      if (inflight) continue;
      if (now - record.updatedAt > this.dedupeTtlMs) expired.push(deliveryId);
    }
    for (const deliveryId of expired) this.records.delete(deliveryId);
    while (this.records.size > this.maxRecords) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [deliveryId, record] of this.records) {
        if (record.state === "queued" || record.state === "delivering") continue;
        if (record.updatedAt < oldestAt) {
          oldestAt = record.updatedAt;
          oldestId = deliveryId;
        }
      }
      if (!oldestId) break;
      this.records.delete(oldestId);
    }
  }

  private persist(): void {
    if (!this.store) return;
    try {
      this.store.save([...this.records.values()]);
    } catch (cause) {
      this.emit("notify.persist_failed", { error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  private emit(code: string, data: Record<string, unknown>): void {
    try {
      this.onEvent?.(code, data);
    } catch {
      // 日志失败不影响投递
    }
  }
}

/**
 * 极简 JSON 落盘账本。用途只有一个：进程重启后，还没播报完的通知不能凭空消失
 * （hub 收到 2xx 就把 outbox 置成 delivered=1，不会再重投）。
 */
export function createJsonFileStore(filePath: string): NotifyStore {
  return {
    load(): NotifyRecord[] {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        return Array.isArray(parsed) ? (parsed as NotifyRecord[]) : [];
      } catch {
        return [];
      }
    },
    save(records: readonly NotifyRecord[]): void {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(records), "utf8");
      renameSync(tmp, filePath);
    },
  };
}

export interface ListenOptions {
  readonly server: Server;
  readonly port: number;
  readonly host?: string;
  /** true = fail-fast（抛错）；默认 false = 降级（返回 { listening: false }）。 */
  readonly strict?: boolean;
}

export interface ListenResult {
  readonly listening: boolean;
  readonly error?: string;
}

/**
 * P0-1 的修复本体：`server.listen()` 失败时 Node **只发 error 事件、不回调 listening**，
 * 旧代码的 Promise 因此永不 settle，把 `Service.start()` 永久挂死（整机静默）。
 * 这里把 error 事件转成 reject，再按策略决定「降级」还是「失败」。
 *
 * 默认降级：通知 HTTP 端口不是机器人说话的必要条件，为一个辅助端口拖垮整机，
 * 会把偶发故障变成必然故障。降级后 hub 的 outbox 保持未投递，运维修好后自动重投。
 */
export async function listenOrDegrade(options: ListenOptions): Promise<ListenResult> {
  const { server, port, host = "0.0.0.0" } = options;
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: Error) => rejectListen(err);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolveListen();
      });
    });
    return { listening: true };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? "unknown";
    const message = cause instanceof Error ? cause.message : String(cause);
    try {
      server.close();
    } catch {}
    if (options.strict) throw cause;
    return { listening: false, error: `${code}: ${message}` };
  }
}
