import type { TurnResult } from "@yesimbot/agent-runtime";
import type { Element, Logger } from "koishi";
import { isMessage, type ChannelContext, type Event, type Message, type NudgeOptions, type WillEngine, type WillState } from "koishi-plugin-yesimbot";

import { DeepSeekJudge } from "./deepseek-judge.js";
import { hasQuote, mentionKind } from "./message-context.js";
import type { PolicySmartBatchConfig, SmartBatchPreset } from "./types.js";

interface PendingMessageItem {
  readonly shortId: string;
  readonly realMsgId: string;
  readonly compactLine: string;
  readonly cleanText: string;
  readonly isNoiseRepeat: boolean;
  readonly userId?: string;
  /** 是否冲着自己来（@自己 / 引用自己 / 命中唤醒词），兜底判定用，与 config 开关无关 */
  readonly addressed?: boolean;
  /** 已被判定器评估过的次数（用于「同一批只重试一次」） */
  readonly attempts?: number;
  /** nudge 失败后回池的次数（用于避免无限回池） */
  readonly nudgeFailures?: number;
}

/** 同人追问窗口时长：沿用 45s。 */
const FOLLOW_UP_WINDOW_MS = 45_000;
/** 追问窗口硬上限：连续续期 3 次后强制关闭一次，让判定器重新裁决。 */
const FOLLOW_UP_MAX_RENEWALS = 3;
/** 瞬时失败重试的短退避（<500ms，避免一批消息失去时效）。 */
const RETRY_BACKOFF_MS = 400;
/** nudge 失败回池后的重跑延迟。 */
const NUDGE_RETRY_DELAY_MS = 4_000;
/** nudge 连续失败回池上限，超过就归档（有日志，不静默）。 */
const MAX_NUDGE_REQUEUE = 2;
/** runtime 重建后，迁移过来的旧池在多久之后补跑一次。 */
const MIGRATED_FLUSH_DELAY_MS = 1_000;

export class PolicySmartBatchEngine implements WillEngine {
  private readonly judge: DeepSeekJudge;
  private readonly preset: SmartBatchPreset;
  private readonly scopeKey: string;
  private pendingItems: PendingMessageItem[] = [];
  private msgSeq = 0;
  private effectiveCount = 0;
  private effectiveMinBatch = 1;
  private lastMessageAt: number | null = null;
  private cooldownUntil = 0;
  private lastPokeKey: string | null = null;
  private lastPokeAt = 0;

  /** 拍一拍冷却与同人去重：同一个人在 5 秒内连戳只认一次，其余静默丢弃。 */
  private isPokeAllowed(input: Event): boolean {
    const now = Date.now();
    if (now < this.cooldownUntil) return false;
    const data = (input.data ?? {}) as Record<string, unknown>;
    const key = `${String(data.channelId ?? "")}|${String(data.userId ?? "")}`;
    if (key === this.lastPokeKey && now - this.lastPokeAt < 5_000) return false;
    this.lastPokeKey = key;
    this.lastPokeAt = now;
    return true;
  }
  private debounceTimer: NodeJS.Timeout | undefined;
  private maxWaitTimer: NodeJS.Timeout | undefined;
  private cooldownTimer: NodeJS.Timeout | undefined;
  private nudgeRetryTimer: NodeJS.Timeout | undefined;
  private deferredFlushTimer: NodeJS.Timeout | undefined;
  private migratedFlushTimer: NodeJS.Timeout | undefined;
  private recentTexts: string[] = [];
  private recentBotMsgIds = new Set<string>();
  private lastBotReplyAt = 0;
  private lastBotActiveUserId = "";
  /** 追问窗口连续续期次数（硬上限 FOLLOW_UP_MAX_RENEWALS） */
  private followUpRenewals = 0;
  /** 追问窗口被强制关闭后的静默期，避免下一条消息立刻把窗口重新续上 */
  private followUpSuppressedUntil = 0;
  /** 评估中又收到 flush 请求时，记下原因，本轮结束后重跑 */
  private pendingFlushReason: string | null = null;
  private stopped = false;
  private evaluating = false;

