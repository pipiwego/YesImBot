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

  private persona = "";
  private lastPersistedInput: Message | Event | undefined;
  private pendingNudgeHint: string | undefined;
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
            if (this.pendingNudgeHint !== undefined && !this.nudgeHintsByTurn.has(ctx.turnId)) {
              const h = this.pendingNudgeHint.trim();
              this.pendingNudgeHint = undefined;
              if (h) this.nudgeHintsByTurn.set(ctx.turnId, h);
            }
            const hint = this.nudgeHintsByTurn.get(ctx.turnId);
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
            if (this.pendingNudgeHint !== undefined && !this.nudgeHintsByTurn.has(ctx.turnId)) {
              const h = this.pendingNudgeHint.trim();
              this.pendingNudgeHint = undefined;
              if (h) this.nudgeHintsByTurn.set(ctx.turnId, h);
            }
            const hint = this.nudgeHintsByTurn.get(ctx.turnId);
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
    return this.schedule(async () => {
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
    return this.schedule(async () => {
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
    return this.schedule(async () => {
      const ifBusy = options?.ifBusy ?? "reject";
      if (this.stopped || !this.lastPersistedInput) {
        return { kind: "wait" as const, eventId: "" };
      }
      if (ifBusy === "reject" && this.agent.getActiveTurnId() !== null) {
        return { kind: "wait" as const, eventId: "" };
      }
      this.pendingNudgeHint = options?.nudgeHint;
      const result = this.start(this.lastPersistedInput, true, ifBusy);
      this.logger.debug("runtime.nudge", {
        eventId: this.lastPersistedInput.id,
        ifBusy,
        hasHint: Boolean(options?.nudgeHint),
        result: result.kind,
      });
      return result;
    });
  }

  public fail(eventId: string, cause: unknown, delivery?: { turnId: string; messageId: string; segmentIndex: number; segmentTotal: number }): Promise<void> {
    return this.schedule(async () => {
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

  public compact(reason: "auto" | "idle" | "manual"): Promise<unknown> {
    return this.schedule(async () => {
      const result = await this.options.channel.conversation.compact(reason, {
        model: this.options.compactModel ?? this.options.model,
        personaName: "月见诗音",
        persona: this.persona,
      });
      if (result.compacted) {
        this.turnsSinceCompact = 0;
        this.lastInputTokens = undefined;
        await this.archiveIfOversize();
      }
      return result;
    });
  }

  public stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    this.clearIdleTimer();
    for (const controller of this.controllers) controller.abort();
    this.stopTask = this.schedule(async () => {
      await this.agent.interrupt("stop");
      await this.agent.stop();
      await Promise.allSettled([...this.streams]);
    });
    return this.stopTask;
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
          throw new Error("Agent turn aborted");
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
        void this.compact("idle");
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
      return;
    }
    this.forceCompactPending = false;
    this.logger.info("runtime.compact.forced", {
      lastInputTokens: this.lastInputTokens,
      turnsSinceCompact: this.turnsSinceCompact,
      overTokens,
      overTurns,
    });
    void this.compact("auto");
  }

  private state(): WillState {
    return { activeTurnId: this.agent.getActiveTurnId() };
  }

  private schedule<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.stopped) throw new Error("Channel runtime is stopped");
  }

  private scheduleArchiveCheck(): void {
    if (this.stopped || (this.options.archiveMaxBytes ?? 0) <= 0) return;
    void this.schedule(async () => {
      if (this.stopped || this.agent.getActiveTurnId() !== null) return;
      await this.archiveIfOversize();
    });
  }

  private async archiveIfOversize(): Promise<void> {
    const maxBytes = this.options.archiveMaxBytes ?? 0;
    if (this.stopped || maxBytes <= 0) return;
    await this.options.channel.conversation.archiveIfOversize(maxBytes, {
      model: this.options.compactModel ?? this.options.model,
      personaName: "月见诗音",
      persona: this.persona,
    });
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
      void this.compact("idle");
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
