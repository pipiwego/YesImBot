/**
 * 记忆重要性（salience）与边界判定的纯算术实现。
 *
 * 设计约束（见 MEMORY-PLAN.md §2.2 / §2.3）：
 * - 不调用任何模型，全部是可回归的加权和；
 * - 权重是常量，不接 Beta 在线校准（本代码里还没有可用的下行 reward 信号）；
 * - 边界用 max 聚合、不衰减，判据故意宽松（漏判要踩雷，误判只是少说一句）。
 */

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

const sigmoid = (value: number): number => 1 / (1 + Math.exp(-value));

/** 情绪词表：词 → 强度（0..1）。同句取最大值，不累加。 */
const EMOTION_CUES: ReadonlyArray<readonly [string, number]> = [
  ["超", 0.5],
  ["巨", 0.5],
  ["太", 0.45],
  ["最", 0.4],
  ["好喜欢", 0.9],
  ["喜欢", 0.6],
  ["爱你", 0.95],
  ["爱你哟", 0.95],
  ["开心", 0.7],
  ["高兴", 0.65],
  ["爽", 0.6],
  ["生气", 0.75],
  ["难受", 0.75],
  ["难过", 0.75],
  ["委屈", 0.7],
  ["哭", 0.65],
  ["烦", 0.55],
  ["讨厌", 0.75],
  ["恶心", 0.8],
  ["受不了", 0.85],
  ["崩溃", 0.85],
  ["害怕", 0.75],
  ["离谱", 0.6],
  ["绝了", 0.6],
  ["笑死", 0.7],
  ["救命", 0.7],
];

/** 否定祈使 + 强否定 + 强断言：与 spice-gate 的 veto/hurt 正则同构。 */
const IMPERATIVE_CUES: ReadonlyArray<readonly [string, number]> = [
  ["别在我面前", 1.0],
  ["别再提", 0.95],
  ["别再说", 0.95],
  ["不许再", 0.95],
  ["禁止", 0.95],
  ["不许", 0.9],
  ["不准", 0.9],
  ["不要", 0.85],
  ["闭嘴", 0.85],
  ["少来", 0.7],
  ["受不了", 0.8],
  ["不想听", 0.75],
  ["讨厌", 0.7],
  ["必须", 0.6],
  ["一定", 0.5],
  ["绝对", 0.6],
  ["记住", 0.6],
  ["就是", 0.35],
];

/** 恒常性：区分「别在这说」与「别在我面前提我妈」。 */
const PERSIST_CUES: readonly string[] = [
  "总是",
  "老是",
  "每次",
  "每次都",
  "一直",
  "从来",
  "永远",
  "以后",
  "下次",
  "再也",
  "再也别",
  "天天",
  "每天",
  "在我面前",
  "跟我说",
  "跟我说过",
];

/**
 * 「这种/这个/这样/那」这类指代 + 否定祈使，本身就是持续意图：
 * 「别再说这种话了」「不要再发这个表情」不写恒常副词，但语义上不是一次性请求。
 * 只用于边界判定，不进 salience。
 */
const RECURRENCE_POINTERS: readonly string[] = ["再", "这种", "这个", "这样", "那样", "以后", "下次"];

const SECOND_PERSON = ["你", "您", "妳"] as const;
const FIRST_PERSON = ["我", "俺", "咱"] as const;
const EXCLUSIVE_CUES = ["只有你", "就你", "咱俩", "我们俩", "只跟你", "单独跟你", "只对你"] as const;

function sumCues(text: string, cues: ReadonlyArray<readonly [string, number]>): number {
  let total = 0;
  for (const [cue, weight] of cues) {
    if (text.includes(cue)) total += weight;
  }
  return total;
}

function emotionIntensity(text: string): number {
  let best = 0;
  for (const [cue, weight] of EMOTION_CUES) {
    if (text.includes(cue) && weight > best) best = weight;
  }
  return best;
}

function punctuationScore(text: string): number {
  const exclamations = (text.match(/[!！]/g) ?? []).length;
  const questions = (text.match(/[?？]/g) ?? []).length;
  const trailOff = (text.match(/[…~～]/g) ?? []).length;
  return clamp01(exclamations * 0.35 + questions * 0.15 + trailOff * 0.1);
}

function lengthNorm(text: string): number {
  return clamp01(text.trim().length / 30);
}

/** 首人称是否处在「受事」位置：我/俺 + 情绪或禁止谓词。 */
function firstPersonPatient(text: string): number {
  if (!FIRST_PERSON.some((word) => text.includes(word))) return 0;
  return /(我|俺|咱)[^，。！？!?]{0,6}(受不了|讨厌|别|不要|不许|不准|烦|难受|害怕|委屈)/.test(text) ||
    /(别|不要|不许|不准|禁止)[^，。！?]{0,6}(我|俺|咱)/.test(text) ||
    /(在我面前|跟我说)/.test(text)
    ? 1
    : 0.5;
}

