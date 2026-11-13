import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

import { type Bot, type Context, Service } from "koishi";

import { Agents } from "./agents/index.js";
import { Channels } from "./channels/index.js";
import { registerSessionCommands } from "./commands/index.js";
import { Config } from "./config.js";
import { type EventRecord } from "./messages/index.js";
import { Messenger } from "./messengers/index.js";
import { ModelService } from "./models/index.js";
import {
  createJsonFileStore,
  fallbackText,
  listenOrDegrade,
  NotifyDispatcher,
  type NotifyHandlers,
  type NotifyRecord,
} from "./notify/index.js";
import { registerPlatforms } from "./platforms/index.js";
import type { Resources } from "./resources/index.js";
import { Runtimes } from "./runtimes/index.js";
import { ensureAgentsFile, ensureDefaultPersona } from "./runtimes/prompt.js";

/**
 * ── 投递失败原因标记（对齐 hub 的四态判定）───────────────────────────────
 *
 * hub（`worker_im_bus.py`）判定一次播报只读两处：
 *   1. `_classify_notify_response(status, body)`：HTTP 状态码 + body 里的
 *      `produced_message` / `delivered_to_chat` / `accepted` / `delivery_id` /
 *      `status_url` / `state` / `error` / `last_error` / `message` / `detail` / `reason` / `ok`；
 *   2. `_poll_notify_status()`：status_url 返回的 `produced_message` / `state` / `error` / `last_error`。
 * 非 2xx 时它把 `HTTP {code}: {body 前 200 字}` 连同上面的错误字段一起记进
 * `effects_outbox.last_error`，再拿这段文本去撞 `is_permanent_delivery_error`。
 *
 * 也就是说：**能区分「端口不通」和「对端拒收」的信息，只存在于这些字段的文本里**。
 * 所以这里给出两台机器都能读的稳定词素：
 *   unreachable   —— 连接层根本没通（ECONNREFUSED / ConnectTimeout / 适配器没连上平台）
 *   peer_degraded —— 对端活着但拒收/降级（通知子系统 degraded、纯文本兜底被关）
 * 其它失败保持原样，避免给 hub 制造新的误判。
 */
export type DeliveryFailureMarker = "unreachable" | "peer_degraded";

const UNREACHABLE_PATTERN =
  /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ConnectTimeout|connect timeout|connection refused|socket hang up|fetch failed|network error|not connected|disconnected|no-bot-online|no bot is available|websocket.*(?:closed|error)/i;

const PEER_DEGRADED_PATTERN = /degraded|notify-dispatcher-unavailable|plain fallback|fallback disabled/i;

export function classifyDeliveryFailure(text: string): DeliveryFailureMarker | undefined {
  const value = String(text ?? "").trim();
  if (!value) return undefined;
  // 先判 unreachable：连接层失败比「对端说降级」更具体，也更接近运维要先动手的地方
  if (UNREACHABLE_PATTERN.test(value)) return "unreachable";
  if (PEER_DEGRADED_PATTERN.test(value)) return "peer_degraded";
  return undefined;
}

/** 把标记写进文本前缀：hub 存的就是这段字符串，人也能一眼看出是哪一类。 */
export function markDeliveryFailure(text: string, hint?: DeliveryFailureMarker): string {
  const value = String(text ?? "");
  const marker = hint ?? classifyDeliveryFailure(value);
  if (!marker) return value;
  return value.startsWith(`${marker}:`) ? value : `${marker}: ${value}`;
}


export default class YesImBotService extends Service<Config> {
  public static readonly name = "yesimbot";
  public static readonly usage = ``;
  public static readonly inject = ["database"];
  public static readonly Config = Config;

  public readonly model: ModelService;
  public readonly messenger: Pick<Messenger, "use" | "post" | "nudge">;
  public readonly agent: Pick<Agents, "use" | "will">;
  public readonly resource: Resources;

  private readonly channels: Channels;
  private readonly runtimes: Runtimes;
  private readonly messengerOwner: Messenger;
  private readonly commandDisposer: () => void;
  private platformDisposer: (() => void) | undefined;
  private notifyServer: Server | undefined;
  private notifyDispatcher: NotifyDispatcher | undefined;
  private notifyStatus: "listening" | "degraded" | "stopped" = "stopped";
  private notifyError: string | undefined;

