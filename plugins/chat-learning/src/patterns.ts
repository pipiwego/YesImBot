import { generateText, type LanguageModel } from "ai";
import { z } from "zod";

import { buildConversationChains } from "./links.js";
import { modelCacheId, type ModelCache } from "./model-cache.js";
import { patternPhrase, sanitizeForDisplay } from "./text.js";
import type {
  ConversationSegment,
  InitiationIntent,
  InitiationPattern,
  LocalChainSample,
  MessageLink,
  MessageTurn,
  ResponseIntent,
  ResponsePattern,
} from "./types.js";

const RESPONSE_INTENTS = ["ack", "agree", "question", "joke", "roast", "empathy", "refuse"] as const;

const INITIATION_INTENTS = ["share", "question", "react", "recall", "opinion"] as const;

const messageAnnotationSchema = z.object({ id: z.string(), role: z.enum(["response", "initiation", "noise"]), intent: z.string() });

const modelOutputSchema = z.object({ messages: z.array(messageAnnotationSchema).optional() });

const MAX_MODEL_MESSAGES = 80;

const MAX_MODEL_CHARS = 12_000;

export interface PatternSnapshot {
  readonly responsePatterns: readonly ResponsePattern[];
  readonly initiationPatterns: readonly InitiationPattern[];
}

export interface ClassifyModelOptions {
  readonly maxThreads?: number;
  readonly maxThreadMessages?: number;
}

/**
 * 标注结果的三种语义（R15）：
 * - ok     ：成功拿到结果，可能为空数组（模型确实认为没有可学规律）；
 * - empty  ：成功但输入侧没有可标注的东西（没有线程 / 全部 noise 之外的无效标签）；
 * - failed ：上游报错或输出无法解析。
 * 只有 ok 才允许覆盖已有规律；empty/failed 一律保留旧值，只是日志级别不同。
 */
export type PatternAnnotationOutcome =
  | { readonly status: "ok"; readonly snapshot: PatternSnapshot }
  | { readonly status: "empty"; readonly reason: "no_threads" }
  | { readonly status: "failed"; readonly reason: "model_error" | "parse_error"; readonly detail: string };

interface ClassifyThread {
  readonly turns: readonly MessageTurn[];
}

/** 详细版：保留失败/空结果的区别，供调用方决定是否覆盖已有规律。失败结果不进缓存。 */
export async function classifyPatternsWithModelDetailed(
  model: LanguageModel,
  turns: readonly MessageTurn[],
  segments: readonly ConversationSegment[],
  links: readonly MessageLink[] = [],
  options: ClassifyModelOptions = {},
  cache?: ModelCache,
): Promise<PatternAnnotationOutcome> {
  const key = cache?.key(["classify", modelCacheId(model), turns, segments, links, options]);
  const produce = async (): Promise<PatternAnnotationOutcome> => {
    const maxThreads = options.maxThreads ?? 3;
    const maxThreadMessages = options.maxThreadMessages ?? 30;
    const threads = selectClassifyThreads(segments, links, maxThreads, maxThreadMessages);
    if (threads.length === 0) return { status: "empty", reason: "no_threads" };

    const { prompt, messageByPromptId } = buildThreadPrompt(threads);
    const system = [
      "你是一个群聊行为标注器。",
      "你会看到若干完整对话线程，请为线程中的每条消息标注 role 和 intent。",
      "role=response 表示消息是在回应前面某人的话，intent 从 agree|ack|question|joke|roast|empathy|refuse 中选择。",
      "role=initiation 表示消息是在发起新话题或开启新一轮对话，intent 从 share|question|react|recall|opinion 中选择。",
      "如果消息不适合作为发言风格样本，例如纯状态、无意义、命令、通知、纯媒体或无法判断，使用 role=noise。",
      "必须参考完整线程上下文判断，不要只根据单条消息猜测。",
      "id 必须原样返回，不要改写、遗漏或补充消息。",
      '只返回 JSON：{"messages":[{"id":"t0-m0","role":"response","intent":"agree"}]}',
      "不要输出其他内容。",
    ].join("\n");

    try {
      const { text } = await generateText({ model, system, prompt, temperature: 0.1 });
      return parseModelAnnotations(text, messageByPromptId);
    } catch (cause) {
      return { status: "failed", reason: "model_error", detail: cause instanceof Error ? cause.message : String(cause) };
    }
  };
  if (!cache || !key) return produce();
  const cached = cache.get<PatternAnnotationOutcome>(key);
  if (cached !== undefined) return cached;
  const outcome = await produce();
  // 只缓存成功结果：失败/空结果缓存住会让上游一次抖动长期失效。
  if (outcome.status === "ok") cache.set(key, outcome);
  return outcome;
}

/** 兼容旧接口：只要快照，失败与"无输入"都压成 undefined。 */
export async function classifyPatternsWithModel(
  model: LanguageModel,
  turns: readonly MessageTurn[],
  segments: readonly ConversationSegment[],
  links: readonly MessageLink[] = [],
  options: ClassifyModelOptions = {},
  cache?: ModelCache,
): Promise<PatternSnapshot | undefined> {
  const outcome = await classifyPatternsWithModelDetailed(model, turns, segments, links, options, cache);
  return outcome.status === "ok" ? outcome.snapshot : undefined;
}

