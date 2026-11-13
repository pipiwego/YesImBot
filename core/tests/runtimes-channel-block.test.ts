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
}));

vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("@yesimbot/agent-runtime", async (original) => {
  const actual = await original<typeof import("@yesimbot/agent-runtime")>();
  return {
    ...actual,
    createAgent: vi.fn(() => ({
      init: vi.fn(),
      append: state.append,
      send: state.send,
      run: state.run,
      getActiveTurnId: () => state.active,
      wait: vi.fn(),
      interrupt: state.interrupt,
      stop: state.stop,
      isIdle: () => true,
    })),
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

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function createRuntime(overrides: Partial<ChannelRuntimeOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-channel-block-"));
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
  return { value, channel, root };
}

beforeEach(() => {
  state.active = null;
  state.append.mockReset().mockResolvedValue(undefined);
  state.send.mockReset();
  state.run.mockReset().mockReturnValue((async function* () {})());
  state.decide.mockReset().mockResolvedValue("wait");
  state.interrupt.mockReset().mockResolvedValue(undefined);
  state.stop.mockReset().mockResolvedValue(undefined);
});

describe("ChannelRuntime 不再被永不结束的 turn / 压缩堵死", () => {
  it("stop() 在 agent.interrupt 永不返回时仍然有界返回", async () => {
    state.interrupt.mockReturnValue(new Promise(() => undefined));
    const { value } = await createRuntime({ interruptTimeoutMs: 40, stopTimeoutMs: 40 });

    const startedAt = Date.now();
    await expect(value.stop()).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(state.interrupt).toHaveBeenCalled();
  });

  it("stop() 在 agent.stop 永不返回时仍然有界返回", async () => {
    state.stop.mockReturnValue(new Promise(() => undefined));
    const { value } = await createRuntime({ stopTimeoutMs: 30 });

    const startedAt = Date.now();
    await expect(value.stop()).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("压缩挂在独立车道上时，新的入站记录不再排在它后面", async () => {
    const { value, channel } = await createRuntime();
    const compact = vi.spyOn(channel.conversation, "compact").mockImplementation(() => new Promise(() => undefined));

    const hanging = value.compact("auto");
    await Promise.resolve();

    const startedAt = Date.now();
    await expect(value.post(event, { trigger: false })).resolves.toMatchObject({ kind: "wait" });
    const waited = Date.now() - startedAt;

    expect(waited).toBeLessThan(500);
    expect(compact).toHaveBeenCalledWith("auto", expect.anything());
    // 压缩还挂在那儿（证明入站确实没等它）
    await expect(Promise.race([hanging.then(() => "settled"), Promise.resolve("pending")])).resolves.toBe("pending");
  });

  it("重复的自动压缩请求合并成一次", async () => {
    const { value, channel } = await createRuntime();
    const compact = vi.spyOn(channel.conversation, "compact").mockImplementation(() => new Promise(() => undefined));

    const first = value.compact("auto");
    const second = value.compact("idle");
    await Promise.resolve();

    expect(second).toBe(first);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("turn.abandoned 会结束输出流，而不是让消费者一直挂着", async () => {
    state.run.mockReturnValue(
      (async function* () {
        yield { type: "turn.start", turnId: "turn-x" };
        yield { type: "turn.abandoned", turnId: "turn-x", elapsedMs: 12, timeoutMs: 3, queueLength: 0 };
      })(),
    );
    const { value } = await createRuntime();
    state.decide.mockResolvedValue("run");

    const result = await value.post(event, { trigger: true, ifBusy: "defer" });
    expect(result.kind).toBe("run");
    if (result.kind !== "run") return;

    const startedAt = Date.now();
    const collected: unknown[] = [];
    for await (const item of result.output) collected.push(item);
    expect(collected).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(await value.wait()).toBeUndefined();
  });

  it("stop 之后 compact 立刻返回 stopped，不再排队", async () => {
    const { value } = await createRuntime();
    await value.stop();
    await expect(value.compact("auto")).resolves.toEqual({ compacted: false, reason: "stopped" });
  });
});
