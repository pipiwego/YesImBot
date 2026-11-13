import {
  AgentBusyError,
  createAgent,
  createEntry,
  createSystemMessage,
  type Agent,
  type AgentInternalEvent,
  type AgentPlugin,
  type AgentToolSet,
} from "@yesimbot/agent-runtime";
import type { AssistantContent, LanguageModel, ToolSet } from "ai";
import { Universal, type Bot, type Context, type Element, type Logger } from "koishi";

import {
  createDescribeImageTool,
  createReadTool,
  createSendChatRecordCardTool,
  createSendMessageTool,
} from "../agents/tools.js";
import type { WillEngine, WillState } from "../agents/will.js";
import { type Channel, type ChannelContext, deriveChannelKey } from "../channels/index.js";
import type { Config } from "../config.js";
import type { CompactReason, CompactResult } from "../conversations/index.js";
import {
  createEvent,
  createMessage,
  formatInput,
  parseReply,
  isEvent,
  isMessage,
  isMessageRecord,
  type Event,
  type EventRecord,
  type Message,
  type MessageRecord,
} from "../messages/index.js";
import { prepareOutputSegments } from "../resources/index.js";
import { OutputQueue } from "./output.js";
import { buildCoreSystemPrompt, readPersona } from "./prompt.js";

const MODEL_INPUT_PLUGIN: AgentPlugin = {
  name: "core.model-input",
  enforce: "pre",
  toModelMessages: async (message) => (isMessage(message) || isEvent(message) ? [formatInput(message)] : []),
};

const COMPACT_HISTORY_PLUGIN: AgentPlugin = {
  name: "core.compact-history",
  enforce: "pre",
  transformEntries: (entries) => {
    const lastCompactIndex = entries.reduce((last, entry, index) => (entry.type === "compact" ? index : last), -1);
    return (lastCompactIndex === -1 ? entries : entries.slice(lastCompactIndex)).map((entry) =>
      entry.type === "compact"
        ? createEntry(
            "message",
            createSystemMessage(`<conversation_memory>\n${entry.data.summary}\n</conversation_memory>`, { id: entry.id, timestamp: entry.timestamp }),
            { id: entry.id, timestamp: entry.timestamp },
          )
        : entry,
    );
  },
};

export type ChannelOutput = { readonly turnId: string; readonly messageId: string; readonly segments: readonly Element[][] };

export type RuntimeResult =
  | { readonly kind: "wait"; readonly eventId: string }
  | { readonly kind: "join"; readonly eventId: string; readonly turnId: string }
  | { readonly kind: "run"; readonly eventId: string; readonly output: AsyncIterable<ChannelOutput>; readonly signal: AbortSignal };

export type PostOptions = { readonly trigger?: boolean; readonly ifBusy?: "defer" | "join" | "reject" };

export type NudgeOptions = { readonly ifBusy?: "defer" | "join" | "reject"; readonly nudgeHint?: string };

/**
 * 已装填、尚未被任何 turn 消费的 nudge 指令。
 *
 * 必须带时间戳与来源 eventId：
 *  - `at` 用于消费时的 TTL 判定 —— turn 可能在首次 prepareStep 之前就结束
 *    （provider 报错 / turn.aborted / turn.abandoned / AgentBusyError 重排），
 *    指令会留在字段里，之后任意一轮都会取走它；
 *  - `eventId` 用于日志定位「这条过期指令当初是为哪条消息装的」。
 */
type ArmedNudgeHint = { readonly hint: string; readonly at: number; readonly eventId: string };

/** nudge 指令从装填到被消费的最大存活时间；超过即视为过期并丢弃。 */
const NUDGE_HINT_TTL_MS = 90_000;

