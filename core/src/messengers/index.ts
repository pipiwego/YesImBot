import type { Awaitable, Bot, Context, Element, Logger, Session } from "koishi";
import { Universal } from "koishi";

import type { Channels } from "../channels/index.js";
import { type ChannelContext, deriveChannelKey, contextFromSession, contextFromRecord } from "../channels/index.js";
import type { ChannelAllowRule, Config, PacingConfig } from "../config.js";
import { formatElements } from "../messages/index.js";
import type { DeliveredPayload, EventRecord, MessageRecord, RecordBase } from "../messages/index.js";
import type { ChannelResources } from "../resources/index.js";
import type { ChannelRuntime, NudgeOptions, PostOptions, RuntimeResult, Runtimes } from "../runtimes/index.js";

type RunResult = Extract<RuntimeResult, { readonly kind: "run" }>;

type DeliveryContext = { turnId: string; messageId: string; segmentIndex: number; segmentTotal: number };

/** 分段投递统计：`yesimbot/delivered` 会额外带上这些字段（DeliveredPayload 的结构化扩展）。 */
export interface DeliveryStats {
  readonly segmentsDelivered: number;
  readonly segmentsFailed: number;
  readonly segmentsTotal: number;
}

/** 一次投递的逐段记账。`aborted` 同时充当 pacedSegments 的进度信号。 */
interface DeliveryTally {
  delivered: number;
  failed: number;
  attempted: number;
  aborted: boolean;
  reason: string;
  text: string[];
  error?: unknown;
}

/** `post()` 的投递结果：是否真的产出了 assistant 文本并发出（供内部通知链路判定「到底说没说出口」）。 */
export interface PostOutcome {
  readonly produced: boolean;
  readonly segments: number;
  readonly error?: string;
}

export interface Translator {
  readonly platform: string;
  translate(session: Session, resources: ChannelResources): Awaitable<MessageRecord | EventRecord | null>;
}

export class Messenger {
  private readonly logger: Logger;
  private readonly translators = new Map<string, Translator>();
  private readonly sessions = new WeakSet<object>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly deliveryTails = new Map<string, Promise<void>>();
  private readonly disposers: Array<() => unknown> = [];
  private closed = false;

