import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@koishijs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  active: null as string | null,
  append: vi.fn(),
  send: vi.fn(),
  run: vi.fn(),
  decide: vi.fn(),
  observe: vi.fn(),
  interrupt: vi.fn(),
  stop: vi.fn(),
  agentOptions: undefined as unknown,
}));

vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("@yesimbot/agent-runtime", async (original) => {
  const actual = await original<typeof import("@yesimbot/agent-runtime")>();
  return {
    ...actual,
    createAgent: vi.fn((options: unknown) => {
      state.agentOptions = options;
      return {
        init: vi.fn(),
        append: state.append,
        send: state.send,
        run: state.run,
        getActiveTurnId: () => state.active,
        wait: vi.fn(),
        interrupt: state.interrupt,
        stop: state.stop,
        isIdle: () => true,
      };
    }),
  };
});

import { Channel } from "../src/channels/index.js";
import type { Config } from "../src/config.js";
import { ChannelRuntime, type ChannelRuntimeOptions } from "../src/runtimes/channel.js";

const config: Config = {
  basePath: "/tmp",
  chatModel: "test:model",
  visionModel: undefined,
  logLevel: 2,
  allowedChannels: [],
  imageInput: false,
  resourceReadTimeout: 1,
  pacing: { charactersPerSecond: 1, maxTotalDelayMs: 1 },
  customInnerThought: false,
  session: {
    compact: { responseIdleMinutes: 0, minMessages: 20, maxFailures: 1, model: undefined, triggerTokens: 0, fallbackTurns: 0 },
    archive: { maxKB: 0 },
  },
};

const event = {
  eventType: "delivery.failed",
  platform: "test",
  selfId: "bot",
  timestamp: 1,
  channel: { id: "room", type: 0 },
  text: "failure",
  delivery: { turnId: "t", messageId: "m", segmentIndex: 0, segmentTotal: 1, error: { name: "Error", message: "x" } },
} as const;

type LogLine = { level: string; name: string; args: unknown[] };
type HintPlugin = {
  name?: string;
  prepareStep?: (messages: unknown[], ctx: { turnId: string }) => unknown;
};

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function createRuntime(overrides: Partial<ChannelRuntimeOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-nudge-hint-"));
  roots.push(root);
  const channel = new Channel({ type: "guild", platform: "test", channelId: "room", guildId: "room" }, root);
  await channel.conversation.init();
  const value = new ChannelRuntime(new Context(), {
    channel,
    bot: { selfId: "bot", sendMessage: vi.fn() } as never,
    will: { decide: state.decide, observe: state.observe } as never,
    model: {} as never,
    imageOutputSupported: false,
    config,
    plugins: [],
    ...overrides,
  });
  await value.init();

  const logs: LogLine[] = [];
  const logger = (value as unknown as { logger: Record<string, (...args: unknown[]) => void> }).logger;
  for (const level of ["debug", "info", "warn", "error"]) {
    logger[level] = (...args: unknown[]) => logs.push({ level, name: String(args[0]), args: args.slice(1) });
  }
  return { value, channel, logs };
}

/** 从 createAgent 收到的 options 里取出两个 nudge-hint 钩子，直接调用。 */
function hintPlugins(): { pre: HintPlugin; post: HintPlugin } {
  const plugins = (state.agentOptions as { plugins?: HintPlugin[] } | undefined)?.plugins ?? [];
  const pre = plugins.find((plugin) => plugin.name === "core.nudge-hint-pre");
  const post = plugins.find((plugin) => plugin.name === "core.nudge-hint");
  if (!pre?.prepareStep || !post?.prepareStep) throw new Error("nudge hint plugins not registered");
  return { pre, post };
}

async function step(plugin: HintPlugin, turnId: string): Promise<unknown[]> {
  const messages: unknown[] = [];
  const out = await plugin.prepareStep!(messages, { turnId });
  return out as unknown[];
}

function armed(value: ChannelRuntime): { hint: string; at: number; eventId: string } | undefined {
  return (value as unknown as { pendingNudgeHint?: { hint: string; at: number; eventId: string } }).pendingNudgeHint;
}

function hintsByTurn(value: ChannelRuntime): Map<string, string> {
  return (value as unknown as { nudgeHintsByTurn: Map<string, string> }).nudgeHintsByTurn;
}