  public constructor(
    private readonly scope: ChannelContext,
    private readonly config: PolicySmartBatchConfig,
    private readonly logger: Logger,
    private readonly nudgeFn: (options?: NudgeOptions) => Promise<boolean>,
    private readonly onBotDelivered?: (cb: (msgId: string, text?: string) => void) => () => void,
  ) {
    this.scopeKey = `${scope.platform}:${scope.channelId}`;
    this.preset = this.resolvePreset();
    this.effectiveMinBatch = this.preset.minBatchSize;
    this.judge = new DeepSeekJudge(
      this.scopeKey,
      {
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
      },
      logger,
    );
    if (this.onBotDelivered) {
      this.disposeDelivered = this.onBotDelivered((msgId, text) => {
        this.lastBotReplyAt = Date.now();
        if (text && text.trim()) {
          const cleanBot = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
          if (cleanBot) {
            this.judge.recordSilentBatch([`[诗音(我)]: ${cleanBot}`], "bot_reply");
          }
        }
        if (!msgId) return;
        this.recentBotMsgIds.add(msgId);
        if (this.recentBotMsgIds.size > 50) {
          const first = this.recentBotMsgIds.values().next().value;
          if (first !== undefined) this.recentBotMsgIds.delete(first);
        }
      });
    }
  }

  private disposeDelivered?: () => void;

  private resolvePreset(): SmartBatchPreset {
    const override = this.config.channelOverrides?.find((o) => o.channelId === this.scope.channelId);
    const kind = override?.preset ?? this.config.defaultPreset ?? "small";
    return kind === "large" ? this.config.largePreset : this.config.smallPreset;
  }