  public constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly channels: Channels,
    private readonly runtimes: Runtimes,
  ) {
    this.logger = ctx.logger("yesimbot.messenger");
    this.logger.level = config.logLevel ?? 2;
    const middleware = ctx.middleware(async (session, next) => {
      try {
        await this.handle(session);
      } finally {
        await next();
      }
    });
    if (typeof middleware === "function") this.disposers.push(middleware);
    const internal = ctx.on("internal/session", (session) => {
      if (session.type !== "message-created") void this.handle(session);
    });
    if (typeof internal === "function") this.disposers.push(internal);
  }

  public use(translator: Translator): () => void {
    if (this.translators.has(translator.platform)) {
      throw new Error(`Translator for platform "${translator.platform}" is already registered`);
    }
    this.translators.set(translator.platform, translator);
    this.logger.debug("messenger.translator_registered", { platform: translator.platform });
    return () => {
      if (this.translators.get(translator.platform) === translator) {
        this.translators.delete(translator.platform);
        this.logger.debug("messenger.translator_unregistered", { platform: translator.platform });
      }
    };
  }

  public async post(event: EventRecord, options?: PostOptions): Promise<PostOutcome> {
    if (this.closed) return { produced: false, segments: 0, error: "messenger closed" };
    const bot = this.ctx.bots.find((candidate) => candidate.platform === event.platform && candidate.selfId === event.selfId);
    if (!bot) throw new Error(`No Bot is available for ${event.platform}:${event.selfId}`);
    const channel = await this.channels.resolve(contextFromRecord(event)!);
    const runtime = await this.runtimes.get(channel, bot);
    const result = await runtime.post(event, options ?? { trigger: true, ifBusy: "defer" });
    this.logger.debug("messenger.post", {
      eventType: event.eventType,
      platform: event.platform,
      channelId: event.channel.id,
      result: result.kind,
      eventId: result.eventId,
    });
    if (result.kind === "run") return this.track(this.deliverActive(bot, event.channel.id, runtime, result));
    return { produced: false, segments: 0, error: `not-triggered:${result.kind}` };
  }

  public async nudge(ctx: ChannelContext, options?: NudgeOptions & { selfId?: string }): Promise<boolean> {
    if (this.closed || !matchesAllowedChannel(ctx, this.config.allowedChannels)) return false;
    const targetSelfId = options?.selfId ?? ctx.selfId;
    const bot =
      this.ctx.bots.find((candidate) => candidate.platform === ctx.platform && (!targetSelfId || candidate.selfId === targetSelfId)) ??
      this.ctx.bots.find((candidate) => candidate.platform === ctx.platform);
    if (!bot) return false;
    try {
      await this.channels.start();
      await assertAssignee(this.ctx, ctx, bot.selfId);
      const channel = await this.channels.resolve(ctx);
      const runtime = await this.runtimes.get(channel, bot);
      const result = await runtime.nudge(options);
      this.logger.debug("messenger.nudge", {
        platform: ctx.platform,
        channelId: ctx.channelId,
        result: result.kind,
        eventId: result.eventId,
      });
      if (result.kind === "run") {
        void this.track(this.deliverActive(bot, ctx.channelId, runtime, result));
        return true;
      }
      return false;
    } catch (cause) {
      this.warn("messenger.nudge_failed", cause, ctx.platform);
      return false;
    }
  }

  public async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {}
    }
    await this.runtimes.stop();
    await Promise.allSettled([...this.tasks]);
  }

  private async handle(session: Session): Promise<void> {
    if (this.closed || this.sessions.has(session)) return;
    this.sessions.add(session);
    await this.track(this.route(session));
  }

  private async route(session: Session): Promise<void> {
    const ctx = contextFromSession(session);
    const routeId = session.messageId ?? String(session.id);
    if (!ctx || !matchesAllowedChannel(ctx, this.config.allowedChannels)) return;
    try {
      await this.channels.start();
      await assertAssignee(this.ctx, ctx, session.selfId);
      const channel = await this.channels.resolve(ctx);
      const translator = this.translators.get(session.platform) ?? this.translators.get("*");
      const record = translator ? await translator.translate(session, channel.resources) : await translateDefault(this.ctx, session, channel.resources);
      if (!record) return;
      this.logger.debug("messenger.route.record", {
        routeId,
        recordType: "messageId" in record ? "message" : "event",
        platform: record.platform,
        selfId: record.selfId,
        channelId: record.channel.id,
      });
      const bot = this.ctx.bots.find((candidate) => candidate.platform === record.platform && candidate.selfId === record.selfId);
      if (!bot) throw new Error(`No Bot is available for ${record.platform}:${record.selfId}`);
      const runtime = await this.runtimes.get(channel, bot, session);
      const result = await runtime.handle(record);
      this.logger.debug("messenger.route.result", { routeId, result: result.kind, eventId: result.eventId });
      if (result.kind === "run") await this.deliverPassive(session, runtime, result);
    } catch (cause) {
      this.warn("messenger.route_failed", cause, session.platform);
    }
  }

  private async deliverPassive(session: Session, runtime: ChannelRuntime, result: RunResult): Promise<void> {
    const delivery = emptyDeliveryContext(result.eventId);
    await this.serializeDelivery(runtime.context, async () => {
      const tally = await this.deliverSegments(runtime.context, delivery, result, (segment) => session.send([...segment]));
      await this.settleDelivery(runtime, result, delivery, tally);
    });
  }

  private async deliverActive(bot: Bot, channelId: string, runtime: ChannelRuntime, result: RunResult): Promise<PostOutcome> {
    const delivery = emptyDeliveryContext(result.eventId);
    let outcome: PostOutcome = { produced: false, segments: 0 };
    await this.serializeDelivery(runtime.context, async () => {
      const tally = await this.deliverSegments(runtime.context, delivery, result, (segment) => bot.sendMessage(channelId, [...segment]));
      outcome = {
        produced: tally.delivered > 0,
        segments: tally.delivered,
        ...(tally.failed > 0 || tally.aborted ? { error: tally.aborted ? "aborted" : tally.reason } : {}),
      };
      await this.settleDelivery(runtime, result, delivery, tally);
    });
    return outcome;
  }

  /**
   * 逐段投递：**单段失败只记账，不中断后续段**。
   * 旧实现把整个 for-await 包在一个 try 里：第 N 段抛错 → 第 N+1 段起全部丢弃，
   * 一句话发失败就吞掉后面所有内容（B1-7）。成功段文本也只在 send 真的返回后才记，
   * 避免把「首段就失败」误判成「说了一半」。
   */
  private async deliverSegments(
    ctx: ChannelContext,
    delivery: DeliveryContext,
    result: RunResult,
    send: (segment: readonly Element[]) => Promise<unknown>,
  ): Promise<DeliveryTally> {
    const tally: DeliveryTally = { delivered: 0, failed: 0, attempted: 0, aborted: false, reason: "", text: [] };
    try {
      for await (const segment of this.pacedSegments(result, delivery, tally)) {
        tally.attempted += 1;
        try {
          await send(segment);
        } catch (cause) {
          tally.failed += 1;
          tally.error ??= cause;
          tally.reason = cause instanceof Error ? cause.message : String(cause);
          // 每段失败都单独留 trace：段索引 / 总段数 / 失败原因
          this.warnSegment(ctx, "delivery.segment_failed", { cause, delivery, reason: tally.reason });
          continue;
        }
        tally.delivered += 1;
        this.collectText(tally.text, segment);
      }
    } catch (cause) {
      // output 流本身抛错（不是某段的 send 失败）：按中断 / 失败归类，不再静默吞掉
      if (result.signal.aborted) {
        tally.aborted = true;
        tally.reason = "aborted";
      } else {
        tally.failed += 1;
        tally.error ??= cause;
        tally.reason = cause instanceof Error ? cause.message : String(cause);
        this.warnSegment(ctx, "delivery.stream_failed", { cause, delivery, reason: tally.reason });
      }
    }
    return tally;
  }

  /**
   * 全部段跑完后按**实际结果**汇总：
   * - 至少一段成功 → 部分成功，发射 `yesimbot/delivered`（带成功/失败/总段数）；
   * - 一段都没成功且确有失败 → 写 `delivery.failed`；
   * - 中断 → 一律写 `delivery.failed`（reason 落在 error.message = "aborted"），
   *   已经发出去的段照样更新 `delivered`，不让 abort 顺手抹掉插嘴判定的记忆；
   * - 压根没有段（空输出）→ 两条都不写，保持原有语义。
   */
  private async settleDelivery(
    runtime: ChannelRuntime,
    result: RunResult,
    delivery: DeliveryContext,
    tally: DeliveryTally,
  ): Promise<void> {
    const ctx = runtime.context;
    const stats: DeliveryStats = {
      segmentsDelivered: tally.delivered,
      segmentsFailed: tally.failed,
      segmentsTotal: Math.max(tally.attempted, tally.delivered + tally.failed),
    };
    if (tally.aborted) {
      await this.failDelivery(runtime, result, delivery, tally.error, "aborted");
      if (tally.delivered > 0) this.emitDelivered(ctx, delivery, tally.text, stats);
      return;
    }
    if (tally.delivered === 0) {
      if (tally.failed > 0) await this.failDelivery(runtime, result, delivery, tally.error ?? new Error("delivery failed"));
      return;
    }
    if (tally.failed > 0) {
      this.warnSegment(ctx, "delivery.partial", {
        delivery,
        reason: `${tally.delivered}/${stats.segmentsTotal} segments delivered`,
      });
    }
    this.emitDelivered(ctx, delivery, tally.text, stats);
  }

  /**
   * `yesimbot/delivered` 此前只有监听者、没有任何发射点，
   * 导致 will-policy 的 recentBotMsgIds / lastBotReplyAt 永远是空的，
   * 「引用诗音的回复才触发」与「45 秒同人追问直通」双双失效。
   * 现在额外带分段统计（segmentsDelivered / segmentsFailed / segmentsTotal / partial）：
   * 部分成功也算发射 —— 说出口的内容必须让下一轮插嘴判定看得见。
   */
  private emitDelivered(ctx: ChannelContext, delivery: DeliveryContext, sent: readonly string[], stats?: DeliveryStats): void {
    if (sent.length === 0) return;
    const text = sent.join("");
    if (!text.trim()) return;
    const payload: DeliveredPayload = {
      platform: ctx.platform,
      selfId: ctx.selfId ?? "",
      channel: {
        id: ctx.channelId,
        type: ctx.type === "direct" ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT,
      },
      messageId: delivery.messageId,
      turnId: delivery.turnId,
      text,
    };
    // DeliveredPayload 定义在 messages/（本轮不改那里）：额外字段按结构化扩展透传，
    // 老监听者只读已知字段，行为不变。
    const detail = stats ? { ...payload, ...stats, partial: stats.segmentsFailed > 0 } : payload;
    try {
      this.ctx.emit("yesimbot/delivered", detail as DeliveredPayload);
    } catch (cause) {
      this.warn("messenger.delivered_emit_failed", cause, ctx.platform);
    }
  }

  private async *pacedSegments(
    result: RunResult,
    delivery: DeliveryContext,
    progress?: { aborted: boolean },
  ): AsyncIterable<readonly Element[]> {
    let elapsed = 0;
    for await (const output of result.output) {
      for (const [index, segment] of output.segments.entries()) {
        if (result.signal.aborted) {
          if (progress) progress.aborted = true;
          return;
        }
        this.logger.debug("messenger.delivery.segment", {
          turnId: output.turnId,
          messageId: output.messageId,
          segmentIndex: index + 1,
          segmentTotal: output.segments.length,
        });
        const delay = pacedDelay(segment, this.config.pacing, elapsed);
        const startedAt = Date.now();
        await sleep(delay, result.signal);
        elapsed += Math.max(delay, Date.now() - startedAt);
        if (result.signal.aborted) {
          if (progress) progress.aborted = true;
          return;
        }
        delivery.turnId = output.turnId;
        delivery.messageId = output.messageId;
        delivery.segmentIndex = index + 1;
        delivery.segmentTotal = output.segments.length;
        yield segment;
      }
    }
  }

  private async failDelivery(
    runtime: ChannelRuntime,
    result: RunResult,
    delivery: DeliveryContext,
    cause: unknown,
    reason?: string,
  ): Promise<void> {
    // `delivery.failed` 事件的 error 只有 name/message，没有独立 reason 字段：把 reason 编进 message。
    const error = reason === undefined ? cause : namedError(reason, "AbortError");
    await runtime.fail(result.eventId, error, delivery);
    this.warnSegment(runtime.context, "delivery.failed", {
      cause: error,
      delivery,
      reason: reason ?? (cause instanceof Error ? cause.message : String(cause)),
    });
  }

  private collectText(sink: string[], segment: readonly Element[]): void {
    try {
      sink.push(formatElements(segment));
    } catch {
      // 渲染失败不影响投递本身
    }
  }

  /** 带段索引 / 总段数 / 原因的结构化 warn：`warn()` 只带 code+cause，定位不到是哪一段丢的。 */
  private warnSegment(ctx: ChannelContext, code: string, info: { cause?: unknown; delivery: DeliveryContext; reason: string }): void {
    try {
      this.logger.warn({
        code,
        platform: ctx.platform,
        channelId: ctx.channelId,
        turnId: info.delivery.turnId,
        messageId: info.delivery.messageId,
        segmentIndex: info.delivery.segmentIndex,
        segmentTotal: info.delivery.segmentTotal,
        reason: info.reason,
        cause: info.cause === undefined ? undefined : info.cause instanceof Error ? info.cause.message : String(info.cause),
      });
    } catch {}
  }

  private async serializeDelivery(ctx: ChannelContext, task: () => Promise<void>): Promise<void> {
    const key = deriveChannelKey(ctx);
    const previous = this.deliveryTails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.deliveryTails.set(key, settled);
    try {
      await next;
    } finally {
      if (this.deliveryTails.get(key) === settled) this.deliveryTails.delete(key);
    }
  }

  private async track<T>(task: Promise<T>): Promise<T> {
    const tracked = task.then(
      (value) => value,
      (cause) => {
        throw cause;
      },
    );
    this.tasks.add(tracked);
    try {
      return await tracked;
    } finally {
      this.tasks.delete(tracked);
    }
  }

  private warn(code: string, cause: unknown, platform: string): void {
    try {
      this.logger.warn({ code, platform, cause: cause instanceof Error ? cause.message : String(cause) });
    } catch {}
  }
}

