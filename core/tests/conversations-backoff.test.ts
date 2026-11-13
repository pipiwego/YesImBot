import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEntry } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateText }));

import { COMPACT_BACKOFF_STEPS_MS, Conversation } from "../src/conversations/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function createConversation(options: { minMessages?: number; maxFailures?: number; degradeKeepMessages?: number; now: () => number }) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-backoff-"));
  roots.push(root);
  const conversation = new Conversation(root, {
    minMessages: options.minMessages ?? 2,
    maxFailures: options.maxFailures ?? 1,
    degradeKeepMessages: options.degradeKeepMessages,
    now: options.now,
  });
  await conversation.init();
  return conversation;
}

async function appendMessages(conversation: Conversation, count: number) {
  const entries = Array.from({ length: count }, (_, index) =>
    createEntry("message", { id: `m${index + 1}`, timestamp: index + 1, role: index % 2 === 0 ? "user" : "assistant", content: `line ${index + 1}` }),
  );
  await conversation.storage.append(...entries);
}

describe("Conversation compact 失败退避", () => {
  it("达到失败上限后按 5 分钟 / 15 分钟 / 1 小时退避重试，而不是永久关闭", async () => {
    let now = 1_000_000;
    generateText.mockReset().mockRejectedValue(new Error("model unavailable"));
    const conversation = await createConversation({ now: () => now });
    await appendMessages(conversation, 4);

    const input = { model: {} as never, personaName: "Athena", persona: "persona" };

    // 第 1 次：真的调模型，失败
    await expect(conversation.compact("manual", input)).resolves.toMatchObject({ compacted: false, reason: "model_failure" });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(conversation.failuresCount()).toBe(1);
    expect(conversation.compactBackoffRemainingMs()).toBe(COMPACT_BACKOFF_STEPS_MS[0]);

    // 退避窗口内：不再打模型
    now += 60_000;
    await expect(conversation.compact("manual", input)).resolves.toEqual({ compacted: false, reason: "failure_limit" });
    expect(generateText).toHaveBeenCalledTimes(1);

    // 5 分钟到点：允许重试（第 2 次），仍失败 → 退避升到 15 分钟
    now += 5 * 60_000;
    await expect(conversation.compact("manual", input)).resolves.toMatchObject({ compacted: false, reason: "model_failure" });
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(conversation.compactBackoffRemainingMs()).toBe(COMPACT_BACKOFF_STEPS_MS[1]);

    // 15 分钟到点：再试（第 3 次），失败 → 封顶 1 小时
    now += 15 * 60_000;
    await expect(conversation.compact("manual", input)).resolves.toMatchObject({ compacted: false, reason: "model_failure" });
    expect(generateText).toHaveBeenCalledTimes(3);
    expect(conversation.compactBackoffRemainingMs()).toBe(COMPACT_BACKOFF_STEPS_MS[2]);

    // 封顶后继续保持 1 小时，不会永久关闭
    now += 60 * 60_000;
    await expect(conversation.compact("manual", input)).resolves.toMatchObject({ compacted: false, reason: "model_failure" });
    expect(generateText).toHaveBeenCalledTimes(4);
    expect(conversation.compactBackoffRemainingMs()).toBe(COMPACT_BACKOFF_STEPS_MS[2]);
  });

  it("退避窗口内模型恢复后，下一次到点就能成功并把 failures 清零", async () => {
    let now = 2_000_000;
    generateText.mockReset().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ text: "recovered memory" });
    const conversation = await createConversation({ now: () => now });
    await appendMessages(conversation, 4);
    const input = { model: {} as never, personaName: "Athena", persona: "persona" };

    await conversation.compact("manual", input);
    expect(conversation.failuresCount()).toBe(1);
    now += 5 * 60_000;
    await expect(conversation.compact("manual", input)).resolves.toEqual({ compacted: true });
    expect(conversation.failuresCount()).toBe(0);
    expect(conversation.compactBackoffRemainingMs()).toBe(0);
  });

  it("压缩长期不可用时降级截断最老消息，并写一条 degraded compact 边界", async () => {
    let now = 3_000_000;
    generateText.mockReset().mockRejectedValue(new Error("model unavailable"));
    const conversation = await createConversation({ now: () => now, degradeKeepMessages: 2 });
    await appendMessages(conversation, 8);
    const input = { model: {} as never, personaName: "Athena", persona: "persona" };

    await conversation.compact("manual", input);
    expect(generateText).toHaveBeenCalledTimes(1);

    // 退避窗口内再次触发：不调模型，但因为消息已失控增长（8 >= 2*3），降级截断
    const result = await conversation.compact("manual", input);
    expect(result).toMatchObject({ compacted: false, reason: "failure_limit", degraded: true });
    expect(generateText).toHaveBeenCalledTimes(1);

    const entries = await conversation.storage.read();
    const compact = entries.at(-1);
    expect(compact).toMatchObject({ type: "compact", data: { degraded: true } });
    const summary = (compact as { data: { summary: string } }).data.summary;
    expect(summary).toContain("自动降级");
    expect(summary).toContain("丢弃最早的 6 条消息");

    // 送进模型的上下文只剩最近 2 条消息 + 那条 compact 边界
    const lastCompactIndex = entries.reduce((last, entry, index) => (entry.type === "compact" ? index : last), -1);
    const afterCompact = entries.slice(lastCompactIndex + 1).filter((entry) => entry.type === "message");
    expect(afterCompact).toHaveLength(0);
    expect(entries.slice(0, lastCompactIndex).filter((entry) => entry.type === "message")).toHaveLength(8);

    // 仍然保留重试路径（不是永久关闭）：窗口到点后会再次尝试，只是降级后消息不足，这次报 minimum_messages
    now += 5 * 60_000;
    await expect(conversation.compact("manual", input)).resolves.toEqual({ compacted: false, reason: "minimum_messages" });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("消息没有失控增长时不会降级", async () => {
    let now = 4_000_000;
    generateText.mockReset().mockRejectedValue(new Error("model unavailable"));
    const conversation = await createConversation({ now: () => now, degradeKeepMessages: 5 });
    await appendMessages(conversation, 4);
    const input = { model: {} as never, personaName: "Athena", persona: "persona" };

    await conversation.compact("manual", input);
    const result = await conversation.compact("manual", input);
    expect(result).toEqual({ compacted: false, reason: "failure_limit" });
    expect(await conversation.storage.read()).toHaveLength(4);
  });
});
