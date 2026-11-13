/**
 * prepareStep 的 rebuild 闸门（R15）。
 *
 * 背景：`rebuild()` 是单飞的 —— 已有任务在飞时它直接返回同一个 promise，
 * 且 `allowModel` 参数被忽略。而 prepareStep 里原本写的是 `await rebuild(false)`，
 * 本意是"随手刷一下本地快照（不调模型）"，实际却可能拿到 syncHooks 发起的
 * `rebuild(true)`（模型标注 10–40 秒），于是整轮回复被模型标注堵住。
 *
 * 策略：
 * - 有缓存时**绝不** await 在飞的 rebuild，直接用上次结果，同时不取消 rebuild；
 * - 没有缓存（首轮）必须等时，最多等 `DEFAULT_REBUILD_WAIT_MS`，超时用空块继续；
 * - 没有在飞任务时，启动一个本地快照重建并同样施加上限。
 *
 * 返回值交给调用方记 debug 日志（reason + 已运行时长），让运维能看到"跳过一次重建"。
 */

export const DEFAULT_REBUILD_WAIT_MS = 2000;

export type RebuildGateSkipReason = "inflight_skipped" | "inflight_timeout" | "local_timeout";

export interface RebuildGateInput {
  /** 当前是否有可用缓存（上一次快照已就绪）。 */
  readonly hasCache: boolean;
  /** 正在飞的 rebuild；没有则 undefined。 */
  readonly inflight?: Promise<unknown> | undefined;
  /** 在飞任务的开始时刻（Date.now()），用于报告已运行时长。 */
  readonly inflightStartedAt?: number | undefined;
  /** 没有在飞任务时，用来启动本地快照重建（不调模型）。 */
  readonly startLocal?: (() => Promise<unknown>) | undefined;
  /** 等待上限，默认 DEFAULT_REBUILD_WAIT_MS。 */
  readonly timeoutMs?: number | undefined;
}

export interface RebuildGateResult {
  /** 是否等待过（false = 直接用缓存返回）。 */
  readonly waited: boolean;
  /** 是否等超时了（此时调用方用缓存/空块继续）。 */
  readonly timedOut: boolean;
  /** 跳过原因；没有跳过时为 undefined。 */
  readonly reason?: RebuildGateSkipReason | undefined;
  /** 在飞任务已运行时长（ms）。 */
  readonly runningMs: number;
  /** 本次实际等待时长（ms）。 */
  readonly waitedMs: number;
}

export async function awaitRebuildForStep(input: RebuildGateInput): Promise<RebuildGateResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_REBUILD_WAIT_MS;
  const startedAt = Date.now();
  const inflight = input.inflight;

  if (inflight) {
    const runningMs = Math.max(0, startedAt - (input.inflightStartedAt ?? startedAt));
    if (input.hasCache) {
      // 有缓存：不 await、不取消，直接用上一轮结果。
      return { waited: false, timedOut: false, reason: "inflight_skipped", runningMs, waitedMs: 0 };
    }
    const timedOut = await raceWithTimeout(inflight, timeoutMs);
    return {
      waited: true,
      timedOut,
      reason: timedOut ? "inflight_timeout" : undefined,
      runningMs: Math.max(0, Date.now() - (input.inflightStartedAt ?? startedAt)),
      waitedMs: Date.now() - startedAt,
    };
  }

  if (!input.startLocal) {
    return { waited: false, timedOut: false, runningMs: 0, waitedMs: 0 };
  }

  const timedOut = await raceWithTimeout(input.startLocal(), timeoutMs);
  return {
    waited: true,
    timedOut,
    reason: timedOut ? "local_timeout" : undefined,
    runningMs: 0,
    waitedMs: Date.now() - startedAt,
  };
}

/** 返回 true 表示超时。任务的 reject 被吞掉（调用方自己负责日志），避免 unhandled rejection。 */
async function raceWithTimeout(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  });
  try {
    const outcome = await Promise.race([task.then(() => "done" as const, () => "error" as const), timeout]);
    return outcome === "timeout";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