  public constructor(ctx: Context, config: Config) {
    ctx.scope.update;
    super(ctx, "yesimbot");
    config = Config(config ?? {}) as Config;
    this.config = config;
    this.logger.level = config.logLevel ?? 2;
    this.model = new ModelService(ctx, { basePath: config.basePath, logLevel: config.logLevel });
    this.channels = new Channels(ctx, {
      basePath: config.basePath || ctx.baseDir,
      logLevel: config.logLevel,
      imageInput: config.imageInput,
      readTimeoutMs: config.resourceReadTimeout * 1000,
      compactConfig: { minMessages: config.session.compact.minMessages, maxFailures: config.session.compact.maxFailures },
    });
    const agentsLogger = ctx.logger("yesimbot.agents");
    agentsLogger.level = config.logLevel ?? 2;
    const agents = new Agents(ctx);
    this.runtimes = new Runtimes(ctx, this.channels, this.model, config, agents);
    this.messengerOwner = new Messenger(ctx, config, this.channels, this.runtimes);
    this.messenger = this.messengerOwner;
    this.agent = agents;
    this.resource = this.channels;
    this.commandDisposer = registerSessionCommands(ctx, this.runtimes, { authority: 4 });
  }

  public override async start(): Promise<void> {
    await this.channels.start();
    const promptBasePath = resolve(this.ctx.baseDir, this.config.basePath || this.ctx.baseDir);
    await ensureDefaultPersona(promptBasePath);
    await ensureAgentsFile(promptBasePath);
    this.platformDisposer = registerPlatforms(this.ctx, this.messengerOwner);
    await this.startWorkerNotifyServer();
    this.startNotifyDispatcher();
  }

