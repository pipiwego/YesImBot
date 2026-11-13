import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Context, h } from "koishi";

import type { Config } from "../src/config.js";
import type { EventRecord } from "../src/messages/index.js";
import { Messenger, extractPlatformMessageId } from "../src/messengers/index.js";

const config: Config = {
  basePath: "data/yesimbot",
  chatModel: "test:model",
  visionModel: undefined,
  logLevel: 2,
  allowedChannels: [],
  imageInput: false,
  resourceReadTimeout: 30,
  pacing: { charactersPerSecond: 100_000, maxTotalDelayMs: 60_000 },
  customInnerThought: false,
  session: { compact: { responseIdleMinutes: 0, minMessages: 20, maxFailures: 3, model: undefined }, archive: { maxKB: 0 } },
};

const event: EventRecord<"delivery.failed"> = {
  eventType: "delivery.failed",
  platform: "test",
  selfId: "bot-1",
  timestamp: 1,
  channel: { id: "room-1", type: 0 },
  text: "delivery failed",
  delivery: { turnId: "turn-1", messageId: "message-1", segmentIndex: 0, segmentTotal: 1, error: { name: "Error", message: "offline" } },
};

describe("Messenger", () => {
  it("routes an active post through its matching Bot and producing Runtime", async () => {
    const ctx = new Context();
    const exact = { platform: "test", selfId: "bot-1", sendMessage: vi.fn(async () => []) };
    const decoy = { platform: "test", selfId: "bot-2", sendMessage: vi.fn(async () => []) };
    ctx.bots.push(decoy as never, exact as never);
    const runtime = {
      context: { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1" },
      fail: vi.fn(async () => undefined),
      post: vi.fn(async () => ({
        kind: "run" as const,
        eventId: "event-1",
        output: (async function* () {
          yield { turnId: "turn-1", messageId: "assistant-1", segments: [[h.text("reply")]] };
        })(),
        signal: new AbortController().signal,
      })),
    };
    const channels = { resolve: vi.fn(async () => ({ context: { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1" } })) };
    const runtimes = { get: vi.fn(async () => runtime) };

    const messenger = new Messenger(ctx, config, channels as never, runtimes as never);

    await messenger.post(event);

    expect(runtimes.get).toHaveBeenCalledWith(expect.anything(), exact);
    expect(runtime.post).toHaveBeenCalledWith(event, { trigger: true, ifBusy: "defer" });
    expect(exact.sendMessage).toHaveBeenCalledWith("room-1", [h.text("reply")]);
    expect(decoy.sendMessage).not.toHaveBeenCalled();
    expect(runtime.fail).not.toHaveBeenCalled();
  });

  it("keeps the Session live through default translation and resource persistence", async () => {
    const ctx = new Context();
    const bot = { platform: "test", selfId: "bot-1", status: 1, sendMessage: vi.fn(async () => []) };
    ctx.bots.push(bot as never);
    Object.assign(ctx, { database: { get: vi.fn(async () => [{ assignee: "bot-1" }]) } });
    const put = vi.fn(async () => "0123456789abcdef0123456789abcdef");
    const resources = {
      assets: { put },
      persistElements: vi.fn(async (_ctx: unknown, elements: readonly { type: string; attrs: Record<string, unknown> }[]) =>
        elements.map((el) => (el.type === "img" ? h("img", { id: "0123456789abcdef0123456789abcdef" }) : el)),
      ),
    };
    const channel = { context: { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1" }, resources };
    const runtime = { handle: vi.fn(async () => ({ kind: "wait" as const, eventId: "event-1" })) };
    const channels = { start: vi.fn(async () => undefined), resolve: vi.fn(async () => channel) };
    const runtimes = { get: vi.fn(async () => runtime) };
    const http = Object.assign(
      vi.fn(async () => ({
        data: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
            controller.close();
          },
        }),
      })),
      { head: vi.fn(async () => ({ get: (name: string) => ({ "content-type": "image/png", "content-length": "4" })[name] ?? null })) },
    );
    Object.assign(ctx, { http });
    const messenger = new Messenger(ctx, { ...config, allowedChannels: [{ platform: "test", channelId: "room-1" }] }, channels as never, runtimes as never);
    const session = {
      type: "message-created",
      platform: "test",
      selfId: "bot-1",
      channelId: "room-1",
      guildId: "room-1",
      userId: "user-1",
      timestamp: 1,
      messageId: "message-1",
      isDirect: false,
      event: { channel: { type: 0 }, user: { id: "user-1" } },
      elements: [h("img", { src: "https://example.test/image.png" })],
      send: vi.fn(async () => []),
    };

    await messenger["handle"](session as never);

    expect(resources.persistElements).toHaveBeenCalledOnce();
    expect(runtime.handle).toHaveBeenCalledWith(expect.objectContaining({ elements: [h("img", { id: "0123456789abcdef0123456789abcdef" })] }));
    expect(runtimes.get).toHaveBeenCalledWith(channel, bot, session);
  });

  it("feeds an active delivery rejection back to its producing Runtime", async () => {
    const ctx = new Context();
    const bot = { platform: "test", selfId: "bot-1", sendMessage: vi.fn(async () => Promise.reject(new Error("offline"))) };
    ctx.bots.push(bot as never);
    const runtime = {
      context: { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1" },
      fail: vi.fn(async () => undefined),
      post: vi.fn(async () => ({
        kind: "run" as const,
        eventId: "event-1",
        output: (async function* () {
          yield { turnId: "turn-1", messageId: "assistant-1", segments: [[h.text("reply")]] };
        })(),
        signal: new AbortController().signal,
      })),
    };
    const channels = { resolve: vi.fn(async () => ({ context: runtime.context })) };
    const runtimes = { get: vi.fn(async () => runtime) };
    const messenger = new Messenger(ctx, { ...config, pacing: { charactersPerSecond: 8, maxTotalDelayMs: 1 } }, channels as never, runtimes as never);

    await messenger.post(event);

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    expect(runtime.fail).toHaveBeenCalledWith("event-1", expect.objectContaining({ message: "offline" }), {
      turnId: "turn-1",
      messageId: "assistant-1",
      segmentIndex: 1,
      segmentTotal: 1,
    });
  });
  it("does not deliver a segment aborted during pacing delay", async () => {
    vi.useFakeTimers();
    try {
      const ctx = new Context();
      const controller = new AbortController();
      const bot = { platform: "test", selfId: "bot-1", sendMessage: vi.fn(async () => []) };
      ctx.bots.push(bot as never);
      const runtime = {
        context: { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1" },
        fail: vi.fn(async () => undefined),
        post: vi.fn(async () => ({
          kind: "run" as const,
          eventId: "event-1",
          output: (async function* () {
            yield { turnId: "turn-1", messageId: "assistant-1", segments: [[h.text("reply")]] };
          })(),
          signal: controller.signal,
        })),
      };
      const channels = { resolve: vi.fn(async () => ({ context: runtime.context })) };
      const runtimes = { get: vi.fn(async () => runtime) };
      const messenger = new Messenger(ctx, { ...config, pacing: { charactersPerSecond: 1, maxTotalDelayMs: 1_000 } }, channels as never, runtimes as never);

      const pending = messenger.post(event);
      for (let attempt = 0; attempt < 10 && vi.getTimerCount() === 0; attempt += 1) await Promise.resolve();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      controller.abort();
      await vi.runAllTimersAsync();
      // post() 现在返回投递结果（R2：内部通知链路要知道「到底说没说出口」）
      await expect(pending).resolves.toMatchObject({ produced: false, segments: 0 });
      expect(bot.sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an active post without a matching Bot before Runtime creation", async () => {
    const ctx = new Context();
    ctx.bots.push({ platform: "test", selfId: "other", sendMessage: vi.fn() } as never);
    const channels = { resolve: vi.fn() };
    const runtimes = { get: vi.fn() };
    const messenger = new Messenger(ctx, config, channels as never, runtimes as never);

    await expect(messenger.post(event)).rejects.toThrow("No Bot is available for test:bot-1");

    expect(channels.resolve).not.toHaveBeenCalled();
    expect(runtimes.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R14 / B1-7 分段投递：单段失败不吞后续段，按实际结果汇总
// ---------------------------------------------------------------------------

function runnable(segments: readonly (readonly unknown[])[], signal: AbortSignal = new AbortController().signal) {
  const context = { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1" };
  return {
    context,
    fail: vi.fn(async () => undefined),
    post: vi.fn(async () => ({
      kind: "run" as const,
      eventId: "event-1",
      output: (async function* () {
        yield { turnId: "turn-1", messageId: "assistant-1", segments };
      })(),
      signal,
    })),
  };
}

function collector(ctx: Context): unknown[] {
  const seen: unknown[] = [];
  ctx.on("yesimbot/delivered", (payload) => seen.push(payload));
  return seen;
}

describe("Messenger segmented delivery accounting", () => {
  it("keeps sending later segments after one fails, then emits delivered with the real counts", async () => {
    const ctx = new Context();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("segment-2 boom"))
      .mockResolvedValueOnce([]);
    ctx.bots.push({ platform: "test", selfId: "bot-1", sendMessage } as never);
    const delivered = collector(ctx);
    const runtime = runnable([[h.text("one")], [h.text("two")], [h.text("three")]]);
    const channels = { resolve: vi.fn(async () => ({ context: runtime.context })) };
    const runtimes = { get: vi.fn(async () => runtime) };
    const messenger = new Messenger(ctx, config, channels as never, runtimes as never);

    const outcome = await messenger.post(event);

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[2]![1]).toEqual([h.text("three")]);
    expect(runtime.fail).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ produced: true, segments: 2 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      text: "onethree",
      segmentsDelivered: 2,
      segmentsFailed: 1,
      segmentsTotal: 3,
      partial: true,
    });
  });

  it("writes delivery.failed only when every segment fails", async () => {
    const ctx = new Context();
    const sendMessage = vi.fn(async () => Promise.reject(new Error("offline")));
    ctx.bots.push({ platform: "test", selfId: "bot-1", sendMessage } as never);
    const delivered = collector(ctx);
    const runtime = runnable([[h.text("one")], [h.text("two")], [h.text("three")]]);
    const channels = { resolve: vi.fn(async () => ({ context: runtime.context })) };
    const runtimes = { get: vi.fn(async () => runtime) };
    const messenger = new Messenger(ctx, config, channels as never, runtimes as never);

    const outcome = await messenger.post(event);

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(delivered).toHaveLength(0);
    expect(runtime.fail).toHaveBeenCalledOnce();
    expect(runtime.fail).toHaveBeenCalledWith("event-1", expect.objectContaining({ message: "offline" }), {
      turnId: "turn-1",
      messageId: "assistant-1",
      segmentIndex: 3,
      segmentTotal: 3,
    });
    expect(outcome).toMatchObject({ produced: false, segments: 0, error: "offline" });
  });

  it("writes delivery.failed with reason aborted when the turn is aborted mid-delivery", async () => {
    vi.useFakeTimers();
    try {
      const ctx = new Context();
      const controller = new AbortController();
      const sendMessage = vi.fn(async () => []);
      ctx.bots.push({ platform: "test", selfId: "bot-1", sendMessage } as never);
      const delivered = collector(ctx);
      const runtime = runnable([[h.text("one")], [h.text("two")]], controller.signal);
      const channels = { resolve: vi.fn(async () => ({ context: runtime.context })) };
      const runtimes = { get: vi.fn(async () => runtime) };
      const messenger = new Messenger(ctx, { ...config, pacing: { charactersPerSecond: 1, maxTotalDelayMs: 1_000 } }, channels as never, runtimes as never);

      const pending = messenger.post(event);
      await vi.advanceTimersByTimeAsync(300);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      controller.abort();
      await vi.runAllTimersAsync();
      const outcome = await pending;

      // 中断不再静默 return：delivery.failed 一条都不能少
      expect(runtime.fail).toHaveBeenCalledOnce();
      expect(runtime.fail).toHaveBeenCalledWith(
        "event-1",
        expect.objectContaining({ name: "AbortError", message: "aborted" }),
        expect.objectContaining({ turnId: "turn-1", messageId: "assistant-1" }),
      );
      // 已经发出去的那一段仍要更新 delivered，插嘴判定才不会瞎
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ text: "one", segmentsDelivered: 1, segmentsFailed: 0, partial: false });
      expect(outcome).toMatchObject({ produced: true, segments: 1, error: "aborted" });
    } finally {
      vi.useRealTimers();
    }
  });
});


// ---------------------------------------------------------------------------
// R17 / item 4：`delivered.messageId` 用平台真实 id，并标明来源
// ---------------------------------------------------------------------------

describe("Messenger delivery identity", () => {
  it("reports the platform message id and marks its source", async () => {
    const ctx = new Context();
    const sendMessage = vi.fn(async () => ["platform-msg-9"]);
    ctx.bots.push({ platform: "test", selfId: "bot-1", sendMessage } as never);
    const delivered = collector(ctx);
    const runtime = runnable([[h.text("hi")]]);
    const channels = { resolve: vi.fn(async () => ({ context: runtime.context })) };
    const runtimes = { get: vi.fn(async () => runtime) };
    const messenger = new Messenger(ctx, config, channels as never, runtimes as never);

    await messenger.post(event);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      messageId: "platform-msg-9",
      messageIdSource: "platform",
      internalMessageId: "assistant-1",
      turnId: "turn-1",
    });
  });

  it("falls back to the internal uuid when the platform returns no id", async () => {
    const ctx = new Context();
    const sendMessage = vi.fn(async () => []);
    ctx.bots.push({ platform: "test", selfId: "bot-1", sendMessage } as never);
    const delivered = collector(ctx);
    const runtime = runnable([[h.text("hi")]]);
    const channels = { resolve: vi.fn(async () => ({ context: runtime.context })) };
    const runtimes = { get: vi.fn(async () => runtime) };
    const messenger = new Messenger(ctx, config, channels as never, runtimes as never);

    await messenger.post(event);

    expect(delivered[0]).toMatchObject({
      messageId: "assistant-1",
      messageIdSource: "internal",
      internalMessageId: "assistant-1",
    });
  });

  it("uses the first delivered platform id for a multi-segment card", async () => {
    const ctx = new Context();
    const sendMessage = vi.fn().mockResolvedValueOnce(["p-one"]).mockResolvedValueOnce(["p-two"]);
    ctx.bots.push({ platform: "test", selfId: "bot-1", sendMessage } as never);
    const delivered = collector(ctx);
    const runtime = runnable([[h.text("one")], [h.text("two")]]);
    const channels = { resolve: vi.fn(async () => ({ context: runtime.context })) };
    const runtimes = { get: vi.fn(async () => runtime) };
    const messenger = new Messenger(ctx, config, channels as never, runtimes as never);

    await messenger.post(event);

    expect(delivered[0]).toMatchObject({ messageId: "p-one", messageIdSource: "platform", text: "onetwo" });
  });

  it("keeps failure attribution on the internal uuid after a platform id is known", async () => {
    vi.useFakeTimers();
    try {
      const ctx = new Context();
      const controller = new AbortController();
      const sendMessage = vi.fn(async () => ["p-one"]);
      ctx.bots.push({ platform: "test", selfId: "bot-1", sendMessage } as never);
      const delivered = collector(ctx);
      const runtime = runnable([[h.text("one")], [h.text("two")]], controller.signal);
      const channels = { resolve: vi.fn(async () => ({ context: runtime.context })) };
      const runtimes = { get: vi.fn(async () => runtime) };
      const messenger = new Messenger(ctx, { ...config, pacing: { charactersPerSecond: 1, maxTotalDelayMs: 1_000 } }, channels as never, runtimes as never);

      const pending = messenger.post(event);
      await vi.advanceTimersByTimeAsync(300);
      controller.abort();
      await vi.runAllTimersAsync();
      await pending;

      expect(runtime.fail).toHaveBeenCalledWith(
        "event-1",
        expect.objectContaining({ name: "AbortError" }),
        { turnId: "turn-1", messageId: "assistant-1", segmentIndex: 1, segmentTotal: 2 },
      );
      expect(delivered[0]).toMatchObject({ messageId: "p-one", messageIdSource: "platform", internalMessageId: "assistant-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("extracts ids from the shapes adapters actually return", () => {
    expect(extractPlatformMessageId("b")).toBe("b");
    expect(extractPlatformMessageId(["a"])).toBe("a");
    expect(extractPlatformMessageId([[{ messageId: "c" }]])).toBe("c");
    expect(extractPlatformMessageId({ id: 42 })).toBe("42");
    expect(extractPlatformMessageId([])).toBeUndefined();
    expect(extractPlatformMessageId(undefined)).toBeUndefined();
    expect(extractPlatformMessageId("   ")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R17 / item 5：准入拒绝不再静默（带平台 / 频道 / 原因 + 节流）
// ---------------------------------------------------------------------------

function shadowLogger(messenger: Messenger): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  const warn = vi.fn();
  const debug = vi.fn();
  (messenger as unknown as { logger: unknown }).logger = { level: 0, info, warn, debug };
  return { info, warn, debug };
}

function routeSession(overrides: Record<string, unknown> = {}) {
  return {
    type: "message-created",
    platform: "test",
    selfId: "bot-1",
    channelId: "guild-milky-7777",
    guildId: "7777",
    userId: "user-1",
    timestamp: 1,
    messageId: "message-1",
    isDirect: false,
    event: { channel: { type: 0 }, user: { id: "user-1" } },
    elements: [h.text("hello")],
    send: vi.fn(async () => []),
    ...overrides,
  };
}

describe("Messenger admission logging", () => {
  it("logs a channel outside the allowlist once per throttle window", async () => {
    const ctx = new Context();
    const runtime = { handle: vi.fn(async () => ({ kind: "wait" as const, eventId: "event-1" })) };
    const channels = { start: vi.fn(async () => undefined), resolve: vi.fn(async () => ({ context: {} })) };
    const runtimes = { get: vi.fn(async () => runtime) };
    const messenger = new Messenger(
      ctx,
      { ...config, allowedChannels: [{ platform: "test", channelId: "allowed" }] },
      channels as never,
      runtimes as never,
    );
    const logs = shadowLogger(messenger);

    await messenger["handle"](routeSession() as never);
    await messenger["handle"](routeSession({ messageId: "message-2" }) as never);

    expect(channels.resolve).not.toHaveBeenCalled();
    expect(runtimes.get).not.toHaveBeenCalled();
    expect(logs.info).toHaveBeenCalledTimes(1);
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "admission.not_in_allowlist",
        platform: "test",
        channelId: "guild-milky-7777",
        reason: "channel_not_in_allowedChannels",
      }),
    );
  });

  it("warns when a session carries no resolvable channel context", async () => {
    const ctx = new Context();
    const channels = { start: vi.fn(async () => undefined), resolve: vi.fn(async () => ({ context: {} })) };
    const runtimes = { get: vi.fn() };
    const messenger = new Messenger(ctx, { ...config, allowedChannels: [{ platform: "test", channelId: "*" }] }, channels as never, runtimes as never);
    const logs = shadowLogger(messenger);

    await messenger["handle"](routeSession({ guildId: undefined }) as never);

    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "admission.no_channel_context", platform: "test", channelId: "guild-milky-7777", reason: "missing_channel_context" }),
    );
    expect(runtimes.get).not.toHaveBeenCalled();
  });
});