function findLog(logs: LogLine[], name: string): LogLine | undefined {
  return logs.find((line) => line.name === name);
}

beforeEach(() => {
  state.active = null;
  state.append.mockReset().mockResolvedValue(undefined);
  state.send.mockReset();
  state.run.mockReset().mockReturnValue((async function* () {})());
  state.decide.mockReset().mockResolvedValue("wait");
  state.interrupt.mockReset().mockResolvedValue(undefined);
  state.stop.mockReset().mockResolvedValue(undefined);
  state.agentOptions = undefined;
});

describe("nudge 指令不再跨轮泄漏", () => {
  it("装填时记录 hint / at / eventId，正常消费一次即挂到当前 turn", async () => {
    const { value, logs } = await createRuntime();
    const input = await value.post(event, { trigger: false });

    await expect(value.nudge({ nudgeHint: "把刚才那条撤回" })).resolves.toMatchObject({ kind: "run" });
    const armedHint = armed(value);
    expect(armedHint).toMatchObject({ hint: "把刚才那条撤回", eventId: (input as { eventId: string }).eventId });
    expect(typeof armedHint?.at).toBe("number");

    const { pre } = hintPlugins();
    const sent = await step(pre, "turn-1");
    expect(sent).toHaveLength(1);
    expect(String((sent[0] as { content: string }).content)).toContain("把刚才那条撤回");
    // 消费后待消费字段清空，指令改由 turn 维度持有
    expect(armed(value)).toBeUndefined();
    expect(hintsByTurn(value).get("turn-1")).toBe("把刚才那条撤回");
    expect(findLog(logs, "nudge.hint_expired")).toBeUndefined();
  });

  it("超过 90 秒 TTL 的指令被丢弃，不再注入新的一轮", async () => {
    const { value, logs } = await createRuntime();
    await value.post(event, { trigger: false });
    await value.nudge({ nudgeHint: "过期指令" });
    const armedHint = armed(value)!;

    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 90_001);
    try {
      const { pre } = hintPlugins();
      expect(await step(pre, "turn-late")).toEqual([]);
    } finally {
      clock.mockRestore();
    }

    expect(armed(value)).toBeUndefined();
    expect(hintsByTurn(value).has("turn-late")).toBe(false);
    const expired = findLog(logs, "nudge.hint_expired");
    expect(expired).toBeDefined();
    expect(expired?.args[0]).toMatchObject({ turnId: "turn-late", eventId: armedHint.eventId, ttlMs: 90_000 });
    expect((expired?.args[0] as { ageMs: number }).ageMs).toBeGreaterThanOrEqual(90_001);
  });

  it("TTL 边界内（89.9 秒）仍然正常注入", async () => {
    const { value } = await createRuntime();
    await value.post(event, { trigger: false });
    await value.nudge({ nudgeHint: "还新鲜的指令" });

    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 89_900);
    try {
      const { pre } = hintPlugins();
      const sent = await step(pre, "turn-ok");
      expect(sent).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
    expect(hintsByTurn(value).get("turn-ok")).toBe("还新鲜的指令");
  });

  it("ifBusy=reject 早退时清空待消费指令并记 nudge.hint_dropped", async () => {
    const { value, logs } = await createRuntime();
    await value.post(event, { trigger: false });
    await value.nudge({ nudgeHint: "上一轮没消费掉的指令" });
    expect(armed(value)).toBeDefined();

    state.active = "turn-busy";
    await expect(value.nudge({ nudgeHint: "第二条" })).resolves.toMatchObject({ kind: "wait" });

    expect(armed(value)).toBeUndefined();
    const dropped = findLog(logs, "nudge.hint_dropped");
    expect(dropped?.args[0]).toMatchObject({ reason: "busy" });

    // 之后任何一轮都不该看到这条过期指令
    state.active = null;
    const { pre } = hintPlugins();
    expect(await step(pre, "turn-after")).toEqual([]);
  });

  it("没有可复用的输入时早退也清空并记 nudge.hint_dropped{no-input}", async () => {
    const { value, logs } = await createRuntime();
    await value.post(event, { trigger: false });
    await value.nudge({ nudgeHint: "孤儿指令" });
    expect(armed(value)).toBeDefined();

    (value as unknown as { lastPersistedInput: unknown }).lastPersistedInput = undefined;
    await expect(value.nudge({ nudgeHint: "孤儿指令2" })).resolves.toMatchObject({ kind: "wait" });

    expect(armed(value)).toBeUndefined();
    expect(findLog(logs, "nudge.hint_dropped")?.args[0]).toMatchObject({ reason: "no-input" });
  });

  it("stop() 同时清空 pendingNudgeHint 与 nudgeHintsByTurn", async () => {
    const { value, logs } = await createRuntime();
    await value.post(event, { trigger: false });
    await value.nudge({ nudgeHint: "挂到 turn 上的指令" });
    const { pre } = hintPlugins();
    expect(await step(pre, "turn-old")).toHaveLength(1);
    expect(hintsByTurn(value).size).toBe(1);

    await value.nudge({ nudgeHint: "还没被消费的指令" });
    expect(armed(value)).toBeDefined();

    await value.stop();

    expect(armed(value)).toBeUndefined();
    expect(hintsByTurn(value).size).toBe(0);
    expect(findLog(logs, "nudge.hint_dropped")?.args[0]).toMatchObject({ reason: "stop" });
    expect(findLog(logs, "nudge.hints_cleared")?.args[0]).toMatchObject({ reason: "stop" });
    // 停机后新的 step 不会凭空拿到旧指令
    expect(await step(pre, "turn-new")).toEqual([]);
  });

  it("turn.aborted 会清掉该 turn 已登记的指令", async () => {
    const { value, logs } = await createRuntime();
    await value.post(event, { trigger: false });
    await value.nudge({ nudgeHint: "被中断的指令" });
    const { pre } = hintPlugins();
    expect(await step(pre, "turn-abort")).toHaveLength(1);

    state.run.mockReturnValue(
      (async function* () {
        yield { type: "turn.start", turnId: "turn-abort" };
        yield { type: "turn.aborted", turnId: "turn-abort", reason: "stop" };
      })(),
    );
    const result = await value.post(event, { trigger: true, ifBusy: "defer" });
    expect(result.kind).toBe("run");
    if (result.kind !== "run") return;
    await expect(
      (async () => {
        for await (const _ of result.output) void _;
      })(),
    ).rejects.toThrow();

    expect(hintsByTurn(value).size).toBe(0);
    expect(findLog(logs, "nudge.hints_cleared")?.args[0]).toMatchObject({ reason: "abort" });
    expect(await step(pre, "turn-abort")).toEqual([]);
  });

  it("turn.abandoned 也会清掉该 turn 已登记的指令", async () => {
    const { value, logs } = await createRuntime();
    await value.post(event, { trigger: false });
    await value.nudge({ nudgeHint: "被放弃的指令" });
    const { pre } = hintPlugins();
    expect(await step(pre, "turn-gone")).toHaveLength(1);

    state.run.mockReturnValue(
      (async function* () {
        yield { type: "turn.start", turnId: "turn-gone" };
        yield { type: "turn.abandoned", turnId: "turn-gone", elapsedMs: 5, timeoutMs: 3, queueLength: 0 };
      })(),
    );
    const result = await value.post(event, { trigger: true, ifBusy: "defer" });
    expect(result.kind).toBe("run");
    if (result.kind !== "run") return;
    for await (const _ of result.output) void _;

    expect(hintsByTurn(value).size).toBe(0);
    expect(findLog(logs, "nudge.hints_cleared")?.args[0]).toMatchObject({ reason: "abandoned" });
    expect(await step(pre, "turn-gone")).toEqual([]);
  });

  it("调用方不带 hint 时，旧指令被丢弃而不是等到下一轮", async () => {
    const { value, logs } = await createRuntime();
    await value.post(event, { trigger: false });
    await value.nudge({ nudgeHint: "旧指令" });
    expect(armed(value)).toBeDefined();

    await value.nudge();
    expect(armed(value)).toBeUndefined();
    expect(findLog(logs, "nudge.hint_dropped")?.args[0]).toMatchObject({ reason: "superseded" });

    const { pre } = hintPlugins();
    expect(await step(pre, "turn-x")).toEqual([]);
  });
});
