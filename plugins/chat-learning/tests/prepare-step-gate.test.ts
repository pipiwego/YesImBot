import { describe, expect, it, vi } from "vitest";

import { awaitRebuildForStep, DEFAULT_REBUILD_WAIT_MS } from "../src/rebuild-gate.js";

function never<T = void>(): Promise<T> {
  return new Promise<T>(() => {
    /* 永不 settle：模拟卡住的模型标注（10–40s 甚至更久） */
  });
}

describe("awaitRebuildForStep（prepareStep 的 rebuild 闸门）", () => {
  it("有缓存且上游 rebuild 卡住时立即返回，不 await 也不取消它", async () => {
    const inflight = never();
    let settled = false;
    void inflight.finally(() => {
      settled = true;
    });
    const started = Date.now();

    const result = await awaitRebuildForStep({ hasCache: true, inflight, inflightStartedAt: Date.now() - 12_000 });

    expect(Date.now() - started).toBeLessThan(100);
    expect(result.waited).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.reason).toBe("inflight_skipped");
    expect(result.runningMs).toBeGreaterThanOrEqual(12_000);
    expect(result.waitedMs).toBe(0);
    // 没有取消在飞的 rebuild
    expect(settled).toBe(false);
  });

  it("无缓存且上游 rebuild 卡住时，最多 2 秒就用空块继续", async () => {
    const started = Date.now();

    const result = await awaitRebuildForStep({
      hasCache: false,
      inflight: never(),
      inflightStartedAt: Date.now(),
    });

    const elapsed = Date.now() - started;
    expect(DEFAULT_REBUILD_WAIT_MS).toBe(2000);
    expect(result.waited).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.reason).toBe("inflight_timeout");
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(2600);
    expect(result.waitedMs).toBeGreaterThanOrEqual(1900);
  });

  it("没有在飞任务时启动本地重建并等它完成", async () => {
    const startLocal = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const result = await awaitRebuildForStep({ hasCache: true, startLocal });

    expect(startLocal).toHaveBeenCalledTimes(1);
    expect(result.waited).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("本地重建超过上限时按 local_timeout 返回，不阻塞回复", async () => {
    const started = Date.now();

    const result = await awaitRebuildForStep({ hasCache: false, startLocal: () => never(), timeoutMs: 120 });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.timedOut).toBe(true);
    expect(result.reason).toBe("local_timeout");
  });

  it("重建抛错时吞掉异常，交给调用方继续回复", async () => {
    const result = await awaitRebuildForStep({
      hasCache: false,
      startLocal: async () => {
        throw new Error("storage boom");
      },
    });

    expect(result.waited).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});
