import type { Context, Logger, Session } from "koishi";
import { Universal } from "koishi";

import { AdmissionThrottle } from "../channels/index.js";
import { assembleEvent, type EventRecord, type MessageRecord, type RecordBase } from "../messages/index.js";
import type { Translator } from "../messengers/index.js";
import type { ChannelResources } from "../resources/index.js";
import { translateOneBotMessage } from "./onebot.js";

declare module "../messages/index.js" {
  interface EventMap {
    /** 群友/好友戳一戳（拍一拍）。`targetId` 是被拍的人。 */
    "notice.reaction": {
      /** 被贴表情的那条消息 id（不是人）。旧名 targetId 语义有坑，已改名。 */
      messageId: string;
      emoji: string;
      added: boolean;
      operatorId: string;
    };
  }
}

/**
 * Milky 平台翻译器。
 *
 * 默认的 `translateDefault` 只认 `message-created`，会把 Milky 已经解析好的
 * 拍一拍（`notice`/`poke`）和贴表情（`reaction-added`）整条丢掉。
 * 这里把这两类转成 `EventRecord`：
 *   - 事件会被 `persist()` 记进上下文，所以诗音「看得见」；
 *   - 只有拍到自己时 `will-policy` 才会 trigger，其余的 decide 返回 wait，
 *     不会因为群里互相贴表情而把回复刷爆。
 */
export class MilkyTranslator implements Translator {
  public readonly platform = "milky";

  private readonly logger: Logger;
  /** 缺 channelId 的日志节流：同一平台同一原因 5 分钟一条 */
  private readonly admission = new AdmissionThrottle();

  public constructor(private readonly ctx: Context) {
    this.logger = ctx.logger("yesimbot.milky");
  }

  public async translate(
    session: Session,
    resources: ChannelResources,
  ): Promise<MessageRecord | EventRecord | null> {
    const base = recordBase(session);
    if (!base) {
      // 旧实现直接 return null：这条会话连频道都归不了档，等于凭空消失
      this.logAdmission(session);
      return null;
    }

    const event = translateMilkyEvent(base, session);
    if (event) return event;

    return translateOneBotMessage(this.ctx, base, session, resources);
  }

  /**
   * 「缺 channelId」按 info 记：好友申请、部分 notice 本来就没有频道，
   * 频繁出现说明适配器字段变了，而不是每条都是事故。
   */
  private logAdmission(session: Session): void {
    try {
      const reason = session.channelId ? "unknown_record_base_failure" : "missing_channel_id";
      const key = `admission.milky_no_channel|${session.platform}|${session.channelId ?? ""}|${reason}`;
      const { allowed, suppressed } = this.admission.allow(key);
      if (!allowed) return;
      this.logger.info({
        code: "admission.milky_no_channel",
        platform: session.platform,
        channelId: session.channelId ?? "",
        selfId: session.selfId,
        type: session.type,
        reason,
        ...(suppressed > 0 ? { suppressedSinceLastLog: suppressed } : {}),
      });
    } catch {
      // 日志失败不影响消息翻译
    }
  }
}

export function translateMilkyEvent(base: RecordBase, session: Session): EventRecord | null {
  const { event } = session;

  // 拍一拍：只认显式 subtype，避免将来任何 notice 分支都被当成拍一拍
  if (session.type === "notice" && session.subtype === "poke") {
    const raw = (event._data ?? {}) as Record<string, unknown>;
    const action =
      typeof raw.display_action === "string" && raw.display_action.trim()
        ? raw.display_action.trim()
        : "拍了拍";
    const suffix = typeof raw.display_suffix === "string" ? raw.display_suffix : "";

    // friend_nudge 协议里没有「被戳者」字段，只有两个布尔：
    //   is_self_send=true    → 自己戳好友，不该让她回复
    //   is_self_receive=true → 好友戳自己，这才是要响应的
    // 绝不能再用 `receiver_id ?? user_id` 兜底，那会把被戳者算成好友。
    const isFriend = raw.sender_id === undefined && raw.user_id !== undefined;
    if (isFriend) {
      if (raw.is_self_send === true) return null;
      const selfId = String(base.selfId ?? "");
      const peer = String(raw.user_id ?? "");
      if (!selfId || !peer) return null;
      const toSelf = raw.is_self_receive === true;
      const targetId = toSelf ? selfId : peer;
      return assembleEvent<"notice.poke">(base, {
        eventType: "notice.poke",
        targetId,
        action,
        text: `${peer} ${action} ${toSelf ? "诗音" : peer}${suffix}`,
      });
    }

    // 群聊（group_nudge）：sender_id 拍 receiver_id
    const senderId = String(raw.sender_id ?? "");
    const targetId = String(raw.receiver_id ?? "");
    if (!targetId) return null;
    return assembleEvent<"notice.poke">(base, {
      eventType: "notice.poke",
      targetId,
      action,
      text: `${senderId} ${action} ${targetId}${suffix}`,
    });
  }

  // 贴表情：只收「新增」，删表情是纯噪声
  if (session.type === "reaction-added") {
    const raw = (event.emoji ?? {}) as { id?: string };
    const emoji = String(raw.id ?? "");
    const operatorId = String(session.userId ?? "");
    const messageId = String(session.messageId ?? "");
    if (!emoji) return null;
    if (!shouldRecordReaction(operatorId, messageId, emoji)) return null;
    return assembleEvent<"notice.reaction">(base, {
      eventType: "notice.reaction",
      text: `${operatorId} 给消息 ${messageId} 贴了表情 ${emoji}`,
      messageId,
      emoji,
      added: true,
      operatorId,
    });
  }

  return null;
}

/** 同一个 (人, 消息, 表情) 60 秒内只记一次，防群里连点刷上下文。 */
const RECENT_REACTIONS = new Map<string, number>();
const REACTION_DEDUPE_MS = 60_000;
const REACTION_MAP_LIMIT = 500;

function shouldRecordReaction(operatorId: string, messageId: string, emoji: string): boolean {
  const now = Date.now();
  if (RECENT_REACTIONS.size > REACTION_MAP_LIMIT) {
    for (const [k, ts] of RECENT_REACTIONS) {
      if (now - ts > REACTION_DEDUPE_MS) RECENT_REACTIONS.delete(k);
    }
  }
  const key = `${operatorId}|${messageId}|${emoji}`;
  const last = RECENT_REACTIONS.get(key);
  if (last !== undefined && now - last < REACTION_DEDUPE_MS) return false;
  RECENT_REACTIONS.set(key, now);
  return true;
}

function recordBase(session: Session): RecordBase | null {
  if (!session.channelId) return null;
  return {
    platform: session.platform,
    selfId: session.selfId,
    timestamp: session.timestamp,
    channel: {
      id: session.channelId,
      type:
        session.event.channel?.type ??
        (session.isDirect ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT),
      ...(session.event.channel?.name === undefined ? {} : { name: session.event.channel.name }),
    },
    user: {
      id: session.userId || session.event.user?.id || session.author?.id || "",
      ...((session.event.user?.name ?? session.author?.name) === undefined
        ? {}
        : { name: session.event.user?.name ?? session.author?.name }),
    },
  };
}