export function matchesAllowedChannel(ctx: ChannelContext, rules: readonly ChannelAllowRule[] | undefined): boolean {
  return (
    rules?.some(
      (rule) =>
        (rule.platform === "*" || rule.platform === ctx.platform) &&
        (rule.channelId === "*" || rule.channelId === ctx.channelId) &&
        (rule.isDirect === undefined || rule.isDirect === (ctx.type === "direct")),
    ) ?? false
  );
}

async function assertAssignee(koishiCtx: Context, ctx: ChannelContext, selfId: string): Promise<void> {
  if (ctx.type === "direct") return;
  const [channel] = await koishiCtx.database.get("channel", { platform: ctx.platform, id: ctx.channelId }, ["assignee"]);
  if (!channel?.assignee || channel.assignee !== selfId) throw new Error("Shared channel assignee admission failed");
}

async function translateDefault(ctx: Context, session: Session, resources: ChannelResources): Promise<MessageRecord | null> {
  if (session.type !== "message-created" || !session.messageId || !session.channelId || !Array.isArray(session.elements)) return null;
  const base: RecordBase = {
    platform: session.platform,
    selfId: session.selfId,
    timestamp: session.timestamp,
    channel: {
      id: session.channelId,
      type: session.event.channel?.type ?? (session.isDirect ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT),
      ...(session.event.channel?.name === undefined ? {} : { name: session.event.channel.name }),
    },
    user: {
      id: session.userId || session.event.user?.id || session.author?.id || "",
      ...((session.event.user?.name ?? session.author?.name) === undefined ? {} : { name: session.event.user?.name ?? session.author?.name }),
    },
  };
  return { ...base, messageId: session.messageId, elements: await resources.persistElements(ctx, session.elements) };
}