export interface ChannelRuntimeOptions {
  readonly channel: Channel;
  readonly bot: Bot;
  readonly will: WillEngine;
  readonly model: LanguageModel;
  readonly providerTools?: ToolSet;
  readonly visionModel?: LanguageModel;
  readonly imageOutputSupported: boolean;
  readonly config: Config;
  readonly plugins: readonly AgentPlugin[];
  readonly compactModel?: LanguageModel;
  readonly idleTimeout?: number;
  readonly compactTriggerTokens?: number;
  readonly compactFallbackTurns?: number;
  readonly archiveMaxBytes?: number;
  /** interrupt() 等待 turn 收尾的上限（毫秒），超时即放弃等待并释放串行队列（默认 3000） */
  readonly interruptTimeoutMs?: number;
  /** stop() 各阶段（队尾/interrupt/agent.stop/流）等待上限（毫秒，默认 5000） */
  readonly stopTimeoutMs?: number;
  /** 单次压缩 LLM 调用上限（毫秒，默认 90000） */
  readonly compactTimeoutMs?: number;
  /** 单次工具执行上限（毫秒），默认交给 agent-runtime（120s） */
  readonly toolTimeoutMs?: number;
}

export class ChannelRuntime {
  public readonly context: ChannelContext;
  public readonly selfId: string;

  private readonly agent: Agent;
  private readonly logger: Logger;
  private tail: Promise<void> = Promise.resolve();
  private readonly streams = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;
  private stopTask: Promise<void> | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private responseCompactionPending = false;
  /** 上一轮请求实际发送的 input token 数（provider 在响应里回传，天然滞后一轮） */
  private lastInputTokens: number | undefined;
  /** 距上次成功压缩累计的回复轮数，作为 token 统计缺失时的兜底触发轴 */
  private turnsSinceCompact = 0;
  /** 压缩已判定需要执行、但当时正忙，等空闲窗口立即执行 */
  private forceCompactPending = false;
  /** 压缩独立车道的队尾：与入站消息的 schedule 完全解耦 */
  private compactTail: Promise<void> = Promise.resolve();
  /** 正在跑（或排队中）的那次压缩，用来合并重复请求 */
  private compactInFlight: Promise<CompactResult> | undefined;
  /** 入站车道上一次请求压缩的时间（节流，避免每条消息都触发一次读盘） */
  private lastCompactRequestAt = 0;
  /** schedule 里还在排队的任务数，用于「排队中」可观测性 */
  private pendingTasks = 0;
  /** 排队/执行超过这个时长就打 warn（毫秒） */
  private readonly queueWarnMs = 5_000;

  private persona = "";
  private lastPersistedInput: Message | Event | undefined;
  /** 装填待消费的 nudge 指令（带时间戳，跨轮安全靠它 + TTL） */
  private pendingNudgeHint: ArmedNudgeHint | undefined;
  private readonly nudgeHintsByTurn = new Map<string, string>();