  public stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.pendingFlushReason = null;
    this.disposeDelivered?.();
    this.disposeDelivered = undefined;
  }

  private clearTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = undefined;
    }
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = undefined;
    }
    if (this.nudgeRetryTimer) {
      clearTimeout(this.nudgeRetryTimer);
      this.nudgeRetryTimer = undefined;
    }
    if (this.deferredFlushTimer) {
      clearTimeout(this.deferredFlushTimer);
      this.deferredFlushTimer = undefined;
    }
    if (this.migratedFlushTimer) {
      clearTimeout(this.migratedFlushTimer);
      this.migratedFlushTimer = undefined;
    }
  }

  /**
   * runtime 重建时把旧 engine 的状态迁到新 engine（旧池、冷却、追问窗口、去重集合）。
   * 迁移后旧池会在 MIGRATED_FLUSH_DELAY_MS 后补跑一次，避免「重建即丢池、旧池永不 flush」。
   * 调用方随后必须 stop() 旧 engine，否则旧定时器与 delivered 监听会泄漏。
   */
  public adoptStateFrom(previous: PolicySmartBatchEngine): {
    pending: number;
    cooldownRemainMs: number;
    lastBotReplyAgoMs: number | null;
    previousEvaluating: boolean;
  } {
    this.pendingItems = previous.pendingItems.map((item) => ({ ...item }));
    previous.pendingItems = [];
    this.msgSeq = previous.msgSeq;
    this.effectiveCount = previous.effectiveCount;
    this.effectiveMinBatch = previous.effectiveMinBatch;
    this.lastMessageAt = previous.lastMessageAt;
    this.cooldownUntil = previous.cooldownUntil;
    this.lastBotReplyAt = previous.lastBotReplyAt;
    this.lastBotActiveUserId = previous.lastBotActiveUserId;
    this.followUpRenewals = previous.followUpRenewals;
    this.followUpSuppressedUntil = previous.followUpSuppressedUntil;
    this.recentTexts = [...previous.recentTexts];
    this.recentBotMsgIds = new Set(previous.recentBotMsgIds);
    this.lastPokeKey = previous.lastPokeKey;
    this.lastPokeAt = previous.lastPokeAt;

    const pending = this.pendingItems.length;
    if (pending > 0) {
      if (this.migratedFlushTimer) clearTimeout(this.migratedFlushTimer);
      this.migratedFlushTimer = setTimeout(() => {
        this.migratedFlushTimer = undefined;
        if (this.stopped) return;
        void this.flushAndEvaluate("migrated");
      }, MIGRATED_FLUSH_DELAY_MS);
    }

    const now = Date.now();
    return {
      pending,
      cooldownRemainMs: Math.max(0, this.cooldownUntil - now),
      lastBotReplyAgoMs: this.lastBotReplyAt > 0 ? now - this.lastBotReplyAt : null,
      previousEvaluating: previous.evaluating,
    };
  }

  public async observe(_result: TurnResult): Promise<void> {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + this.preset.cooldownSeconds * 1000);
  }

  public async decide(input: Message | Event, state: WillState): Promise<"wait" | "trigger"> {
    if (this.stopped) return "wait";

    // L0-A: 私聊 VIP 直通
    if (this.scope.type === "direct" || this.scope.channelId.startsWith("private:")) {
      if (this.config.directForce && isMessage(input)) {
        return "trigger";
      }
    }

    // 处理拍一拍事件
    if (!isMessage(input)) {
      if (this.config.pokeForce && isPokeToSelf(input) && this.isPokeAllowed(input)) {
        this.flushPendingAsSilent("vip_poke");
        this.cooldownUntil = Date.now() + this.preset.cooldownSeconds * 1000;
        return "trigger";
      }
      return "wait";
    }

    const now = Date.now();
    const silenceMs = this.lastMessageAt === null ? Infinity : now - this.lastMessageAt;
    const isColdStart = silenceMs >= this.preset.longSilenceMinutes * 60_000;
    this.lastMessageAt = now;

    const item = this.buildItem(input);

    // L0-B: 群聊强唤醒 (@self / 引用诗音 / 命中唤醒词 / 刚跟诗音对话 45s 内的同人追问)
    const withinFollowUpWindow =
      this.lastBotReplyAt > 0 &&
      now - this.lastBotReplyAt <= FOLLOW_UP_WINDOW_MS &&
      input.data.user.id === this.lastBotActiveUserId &&
      !input.data.elements?.some((el) => el.type === "at" && String(el.attrs?.id ?? "") !== "" && String(el.attrs?.id ?? "") !== input.data.selfId);
    // 硬上限：窗口连续续期 3 次就强制关闭一次，否则用户持续发言时窗口永不到期、判定器永远拿不到裁决权
    const followUpCapped =
      withinFollowUpWindow && (this.followUpRenewals >= FOLLOW_UP_MAX_RENEWALS || now < this.followUpSuppressedUntil);
    if (followUpCapped) {
      if (now >= this.followUpSuppressedUntil) {
        this.followUpSuppressedUntil = now + FOLLOW_UP_WINDOW_MS;
        this.logger.info("smart_batch.followup_capped", {
          channelId: this.scope.channelId,
          userId: input.data.user.id,
          renewals: this.followUpRenewals,
          suppressedMs: FOLLOW_UP_WINDOW_MS,
        });
      }
      this.followUpRenewals = 0;
    } else if (!withinFollowUpWindow) {
      this.followUpRenewals = 0;
      this.followUpSuppressedUntil = 0;
    }
    const isFollowUpWindow = withinFollowUpWindow && !followUpCapped;
    if (this.isVipMessage(input, item.cleanText) || isFollowUpWindow) {
      if (isFollowUpWindow) this.followUpRenewals++;
      this.lastBotActiveUserId = input.data.user.id;
      this.lastBotReplyAt = now;
      this.pendingItems.push(item);
      this.flushPendingAsSilent(isFollowUpWindow ? "vip_followup" : "vip_direct");
      this.cooldownUntil = now + (isFollowUpWindow ? 4_000 : this.preset.cooldownSeconds * 1000);
      this.logger.debug("smart_batch.vip_trigger", {
        channelId: this.scope.channelId,
        messageId: input.data.messageId,
        isFollowUpWindow,
        followUpRenewals: this.followUpRenewals,
      });
      return "trigger";
    }

    // 记入蓄水池
    if (this.pendingItems.length === 0) {
      this.effectiveMinBatch = isColdStart ? 1 : this.preset.minBatchSize;
    }
    this.pendingItems.push(item);
    if (!item.isNoiseRepeat) {
      this.effectiveCount++;
    }

    // 硬冷却锁或正在回复中：只静默记入背景，待冷却结束后评估剩余新消息
    if (state.activeTurnId !== null || now < this.cooldownUntil) {
      this.scheduleCooldownFlush(now);
      return "wait";
    }

    // 攒满 maxBatchSize 立即触发评估
    if (this.pendingItems.length >= this.preset.maxBatchSize) {
      this.clearTimers();
      void this.flushAndEvaluate("max_batch");
      return "wait";
    }

    // 若不是无意义复读，则设置/重置防抖定时器
    if (!item.isNoiseRepeat) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        void this.flushAndEvaluate("debounce");
      }, this.preset.debounceSeconds * 1000);
    }

    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        this.maxWaitTimer = undefined;
        void this.flushAndEvaluate("max_wait");
      }, this.preset.maxWaitSeconds * 1000);
    }

    return "wait";
  }

  private scheduleCooldownFlush(now: number): void {
    if (this.cooldownTimer || this.stopped) return;
    const waitMs = Math.max(500, this.cooldownUntil - now + 200);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = undefined;
      if (this.stopped || this.pendingItems.length === 0) return;
      void this.flushAndEvaluate("after_cooldown");
    }, waitMs);
  }

  private flushPendingAsSilent(reason: string): void {
    this.clearTimers();
    if (this.pendingItems.length === 0) return;
    const lines = this.pendingItems.map((i) => i.compactLine);
    this.pendingItems = [];
    this.effectiveCount = 0;
    this.effectiveMinBatch = this.preset.minBatchSize;
    this.judge.recordSilentBatch(lines, reason);
  }

  private async flushAndEvaluate(reason: string): Promise<void> {
    if (this.stopped || this.pendingItems.length === 0) return;
    if (this.evaluating) {
      // 评估进行中被触发的 flush：排队到本轮结束后重跑，不静默丢弃
      this.pendingFlushReason = reason;
      this.logger.debug("smart_batch.flush_deferred", {
        channelId: this.scope.channelId,
        reason,
        pending: this.pendingItems.length,
      });
      return;
    }
    this.clearTimers();

    const batch = this.pendingItems.splice(0, this.pendingItems.length);
    const effCount = this.effectiveCount;
    const reqMin = this.effectiveMinBatch;
    this.effectiveCount = 0;
    this.effectiveMinBatch = this.preset.minBatchSize;

    const lines = batch.map((b) => b.compactLine);
    const attempts = Math.max(0, ...batch.map((b) => b.attempts ?? 0));

    // 若到期时有效水位仍不足 effectiveMinBatch（例如大群零星 1~2 句后冷场或纯复读），静默归档不调 API
    if (effCount < reqMin) {
      this.judge.recordSilentBatch(lines, "low_water");
      this.logger.debug("smart_batch.silent_archive", {
        channelId: this.scope.channelId,
        reason,
        effCount,
        reqMin,
      });
      return;
    }

    this.evaluating = true;
    try {
      // 同一批最多重试一次：已重试过的批次以 final=true 调用，失败即走规则兜底
      const decision = await this.judge.evaluate(lines, { final: attempts >= 1 });
      this.logger.info("smart_batch.judge", {
        channelId: this.scope.channelId,
        reason,
        batchSize: batch.length,
        attempt: attempts + 1,
        a: decision.a,
        s: decision.s,
        id: decision.id,
        g: decision.g,
        m: decision.m,
        h: decision.h,
        latencyMs: decision.latencyMs,
        cacheHit: decision.cacheHitTokens,
        cacheMiss: decision.cacheMissTokens,
        degraded: decision.degraded === true,
        degradedReason: decision.degradedReason,
        failureKind: decision.failureKind,
      });

      // 瞬时失败：不判死。退回蓄水池，短退避后重跑一次（attempts 记录在同一批上，只重试一次）
      if (decision.retryable) {
        this.requeueBatch(
          batch.map((b) => ({ ...b, attempts: (b.attempts ?? 0) + 1 })),
          effCount,
          reqMin,
          RETRY_BACKOFF_MS,
          "retry_transient",
        );
        this.logger.warn("smart_batch.judge_retry", {
          channelId: this.scope.channelId,
          reason,
          batchSize: batch.length,
          attempt: attempts + 1,
          degradedReason: decision.degradedReason,
          latencyMs: decision.latencyMs,
          backoffMs: RETRY_BACKOFF_MS,
        });
        return;
      }

      if (this.stopped) {
        // 引擎已停：把这一批交回历史，别让它凭空消失
        this.judge.recordSilentBatch(lines, "stopped");
        this.logger.warn("smart_batch.dropped_stopped", {
          channelId: this.scope.channelId,
          reason,
          batchSize: batch.length,
        });
        return;
      }

      const addressed = batch.some((b) => b.addressed === true);
      const speakByModel = decision.degraded !== true && decision.a === 1 && decision.s >= this.config.scoreThreshold;
      // 规则兜底：判定器降级（配置类失败 / 重试后仍失败）时，@自己、引用自己、唤醒词直接开口，其余 wait
      const speakByFallback = decision.degraded === true && addressed;
      if (decision.degraded === true) {
        this.logger.warn("smart_batch.degraded_fallback", {
          channelId: this.scope.channelId,
          reason,
          batchSize: batch.length,
          degradedReason: decision.degradedReason,
          failureKind: decision.failureKind,
          addressed,
          speak: speakByFallback,
          latencyMs: decision.latencyMs,
        });
      }

      if (speakByModel || speakByFallback) {
        const matched =
          (speakByModel ? batch.find((b) => b.shortId === decision.id) : undefined) ??
          batch.find((b) => b.addressed) ??
          batch.at(-1)!;
        const targetRealMsgId = matched.realMsgId;
        const gateName = speakByModel ? (decision.g === 1 ? "comfort" : decision.g === 2 ? "work_delivery" : "casual") : "casual";
        const moveName = speakByModel ? decision.m || "random_chat" : "random_chat";
        const hookText = speakByModel ? decision.h || "自然接话" : "有人在直接找她，自然接一句";
        const nudgeHint = `<nudge_hint data-gate="${gateName}" data-move="${moveName}" data-target-id="${targetRealMsgId}">\n[潜意识切入参考] 可自然接话消息 id=${targetRealMsgId}（切入点：${hookText}），按平时短句风格随口接一句即可。\n</nudge_hint>`;

        // 乐观预扣冷却，挡住 await nudge 期间的重入；nudge 没成功就原样回滚
        const prevCooldownUntil = this.cooldownUntil;
        const prevLastBotReplyAt = this.lastBotReplyAt;
        this.cooldownUntil = Date.now() + this.preset.cooldownSeconds * 1000;
        this.lastBotReplyAt = Date.now();

        let nudged = false;
        try {
          nudged = await this.nudgeFn({ ifBusy: "reject", nudgeHint });
        } catch (cause) {
          this.logger.warn("smart_batch.nudge_threw", {
            channelId: this.scope.channelId,
            targetRealMsgId,
            message: cause instanceof Error ? cause.message : String(cause),
          });
          nudged = false;
        }

        this.logger.info("smart_batch.nudged", {
          channelId: this.scope.channelId,
          targetRealMsgId,
          gateName,
          moveName,
          hookText,
          nudged,
          speakBy: speakByModel ? "model" : "fallback",
        });

        if (nudged) {
          this.lastBotActiveUserId = matched.userId ?? this.lastBotActiveUserId;
          this.followUpRenewals = 0;
        } else {
          // 冷却回滚：没开口就不该扣冷却，这一批也不能丢
          this.cooldownUntil = prevCooldownUntil;
          this.lastBotReplyAt = prevLastBotReplyAt;
          const failures = Math.max(0, ...batch.map((b) => b.nudgeFailures ?? 0)) + 1;
          if (failures <= MAX_NUDGE_REQUEUE) {
            this.requeueBatch(
              batch.map((b) => ({ ...b, nudgeFailures: failures })),
              effCount,
              reqMin,
              NUDGE_RETRY_DELAY_MS,
              "retry_nudge",
            );
            this.logger.warn("smart_batch.nudge_requeued", {
              channelId: this.scope.channelId,
              reason,
              batchSize: batch.length,
              failures,
              delayMs: NUDGE_RETRY_DELAY_MS,
              cooldownRolledBack: true,
            });
          } else {
            this.judge.recordSilentBatch(lines, "nudge_fail");
            this.logger.warn("smart_batch.nudge_abandoned", {
              channelId: this.scope.channelId,
              reason,
              batchSize: batch.length,
              failures,
              cooldownRolledBack: true,
            });
          }
        }
      }
    } catch (cause) {
      // judge.evaluate 已自己兜住已知失败；这里兜住真正意外的异常，并把这一批归还，不静默丢
      this.logger.warn("smart_batch.flush_failed", {
        channelId: this.scope.channelId,
        reason,
        batchSize: batch.length,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      this.requeueBatch(batch, effCount, reqMin, NUDGE_RETRY_DELAY_MS, "retry_error");
    } finally {
      this.evaluating = false;
      this.runDeferredFlush();
    }
  }

  /** 把一批消息放回蓄水池队首并在 delayMs 后重跑；引擎已停则归档，绝不静默丢弃。 */
  private requeueBatch(
    items: PendingMessageItem[],
    effCount: number,
    reqMin: number,
    delayMs: number,
    reason: string,
  ): void {
    if (this.stopped) {
      this.judge.recordSilentBatch(
        items.map((b) => b.compactLine),
        "stopped",
      );
      this.logger.warn("smart_batch.requeue_stopped", {
        channelId: this.scope.channelId,
        reason,
        batchSize: items.length,
      });
      return;
    }
    this.pendingItems = [...items, ...this.pendingItems];
    this.effectiveCount += effCount;
    this.effectiveMinBatch = reqMin;
    if (this.nudgeRetryTimer) clearTimeout(this.nudgeRetryTimer);
    this.nudgeRetryTimer = setTimeout(() => {
      this.nudgeRetryTimer = undefined;
      void this.flushAndEvaluate(reason);
    }, delayMs);
  }

  /** 本轮评估结束后补跑被推迟的 flush。 */
  private runDeferredFlush(): void {
    const queued = this.pendingFlushReason;
    this.pendingFlushReason = null;
    if (!queued || this.stopped || this.pendingItems.length === 0) return;
    if (this.deferredFlushTimer) clearTimeout(this.deferredFlushTimer);
    this.deferredFlushTimer = setTimeout(() => {
      this.deferredFlushTimer = undefined;
      void this.flushAndEvaluate(queued);
    }, 0);
  }

  private buildItem(input: Message): PendingMessageItem {
    this.msgSeq = (this.msgSeq % 99) + 1;
    const shortId = `m${this.msgSeq}`;
    const realMsgId = input.data.messageId;
    const sender = (input.data.user.name || input.data.user.id || "群友").slice(0, 12);
    const { compact, clean } = compactElements(input.data.elements);

    const norm = clean.toLowerCase().trim();
    const isShort = norm.length <= 12;
    const repeatCount = norm ? this.recentTexts.filter((t) => t === norm).length : 0;
    const isNoiseRepeat = isShort && repeatCount >= 2; // 含当前第 3 条及以上相同短文本

    if (norm) {
      this.recentTexts.push(norm);
      if (this.recentTexts.length > 8) this.recentTexts.shift();
    }

    const compactLine = `[${shortId}] ${sender}: ${compact || "[空]"}`;
    return {
      shortId,
      realMsgId,
      compactLine,
      cleanText: clean,
      isNoiseRepeat,
      userId: input.data.user.id,
      addressed: this.isAddressedToSelf(input, clean),
      attempts: 0,
      nudgeFailures: 0,
    };
  }

  /** 是否冲着自己来（@自己 / 引用自己 / 命中唤醒词）。与 config 开关无关，供判定器降级时的规则兜底使用。 */
  private isAddressedToSelf(input: Message, cleanText: string): boolean {
    const { selfId, elements } = input.data;
    if (mentionKind(selfId, elements) === "self") return true;
    if (hasQuoteToSelf(selfId, elements, this.recentBotMsgIds)) return true;
    if (this.config.forceKeywords.length > 0 && cleanText) {
      const lower = cleanText.toLowerCase();
      for (const kw of this.config.forceKeywords) {
        if (kw && lower.includes(kw.toLowerCase())) return true;
      }
    }
    return false;
  }

  private isVipMessage(input: Message, cleanText: string): boolean {
    const { selfId, elements } = input.data;
    if (this.config.mentionForce && mentionKind(selfId, elements) === "self") {
      return true;
    }
    if (this.config.quoteForce && hasQuoteToSelf(selfId, elements, this.recentBotMsgIds)) {
      return true;
    }
    if (this.config.forceKeywords.length > 0 && cleanText) {
      const lower = cleanText.toLowerCase();
      for (const kw of this.config.forceKeywords) {
        if (kw && lower.includes(kw.toLowerCase())) return true;
      }
    }
    return false;
  }
}

function hasQuoteToSelf(selfId: string, elements: readonly Element[] | undefined, recentBotMsgIds: Set<string>): boolean {
  if (!hasQuote(elements)) return false;
  for (const el of elements ?? []) {
    if (el.type !== "quote" && el.type !== "reply") continue;
    const attrs = el.attrs ?? {};
    const uid = String(attrs.userId ?? (attrs.user as { id?: unknown } | undefined)?.id ?? attrs.authorId ?? "");
    if (uid && uid === selfId) return true;
    const qId = String(attrs.id ?? attrs.messageId ?? "");
    if (qId && recentBotMsgIds.has(qId)) return true;
    for (const child of el.children ?? []) {
      if (child.type === "author" && String(child.attrs?.id ?? child.attrs?.userId ?? "") === selfId) {
        return true;
      }
    }
  }
  return false;
}

function isPokeToSelf(input: Event): boolean {
  if (input.role !== "custom" || input.type !== "yesimbot.event") return false;
  const data = input.data as Record<string, unknown>;
  if (data.eventType !== "notice.poke") return false;
  // 空 targetId 视为无法判定，不再默认算「拍到自己」
  const targetId = String(data.targetId ?? data.userId ?? "");
  return targetId !== "" && targetId === String(data.selfId ?? "");
}

function compactElements(elements: readonly Element[] | undefined): { compact: string; clean: string } {
  if (!elements || elements.length === 0) return { compact: "", clean: "" };
  const parts: string[] = [];
  const cleanParts: string[] = [];
  for (const el of elements) {
    if (el.type === "text") {
      const c = String(el.attrs?.content ?? "")
        .replace(/https?:\/\/\S+/gi, "[链接]")
        .replace(/\s+/g, " ")
        .trim();
      if (c) {
        parts.push(c);
        cleanParts.push(c);
      }
    } else if (el.type === "img" || el.type === "image") {
      parts.push("[图]");
    } else if (el.type === "face" || el.type === "mface" || el.type === "sticker") {
      parts.push("[表情]");
    } else if (el.type === "at") {
      const name = String(el.attrs?.name ?? el.attrs?.id ?? "某人");
      parts.push(`@${name}`);
    } else if (el.type === "quote" || el.type === "reply") {
      parts.push("[引用]");
    } else if (el.type === "file") {
      const title = String(el.attrs?.title ?? el.attrs?.name ?? "文件");
      parts.push(`[文件:${title}]`);
      cleanParts.push(`[文件:${title}]`);
    }
  }
  const compact = parts.join(" ").trim().slice(0, 80);
  const clean = cleanParts.join(" ").trim().slice(0, 120);
  return { compact, clean };
}
