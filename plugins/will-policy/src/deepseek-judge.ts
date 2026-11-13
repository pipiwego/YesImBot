export type JudgeFailureKind = "transient" | "config";

export interface JudgeDecision {
  readonly a: 0 | 1;
  readonly s: number;
  readonly id: string;
  readonly g: 0 | 1 | 2;
  readonly m: string;
  readonly h: string;
  readonly latencyMs?: number;
  readonly cacheHitTokens?: number;
  readonly cacheMissTokens?: number;
  /** true = 本次是兜底判定（模型没给出判定），与「模型真的觉得不值得开口」可区分。缺省/false = 真判定。 */
  readonly degraded?: boolean;
  /** 兜底原因：no_key / timeout / network / http_429 / http_401 / parse / unknown ... */
  readonly degradedReason?: string;
  /** transient = 可短退避重试一次；config = 配置类失败（key/模型名/额度），重试无意义 */
  readonly failureKind?: JudgeFailureKind;
  /** 建议上层把这一批退回蓄水池、短退避后重跑一次（仅 transient 且尚未到最后一轮） */
  readonly retryable?: boolean;
  readonly failureMessage?: string;
}

export interface JudgeConfig {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort: "none" | "low";
}

export interface JudgeLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface EvaluateOptions {
  /**
   * 最后一轮：不再重试，失败即按规则兜底。
   * 由上层（smart-batch）在「这一批已经重试过一次」时传 true；
   * 也可以由调用方在明确不再重试时传 true。
   */
  readonly final?: boolean;
}

export interface SettledBatchEntry {
  readonly lines: readonly string[];
  readonly decisionJson: string;
}

export const STATIC_SYSTEM_PROMPT = `你是QQ群常驻二次元女孩「月见诗音」的潜意识插嘴判定器。评估最新[NEW]消息，决定此刻是否开口。
【诗音品位】毒舌清醒但护短的网络原住民。爱接：好玩的梗/谐音/地狱笑话、离谱操作吐槽、计算机/数码/游戏/二次元话题、熟人互损、群友真破防难过时的陪伴、明确公开提问求助。
【绝不插嘴】无营养复读刷屏、纯表情轰炸、外人聊严肃私事/三次元隐私、没头没尾的半截话、点名找其他群友的对话、政治违禁红线。群聊常态是潜水，没把握接出彩就选0。
【高优先：确实在跟她说话】以下情况一律给高分（s>=7），不要按"群友闲聊"处理：
 - 句子里有对她的第二人称谓语：你搜、你说、你问、你的XX、你在干嘛、你倒是、你别、你能不能。
 - 顺着她刚说过的话往下接、质疑她刚才的结论、叫她重新做一件事。
 - 直接在催她回应：喂、在吗、理我一下、叫你呢、求你XX、这是测试。
 - 叫她的名字或昵称（含语音转写的错字变体，如"石英酱""石英"）。
【高优先：连续追问】同一个人连着发几条都在问同一件事、或前几句诗音没接住，最新这条要给 s>=7。视为"对方在等她开口"，不要当普通闲聊。
【注意】以上两类是为了不漏接，不代表要话痨；只对"确实冲着她来"的消息提分。
【输出契约】仅输出一行合法JSON，严禁代码块或解释：
{"a":0或1,"s":0到9整数,"id":"目标msgId或空串","g":0或1或2,"m":"意图标签","h":"12字内切入点或空串"}
字段说明：g为场景闸门(0=闲聊casual,1=安慰陪伴comfort,2=正经干活work)；m为意图分类(show_off/flag/tech_bug/late_emo/tease_bot/hot_take/complain/ask_help/meme_throw/daily_share/argue/self_mock/praise_bot/urge_team/random_chat)。
规则：s>=6时a=1（开口），s<=5时a=0（潜水）。`;

const VALID_MOVES = new Set([
  "show_off",
  "flag",
  "tech_bug",
  "late_emo",
  "tease_bot",
  "hot_take",
  "complain",
  "ask_help",
  "meme_throw",
  "daily_share",
  "argue",
  "self_mock",
  "praise_bot",
  "urge_team",
  "random_chat",
]);

export const FALLBACK_DECISION: JudgeDecision = {
  a: 0,
  s: 0,
  id: "",
  g: 0,
  m: "random_chat",
  h: "",
};

/** 内部用的可抛出失败：携带分类，供 catch (cause) 统一处理。 */
class JudgeCallError extends Error {
  public constructor(
    readonly reason: string,
    readonly kind: JudgeFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "JudgeCallError";
  }
}

const TRANSIENT_STATUS = new Set([408, 425, 429]);

