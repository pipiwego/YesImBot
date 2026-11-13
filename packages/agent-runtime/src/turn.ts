import type { LanguageModelUsage } from "ai";

import { AgentBusyError } from "./errors.js";
import { createRandomId } from "./id.js";
import { AgentMessage } from "./message.js";

export type BusyBehavior = "defer" | "join" | "reject";

export type TurnStatus = "queued" | "running" | "done" | "failed" | "aborted" | "abandoned";

/** interrupt() 等待 turn 收尾的默认上限（毫秒）。超过即放弃等待并释放队列。 */
export const DEFAULT_INTERRUPT_TIMEOUT_MS = 3_000;

export interface TurnRequest {
  readonly turnId: string;
  readonly submittedAt: number;
  readonly messages: AgentMessage[];
  readonly signal: AbortSignal;
  addJoined(messages: AgentMessage[], persistence?: Promise<void>): void;
  drainJoined(): Promise<AgentMessage[]>;
}

export interface TurnQueueLogger {
  warn?(message: string, meta?: unknown): void;
}

/** interrupt() 超时放弃等待时回传的信息（用于标记 turn 状态与落日志/事件）。 */
export interface TurnAbandonInfo {
  readonly turnId: string;
  readonly reason?: unknown;
  /** 该 turn 从开始执行到被放弃的时长（毫秒） */
  readonly elapsedMs: number;
  /** interrupt() 使用的等待上限（毫秒） */
  readonly timeoutMs: number;
  /** 放弃时仍在队列里排队的 turn 数 */
  readonly queueLength: number;
}

export interface TurnQueueOptions {
  onRun(request: TurnRequest): Promise<TurnResult>;
  /** interrupt() 等待 turn 收尾的上限（毫秒），默认 {@link DEFAULT_INTERRUPT_TIMEOUT_MS} */
  interruptTimeoutMs?: number;
  logger?: TurnQueueLogger;
  /** 放弃等待后的回调：用来记事件 / 标状态。抛错会被忽略，不影响队列释放。 */
  onAbandon?(info: TurnAbandonInfo): void;
}

export interface TurnError {
  name: string;
  message: string;
  cause?: string;
}

export interface TurnResult {
  turnId: string;
  status: Exclude<TurnStatus, "queued" | "running">;
  messages: AgentMessage[];
  error?: TurnError;
  usage?: Partial<LanguageModelUsage>;
}

export interface AgentWaitOptions {
  signal?: AbortSignal;
}

interface QueuedTurn {
  request: TurnRequest;
  controller: AbortController;
}

