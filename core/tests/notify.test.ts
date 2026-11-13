import { describe, expect, it, vi } from "vitest";

import {
  createJsonFileStore,
  fallbackText,
  listenOrDegrade,
  NotifyDispatcher,
  notifyDedupeKey,
  type NotifyPayload,
  type NotifyRecord,
  type NotifyState,
  type NotifyStore,
} from "../src/notify/index.js";

const payload: NotifyPayload = {
  platform: "milky",
  selfId: "bot-1",
  channelId: "12345",
  isDirect: false,
  ticketId: "t-1",
  status: "delivered",
  messageToShion: "视频转码好了，放在 shared 里了",
  artifacts: [],
};

function memoryStore(initial: NotifyRecord[] = []): NotifyStore & { saved: NotifyRecord[][] } {
  const saved: NotifyRecord[][] = [];
  let current = initial;
  return {
    saved,
    load: () => current,
    save: (records) => {
      current = [...records];
      saved.push([...records]);
    },
  };
}

/** 立即触发的调度器：把退避重试压成立即递归，便于单测跑完整个状态机。 */
const immediate = (task: () => void) => {
  queueMicrotask(task);
  return 0;
};

async function settle(dispatcher: NotifyDispatcher, deliveryId: string): Promise<NotifyRecord> {
  for (let i = 0; i < 200; i += 1) {
    const record = dispatcher.get(deliveryId);
    if (record && record.state !== "queued" && record.state !== "delivering") return record;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("dispatcher did not settle");
}

function stateOf(dispatcher: NotifyDispatcher, deliveryId: string): NotifyState | undefined {
  return dispatcher.get(deliveryId)?.state;
}

describe("NotifyDispatcher", () => {
  it("accepts immediately with an honest produced_message:false receipt", () => {
    const dispatcher = new NotifyDispatcher({ store: memoryStore(), schedule: immediate });
    const { record, duplicate } = dispatcher.accept(payload);
    expect(duplicate).toBe(false);
    expect(record.state).toBe("queued");
    const receipt = dispatcher.receipt(record, false);
    expect(receipt).toMatchObject({
      ok: true,
      accepted: true,
      duplicate: false,
      produced_message: false,
      state: "queued",
      ticket_id: "t-1",
    });
    expect(String(receipt.status_url)).toContain(record.deliveryId);
    dispatcher.stop();
  });

  it("dedupes a hub retry instead of broadcasting twice", () => {
    const handlers = { deliver: vi.fn(async () => ({ produced: true })), fallback: vi.fn(async () => ({ produced: true })) };
    const dispatcher = new NotifyDispatcher({ store: memoryStore(), schedule: immediate });
    const first = dispatcher.accept(payload);
    dispatcher.run(first.record, handlers);
    const second = dispatcher.accept({ ...payload });
    expect(second.duplicate).toBe(true);
    expect(second.record.deliveryId).toBe(first.record.deliveryId);
    expect(dispatcher.receipt(second.record, true)).toMatchObject({ duplicate: true });
    dispatcher.stop();
  });

  it("marks delivered when the model turn actually produces a message", async () => {
    const handlers = {
      deliver: vi.fn(async () => ({ produced: true, segments: 2 })),
      fallback: vi.fn(async () => ({ produced: true })),
    };
    const dispatcher = new NotifyDispatcher({ store: memoryStore(), schedule: immediate });
    const { record } = dispatcher.accept(payload);
    dispatcher.run(record, handlers);

    const settled = await settle(dispatcher, record.deliveryId);
    expect(settled.state).toBe("delivered");
    expect(settled.produced).toBe(true);
    expect(settled.degraded).toBe(false);
    expect(handlers.fallback).not.toHaveBeenCalled();
    expect(dispatcher.describe(settled)).toMatchObject({ produced_message: true, degraded: false, attempts: 1 });
    dispatcher.stop();
  });

  it("falls back to plain text when the model turn yields nothing", async () => {
    const handlers = {
      deliver: vi.fn(async () => ({ produced: false, segments: 0, error: "Insufficient Balance" })),
      fallback: vi.fn(async () => ({ produced: true, degraded: true, segments: 1 })),
    };
    const dispatcher = new NotifyDispatcher({ store: memoryStore(), schedule: immediate });
    const { record } = dispatcher.accept(payload);
    dispatcher.run(record, handlers);

    const settled = await settle(dispatcher, record.deliveryId);
    expect(settled.state).toBe("degraded");
    expect(settled.produced).toBe(true);
    expect(settled.degraded).toBe(true);
    expect(settled.error).toBe("Insufficient Balance");
    expect(handlers.fallback).toHaveBeenCalledTimes(1);
    dispatcher.stop();
  });

  it("does not resend plain text when segments were already delivered", async () => {
    const handlers = {
      deliver: vi.fn(async () => ({ produced: false, segments: 1, error: "socket hang up" })),
      fallback: vi.fn(async () => ({ produced: true, degraded: true, segments: 1 })),
    };
    const dispatcher = new NotifyDispatcher({ store: memoryStore(), schedule: immediate });
    const { record } = dispatcher.accept(payload);
    dispatcher.run(record, handlers);

    const settled = await settle(dispatcher, record.deliveryId);
    expect(settled.state).toBe("degraded");
    expect(settled.produced).toBe(true);
    expect(handlers.fallback).not.toHaveBeenCalled();
    dispatcher.stop();
  });

  it("retries with backoff and ends failed when nothing can be sent", async () => {
    const handlers = {
      deliver: vi.fn(async () => ({ produced: false, error: "offline" })),
      fallback: vi.fn(async () => ({ produced: false, error: "offline" })),
    };
    const dispatcher = new NotifyDispatcher({ store: memoryStore(), schedule: immediate, maxAttempts: 3 });
    const { record } = dispatcher.accept(payload);
    dispatcher.run(record, handlers);

    const settled = await settle(dispatcher, record.deliveryId);
    expect(settled.state).toBe("failed");
    expect(settled.produced).toBe(false);
    expect(settled.attempts).toBe(3);
    expect(handlers.deliver).toHaveBeenCalledTimes(3);
    expect(dispatcher.receipt(settled, false)).toMatchObject({ produced_message: false, state: "failed" });
    dispatcher.stop();
  });

  it("re-arms a failed delivery when the hub retries the same effect", async () => {
    const failing = {
      deliver: async () => ({ produced: false, error: "offline" }),
      fallback: async () => ({ produced: false, error: "offline" }),
    };
    const dispatcher = new NotifyDispatcher({ store: memoryStore(), schedule: immediate, maxAttempts: 1 });
    const first = dispatcher.accept(payload);
    dispatcher.run(first.record, failing);
    expect((await settle(dispatcher, first.record.deliveryId)).state).toBe("failed");

    const retry = dispatcher.accept({ ...payload });
    expect(retry.duplicate).toBe(true);
    expect(retry.record.state).toBe("queued");
    dispatcher.stop();
  });

  it("never re-arms a record that already produced a message", () => {
    const handlers = { deliver: vi.fn(async () => ({ produced: true })), fallback: vi.fn(async () => ({ produced: true })) };
    const dispatcher = new NotifyDispatcher({ store: memoryStore(), schedule: immediate });
    const first = dispatcher.accept(payload);
    first.record.state = "failed"; // 极端情况：终态被外因写成 failed
    first.record.produced = true;
    first.record.degraded = false;

    const again = dispatcher.accept({ ...payload });
    expect(again.duplicate).toBe(true);
    expect(again.record.state).toBe("delivered");
    expect(dispatcher.pendingRecords()).toHaveLength(0);
    expect(handlers.deliver).not.toHaveBeenCalled();
    dispatcher.stop();
  });

  it("does not re-queue a produced record restored from disk", () => {
    const store = memoryStore();
    const first = new NotifyDispatcher({ store, schedule: immediate });
    const { record } = first.accept(payload);
    record.state = "delivering";
    record.produced = true; // 落盘时已经说出口，但状态还没来得及落成终态
    store.save([record]);
    first.stop();

    const second = new NotifyDispatcher({ store, schedule: immediate });
    expect(second.pendingRecords()).toHaveLength(0);
    expect(second.get(record.deliveryId)?.state).toBe("delivered");
    second.stop();
  });

  it("restores unfinished records from the store after a restart", () => {
    const store = memoryStore();
    const first = new NotifyDispatcher({ store, schedule: immediate });
    const { record } = first.accept(payload);
    record.state = "delivering"; // 模拟进程在投递中途被杀
    store.save([record]);
    first.stop();

    const second = new NotifyDispatcher({ store, schedule: immediate });
    const pending = second.pendingRecords();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.deliveryId).toBe(record.deliveryId);
    expect(pending[0]?.state).toBe("queued");
    second.stop();
  });

  it("keeps the dedupe key stable for identical payloads and distinct across statuses", () => {
    expect(notifyDedupeKey(payload)).toBe(notifyDedupeKey({ ...payload }));
    expect(notifyDedupeKey(payload)).not.toBe(notifyDedupeKey({ ...payload, status: "waiting" }));
    expect(notifyDedupeKey(payload)).toHaveLength(16);
  });

  it("prunes terminal records past the dedupe window", () => {
    let now = 1_000;
    const dispatcher = new NotifyDispatcher({ store: memoryStore(), schedule: immediate, now: () => now, dedupeTtlMs: 1_000 });
    const first = dispatcher.accept(payload);
    first.record.state = "delivered";
    first.record.produced = true;
    now += 5_000;
    const second = dispatcher.accept({ ...payload, ticketId: "t-2" });
    expect(second.duplicate).toBe(false);
    expect(dispatcher.get(first.record.deliveryId)).toBeUndefined();
    dispatcher.stop();
  });
});

