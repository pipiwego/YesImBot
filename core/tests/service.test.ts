import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@koishijs/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import type { Config } from "../src/config.js";
import YesImBotService from "../src/index.js";
import { classifyDeliveryFailure, markDeliveryFailure } from "../src/service.js";

const config: Config = {
  basePath: "data/yesimbot",
  chatModel: "test:model",
  visionModel: undefined,
  logLevel: 2,
  allowedChannels: [],
  imageInput: false,
  resourceReadTimeout: 30,
  pacing: { charactersPerSecond: 8, maxTotalDelayMs: 60_000 },
  customInnerThought: false,
  session: { compact: { responseIdleMinutes: 0, minMessages: 20, maxFailures: 3, model: undefined }, archive: { maxKB: 0 } },
};

describe("YesImBotService facade", () => {
  it("accepts a null plugin config and applies schema defaults", () => {
    const ctx = new Context();
    ctx.baseDir = tmpdir();
    Object.assign(ctx, { "yesimbot.model": {}, database: { get: vi.fn() } });

    const service = new YesImBotService(ctx as never, null as never);

    expect((service as unknown as { config: Config }).config.logLevel).toBe(2);
  });

  it("exposes exactly the four approved domain entries", () => {
    const ctx = new Context();
    ctx.baseDir = tmpdir();
    Object.assign(ctx, { "yesimbot.model": {}, database: { get: vi.fn() } });
    const service = new YesImBotService(ctx as never, { ...config, basePath: join(tmpdir(), `yesimbot-service-${randomUUID()}`) });

    expect(service.model).toBeDefined();
    expect(service.messenger).toMatchObject({ use: expect.any(Function), post: expect.any(Function) });
    expect(service.agent).toMatchObject({ use: expect.any(Function), will: expect.any(Function) });
    expect(service.resource).toMatchObject({ get: expect.any(Function), use: expect.any(Function) });
    expect("trigger" in service).toBe(false);
    expect("reset" in service).toBe(false);
    expect("assets" in service).toBe(false);
    expect("getStoragePath" in service).toBe(false);
  });
  it("threads image input and converts resource timeout seconds", async () => {
    vi.useFakeTimers();
    try {
      const ctx = new Context();
      ctx.baseDir = tmpdir();
      Object.assign(ctx, { "yesimbot.model": {}, database: { get: vi.fn() } });
      const basePath = join(tmpdir(), `yesimbot-service-config-${randomUUID()}`);
      const service = new YesImBotService(ctx as never, { ...config, basePath, imageInput: true, resourceReadTimeout: 1 });
      const resources = await service.resource.get({ type: "guild", platform: "test", channelId: "room", guildId: "room" });
      resources.use({ scheme: "slow", prompt: "slow reader", setup: async () => Promise.withResolvers<never>().promise });
      const controller = new AbortController();
      let cause: unknown;
      void resources.openStrict("slow:///file", controller.signal).catch((error: unknown) => {
        cause = error;
      });
      try {
        expect(resources.imageInput).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(cause).toMatchObject({ code: "timeout" });
      } finally {
        controller.abort();
        await vi.runAllTimersAsync();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// R17 / item 1：给 hub 的四态判定留下可识别的失败原因
// ---------------------------------------------------------------------------

describe("delivery failure markers", () => {
  it("marks connection-level failures as unreachable", () => {
    expect(classifyDeliveryFailure("connect ECONNREFUSED 172.20.0.5:3000")).toBe("unreachable");
    expect(classifyDeliveryFailure("ConnectTimeout: timed out")).toBe("unreachable");
    expect(classifyDeliveryFailure("No Bot is available for milky:2690928435")).toBe("unreachable");
    expect(markDeliveryFailure("no-bot-online")).toBe("unreachable: no-bot-online");
  });

  it("marks peer-side refusal or degradation as peer_degraded", () => {
    expect(classifyDeliveryFailure("notify-dispatcher-unavailable")).toBe("peer_degraded");
    expect(markDeliveryFailure("delivery degraded: plain fallback used")).toBe("peer_degraded: delivery degraded: plain fallback used");
  });

  it("leaves unrelated failures untouched and stays idempotent", () => {
    expect(classifyDeliveryFailure("Group not found")).toBeUndefined();
    expect(markDeliveryFailure("Group not found")).toBe("Group not found");
    expect(markDeliveryFailure("unreachable: ECONNREFUSED")).toBe("unreachable: ECONNREFUSED");
  });

  it("decorates a status receipt with the marker hub reads", () => {
    const ctx = new Context();
    ctx.baseDir = tmpdir();
    Object.assign(ctx, { "yesimbot.model": {}, database: { get: vi.fn() } });
    const service = new YesImBotService(ctx as never, { ...config, basePath: join(tmpdir(), `yesimbot-r17-${randomUUID()}`) });
    const decorate = (service as unknown as { decorateNotifyStatus: (value: Record<string, unknown>) => Record<string, unknown> })
      .decorateNotifyStatus.bind(service);

    expect(decorate({ state: "failed", error: "fetch failed" })).toMatchObject({
      state: "failed",
      reason: "unreachable",
      error: "unreachable: fetch failed",
      last_error: "unreachable: fetch failed",
    });
    expect(decorate({ state: "failed", error: "Group not found" })).toEqual({ state: "failed", error: "Group not found" });
    expect(decorate({ state: "delivered", produced_message: true })).toEqual({ state: "delivered", produced_message: true });
  });
});