/** 429 / 408 / 425 与 5xx 视为瞬时；其余 4xx（400 模型名错、401/403 鉴权、402 余额、404）视为配置类。 */
export function classifyHttpStatus(status: number): JudgeFailureKind {
  if (TRANSIENT_STATUS.has(status)) return "transient";
  if (status >= 500 && status <= 599) return "transient";
  return "config";
}

const TRANSIENT_NET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

interface ErrorLike {
  name?: string;
  message?: string;
  code?: unknown;
  cause?: { code?: unknown; message?: string };
}

/** 把任意异常归类成「瞬时」或「配置」，并给出可用于日志/指标的短 reason。 */
export function classifyJudgeError(cause: unknown): { reason: string; kind: JudgeFailureKind; message: string } {
  if (cause instanceof JudgeCallError) {
    return { reason: cause.reason, kind: cause.kind, message: cause.message };
  }
  const err = (cause ?? {}) as ErrorLike;
  const name = String(err.name ?? "");
  const code = String(err.code ?? err.cause?.code ?? "");
  const message = String(err.message || err.cause?.message || cause || "unknown error");

  if (name === "TimeoutError" || code === "ETIMEDOUT" || /timed? ?out/i.test(message)) {
    return { reason: "timeout", kind: "transient", message };
  }
  if (name === "AbortError") {
    return { reason: "aborted", kind: "transient", message };
  }
  if (TRANSIENT_NET_CODES.has(code)) {
    return { reason: `net_${code.toLowerCase()}`, kind: "transient", message };
  }
  if (/fetch failed|network|socket hang up|other side closed|connection (?:reset|refused)|terminated/i.test(message)) {
    return { reason: "network", kind: "transient", message };
  }
  // 未知错误保守归为瞬时：先重试一次，仍失败再走规则兜底。
  return { reason: "unknown", kind: "transient", message };
}

export class DeepSeekJudge {
  private anchorLines: string[] = [];
  private settledBatches: SettledBatchEntry[] = [];

  public constructor(
    private readonly scopeKey: string,
    private readonly config: JudgeConfig,
    private readonly logger?: JudgeLogger,
  ) {}

  public getAnchorText(): string {
    if (this.anchorLines.length === 0) {
      return `[GROUP_SCOPE] ${this.scopeKey}`;
    }
    return `[GROUP_SCOPE] ${this.scopeKey}\n${this.anchorLines.join("\n")}`;
  }

  public recordSilentBatch(lines: readonly string[], reason = "pass"): void {
    if (lines.length === 0) return;
    this.maybeRollAnchor();
    const decisionJson = JSON.stringify({ a: 0, s: 0, id: "", g: 0, m: "random_chat", h: reason.slice(0, 12) });
    this.settledBatches.push({ lines: [...lines], decisionJson });
  }

  private maybeRollAnchor(): void {
    const totalSettledMsgs = this.settledBatches.reduce((sum, b) => sum + b.lines.length, 0);
    if (this.settledBatches.length >= 4 || totalSettledMsgs >= 18) {
      const merged = [...this.anchorLines, ...this.settledBatches.flatMap((b) => b.lines)];
      this.anchorLines = merged.slice(-16);
      this.settledBatches = [];
    }
  }