  public constructor(
    private readonly ctx: Context,
    private readonly options: ChannelRuntimeOptions,
  ) {
    this.context = options.channel.context;
    this.selfId = options.bot.selfId;
    this.logger = ctx.logger("yesimbot/channel-runtime");
    this.logger.level = options.config.logLevel ?? 2;
    const tools: AgentToolSet = [
      createSendMessageTool(options.bot, this.context.channelId, options.channel.resources),
      createReadTool(options.channel.resources, options.imageOutputSupported),
      createSendChatRecordCardTool(options.bot, this.context.channelId, this.selfId, (messageId, text, count) => {
        // 卡片走的是 bot.sendMessage，不经过 messenger 的投递路径，
        // 这里补发一次 delivered，让 recentBotMsgIds 与 45 秒追问窗口认得它。
        try {
          this.ctx.emit("yesimbot/delivered", {
            platform: this.context.platform,
            selfId: this.selfId,
            channel: {
              id: this.context.channelId,
              type: this.context.type === "direct" ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT,
            },
            messageId,
            turnId: messageId,
            text,
          });
        } catch (cause) {
          this.logger.warn(`card delivered emit failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        this.logger.debug(`card delivered: ${count} 条`);
      }),
    ];
    if (options.visionModel) {
      tools.push(createDescribeImageTool(options.visionModel, options.channel.resources));
    }
    this.agent = createAgent({
      id: deriveChannelKey(this.context),
      model: options.model,
      logger: this.logger,
      interruptTimeoutMs: options.interruptTimeoutMs,
      toolTimeoutMs: options.toolTimeoutMs,
      storage: options.channel.conversation.storage,
      systemPrompt: () =>
        buildCoreSystemPrompt({
          basePath: options.config.basePath,
          channel: this.context,
          selfId: this.selfId,
          logger: this.logger,
          customInnerThought: options.config.customInnerThought,
        }),
      tools,
      providerTools: options.providerTools,
      terminalTool: {
        name: "finalize",
        description: "结束本轮回复，不输出任何对外内容。调用后不要再生成文本或调用其他工具。",
      },
      plugins: [
        COMPACT_HISTORY_PLUGIN,
        MODEL_INPUT_PLUGIN,
        {
          name: "core.nudge-hint-pre",
          enforce: "pre",
          prepareStep: (messages, ctx) => {
            const hint = this.takeNudgeHint(ctx.turnId);
            if (!hint) return messages;
            const tag = hint.startsWith("<nudge_hint") ? hint : `<nudge_hint>\n${hint}\n</nudge_hint>`;
            return [...messages, { role: "user", content: tag }];
          },
        },
        ...options.plugins,
        {
          name: "core.nudge-hint",
          enforce: "post",
          prepareStep: (messages, ctx) => {
            const hint = this.takeNudgeHint(ctx.turnId);
            if (!hint) return messages;
            const tag = hint.startsWith("<nudge_hint") ? hint : `<nudge_hint>\n${hint}\n</nudge_hint>`;
            const already = messages.some(
              (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("<nudge_hint"),
            );
            return already ? messages : [...messages, { role: "user", content: tag }];
          },
          onTurnFinish: (_result, ctx) => {
            this.nudgeHintsByTurn.delete(ctx.turnId);
          },
        },
      ],
    });
  }

  public async init(): Promise<void> {
    this.persona = await readPersona(this.options.config.basePath, this.logger);
    await this.agent.init();
  }

  public handle(record: MessageRecord | EventRecord): Promise<RuntimeResult> {
    return this.schedule("handle", async () => {
      const input = await this.persist(record);
      await this.archiveIfOversize();
      const decision = await this.options.will.decide(input, this.state());
      const result = decision === "wait" ? { kind: "wait" as const, eventId: input.id } : this.start(input, true, "join");
      this.logger.debug("runtime.handle", {
        eventId: input.id,
        eventType: "messageId" in record ? "message" : "event",
        decision,
        result: result.kind,
        activeTurnId: this.state().activeTurnId,
      });
      return result;
    });
  }

  public post(event: EventRecord, options: PostOptions = {}): Promise<RuntimeResult> {
    const trigger = options.trigger ?? true;
    const ifBusy = options.ifBusy ?? "defer";
    return this.schedule("post", async () => {
      this.assertOpen();
      if (trigger && ifBusy === "reject" && this.agent.getActiveTurnId() !== null) throw new AgentBusyError();
      const input = await this.persist(event);
      await this.archiveIfOversize();
      const result = !trigger ? { kind: "wait" as const, eventId: input.id } : this.start(input, false, ifBusy);
      this.logger.debug("runtime.post", { eventId: input.id, eventType: event.eventType, trigger, ifBusy, result: result.kind });
      return result;
    });
  }

  public nudge(options?: NudgeOptions): Promise<RuntimeResult> {
    return this.schedule("nudge", async () => {
      const ifBusy = options?.ifBusy ?? "reject";
      if (this.stopped || !this.lastPersistedInput) {
        // 早退：这条 nudge 不会产生 turn，上一轮装填但没被消费的指令也不能留到下一轮
        this.dropPendingNudgeHint(this.stopped ? "stopped" : "no-input");
        return { kind: "wait" as const, eventId: "" };
      }
      if (ifBusy === "reject" && this.agent.getActiveTurnId() !== null) {
        // 早退：turn 还在跑，谁都不会消费这条指令 —— 连同旧的待消费指令一起丢掉
        this.dropPendingNudgeHint("busy");
        return { kind: "wait" as const, eventId: "" };
      }
      const hint = options?.nudgeHint;
      if (hint === undefined) {
        // 调用方明确不带 hint：语义是「清掉之前那条」，不能让旧指令继续等下一个 turn
        this.dropPendingNudgeHint("superseded");
      } else {
        this.pendingNudgeHint = { hint, at: Date.now(), eventId: this.lastPersistedInput.id };
      }
      const result = this.start(this.lastPersistedInput, true, ifBusy);
      this.logger.debug("runtime.nudge", {
        eventId: this.lastPersistedInput.id,
        ifBusy,
        hasHint: Boolean(hint),
        result: result.kind,
      });
      return result;
    });
  }

  /**
   * nudge 指令的唯一消费点：把待消费指令挂到当前 turn 上，并做 TTL 校验。
   *
   * 之所以必须校验 TTL：装填之后、被消费之前的那段时间里 turn 可能已经结束
   * （provider 报错 / abort / abandoned），指令会原封不动留到下一轮。
   * 注入一条带过期 data-target-id 与过期 gate 的指令比不注入更糟。
   */
  private takeNudgeHint(turnId: string): string | undefined {
    if (this.pendingNudgeHint !== undefined && !this.nudgeHintsByTurn.has(turnId)) {
      const armed = this.pendingNudgeHint;
      this.pendingNudgeHint = undefined;
      const ageMs = Date.now() - armed.at;
      if (ageMs > NUDGE_HINT_TTL_MS) {
        this.logger.info("nudge.hint_expired", { turnId, eventId: armed.eventId, ageMs, ttlMs: NUDGE_HINT_TTL_MS });
      } else {
        const hint = armed.hint.trim();
        if (hint) this.nudgeHintsByTurn.set(turnId, hint);
      }
    }
    return this.nudgeHintsByTurn.get(turnId);
  }

  /** 丢弃尚未被消费的 nudge 指令（早退 / 被替换），并留下可查的原因。 */
  private dropPendingNudgeHint(reason: string): void {
    const armed = this.pendingNudgeHint;
    if (armed === undefined) return;
    this.pendingNudgeHint = undefined;
    this.logger.info("nudge.hint_dropped", { reason, eventId: armed.eventId, ageMs: Date.now() - armed.at });
  }

  /** 清空「已挂到某个 turn 上」的指令（stop / abort / abandoned），并留下可查的原因。 */
  private clearNudgeHints(reason: string): void {
    if (this.nudgeHintsByTurn.size === 0) return;
    this.logger.info("nudge.hints_cleared", { reason, turnIds: [...this.nudgeHintsByTurn.keys()] });
    this.nudgeHintsByTurn.clear();
  }

  public fail(eventId: string, cause: unknown, delivery?: { turnId: string; messageId: string; segmentIndex: number; segmentTotal: number }): Promise<void> {
    return this.schedule("fail", async () => {
      const input = createEvent({
        eventType: "delivery.failed",
        platform: this.context.platform,
        selfId: this.selfId,
        channel: { id: this.context.channelId, type: this.context.type === "direct" ? 1 : 0 },
        timestamp: Date.now(),
        text: "delivery failed",
        delivery: {
          turnId: delivery?.turnId ?? "",
          messageId: delivery?.messageId ?? eventId,
          segmentIndex: delivery?.segmentIndex ?? 0,
          segmentTotal: delivery?.segmentTotal ?? 0,
          error: { name: cause instanceof Error ? cause.name : "Error", message: cause instanceof Error ? cause.message : String(cause) },
        },
      });
      await this.agent.append(input);
      this.ctx.emit("yesimbot/event", input);
    });
  }

  public wait(): Promise<void> {
    return this.agent.wait();
  }

  /**
   * 压缩在**独立车道**（compactTail）上跑，不再占 schedule 的队尾：
   * 入站消息只排在 turn / persist 后面，不会排在一次可能很慢的 LLM 压缩后面。
   * 同一时刻只保留一次压缩，重复的 auto/idle 请求合并到正在跑的那次。
   */
  public compact(reason: CompactReason): Promise<CompactResult> {
    if (this.stopped) return Promise.resolve({ compacted: false, reason: "stopped" });
    if (reason !== "manual" && this.compactInFlight) {
      this.logger.debug("runtime.compact.coalesced", { reason });
      return this.compactInFlight;
    }

    const run = (): Promise<CompactResult> => this.runCompact(reason);
    const result = this.compactTail.then(run, run);
    this.compactTail = result.then(
      () => undefined,
      () => undefined,
    );
    this.compactInFlight = result;
    const clear = () => {
      if (this.compactInFlight === result) this.compactInFlight = undefined;
    };
    void result.then(clear, clear);
    return result;
  }

  /**
   * 压缩一次，并在出入口各打一条 info（耗时 / 条目数 / 是否成功）。
   * 这是排查「频道卡住多久」的唯一抓手：改前压缩成功时全静默。
   */
  private async runCompact(reason: CompactReason): Promise<CompactResult> {
    const conversation = this.options.channel.conversation;
    const startedAt = Date.now();
    // 入场日志不打读盘快照：压缩本身就要读全文，这里再读一次纯属浪费，
    // 也会在（fake timer 之类的）临界路径上多插一次 I/O。
    this.logger.info("runtime.compact.start", {
      reason,
      failures: conversation.failuresCount(),
      turnsSinceCompact: this.turnsSinceCompact,
      lastInputTokens: this.lastInputTokens,
    });

    let result: CompactResult;
    try {
      result = await conversation.compact(reason, {
        model: this.options.compactModel ?? this.options.model,
        personaName: "月见诗音",
        persona: this.persona,
        timeoutMs: this.options.compactTimeoutMs,
      });
    } catch (cause) {
      this.logger.warn("runtime.compact.error", {
        reason,
        elapsedMs: Date.now() - startedAt,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }

    const elapsedMs = Date.now() - startedAt;
    const after = await this.compactSnapshot();
    if (result.compacted) {
      this.turnsSinceCompact = 0;
      this.lastInputTokens = undefined;
    }
    this.logger.info("runtime.compact.end", {
      reason,
      ok: result.compacted,
      code: result.reason ?? "ok",
      degraded: result.degraded ?? false,
      elapsedMs,
      entries: after.entries,
      messages: after.messages,
      bytes: after.bytes,
      failures: conversation.failuresCount(),
      retryInMs: conversation.compactBackoffRemainingMs(),
    });

    if (result.degraded) {
      this.logger.warn("runtime.compact.degraded", {
        reason,
        messages: after.messages,
        bytes: after.bytes,
        failures: conversation.failuresCount(),
        retryInMs: conversation.compactBackoffRemainingMs(),
      });
    } else if (result.reason === "failure_limit") {
      this.logger.warn("runtime.compact.backoff", {
        reason,
        failures: conversation.failuresCount(),
        retryInMs: conversation.compactBackoffRemainingMs(),
      });
    }

    if (result.compacted || result.degraded) {
      // 换会话放在消息车道里做（scheduleArchiveCheck 只在空闲时动手），
      // 避免和正在写入的 turn 抢同一个会话文件。
      this.scheduleArchiveCheck();
    }
    return result;
  }

  private async compactSnapshot(): Promise<{ entries: number; messages: number; bytes: number }> {
    try {
      const conversation = this.options.channel.conversation;
      const entries = await conversation.storage.read();
      const active = (await conversation.status()).active;
      return {
        entries: entries.length,
        messages: entries.filter((entry) => entry.type === "message").length,
        bytes: active?.size ?? 0,
      };
    } catch (cause) {
      this.logger.debug("runtime.compact.snapshot.failed", { error: cause instanceof Error ? cause.message : String(cause) });
      return { entries: -1, messages: -1, bytes: -1 };
    }
  }

  /** 请求一次压缩；minIntervalMs 节流，避免每条消息都触发（读盘 + 排队）。 */
  private requestCompact(reason: CompactReason, minIntervalMs = 30_000): void {
    if (this.stopped) return;
    const now = Date.now();
    if (now - this.lastCompactRequestAt < minIntervalMs) return;
    this.lastCompactRequestAt = now;
    void this.compact(reason).catch((cause) => {
      this.logger.warn("runtime.compact.request.failed", { reason, error: cause instanceof Error ? cause.message : String(cause) });
    });
  }

  public stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    this.clearIdleTimer();
    // 停机：待消费的与已登记到 turn 上的 nudge 指令都已失去意义，
    // 留着只会在（重建后的）下一轮注入一条过期指令。
    this.dropPendingNudgeHint("stop");
    this.clearNudgeHints("stop");
    for (const controller of this.controllers) controller.abort();
    this.stopTask = this.stopInternal();
    return this.stopTask;
  }

  /**
   * stop 不排在 schedule 队尾后面死等：先给队尾一个有限窗口收尾，
   * 然后无论如何自己跑一遍，每一步都有上限。任何一步超时只记 warn，不再无限等。
   */
  private async stopInternal(): Promise<void> {
    const timeoutMs = this.options.stopTimeoutMs ?? 5_000;
    await this.withDeadline(this.tail.catch(() => undefined), timeoutMs, "schedule.tail", true);
    await this.withDeadline(this.agent.interrupt("stop"), timeoutMs, "agent.interrupt", true);
    await this.withDeadline(this.agent.stop(), timeoutMs, "agent.stop", true);
    await this.withDeadline(Promise.allSettled([...this.streams]), timeoutMs, "agent.streams", true);
    this.logger.debug("runtime.stop.done", { streams: this.streams.size, pendingTasks: this.pendingTasks });
  }

  /** Promise.race + 上限；超时记 warn。swallow=true 时不抛错（stop 路径必须走完）。 */
  private async withDeadline<T>(work: Promise<T> | T, timeoutMs: number, label: string, swallow: boolean): Promise<T | undefined> {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = Promise.resolve(work).then(
        (value) => ({ status: "ok" as const, value }),
        (error: unknown) => ({ status: "error" as const, error }),
      );
      const timeout = new Promise<{ status: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" as const }), timeoutMs);
      });
      const outcome = await Promise.race([settled, timeout]);
      if (outcome.status === "timeout") {
        this.logger.warn("runtime.stop.timeout", { label, timeoutMs, elapsedMs: Date.now() - startedAt });
        if (swallow) return undefined;
        throw new Error(`${label} timed out after ${timeoutMs}ms`);
      }
      if (outcome.status === "error") {
        this.logger.warn("runtime.stop.failed", {
          label,
          error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        });
        if (swallow) return undefined;
        throw outcome.error;
      }
      return outcome.value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async persist(record: MessageRecord | EventRecord): Promise<Message | Event> {
    const input = isMessageRecord(record) ? createMessage(record) : createEvent(record);
    await this.agent.append(input);
    this.lastPersistedInput = input;
    this.ctx.emit(isMessage(input) ? "yesimbot/message" : "yesimbot/event", input as never);
    return input;
  }

  private async commit(record: MessageRecord | EventRecord): Promise<Message | Event> {
    const input = await this.persist(record);
    await this.archiveIfOversize();
    return input;
  }

  private start(input: Message | Event, passive: boolean, ifBusy: "defer" | "join" | "reject"): RuntimeResult {
    const activeTurnId = this.agent.getActiveTurnId();
    if (ifBusy === "join" && activeTurnId !== null) {
      this.agent.send(input, { ifBusy: "join" });
      return { kind: "join", eventId: input.id, turnId: activeTurnId };
    }
    const controller = new AbortController();
    const queue = new OutputQueue<ChannelOutput>();
    const task = this.consume(this.agent.run(input, { ifBusy: ifBusy === "join" ? "defer" : ifBusy }), queue, controller, passive);
    this.controllers.add(controller);
    this.streams.add(task);
    void task.finally(() => {
      this.controllers.delete(controller);
      this.streams.delete(task);
    });
    return { kind: "run", eventId: input.id, output: queue, signal: controller.signal };
  }

  private async consume(
    stream: AsyncIterable<AgentInternalEvent>,
    output: OutputQueue<ChannelOutput>,
    controller: AbortController,
    passive: boolean,
  ): Promise<void> {
    let assistant = false;
    let completed = false;
    let turnId = "";
    try {
      for await (const event of stream) {
        if (event.type === "turn.start") {
          this.logger.debug("runtime.turn.start", { turnId: event.turnId });
          continue;
        }
        if (event.type === "turn.step") {
          const stepTokens = (event.usage as { inputTokens?: number } | undefined)?.inputTokens;
          if (typeof stepTokens === "number" && stepTokens > 0) this.lastInputTokens = stepTokens;
          this.logger.debug("runtime.turn.step", {
            turnId: event.turnId,
            stepNumber: event.step,
            finishReason: event.finishReason,
            usage: event.usage,
            reasoningText: event.reasoningText === undefined ? undefined : event.reasoningText.slice(0, 1000),
          });
          continue;
        }
        if (event.type === "turn.done") {
          this.logger.debug("runtime.turn.done", { turnId: event.turnId });
          continue;
        }
        if (event.type === "tool.start") {
          this.logger.debug("runtime.tool.start", { turnId: event.turnId, toolName: event.toolName, toolCallId: event.toolCallId });
          continue;
        }
        if (event.type === "tool.done") {
          this.logger.debug("runtime.tool.done", { turnId: event.turnId, toolName: event.toolName, toolCallId: event.toolCallId });
          continue;
        }
        if (event.type === "tool.failed") {
          this.logger.warn("runtime.tool.failed", { turnId: event.turnId, toolName: event.toolName, toolCallId: event.toolCallId, error: event.error.message });
          continue;
        }
        if (event.type === "tool.timeout") {
          this.logger.warn("runtime.tool.timeout", {
            turnId: event.turnId,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            timeoutMs: event.timeoutMs,
          });
          continue;
        }
        if (event.type === "message.appended" && "turnId" in event && event.message.role === "assistant") {
          turnId = event.turnId;
          const content = renderAssistantText(event.message.content);
          if (content !== undefined) {
            const segments = await prepareOutputSegments(parseReply(content), this.options.channel.resources, controller.signal);
            if (segments.length) {
              this.logger.debug("runtime.output.segments", { turnId, messageId: event.message.id, segmentCount: segments.length });
              output.push({ turnId, messageId: event.message.id, segments });
              assistant = true;
            }
          }
        }
        if (event.type === "turn.failed") {
          this.logger.warn("runtime.turn.failed", { turnId: event.turnId, error: event.error.message });
          throw new Error(event.error.message);
        }
        if (event.type === "turn.aborted") {
          this.logger.warn("runtime.turn.aborted", { turnId: event.turnId, reason: event.reason });
          // 被中断的 turn 不会再跑 prepareStep：把挂在它上面的指令一起清掉，别留给下一轮
          this.clearNudgeHints("abort");
          throw new Error("Agent turn aborted");
        }
        if (event.type === "turn.abandoned") {
          // interrupt 已放弃跟踪这个 turn：不要再等它，直接收尾消费者，
          // 否则 output 永不 close、streams 永不清空、投递锁也跟着一起挂住。
          this.clearNudgeHints("abandoned");
          this.logger.warn("runtime.turn.abandoned", {
            turnId: event.turnId,
            elapsedMs: event.elapsedMs,
            timeoutMs: event.timeoutMs,
            queueLength: event.queueLength,
            reason: event.reason,
          });
          break;
        }
      }
      completed = true;
      if (passive && assistant) await this.options.will.observe?.({ turnId, status: "done", messages: [] });
      output.close();
    } catch (cause) {
      output.close(cause);
    } finally {
      const idle = this.agent.getActiveTurnId() === null;
      if (completed && assistant) {
        this.responseCompactionPending = false;
        this.turnsSinceCompact += 1;
        this.resetIdleTimer();
      } else if (this.responseCompactionPending && idle) {
        this.responseCompactionPending = false;
        this.requestCompact("idle", 0);
      }
      this.scheduleArchiveCheck();
      // 体积轴 / 轮次轴强制压缩：回复已 close，用户不感知；压缩经 schedule 串行排在当前 turn 之后。
      this.maybeForceCompact(idle);
    }
  }

  /**
   * 强制压缩判定（多轴取最先命中）：
   *  - 体积轴：上一轮 inputTokens ≥ compactTriggerTokens（覆盖热群 / 长私聊，idle 永不触发的场景）
   *  - 轮次轴：距上次压缩 ≥ compactFallbackTurns（provider 不报 usage 时的兜底，防止静默涨爆）
   * 忙的时候只置位，等下一个空闲窗口再执行；实在等不到就由下一次 finally 兜住。
   */
  private maybeForceCompact(idle: boolean): void {
    if (this.stopped) return;
    const triggerTokens = this.options.compactTriggerTokens ?? 0;
    const fallbackTurns = this.options.compactFallbackTurns ?? 0;
    const overTokens = triggerTokens > 0 && (this.lastInputTokens ?? 0) >= triggerTokens;
    const overTurns = fallbackTurns > 0 && this.turnsSinceCompact >= fallbackTurns;
    if (!overTokens && !overTurns) {
      this.forceCompactPending = false;
      return;
    }
    if (!idle) {
      this.forceCompactPending = true;
      this.logger.debug("runtime.compact.deferred", {
        turnId: this.agent.getActiveTurnId(),
        lastInputTokens: this.lastInputTokens,
        turnsSinceCompact: this.turnsSinceCompact,
        overTokens,
        overTurns,
      });
      // 关键：consume 的 finally 跑在 turn 真正 settle 之前，那一刻 getActiveTurnId() 往往还不是 null，
      // 只置位不重试会让「强制压缩」一直等不到下一个空闲窗口（上下文继续涨）。
      // 这里在消息车道上排一次检查：车道一空就一定看得到 idle。
      this.scheduleIdleCompactCheck();
      return;
    }
    this.forceCompactPending = false;
    this.logger.info("runtime.compact.forced", {
      lastInputTokens: this.lastInputTokens,
      turnsSinceCompact: this.turnsSinceCompact,
      overTokens,
      overTurns,
    });
    this.requestCompact("auto", 0);
  }

  private state(): WillState {
    return { activeTurnId: this.agent.getActiveTurnId() };
  }

  /**
   * 入站车道：同一频道内串行。带排队/执行时长看门狗 ——
   * 改前排队完全静默，堵住时日志里看不出一句「排队中」。
   */
  private schedule<T>(label: string, task: () => Promise<T>): Promise<T> {
    const enqueuedAt = Date.now();
    const depth = this.pendingTasks;
    this.pendingTasks += 1;

    const run = async (): Promise<T> => {
      const waitedMs = Date.now() - enqueuedAt;
      this.pendingTasks -= 1;
      if (waitedMs >= this.queueWarnMs) {
        this.logger.warn("runtime.schedule.lag", { label, waitedMs, depth });
      }
      const startedAt = Date.now();
      try {
        return await task();
      } finally {
        const tookMs = Date.now() - startedAt;
        if (tookMs >= this.queueWarnMs) {
          this.logger.warn("runtime.schedule.slow", { label, tookMs, depth });
        }
      }
    };

    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.stopped) throw new Error("Channel runtime is stopped");
  }

  /** 在消息车道上排一次「空闲就执行待办的强制压缩」的检查（不阻塞入站，只是顺带排在队尾）。 */
  private scheduleIdleCompactCheck(): void {
    if (this.stopped) return;
    void this.schedule("compact-check", async () => {
      if (this.stopped || !this.forceCompactPending) return;
      if (this.agent.getActiveTurnId() !== null) return;
      this.forceCompactPending = false;
      this.requestCompact("auto", 0);
    });
  }

  private scheduleArchiveCheck(): void {
    if (this.stopped || (this.options.archiveMaxBytes ?? 0) <= 0) return;
    void this.schedule("archive-check", async () => {
      if (this.stopped || this.agent.getActiveTurnId() !== null) return;
      await this.archiveIfOversize();
    });
  }

  /**
   * 入站车道里的体积检查：只做「已有摘要就换会话」这种廉价操作。
   * 没有摘要时**不在这里跑 LLM 压缩**（那会把整条频道堵在一次慢调用后面），
   * 而是把压缩丢给独立车道，压完再由 scheduleArchiveCheck 完成换会话。
   */
  private async archiveIfOversize(): Promise<void> {
    const maxBytes = this.options.archiveMaxBytes ?? 0;
    if (this.stopped || maxBytes <= 0) return;
    const conversation = this.options.channel.conversation;
    if (await conversation.archiveIfOversize(maxBytes, undefined, { requireSummary: true })) {
      this.logger.debug("runtime.archive.done", { maxBytes });
      return;
    }
    const active = (await conversation.status()).active;
    if (!active || active.size <= maxBytes) return;
    this.logger.debug("runtime.archive.deferred", { bytes: active.size, maxBytes });
    this.requestCompact("auto");
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    if (this.stopped || !this.options.idleTimeout) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.agent.getActiveTurnId() !== null) {
        this.responseCompactionPending = true;
        return;
      }
      this.requestCompact("idle", 0);
    }, this.options.idleTimeout);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}

function renderAssistantText(content: AssistantContent): string | undefined {
  if (typeof content === "string") return content.trim() ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : "")).join("");
  return text.trim() ? text : undefined;
}