function targetScore(text: string): number {
  const second = SECOND_PERSON.some((word) => text.includes(word)) ? 1 : 0;
  const exclusive = EXCLUSIVE_CUES.some((cue) => text.includes(cue)) ? 1 : 0;
  return clamp01(0.5 * second + 0.3 * firstPersonPatient(text) + 0.2 * exclusive);
}

/**
 * 裸「别」只在不构成别的词时才是否定祈使。
 * 之前用 text.includes("别") 子串匹配，"特别/别人/告别/级别/区别/个别/分别" 全被算成祈使，
 * "我特别讨厌你" 因此被误判成边界。
 */
const BIE_NEGATIVE = /(?<![特区级个告分])别(?![人处])/;

function imperativeScore(text: string): number {
  let score = sumCues(text, IMPERATIVE_CUES);
  if (BIE_NEGATIVE.test(text)) score += 0.9;
  return clamp01(score / 1.5);
}

function persistenceScore(text: string): number {
  if (PERSIST_CUES.some((cue) => text.includes(cue))) return 1;
  // 指代 + 否定祈使视为持续意图。缺省 0.25 会把大量真实禁忌挡在门外。
  if (RECURRENCE_POINTERS.some((cue) => text.includes(cue))) return 0.7;
  return 0.25;
}

/** 专一度：有向量质心时用 1−cos；否则退化为「罕见字 + 数字/拉丁 + 长度」的启发式。 */
function specificityScore(text: string, options: SalienceOptions): number {
  const { embedding, centroid } = options;
  if (embedding && centroid && embedding.length === centroid.length && embedding.length > 0) {
    return clamp01(1 - cosine(embedding, centroid));
  }
  const characters = [...text.replace(/\s+/g, "")];
  if (characters.length === 0) return 0;
  const unique = new Set(characters).size;
  const uniqueRatio = unique / characters.length;
  const hasConcrete = /[0-9０-９a-zA-Z]/.test(text) ? 1 : 0;
  return clamp01(0.5 * uniqueRatio + 0.3 * hasConcrete + 0.2 * lengthNorm(text));
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const size = Math.min(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export interface SalienceOptions {
  /** 同 scope 内与本文本最相似的历史条目的余弦；缺省（无历史/无向量）时取中性 0.5。 */
  readonly maxCosine?: number;
  readonly embedding?: readonly number[];
  readonly centroid?: readonly number[];
}

export interface SalienceBreakdown {
  readonly novelty: number;
  readonly emotion: number;
  readonly imperative: number;
  readonly target: number;
  readonly specificity: number;
  readonly salience: number;
}

/** 完整分解，便于单测锁定每一维行为。 */
export function explainSalience(text: string, options: SalienceOptions = {}): SalienceBreakdown {
  const novelty = options.maxCosine === undefined ? 0.5 : clamp01((0.92 - options.maxCosine) / 0.42);
  const emotion = clamp01(0.55 * emotionIntensity(text) + 0.25 * punctuationScore(text) + 0.2 * lengthNorm(text));
  const imperative = imperativeScore(text);
  const target = targetScore(text);
  const specificity = specificityScore(text, options);
  const salience = clamp01(sigmoid(1.6 * (0.3 * novelty + 0.2 * emotion + 0.2 * imperative + 0.15 * target + 0.15 * specificity) - 0.8));
  return { novelty, emotion, imperative, target, specificity, salience };
}

/** S = σ(1.6·(0.30·Nov + 0.20·Emo + 0.20·Imp + 0.15·Tgt + 0.15·Spec) − 0.8) */
export function computeSalience(text: string, options: SalienceOptions = {}): number {
  return explainSalience(text, options).salience;
}

export interface BoundaryDetection {
  readonly hit: boolean;
  readonly score: number;
  readonly imperative: number;
  readonly persistence: number;
  readonly target: number;
}

/**
 * 边界判据：hit = Imp ≥ 0.55 ∧ (Persist ≥ 0.50 ∨ Tgt ≥ 0.60)。
 * 「在我面前」计入 Persist 词表，因此「别在我面前提我妈」这类无恒常副词的说法也能命中。
 */
export function detectBoundary(text: string): BoundaryDetection {
  const imperative = imperativeScore(text);
  const persistence = persistenceScore(text);
  const target = targetScore(text);
  // target 从 0.6 放宽到 0.3：没有"你"时 target 封顶 0.5，
  // 旧的 0.6 门槛让「别碰我的东西」这类只对特定人说的话完全进不来。
  const hit = imperative >= 0.55 && (persistence >= 0.5 || target >= 0.3);
  const score = clamp01(imperative * 0.7 + Math.max(persistence, target) * 0.3);
  return { hit, score, imperative, persistence, target };
}