export interface AnnotationBaseline {
  readonly responsePatterns: readonly ResponsePattern[];
  readonly initiationPatterns: readonly InitiationPattern[];
}

export type AnnotationApplyReason = "replaced" | "partial_empty" | "empty_annotation" | "no_threads" | "model_error" | "parse_error";

export interface AppliedAnnotation extends PatternSnapshot {
  /** true = 至少一个字段采用了新结果。 */
  readonly applied: boolean;
  /** 需要记日志的级别；undefined 表示正常替换、无需额外日志。 */
  readonly level: "info" | "warn" | undefined;
  readonly reason: AnnotationApplyReason;
  /** 保留的旧值条数。 */
  readonly keptResponse: number;
  readonly keptInitiation: number;
  /** 新结果的条数。 */
  readonly newResponse: number;
  readonly newInitiation: number;
}

/**
 * 把标注结果合到已有规律上（R15 缺陷 2 的修复点）。
 *
 * 规则：新结果为空数组就保留旧的对应字段。一次空标注（上游空响应、解析失败、
 * 或者模型确实把整段判成 noise）不允许把学到的规律整段清零。
 * 返回的 level 交给调用方记日志：失败 → warn，真空 → info。
 */
export function applyPatternAnnotations(baseline: AnnotationBaseline, outcome: PatternAnnotationOutcome): AppliedAnnotation {
  const keptAll: AppliedAnnotation = {
    responsePatterns: baseline.responsePatterns,
    initiationPatterns: baseline.initiationPatterns,
    applied: false,
    level: outcome.status === "failed" ? "warn" : "info",
    reason: outcome.status === "failed" ? outcome.reason : "no_threads",
    keptResponse: baseline.responsePatterns.length,
    keptInitiation: baseline.initiationPatterns.length,
    newResponse: 0,
    newInitiation: 0,
  };
  if (outcome.status !== "ok") return keptAll;

  const newResponse = outcome.snapshot.responsePatterns;
  const newInitiation = outcome.snapshot.initiationPatterns;
  const keepResponse = newResponse.length === 0 && baseline.responsePatterns.length > 0;
  const keepInitiation = newInitiation.length === 0 && baseline.initiationPatterns.length > 0;

  if (newResponse.length === 0 && newInitiation.length === 0) {
    return { ...keptAll, level: "info", reason: "empty_annotation" };
  }
  if (keepResponse && keepInitiation) {
    return { ...keptAll, level: "info", reason: "empty_annotation" };
  }
  return {
    responsePatterns: keepResponse ? baseline.responsePatterns : newResponse,
    initiationPatterns: keepInitiation ? baseline.initiationPatterns : newInitiation,
    applied: true,
    level: keepResponse || keepInitiation ? "info" : undefined,
    reason: keepResponse || keepInitiation ? "partial_empty" : "replaced",
    keptResponse: keepResponse ? baseline.responsePatterns.length : 0,
    keptInitiation: keepInitiation ? baseline.initiationPatterns.length : 0,
    newResponse: newResponse.length,
    newInitiation: newInitiation.length,
  };
}

export async function generateChainStyle(
  model: LanguageModel,
  chain: readonly string[],
  sample: LocalChainSample,
  cache?: ModelCache,
): Promise<string | undefined> {
  const key = cache?.key(["chain-style", modelCacheId(model), chain, sample]);
  const produce = async (): Promise<string | undefined> => {
    const sampleText = sample.turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n");
    const prompt = [
      "下面是一条真实群聊回复链：",
      `chain: ${chain.join(" -> ")}`,
      "sample:",
      sampleText,
      "",
      "请描述这条链的说话风格，按以下五个维度：",
      "语气：直接、反问、敷衍、认真、阴阳怪气等",
      "句式：短句、反问、排比、复读等",
      "节奏：先否定对方前提，再补论据，最后如何收束",
      "句长：单句大约多少字",
      "语言习惯：是否使用语气词、解释、道歉、感叹号",
      "只输出 60-120 字，不要总结具体内容、人名、链接或事实，不要输出标签或 JSON。",
    ].join("\n");

    try {
      const { text } = await generateText({ model, prompt, temperature: 0.2 });
      const style = text.trim().replace(/\s+/g, " ").slice(0, 120);
      return style.length > 0 ? style : undefined;
    } catch {
      return undefined;
    }
  };
  return cache && key ? cache.getOrProduce(key, produce) : produce();
}

export function sampleSignature(sample: LocalChainSample): string {
  return JSON.stringify(sample.turns);
}