describe("fallbackText", () => {
  it("drops internal artifact links and truncates long text", () => {
    const record = {
      text: "做好了\n/persist/secret.png\ngit:deadbeef",
      artifacts: [],
    } as unknown as NotifyRecord;
    expect(fallbackText(record)).toBe("做好了");

    const long = { text: "あ".repeat(400), artifacts: [] } as unknown as NotifyRecord;
    expect(fallbackText(long).length).toBeLessThanOrEqual(300);
  });
});

describe("createJsonFileStore", () => {
  it("round-trips records through a temp file", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "notify-ledger-"));
    try {
      const path = join(dir, "nested", "ledger.json");
      const store = createJsonFileStore(path);
      expect(store.load()).toEqual([]);
      const dispatcher = new NotifyDispatcher({ store, schedule: immediate });
      const { record } = dispatcher.accept(payload);
      dispatcher.stop();
      const reloaded = createJsonFileStore(path).load();
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0]?.deliveryId).toBe(record.deliveryId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stateOf", () => {
  it("returns undefined for unknown deliveries", () => {
    const dispatcher = new NotifyDispatcher({ store: memoryStore() });
    expect(stateOf(dispatcher, "nope")).toBeUndefined();
    dispatcher.stop();
  });
});

describe("listenOrDegrade (P0-1)", () => {
  it("rejects the listen wait and degrades instead of hanging forever when the port is taken", async () => {
    const { createServer } = await import("node:http");
    const blocker = createServer((_req, res) => res.end("x"));
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const addr = blocker.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const second = createServer((_req, res) => res.end("y"));
    const result = await listenOrDegrade({ server: second, port, host: "127.0.0.1" });
    expect(result.listening).toBe(false);
    expect(result.error).toContain("EADDRINUSE");

    // 关键回归：旧实现这里会永久 pending，测试会超时
    blocker.close();
  });

  it("fails fast when strict mode is on", async () => {
    const { createServer } = await import("node:http");
    const blocker = createServer((_req, res) => res.end("x"));
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const addr = blocker.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const second = createServer((_req, res) => res.end("y"));
    await expect(listenOrDegrade({ server: second, port, host: "127.0.0.1", strict: true })).rejects.toThrow(/EADDRINUSE/);
    blocker.close();
  });

  it("resolves listening:true on a free port", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => res.end("ok"));
    const result = await listenOrDegrade({ server, port: 0, host: "127.0.0.1" });
    expect(result.listening).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
