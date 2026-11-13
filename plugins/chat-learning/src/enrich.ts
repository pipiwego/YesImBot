/**
 * 模型标注 → 本地快照的合并层（R15 缺陷 2）。
 *
 * 从 index.ts 的 enrichWithModel 抽出来，原因有两个：
 * 1. 原实现只把 `next`（buildSnapshot 出来的空 patterns）当基线，拿不到"上一次学到的规律"，
 *    所以空标注必然把 responsePatterns/initiationPatterns 清成 []；
 * 2. 纯函数 + 依赖注入后可以直接单测"空标注保留旧值"。
 */
import type { LanguageModel } from "ai";

import { buildMemeTemplates } from "./memes.js";
import type { ModelCache } from "./model-cache.js";
import { applyPatternAnnotations, classifyPatternsWithModelDetailed } from "./patterns.js";
import type { ChatLearningConfig, ChatLearningState } from "./types.js";

export interface EnrichLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface EnrichDeps {
  /** 已解析好的标注模型；undefined 表示没配模型，直接原样返回。 */
  readonly model: LanguageModel | undefined;
  readonly config: ChatLearningConfig;
  readonly logger: EnrichLogger;
  readonly cache?: ModelCache | undefined;
  readonly modelId?: string | undefined;
}

/**
 * 用模型标注结果补全快照。
 * - 成功且非空：替换（部分字段为空时只保留该字段的旧值）；
 * - 成功但确实没有新规律：保留旧值 + info；
 * - 上游报错 / 解析失败：保留旧值 + warn。
 */
export async function enrichSnapshotWithModel(
  next: ChatLearningState,
  previous: ChatLearningState | undefined,
  deps: EnrichDeps,
): Promise<ChatLearningState> {
  const model = deps.model;
  if (!model) return next;
  const baseline = {
    responsePatterns: previous?.responsePatterns ?? [],
    initiationPatterns: previous?.initiationPatterns ?? [],
  };
  try {
    const outcome = await classifyPatternsWithModelDetailed(
      model,
      next.turns,
      next.segments,
      next.links,
      { maxThreads: deps.config.maxModelThreads, maxThreadMessages: deps.config.maxModelThreadMessages },
      deps.cache,
    );
    const applied = applyPatternAnnotations(baseline, outcome);
    const meta = {
      model: deps.modelId,
      reason: applied.reason,
      applied: applied.applied,
      newResponse: applied.newResponse,
      newInitiation: applied.newInitiation,
      keptResponse: applied.keptResponse,
      keptInitiation: applied.keptInitiation,
    };

    if (outcome.status === "failed") {
      deps.logger.warn("chat_learning.model_enrich_annotation_failed", { ...meta, detail: outcome.detail });
    } else if (applied.level === "info") {
      deps.logger.info("chat_learning.model_enrich_annotation_kept", {
        ...meta,
        kept: applied.keptResponse + applied.keptInitiation,
        detail: outcome.status === "empty" ? "no annotatable threads" : "annotation returned nothing",
      });
    }
    if (!applied.applied) {
      // 保留旧值：不要顺手重建 memeTemplates，否则同样的空输入会把模板也刷空。
      return {
        ...next,
        responsePatterns: applied.responsePatterns,
        initiationPatterns: applied.initiationPatterns,
        memeTemplates: previous?.memeTemplates ?? next.memeTemplates ?? [],
      };
    }

    const phrases = [
      ...applied.responsePatterns.map((pattern) => ({ phrase: pattern.phrase, frequency: pattern.frequency })),
      ...applied.initiationPatterns.map((pattern) => ({ phrase: pattern.phrase, frequency: pattern.frequency })),
    ];
    const templates = await buildMemeTemplates(model, phrases, Date.now(), deps.cache);
    const previousTemplates = previous?.memeTemplates ?? [];
    if (templates.length === 0 && previousTemplates.length > 0) {
      deps.logger.info("chat_learning.model_enrich_templates_kept", { model: deps.modelId, kept: previousTemplates.length });
    }
    return {
      ...next,
      responsePatterns: applied.responsePatterns,
      initiationPatterns: applied.initiationPatterns,
      memeTemplates: templates.length > 0 ? templates : previousTemplates,
      builtAt: Date.now(),
    };
  } catch (cause) {
    deps.logger.warn("chat_learning.model_enrich_failed", {
      model: deps.modelId,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return next;
  }
}