export function createTurnQueue(options: TurnQueueOptions) {
  const queue: QueuedTurn[] = [];
  const idleWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void }>();

  let active: QueuedTurn | undefined;
  let activeDone: Promise<void> | undefined;
  let activeStartedAt = 0;
  let activeAbandon: ((reason?: unknown) => void) | undefined;
  let pumping = false;

  const isIdle = () => active === undefined && queue.length === 0 && !pumping;

  const notifyIdleWaiters = () => {
    if (!isIdle()) {
      return;
    }

    for (const waiter of [...idleWaiters]) {
      idleWaiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve();
    }
  };

  async function pump() {
    if (active || pumping) {
      return;
    }

    const next = queue.shift();
    if (!next) {
      notifyIdleWaiters();
      return;
    }

    pumping = true;
    active = next;
    activeStartedAt = Date.now();

    let settleActive!: () => void;
    activeDone = new Promise<void>((resolve) => {
      settleActive = resolve;
    });

    // 放弃等待的开关：resolve 后 pump 立刻释放 active 并继续下一个 turn，
    // 不再等那个可能永不结束的 onRun。onRun 本身留在后台，settle 时只补一条日志。
    let abandonedReason: unknown;
    let abandonActive!: (reason?: unknown) => void;
    const abandoned = new Promise<"abandoned">((resolve) => {
      abandonActive = (reason?: unknown) => {
        abandonedReason = reason;
        resolve("abandoned");
      };
    });
    activeAbandon = abandonActive;

    const run = options.onRun(next.request).then(
      () => "settled" as const,
      (error: unknown) => {
        options.logger?.warn?.("turn onRun rejected", { turnId: next.request.turnId, error: error instanceof Error ? error.message : String(error) });
        return "settled" as const;
      },
    );

    try {
      const outcome = await Promise.race([run, abandoned]);
      if (outcome === "abandoned") {
        const elapsedMs = activeStartedAt > 0 ? Date.now() - activeStartedAt : Date.now() - next.request.submittedAt;
        void run.then(() => {
          options.logger?.warn?.("abandoned turn settled late", {
            turnId: next.request.turnId,
            elapsedMs: Date.now() - next.request.submittedAt,
            abandonedReason: abandonedReason === undefined ? undefined : String(abandonedReason),
          });
        });
        options.logger?.warn?.("turn abandoned: 队列继续，后续消息不再排队等这个 turn", {
          turnId: next.request.turnId,
          elapsedMs,
          queueLength: queue.length,
        });
      }
    } finally {
      active = undefined;
      activeAbandon = undefined;
      activeStartedAt = 0;
      const done = settleActive;
      activeDone = undefined;
      pumping = false;
      done();
      void pump();
      notifyIdleWaiters();
    }
  }

  return {
    get activeTurnId() {
      return active?.request.turnId;
    },
    isIdle,
    enqueue(messages: AgentMessage[], behavior: BusyBehavior = "defer", persistence?: Promise<void>) {
      if (active && behavior === "reject") {
        throw new AgentBusyError();
      }

      if (active && behavior === "join") {
        active.request.addJoined(messages, persistence);
        return active.request.turnId;
      }

      const queued = createQueuedTurn(messages);
      queue.push(queued);
      void pump();
      return queued.request.turnId;
    },
    wait(options: AgentWaitOptions = {}) {
      const { signal } = options;

      if (signal?.aborted) {
        return Promise.reject(createAbortError());
      }

      if (isIdle()) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve, reject) => {
        const waiter: { resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void } = { resolve, reject, signal };

        waiter.onAbort = () => {
          idleWaiters.delete(waiter);
          reject(createAbortError());
        };

        idleWaiters.add(waiter);
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
      });
    },
    async interrupt(reason?: unknown) {
      const target = active;
      if (!target) {
        return;
      }

      if (!target.controller.signal.aborted) {
        target.controller.abort(reason);
      }

      const done = activeDone;
      const abandon = activeAbandon;
      if (!done || !abandon) {
        return;
      }

      const timeoutMs = Math.max(1, options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });

      let outcome: "settled" | "timeout";
      try {
        outcome = await Promise.race([done.then(() => "settled" as const), timedOut]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }

      if (outcome === "settled") {
        return;
      }

      const info: TurnAbandonInfo = {
        turnId: target.request.turnId,
        reason,
        elapsedMs: activeStartedAt > 0 ? Date.now() - activeStartedAt : Date.now() - target.request.submittedAt,
        timeoutMs,
        queueLength: queue.length,
      };

      options.logger?.warn?.(`interrupt 等待超时（${timeoutMs}ms），放弃等待并释放队列：turn ${info.turnId} 已运行 ${info.elapsedMs}ms`, info);

      try {
        options.onAbandon?.(info);
      } catch (error) {
        options.logger?.warn?.("onAbandon callback failed", { turnId: info.turnId, error: error instanceof Error ? error.message : String(error) });
      }

      abandon(reason);

      // 等 pump 真正腾出 active（微任务级）再返回，保证调用方拿回控制权时队列已经可以继续。
      // 再加一道 1s 保险，避免极端情况下又变成无限等待。
      let guard: ReturnType<typeof setTimeout> | undefined;
      const guarded = new Promise<void>((resolve) => {
        guard = setTimeout(resolve, 1_000);
      });
      try {
        await Promise.race([done, guarded]);
      } finally {
        if (guard) {
          clearTimeout(guard);
        }
      }
    },
  };
}

function createQueuedTurn(messages: AgentMessage[]): QueuedTurn {
  const controller = new AbortController();
  const joined: AgentMessage[] = [];
  const joinedPersistence: Promise<void>[] = [];

  const request: TurnRequest = {
    turnId: createRandomId(),
    submittedAt: Date.now(),
    messages: [...messages],
    signal: controller.signal,
    addJoined(nextMessages, persistence) {
      joined.push(...nextMessages);
      if (persistence) {
        joinedPersistence.push(persistence);
      }
    },
    async drainJoined() {
      if (joinedPersistence.length > 0) {
        const pending = joinedPersistence.splice(0, joinedPersistence.length);
        await Promise.all(pending);
      }
      return joined.splice(0, joined.length);
    },
  };

  return { request, controller };
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}