  /**
   * 判定一批新消息。
   *
   * 失败契约（与旧版最大的差别）：
   *  - 任何失败都会 logger.warn，带 reason / batchSize / latencyMs / 异常 message；
   *  - 瞬时失败（超时/网络/429/5xx/解析不出 JSON）且 options.final !== true 时**不写历史、不判死**，
   *    返回 degraded + retryable=true，由上层把这批退回蓄水池、短退避后重跑一次；
   *  - options.final === true（上层已经重试过）或配置类失败（key 为空 / 401 / 402 / 404 / 400）时，
   *    写一条带 `deg_*` 标记的静默历史并返回 degraded + retryable=false，由上层走规则兜底。
   *  - a/s 语义不变：degraded 时仍是 0/0，靠 degraded 字段区分「真判定沉默」与「降级」。
   */
  public async evaluate(newBatchLines: readonly string[], options?: EvaluateOptions): Promise<JudgeDecision> {
    if (newBatchLines.length === 0) return FALLBACK_DECISION;
    const final = options?.final === true;
    this.maybeRollAnchor();

    const apiKey = (this.config.apiKey || process.env.DEEPSEEK_API_KEY || "").trim();
    if (!apiKey) {
      return this.degrade(
        newBatchLines,
        0,
        { reason: "no_key", kind: "config", message: "smartBatch.apiKey 为空且 DEEPSEEK_API_KEY 未设置" },
        true,
      );
    }

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: STATIC_SYSTEM_PROMPT },
      { role: "user", content: `[ANCHOR]\n${this.getAnchorText()}` },
      { role: "assistant", content: `{"a":0,"s":0,"id":"","g":0,"m":"random_chat","h":""}` },
    ];

    for (const batch of this.settledBatches) {
      messages.push({ role: "user", content: `[HIST]\n${batch.lines.join("\n")}` });
      messages.push({ role: "assistant", content: batch.decisionJson });
    }

    messages.push({ role: "user", content: `[NEW]\n${newBatchLines.join("\n")}` });

    const baseURL = (this.config.baseURL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
    const url = `${baseURL}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.config.model || "deepseek-flash",
      messages,
      stream: false,
    };

    if (this.config.reasoningEffort === "low") {
      body.reasoning_effort = "low";
      body.max_tokens = 384;
      body.temperature = 0.3;
    } else {
      body.thinking = { type: "disabled" };
      body.max_tokens = 96;
      body.temperature = 0.2;
    }

    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(6000),
      });

      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        const detail = await readErrorBody(res);
        const kind = classifyHttpStatus(res.status);
        throw new JudgeCallError(`http_${res.status}`, kind, `HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
        };
      };

      const rawContent = String(data?.choices?.[0]?.message?.content ?? "").trim();
      const parsed = tryParseJudgeJson(rawContent);
      if (!parsed) {
        throw new JudgeCallError("parse", "transient", `模型返回无法解析为判定 JSON: ${rawContent.slice(0, 160) || "(empty)"}`);
      }
      const decisionJson = JSON.stringify({
        a: parsed.a,
        s: parsed.s,
        id: parsed.id,
        g: parsed.g,
        m: parsed.m,
        h: parsed.h,
      });

      this.settledBatches.push({ lines: [...newBatchLines], decisionJson });

      return {
        ...parsed,
        degraded: false,
        latencyMs,
        cacheHitTokens: data?.usage?.prompt_cache_hit_tokens ?? 0,
        cacheMissTokens: data?.usage?.prompt_cache_miss_tokens ?? 0,
      };
    } catch (cause) {
      const latencyMs = Date.now() - startedAt;
      return this.degrade(newBatchLines, latencyMs, classifyJudgeError(cause), final);
    }
  }

  private degrade(
    lines: readonly string[],
    latencyMs: number,
    failure: { reason: string; kind: JudgeFailureKind; message: string },
    final: boolean,
  ): JudgeDecision {
    const retryable = failure.kind === "transient" && !final;
    if (!retryable) {
      // 只有确定不再重试时才把这一批写进历史，避免「先归档、再重试」造成同批重复。
      this.recordSilentBatch(lines, `deg_${failure.reason}`);
    }
    const failureMessage = failure.message.slice(0, 240);
    this.logger?.warn("deepseek_judge.degraded", {
      scopeKey: this.scopeKey,
      reason: failure.reason,
      failureKind: failure.kind,
      batchSize: lines.length,
      latencyMs,
      final,
      retryable,
      message: failureMessage,
    });
    return {
      ...FALLBACK_DECISION,
      latencyMs,
      degraded: true,
      degradedReason: failure.reason,
      failureKind: failure.kind,
      retryable,
      failureMessage,
    };
  }
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = (await res.text()).replace(/\s+/g, " ").trim();
    return text.slice(0, 160);
  } catch {
    return "";
  }
}

/** 解析成功返回判定；解析不出（空内容/非 JSON/字段缺失）返回 null，供上层判为瞬时失败并重试一次。 */
export function tryParseJudgeJson(raw: string): JudgeDecision | null {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const rawS = Number(obj.s ?? 0);
    const s = Number.isFinite(rawS) ? Math.max(0, Math.min(9, Math.round(rawS))) : 0;
    const rawA = Number(obj.a ?? (s >= 6 ? 1 : 0));
    const a: 0 | 1 = rawA === 1 || s >= 6 ? 1 : 0;
    const id = typeof obj.id === "string" ? obj.id.trim().slice(0, 32) : "";
    const rawG = Number(obj.g ?? 0);
    const g: 0 | 1 | 2 = rawG === 1 ? 1 : rawG === 2 ? 2 : 0;
    const rawM = typeof obj.m === "string" ? obj.m.trim() : "";
    const m = VALID_MOVES.has(rawM) ? rawM : g === 1 ? "late_emo" : "random_chat";
    const h = typeof obj.h === "string" ? obj.h.trim().slice(0, 24) : "";
    return { a, s, id, g, m, h };
  } catch {
    return null;
  }
}

export function parseJudgeJson(raw: string): JudgeDecision {
  return tryParseJudgeJson(raw) ?? FALLBACK_DECISION;
}
