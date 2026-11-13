import { describe, expect, it, vi } from "vitest";

import { createTurnQueue, DEFAULT_INTERRUPT_TIMEOUT_MS, type TurnQueueOptions } from "../src/turn.js";
import type { AgentMessage } from "../src/message.js";

function message(content: string): AgentMessage {
  return { role: "user", id: content, timestamp: 1, content } as AgentMessage;
}

function createLogger() {
  const warn = vi.fn();
  return { warn };
}

describe("turn queue interrupt abandon", () => {
  it("默认上限是 3 秒", () => {
    expect(DEFAULT_INTERRUPT_TIMEOUT_MS).toBe(3_000);
  });

  it("onRun 永不返回时 interrupt 在超时后 abandon，而不是无限等待", async () => {
    const logger = createLogger();
    const onAbandon = vi.fn();
    const queue = createTurnQueue({
      onRun: () => new Promise(() => undefined),
      interruptTimeoutMs: 30,
      logger,
      onAbandon,
    });

    queue.enqueue([message("first")]);
    await Promise.resolve();

    const startedAt = Date.now();
    await queue.interrupt("stop");
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(1_000);
    expect(onAbandon).toHaveBeenCalledOnce();
    const info = onAbandon.mock.calls[0][0];
    expect(info.timeoutMs).toBe(30);
    expect(info.turnId).toEqual(expect.any(String));
    expect(info.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("interrupt 等待超时"), expect.objectContaining({ timeoutMs: 30 }));
  });

  it("abandon 之后队列能继续跑下一个 turn（tail 不被悬挂的 turn 占死）", async () => {
    const onAbandon = vi.fn();
    let releaseHanging!: () => void;
    const hanging = new Promise<void>((resolve) => {
      releaseHanging = resolve;
    });

    const finished: string[] = [];
    const queue = createTurnQueue({
      onRun: async (request) => {
        if (request.messages[0]?.id === "hanging") {
          await hanging;
        }
        finished.push(request.turnId);
        return { turnId: request.turnId, status: "done", messages: [] };
      },
      interruptTimeoutMs: 20,
      onAbandon,
    });

    const hangingTurnId = queue.enqueue([message("hanging")]);
    await Promise.resolve();
    expect(queue.activeTurnId).toBe(hangingTurnId);

    await queue.interrupt("reset");
    expect(onAbandon).toHaveBeenCalledOnce();
    // 放弃等待后 active 立即释放
    expect(queue.activeTurnId).toBeUndefined();

    const nextTurnId = queue.enqueue([message("next")]);
    await queue.wait();
    expect(finished).toContain(nextTurnId);
    expect(queue.isIdle()).toBe(true);

    // 悬挂的 onRun 事后 settle 只补日志，不会把队列状态改坏
    releaseHanging();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.isIdle()).toBe(true);
  });

  it("turn 正常收尾时 interrupt 不 abandon（不误伤）", async () => {
    const onAbandon = vi.fn();
    const queue = createTurnQueue({
      onRun: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { turnId: request.turnId, status: "aborted", messages: [] };
      },
      interruptTimeoutMs: 200,
      onAbandon,
    });

    queue.enqueue([message("quick")]);
    await queue.interrupt("stop");

    expect(onAbandon).not.toHaveBeenCalled();
    expect(queue.isIdle()).toBe(true);
  });

  it("没有活动 turn 时 interrupt 不做事", async () => {
    const options: TurnQueueOptions = { onRun: vi.fn() };
    const queue = createTurnQueue(options);
    await expect(queue.interrupt()).resolves.toBeUndefined();
  });
});