function selectClassifyThreads(
  segments: readonly ConversationSegment[],
  links: readonly MessageLink[],
  maxThreads: number,
  maxThreadMessages: number,
): ClassifyThread[] {
  const candidates = buildConversationChains(segments, links)
    .map((chain) => ({ chain, score: threadScore(chain.turns) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  const threads: ClassifyThread[] = [];
  let totalMessages = 0;
  let totalChars = 0;
  for (const candidate of candidates) {
    if (threads.length >= maxThreads) break;
    const selectedTurns = candidate.chain.turns.slice(-maxThreadMessages);
    const chars = selectedTurns.reduce((sum, turn) => sum + sanitizeForDisplay(turn.text).trim().length, 0);
    if (totalMessages + selectedTurns.length > MAX_MODEL_MESSAGES) continue;
    if (totalChars + chars > MAX_MODEL_CHARS) break;
    threads.push({ turns: selectedTurns });
    totalMessages += selectedTurns.length;
    totalChars += chars;
  }
  return threads;
}

function threadScore(turns: readonly MessageTurn[]): number {
  const texts = turns.map((turn) => sanitizeForDisplay(turn.text).trim()).filter((text) => text.length > 0);
  if (texts.length < 2) return 0;
  const userIds = new Set(turns.map((turn) => turn.userId));
  const uniqueTexts = new Set(texts);
  const repetitionRatio = uniqueTexts.size / texts.length;
  if (repetitionRatio < 0.5) return 0;
  return turns.length + userIds.size * 2 + Math.min(uniqueTexts.size, 8);
}

function buildThreadPrompt(threads: readonly ClassifyThread[]): { readonly prompt: string; readonly messageByPromptId: ReadonlyMap<string, MessageTurn> } {
  const lines: string[] = [];
  const messageByPromptId = new Map<string, MessageTurn>();

  for (const [threadIndex, thread] of threads.entries()) {
    lines.push(`## conversation thread ${threadIndex}`);
    const userLabels = new Map<string, string>();
    for (const [messageIndex, turn] of thread.turns.entries()) {
      const id = `t${threadIndex}-m${messageIndex}`;
      messageByPromptId.set(id, turn);
      const text = sanitizeForDisplay(turn.text).trim();
      if (text.length === 0) continue;
      lines.push(`[${id}] [${speakerLabel(turn.userId, userLabels)}] ${text}`);
    }
  }

  return { prompt: lines.join("\n"), messageByPromptId };
}

function speakerLabel(userId: string, labels: Map<string, string>): string {
  const existing = labels.get(userId);
  if (existing !== undefined) return existing;
  const next = `u${labels.size}`;
  labels.set(userId, next);
  return next;
}

function byFrequency(left: { readonly frequency: number }, right: { readonly frequency: number }): number {
  return right.frequency - left.frequency;
}

function parseModelAnnotations(text: string, messageByPromptId: ReadonlyMap<string, MessageTurn>): PatternAnnotationOutcome {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (cleaned.length === 0) return { status: "failed", reason: "parse_error", detail: "empty response" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (cause) {
    return { status: "failed", reason: "parse_error", detail: cause instanceof Error ? cause.message : String(cause) };
  }
  if (typeof parsed !== "object" || parsed === null) return { status: "failed", reason: "parse_error", detail: "not an object" };
  if (!("messages" in parsed)) return { status: "failed", reason: "parse_error", detail: "missing messages" };

  const result = modelOutputSchema.safeParse(parsed);
  if (!result.success) return { status: "failed", reason: "parse_error", detail: result.error.issues[0]?.message ?? "schema mismatch" };

  const responseCounts = new Map<string, { intent: ResponseIntent; phrase: string; sampleIds: string[] }>();
  const initiationCounts = new Map<string, { intent: InitiationIntent; phrase: string; sampleIds: string[] }>();

  for (const item of result.data.messages ?? []) {
    if (item.role === "noise") continue;
    const turn = messageByPromptId.get(item.id);
    if (!turn) continue;
    const phrase = patternPhrase(turn.text);
    if (phrase.length === 0) continue;

    if (item.role === "response") {
      if (!isResponseIntent(item.intent)) continue;
      const key = `${item.intent}:${phrase}`;
      const existing = responseCounts.get(key) ?? { intent: item.intent, phrase, sampleIds: [] };
      existing.sampleIds.push(turn.id);
      responseCounts.set(key, existing);
      continue;
    }

    if (!isInitiationIntent(item.intent)) continue;
    const key = `${item.intent}:${phrase}`;
    const existing = initiationCounts.get(key) ?? { intent: item.intent, phrase, sampleIds: [] };
    existing.sampleIds.push(turn.id);
    initiationCounts.set(key, existing);
  }

  return {
    status: "ok",
    snapshot: {
      responsePatterns: [...responseCounts.values()]
        .map((item) => ({ intent: item.intent, phrase: item.phrase, frequency: item.sampleIds.length, sampleIds: item.sampleIds.slice(0, 3) }))
        .sort(byFrequency),
      initiationPatterns: [...initiationCounts.values()]
        .map((item) => ({ intent: item.intent, phrase: item.phrase, frequency: item.sampleIds.length, sampleIds: item.sampleIds.slice(0, 3) }))
        .sort(byFrequency),
    },
  };
}

function isResponseIntent(value: string): value is ResponseIntent {
  return (RESPONSE_INTENTS as readonly string[]).includes(value);
}

function isInitiationIntent(value: string): value is InitiationIntent {
  return (INITIATION_INTENTS as readonly string[]).includes(value);
}