  public override async stop(): Promise<void> {
    this.notifyDispatcher?.stop();
    this.notifyDispatcher = undefined;
    if (this.notifyServer) {
      const srv = this.notifyServer;
      this.notifyServer = undefined;
      await new Promise<void>((resolveClose) => {
        // P1-8: close() 只停新连接；keep-alive / 半开连接会让 dispose 永久挂住，
        // 连带阻断后面的 messengerOwner.stop()。先关空闲连接，3s 后强制断开。
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveClose();
        };
        const timer = setTimeout(() => {
          this.logger.warn("internal worker-notify server close timed out, forcing connections shut");
          srv.closeAllConnections?.();
          done();
        }, 3000);
        timer.unref?.();
        srv.close(done);
        srv.closeIdleConnections?.();
      });
    }
    this.commandDisposer();
    this.platformDisposer?.();
    await this.messengerOwner.stop();
  }

  /**
   * P0-1：`listen` 失败时 Node **只发 error 事件、不回调 listening**。
   * 旧实现只打一条 warn，Promise 永不 settle → `start()` 永久挂起 → 整个进程静默。
   * 现在：把 error 转成 Promise reject，再由本方法决定策略。
   *
   * 策略 = 降级继续：通知服务不是「说话」的必要条件，为了一个辅助端口把整机拖垮
   * 是把偶发故障变成必然故障。降级后 hub 侧 outbox 的 delivered 保持 0，运维修好
   * 端口后会自动重投，不会丢稿、只是延迟。需要「通知必达」语义时设
   * `YESIMBOT_WORKER_NOTIFY_STRICT=1` 走 fail-fast。
   */
  private async startWorkerNotifyServer(): Promise<void> {
    if (this.notifyServer) return;
    const port = Number(process.env.YESIMBOT_WORKER_NOTIFY_PORT || 5141);
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void this.handleInternalRequest(req, res);
    });
    const result = await listenOrDegrade({
      server,
      port,
      host: "0.0.0.0",
      strict: process.env.YESIMBOT_WORKER_NOTIFY_STRICT === "1",
    }).catch((cause: unknown) => {
      this.logger.error("YESIMBOT_WORKER_NOTIFY_STRICT=1 -> failing startup instead of degrading");
      throw cause;
    });
    if (!result.listening) {
      this.notifyStatus = "degraded";
      this.notifyError = result.error;
      this.logger.error(
        "internal worker-notify server FAILED to listen on 0.0.0.0:%d (%s) — degraded: bot keeps talking, notifications stay undelivered for hub to retry",
        port,
        result.error,
      );
      return;
    }
    // 监听成功后的运行时错误（EMFILE、连接层异常）只记日志，不牵连主流程
    server.on("error", (err) => {
      this.logger.warn("internal worker-notify server error: %s", err instanceof Error ? err.message : String(err));
    });
    this.notifyServer = server;
    this.notifyStatus = "listening";
    this.notifyError = undefined;
    this.logger.info("Internal worker-notify HTTP server listening on 0.0.0.0:%d", port);
  }

  private startNotifyDispatcher(): void {
    if (this.notifyDispatcher) return;
    const basePath = resolve(this.ctx.baseDir, this.config.basePath || this.ctx.baseDir);
    const ledgerPath = resolve(basePath, "worker-notify-ledger.json");
    const dispatcher = new NotifyDispatcher({
      store: createJsonFileStore(ledgerPath),
      onEvent: (code, data) => this.logger.debug(code, data),
    });
    this.notifyDispatcher = dispatcher;
    if (!dispatcher.pendingRecords().length) return;
    // 适配器可能比本服务晚就绪：没有 bot 时投递必然失败并白白消耗一次重试，
    // 所以等 bot 出现再入队（最多等 60s）。
    let waited = 0;
    // 只认「platform + selfId 都已就绪」的 bot：适配器注册 bot 时 selfId 往往要等
    // getLogin 回来才有值，此前 messenger.post 会直接抛 No Bot is available，
    // 白烧一次尝试（旧实现就这样把一次真实播报降级成了纯文本兜底）。
    const ready = (record: NotifyRecord) =>
      this.ctx.bots.some((candidate) => candidate.platform === record.platform && candidate.selfId === record.selfId);
    const flush = () => {
      if (!this.notifyDispatcher) return;
      const pending = dispatcher.pendingRecords();
      if (!pending.length) return;
      const waiting = pending.filter((record) => !ready(record));
      if (waiting.length) {
        waited += 1;
        if (waited > 30) {
          this.logger.warn("worker-notify: bot not ready after 60s, keeping %d notification(s) queued on disk", waiting.length);
          return;
        }
        const timer = setTimeout(flush, 2000);
        timer.unref?.();
        return;
      }
      this.logger.info("worker-notify: re-queueing %d unfinished notification(s) from previous run", pending.length);
      for (const record of pending) {
        this.logger.debug("worker-notify.requeue", { deliveryId: record.deliveryId, ticketId: record.ticketId, attempts: record.attempts });
        dispatcher.run(record, this.notifyHandlers());
      }
    };
    flush();
  }

  private resolveBot(platform?: string, selfId?: string): Bot | undefined {
    const exact = this.ctx.bots.find(
      (candidate) => (!platform || candidate.platform === platform) && (!selfId || candidate.selfId === selfId),
    );
    if (exact) return exact;
    // selfId 对不上时退回同平台（用于兜底发送），但 platform 对不上就是不认——
    // 认了就会往一个根本不存在的平台写事件，等于把播报丢进黑洞。
    return platform ? this.ctx.bots.find((candidate) => candidate.platform === platform) : undefined;
  }

  /**
   * 两段式通知的执行体：先是完整模型回合（会真的说话），失败再退到纯文本兜底。
   * 返回值里的 produced/segments 决定账本状态，服务端据此对 hub 诚实回执。
   */
  private notifyHandlers(): NotifyHandlers {
    return {
      deliver: async (record) => {
        const bot = this.resolveBot(record.platform, record.selfId);
        if (!bot) return { produced: false, error: "no-bot-online" };
        const event = this.buildNotifyEvent(record);
        const outcome = await this.messengerOwner.post(event, { trigger: true, ifBusy: "defer" });
        return { produced: outcome.produced, segments: outcome.segments, error: outcome.error };
      },
      fallback: async (record) => {
        if (process.env.YESIMBOT_NOTIFY_PLAIN_FALLBACK === "0") return { produced: false, error: "plain fallback disabled" };
        const bot = this.resolveBot(record.platform, record.selfId);
        if (!bot) return { produced: false, error: "no-bot-online" };
        const text = fallbackText(record);
        if (!text) return { produced: false, error: "empty fallback text" };
        // 模型这一轮没产出（余额不足 / 502 / 超时）时，至少让群里收到工作结果原文，
        // 这是「永久丢稿」的最后一道闸；语义上等价于降级播报。
        await bot.sendMessage(record.channelId, text);
        return { produced: true, degraded: true, segments: 1 };
      },
    };
  }

  private buildNotifyEvent(record: NotifyRecord): EventRecord<"worker.im_notify"> & { user?: { id: string } } {
    const statusHint =
      record.status === "waiting"
        ? "（这件事卡在一个需要你拍板的点上：结合上下文自己决定，或顺着话题问问群友，然后用 shion-hub-im_worker_chat 把结论告诉我）"
        : record.status === "failed" || record.status === "blocked"
          ? "（这次没做成，用自然的口吻把结果说清楚，或者换个思路用 shion-hub-im_worker_chat 再试一次）"
          : "（做完了，用你自然的少女口吻跟群友/主人接话，别提工单号，也别问要不要关单）";
    const eventText = [
      `[我这边的工作有了结果 | 状态: ${record.status}]`,
      `进展：${record.text}`,
      record.artifacts.length
        ? `可引用成品：${record.artifacts.join(", ")}\n（这些是内部引用链接，供你之后调工具再次修改时用；绝对不要把它们发到聊天里。）`
        : "",
      statusHint,
    ]
      .filter(Boolean)
      .join("\n");
    const cleanPeerId = record.channelId.replace(/^(?:private|direct|group):/i, "");
    return {
      platform: record.platform,
      selfId: record.selfId,
      channel: { id: record.channelId, type: record.isDirect ? 1 : 0 },
      timestamp: Date.now(),
      eventType: "worker.im_notify",
      text: eventText,
      ticketId: record.ticketId,
      status: record.status,
      artifacts: [...record.artifacts],
      ...(record.isDirect ? { user: { id: cleanPeerId } } : {}),
    };
  }

  private authorized(req: IncomingMessage): boolean {
    const expectedToken = process.env.SHION_NOTIFY_TOKEN || "shion-internal-imbus-v2";
    const gotToken = String(req.headers["x-shion-notify-token"] ?? "");
    return !expectedToken || gotToken === expectedToken;
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  /**
   * 给投递回执补上失败标记。
   *
   * hub 的 `_poll_notify_status()` 只从 `error` / `last_error` 里取原因（取不到才退到
   * `_delivery_error_text`），所以标记必须同时出现在这两个字段里，并且额外给一个
   * 结构化的 `reason`，让将来的 hub 不必靠正则。
   */
  private decorateNotifyStatus(described: Record<string, unknown>): Record<string, unknown> {
    const raw = String(described.error ?? described.last_error ?? "").trim();
    if (!raw) return described;
    const marker = classifyDeliveryFailure(raw);
    if (!marker) return described;
    const marked = markDeliveryFailure(raw, marker);
    return { ...described, error: marked, last_error: marked, reason: marker };
  }

  private async handleInternalRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || "/";
    if (req.method === "GET" && url.startsWith("/internal/health")) {
      this.sendJson(res, 200, {
        ok: true,
        service: "yesimbot-worker-notify",
        notify: this.notifyStatus,
        // 与 hub 的四态词表对齐：本机监听失败 = 对端（hub 视角）将看到连接被拒
        notify_reason: this.notifyStatus === "degraded" ? "peer_degraded" : "ok",
        notify_error: this.notifyError,
        pending_notifications: this.notifyDispatcher?.pending ?? 0,
      });
      return;
    }

    if (req.method === "GET" && url.startsWith("/internal/worker-notify/status")) {
      try {
        if (!this.authorized(req)) {
          this.sendJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
        const dispatcher = this.notifyDispatcher;
        if (!dispatcher) {
          this.sendJson(res, 503, {
            ok: false,
            produced_message: false,
            retryable: true,
            reason: "peer_degraded",
            error: markDeliveryFailure("notify-dispatcher-unavailable", "peer_degraded"),
          });
          return;
        }
        const query = new URL(url, "http://127.0.0.1").searchParams;
        const deliveryId = (query.get("delivery_id") ?? "").trim();
        const ticketId = (query.get("ticket_id") ?? "").trim();
        const waitMs = Number(query.get("wait") ?? 0);
        if (deliveryId) {
          const record = waitMs > 0 ? await dispatcher.waitFor(deliveryId, waitMs) : dispatcher.get(deliveryId);
          if (!record) {
            this.sendJson(res, 404, { ok: false, error: "unknown delivery_id", delivery_id: deliveryId });
            return;
          }
          this.sendJson(res, 200, { ok: true, ...this.decorateNotifyStatus(dispatcher.describe(record)) });
          return;
        }
        if (ticketId) {
          const records = dispatcher.findByTicket(ticketId);
          this.sendJson(res, 200, {
            ok: true,
            ticket_id: ticketId,
            deliveries: records.map((record) => this.decorateNotifyStatus(dispatcher.describe(record))),
          });
          return;
        }
        this.sendJson(res, 400, { ok: false, error: "delivery_id or ticket_id is required" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn("Failed to handle /internal/worker-notify/status: %s", message);
        this.sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }

    if (req.method === "POST" && url.startsWith("/internal/worker-notify")) {
      try {
        if (!this.authorized(req)) {
          this.sendJson(res, 401, { ok: false, produced_message: false, error: "unauthorized" });
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of req) {
          const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          totalBytes += buf.length;
          if (totalBytes > 65536) {
            this.sendJson(res, 413, { ok: false, produced_message: false, error: "payload too large" });
            return;
          }
          chunks.push(buf);
        }
        const bodyRaw = Buffer.concat(chunks).toString("utf-8");
        const payload = JSON.parse(bodyRaw || "{}") as {
          platform?: string;
          self_id?: string;
          channel_id?: string;
          is_direct?: boolean;
          ticket_id?: string;
          status?: string;
          message_to_shion?: string;
          artifacts?: string[];
        };

        const rawChannelId = String(payload.channel_id ?? "").trim();
        if (!rawChannelId) {
          this.sendJson(res, 400, { ok: false, produced_message: false, error: "channel_id is required" });
          return;
        }

        const isDirect =
          typeof payload.is_direct === "boolean"
            ? payload.is_direct
            : rawChannelId.startsWith("private:") || rawChannelId.startsWith("direct:");
        const cleanPeerId = rawChannelId.replace(/^(?:private|direct|group):/i, "");
        const channelId = isDirect ? (rawChannelId.startsWith("private:") ? rawChannelId : `private:${cleanPeerId}`) : cleanPeerId;

        const requestedPlatform = String(payload.platform ?? "").trim();
        const requestedSelfId = String(payload.self_id ?? "").trim();
        const bot =
          this.resolveBot(requestedPlatform || undefined, requestedSelfId || undefined) ??
          (!requestedPlatform && !requestedSelfId ? this.ctx.bots[0] : undefined);
        const platform = requestedPlatform || bot?.platform || "milky";
        const selfId = requestedSelfId || bot?.selfId || "2690928435";
        const ticketId = String(payload.ticket_id || "");
        const status = String(payload.status || "delivered");
        const msgToShion = String(payload.message_to_shion || "").trim();
        const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts.map(String) : [];

        // 同步预检：bot 拿不到就是「现在肯定发不出去」，直接非 2xx 让 hub 保留 outbox
        // 等重投（旧实现这里回 200，等于主动吞掉这条播报）。
        if (!bot) {
          this.sendJson(res, 503, {
            ok: false,
            accepted: false,
            produced_message: false,
            retryable: true,
            // 端口/适配器这一层不通：hub 看到的是 unreachable，而不是「对端拒收」
            reason: "unreachable",
            error: markDeliveryFailure(`no-bot-online (platform=${platform || "?"} self_id=${selfId || "?"})`, "unreachable"),
            ticket_id: ticketId,
          });
          return;
        }

        const dispatcher = this.notifyDispatcher;
        if (!dispatcher) {
          this.sendJson(res, 503, {
            ok: false,
            accepted: false,
            produced_message: false,
            retryable: true,
            reason: "peer_degraded",
            error: markDeliveryFailure(`notify-dispatcher-unavailable (notify=${this.notifyStatus})`, "peer_degraded"),
            ticket_id: ticketId,
          });
          return;
        }

        // 幂等入账：同一 (ticket, status, channel, text) 的重投不会再播一次。
        const { record, duplicate } = dispatcher.accept({
          platform,
          selfId,
          channelId,
          isDirect,
          ticketId,
          status,
          messageToShion: msgToShion,
          artifacts,
        });

        // 立即回执（< 6s，远早于 hub 超时），但回执语义诚实：
        // accepted=「请求已收下」；produced_message=「是否真的说出口」，此刻通常还是 false，
        // 真值通过 status_url 查询。
        this.sendJson(res, 200, dispatcher.receipt(record, duplicate));
        dispatcher.run(record, this.notifyHandlers());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn("Failed to handle /internal/worker-notify: %s", message);
        this.sendJson(res, 500, { ok: false, produced_message: false, error: message });
      }
      return;
    }

    this.sendJson(res, 404, { ok: false, error: "not found" });
  }
}