function namedError(reason: string, name: string): Error {
  const error = new Error(reason);
  error.name = name;
  return error;
}

function emptyDeliveryContext(eventId: string): DeliveryContext {
  return { turnId: "", messageId: eventId, segmentIndex: 0, segmentTotal: 0 };
}

function pacedDelay(segment: readonly Element[], pacing: PacingConfig, elapsed: number): number {
  const characters = segment.reduce((total, element) => total + elementTextLength(element), 0);
  const delay = Math.min(Math.max(250, Math.ceil((characters / pacing.charactersPerSecond) * 1000)), 10_000);
  return elapsed + delay >= pacing.maxTotalDelayMs ? 250 : Math.round(delay);
}

function elementTextLength(element: Element): number {
  return (
    (typeof element.attrs.content === "string" ? element.attrs.content.length : 0) +
    element.children.reduce((total, child) => total + elementTextLength(child), 0)
  );
}

function sleep(timeout: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = (
    Promise as PromiseConstructor & { withResolvers<T>(): { promise: Promise<T>; resolve: (value?: T | PromiseLike<T>) => void } }
  ).withResolvers<void>();
  let timer: NodeJS.Timeout;
  const finish = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", finish);
    resolve();
  };
  timer = setTimeout(finish, timeout);
  signal.addEventListener("abort", finish, { once: true });
  return promise;
}
