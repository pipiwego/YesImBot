import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { h, type Session } from "koishi";

import { MilkyTranslator } from "../src/platforms/milky.js";
import { OneBotTranslator } from "../src/platforms/onebot.js";

function createSession(overrides: Record<string, unknown> = {}): Session {
  return {
    type: "message-created",
    platform: "onebot",
    selfId: "10000",
    channelId: "20000",
    userId: "30000",
    timestamp: 1,
    messageId: "40000",
    isDirect: false,
    event: { type: "message", channel: { type: 0, name: "Room" }, user: { id: "30000", name: "Alice" } },
    elements: [h.text("hello")],
    ...overrides,
  } as Session;
}

describe("OneBotTranslator", () => {
  it("persists live-session images through ChannelResources", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const resources = {
      persistElements: vi.fn(async (_ctx: unknown, elements: readonly { type: string; attrs: Record<string, unknown> }[]) =>
        elements.map((el) => (el.type === "img" ? h("img", { ...el.attrs, id }) : el)),
      ),
    };

    const record = await new OneBotTranslator({ http: vi.fn() } as never).translate(
      createSession({ elements: [h("img", { src: "https://onebot.example/image" })] }),
      resources as never,
    );

    expect(resources.persistElements).toHaveBeenCalledOnce();
    expect(record).toMatchObject({ platform: "onebot", selfId: "10000", messageId: "40000", elements: [h("img", { id })] });
  });

  it("maps a poke notice to its frozen event record", async () => {
    const record = await new OneBotTranslator({ http: vi.fn() } as never).translate(
      createSession({
        type: "notice",
        messageId: undefined,
        elements: undefined,
        event: { type: "notice", subtype: "poke", channel: { type: 0 }, _data: { user_id: 30000, target_id: 10000 } },
      }),
      { assets: { put: vi.fn() } } as never,
    );

    expect(record).toMatchObject({ eventType: "notice.poke", targetId: "10000", action: "拍了拍" });
    expect(record).not.toHaveProperty("_data");
  });
});

// ---------------------------------------------------------------------------
// R17 / item 5：缺 channelId 的会话不再静默丢弃
// ---------------------------------------------------------------------------

describe("MilkyTranslator admission logging", () => {
  it("logs and throttles sessions without a channelId", async () => {
    const logger = { level: 2, info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const translator = new MilkyTranslator({ logger: () => logger } as never);
    const session = createSession({ platform: "milky", type: "notice", channelId: undefined });

    await expect(translator.translate(session as never, {} as never)).resolves.toBeNull();
    await expect(translator.translate({ ...session } as never, {} as never)).resolves.toBeNull();

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "admission.milky_no_channel",
        platform: "milky",
        channelId: "",
        reason: "missing_channel_id",
      }),
    );
  });
});
