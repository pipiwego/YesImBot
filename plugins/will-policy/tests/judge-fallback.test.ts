import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { DeepSeekJudge } from "../src/deepseek-judge.js";
import { PolicySmartBatchEngine } from "../src/smart-batch.js";
import { defaultSmartBatchConfig, type PolicySmartBatchConfig } from "../src/types.js";

const realFetch = globalThis.fetch;

type FetchStep = () => Response | Promise<Response>;

function mockFetchSequence(steps: FetchStep[]): ReturnType<typeof vi.fn> {
  let cursor = 0;
  const fn = vi.fn(async () => {
    const step = steps[Math.min(cursor, steps.length - 1)];
    cursor += 1;
    return step();
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function jsonResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OPEN_DECISION = `{"a":1,"s":8,"id":"m1","g":0,"m":"random_chat","h":"接她一句"}`;

function makeJudge(apiKey = "test-key") {
  const logger = { warn: vi.fn() };
  const judge = new DeepSeekJudge(
    "test:room-1",
    { baseURL: "https://judge.test/v1", apiKey, model: "deepseek-flash", reasoningEffort: "none" },
    logger,
  );
  return { judge, logger };
}

const LINES = ["[m1] 群友: 诗音你在吗"];

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe("DeepSeekJudge 失败分类（catch 不再吞异常）", () => {
  it("超时 → degraded + retryable，并 warn 出 reason/batchSize/latencyMs/message", async () => {
    mockFetchSequence([
      () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      },
    ]);
    const { judge, logger } = makeJudge();

    const decision = await judge.evaluate(LINES);

    expect(decision.degraded).toBe(true);
    expect(decision.degradedReason).toBe("timeout");
    expect(decision.failureKind).toBe("transient");
    expect(decision.retryable).toBe(true);
    expect(decision.a).toBe(0);
    expect(decision.s).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [event, meta] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe("deepseek_judge.degraded");
    expect(meta.reason).toBe("timeout");
    expect(meta.batchSize).toBe(1);
    expect(typeof meta.latencyMs).toBe("number");
    expect(String(meta.message)).toContain("timeout");
  });

  it("429 → 瞬时失败，建议上层重试一次", async () => {
    mockFetchSequence([() => new Response("rate limited", { status: 429 })]);
    const { judge } = makeJudge();

    const decision = await judge.evaluate(LINES);

    expect(decision.degraded).toBe(true);
    expect(decision.degradedReason).toBe("http_429");
    expect(decision.failureKind).toBe("transient");
    expect(decision.retryable).toBe(true);
    expect(decision.failureMessage).toContain("429");
  });

  it("5xx → 瞬时失败", async () => {
    mockFetchSequence([() => new Response("upstream boom", { status: 503 })]);
    const { judge } = makeJudge();

    const decision = await judge.evaluate(LINES);

    expect(decision.retryable).toBe(true);
    expect(decision.failureKind).toBe("transient");
  });

  it("401 → 配置类失败，不再重试（走规则兜底）", async () => {
    mockFetchSequence([() => new Response('{"error":"invalid api key"}', { status: 401 })]);
    const { judge } = makeJudge();

    const decision = await judge.evaluate(LINES);

    expect(decision.degraded).toBe(true);
    expect(decision.degradedReason).toBe("http_401");
    expect(decision.failureKind).toBe("config");
    expect(decision.retryable).toBe(false);
  });

  it("apiKey 为空 → no_key，且不发请求", async () => {
    const fetchSpy = mockFetchSequence([() => jsonResponse(OPEN_DECISION)]);
    const { judge, logger } = makeJudge("");

    const decision = await judge.evaluate(LINES);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(decision.degraded).toBe(true);
    expect(decision.degradedReason).toBe("no_key");
    expect(decision.retryable).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("返回体解析不出 JSON → parse 瞬时失败", async () => {
    mockFetchSequence([() => jsonResponse("抱歉，我无法判断")]);
    const { judge } = makeJudge();

    const decision = await judge.evaluate(LINES);

    expect(decision.degradedReason).toBe("parse");
    expect(decision.retryable).toBe(true);
  });

  it("已重试过（final=true）仍失败 → 不再 retryable，并写入带 deg_ 标记的历史", async () => {
    mockFetchSequence([() => new Response("boom", { status: 500 })]);
    const { judge } = makeJudge();

    const decision = await judge.evaluate(LINES, { final: true });

    expect(decision.degraded).toBe(true);
    expect(decision.retryable).toBe(false);
    expect(judge.getAnchorText()).toContain("[GROUP_SCOPE]"); // 历史尚未滚动
  });

  it("成功判定 → degraded=false，a/s 语义不变", async () => {
    mockFetchSequence([() => jsonResponse(OPEN_DECISION)]);
    const { judge, logger } = makeJudge();

    const decision = await judge.evaluate(LINES);

    expect(decision.degraded).toBe(false);
    expect(decision.a).toBe(1);
    expect(decision.s).toBe(8);
    expect(decision.h).toBe("接她一句");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

function makeEngine(nudge: (options?: unknown) => Promise<boolean>, overrides: Partial<PolicySmartBatchConfig> = {}) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() };
  const config: PolicySmartBatchConfig = {
    ...defaultSmartBatchConfig(),
    apiKey: "test-key",
    ...overrides,
  };
  const engine = new PolicySmartBatchEngine(
    { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1" } as never,
    config,
    logger as never,
    nudge as never,
  );
  return { engine, logger };
}

function makeMessage(text: string, messageId = "msg-1", userId = "u1") {
  return {
    role: "custom",
    type: "yesimbot.message",
    data: {
      messageId,
      selfId: "bot-1",
      user: { id: userId, name: "群友" },
      elements: [{ type: "text", attrs: { content: text } }],
    },
  } as never;
}

const BUSY = { activeTurnId: "turn-1" } as never;

type EngineInternals = {
  cooldownUntil: number;
  lastBotReplyAt: number;
  lastBotActiveUserId: string;
  followUpRenewals: number;
  pendingItems: Array<{ realMsgId: string; attempts?: number; nudgeFailures?: number }>;
  judge: DeepSeekJudge;
  flushAndEvaluate(reason: string): Promise<void>;
};

describe("PolicySmartBatchEngine 冷却与回池", () => {
  it("nudge 失败：回滚冷却，并把该批放回蓄水池（不丢）", async () => {
    mockFetchSequence([() => jsonResponse(OPEN_DECISION)]);
    const nudge = vi.fn(async () => false);
    const { engine, logger } = makeEngine(nudge);
    const internals = engine as unknown as EngineInternals;

    internals.cooldownUntil = 1_000; // 旧的冷却值（已过期），用于验证回滚
    internals.lastBotReplyAt = 0;
    await engine.decide(makeMessage("这个 bug 复现了三次"), BUSY);
    await internals.flushAndEvaluate("test");

    expect(nudge).toHaveBeenCalledTimes(1);
    expect(internals.cooldownUntil).toBe(1_000);
    expect(internals.lastBotReplyAt).toBe(0);
    expect(internals.pendingItems).toHaveLength(1);
    expect(internals.pendingItems[0]?.realMsgId).toBe("msg-1");
    expect(internals.pendingItems[0]?.nudgeFailures).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith("smart_batch.nudge_requeued", expect.objectContaining({ cooldownRolledBack: true }));
    engine.stop();
  });

  it("nudge 成功：才真正扣冷却、清空蓄水池", async () => {
    mockFetchSequence([() => jsonResponse(OPEN_DECISION)]);
    const nudge = vi.fn(async () => true);
    const { engine } = makeEngine(nudge);
    const internals = engine as unknown as EngineInternals;

    internals.cooldownUntil = 0;
    await engine.decide(makeMessage("这个 bug 复现了三次"), BUSY);
    await internals.flushAndEvaluate("test");

    expect(nudge).toHaveBeenCalledTimes(1);
    expect(internals.cooldownUntil).toBeGreaterThan(Date.now());
    expect(internals.pendingItems).toHaveLength(0);
    engine.stop();
  });

  it("判定器瞬时失败：该批退回蓄水池并标记 attempts，第二次以 final=true 调用", async () => {
    mockFetchSequence([() => new Response("boom", { status: 500 }), () => jsonResponse(OPEN_DECISION)]);
    const nudge = vi.fn(async () => true);
    const { engine, logger } = makeEngine(nudge);
    const internals = engine as unknown as EngineInternals;
    const evaluateSpy = vi.spyOn(internals.judge, "evaluate");

    await engine.decide(makeMessage("这个 bug 复现了三次"), BUSY);
    await internals.flushAndEvaluate("test");

    // 第一次：不判死、不 nudge、原批回池
    expect(nudge).not.toHaveBeenCalled();
    expect(internals.pendingItems).toHaveLength(1);
    expect(internals.pendingItems[0]?.attempts).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith("smart_batch.judge_retry", expect.objectContaining({ backoffMs: 400 }));
    expect(evaluateSpy.mock.calls[0]?.[1]).toEqual({ final: false });

    // 第二次（重试的那一次）：final=true，模型给出开口 → nudge
    await internals.flushAndEvaluate("retry_transient");

    expect(evaluateSpy.mock.calls[1]?.[1]).toEqual({ final: true });
    expect(nudge).toHaveBeenCalledTimes(1);
    engine.stop();
  });

  it("同人追问窗口连续续期 3 次后强制关闭，消息重新交给判定器", async () => {
    mockFetchSequence([() => jsonResponse(`{"a":0,"s":0,"id":"","g":0,"m":"random_chat","h":""}`)]);
    const nudge = vi.fn(async () => true);
    const { engine, logger } = makeEngine(nudge);
    const internals = engine as unknown as EngineInternals;

    internals.lastBotReplyAt = Date.now();
    internals.lastBotActiveUserId = "u1";
    internals.followUpRenewals = 3;

    const decision = await engine.decide(makeMessage("还在吗"), { activeTurnId: null } as never);

    // 不再走 VIP 直通，落到蓄水池等待判定
    expect(decision).toBe("wait");
    expect(nudge).not.toHaveBeenCalled();
    expect(internals.pendingItems).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith("smart_batch.followup_capped", expect.objectContaining({ renewals: 3 }));
    engine.stop();
  });
});
