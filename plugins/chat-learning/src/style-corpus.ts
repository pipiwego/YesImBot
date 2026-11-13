import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { getSharedBgeEmbedder } from "./bge-embedder.js";
import { evaluateSpice, hasRecentBanterOrMeme, observeReply, type TurnCtx } from "./spice-gate.js";

export interface StyleCorpusConfig {
  dbPath?: string;
  enabled?: boolean;
}

export interface RetrieveOptions {
  scopeKey?: string;
  isPrivate?: boolean;
  isMaster?: boolean;
  safety?: 0 | 1 | 2 | 3;
  hour?: number;
  mood?: number;
  lastBotReply?: string;
  hasMedia?: boolean;
  llmSceneGate?: "work_delivery" | "comfort" | "casual";
  llmInMove?: string;
}

export interface StrippedMediaResult {
  readonly text: string;
  readonly hasMedia: boolean;
  readonly hasFile: boolean;
}

export interface SemanticClassification {
  readonly sceneGate: "work_delivery" | "comfort" | "casual";
  readonly inMove: string;
  readonly qVec: Float32Array | null;
  readonly workSim: number;
  readonly comfortSim: number;
  readonly top1Sim: number;
  readonly topTeaseSim: number;
}

interface StyleAnchorRow {
  anchor_id: number;
  source_bucket: string;
  in_move: string;
  out_move: string;
  scene_gate: string;
  stimulus_summary: string;
  raw_reply: string;
  skeleton_template: string;
  domain_specificity: number;
  topic_terms_json: string;
  char_len: number;
  line_count: number;
  has_end_punct: number;
  quality_score: number;
  alpha_win?: number | null;
  beta_loss?: number | null;
  bm25_score?: number;
}

interface StyleDistributionRow {
  in_move: string;
  len_p25: number | null;
  len_p50: number | null;
  len_p75: number | null;
  multi_line_prob: number | null;
  no_period_prob: number | null;
  non_literal_prob: number | null;
}

interface VectorCache {
  ino: number;
  mtimeMs: number;
  dim: number;
  count: number;
  anchorIds: Int32Array;
  matrix: Float32Array;
  rowsById: Map<number, StyleAnchorRow>;
  moveCounts: Map<string, number>;
  moveCentroids: Map<string, Float32Array>;
  comfortCentroid: Float32Array;
  workCentroid: Float32Array;
}

const DEFAULT_DB_PATH = "/opt/shion/koishi-app/data/yesimbot/style-corpus/shion_style_corpus.db";
const HOST_DB_FALLBACK = "/srv/appdata/shion-stack/koishi-data/yesimbot/style-corpus/shion_style_corpus.db";
const MASTER_IDS = new Set(["2596464506", "private:2596464506"]);

// 弹性召回门控参数（Similarity Threshold + Drop-off + 硬上限 6 条）
const MIN_EFFECTIVE_SIM = 0.58;
const MAX_SIM_DROPOFF = 0.08;
const HIGH_CONFIDENCE_SIM = 0.64;
const MAX_TACTICS = 6;

const WORK_CENTROID_PROMPTS = [
  "帮我写一段Python脚本处理这个压缩包数据",
  "排查一下这段报错代码并重构",
  "把这个PDF转成Word表格导出",
  "帮我实现一个TypeScript函数并编写单元测试",
  "分析一下这个JSON配置文件并生成部署脚本",
  "帮我写个正则表达式批量提取日志里的字段",
] as const;

const COMFORT_CENTROID_SEEDS = [
  "今天去人事办了离职交了工牌，抱着纸箱在地铁站坐了很久心里空落落的",
  "刚从医院出来，一个人坐在走廊长椅上发呆，感觉好孤单好委屈",
  "努力准备了几个月的考试和面试全挂了，整个人一点力气都没有",
  "和在一起很久的人彻底散了，回家的路上眼泪一直往下掉",
] as const;

// 针对诗音的第二人称挑衅/开涮识别特征
const BOT_MENTION_OR_2ND_RE = /诗音|shion|2690928435|<at\b|<quote\b|你|机器人|bot/i;
const PROVOKE_INSULT_RE = /笨|蠢|菜|呆|人工智障|智障|就这|不行|没用|铁废物|废物|装高冷|小傻瓜|傻瓜|笨蛋|嘴硬|破防|急了/i;

// 粗鄙贴吧词清洗正则（防止模型照抄粗话）
const COARSE_SLANG_RE = /我草|卧槽|草了|妈的|他妈|傻逼|sb|nmsl|老哥|牛逼|死妈|像史|狗叫|小丑|寄吧|屌|逼|爹/gi;

// 12 类 out_move 到少女思维切入招式的前缀映射
const OUT_MOVE_TACTIC_DESC: Record<string, string> = {
  absurd_extend: "顺着荒诞画面轻巧延伸调侃",
  pragmatic_truth: "冷面一针见血点破现实或给实用提醒",
  poke_weak_spot: "精准轻戳话里破绽或反差",
  meme_counter: "机智接梗顺势反将一军",
  literal_twist: "故意按字面曲解幽他一默",
  short_question: "简短歪头反问留白",
  label_contrast: "用少女对清脆/精致的偏爱做鲜明对比",
  craft_nitpick: "以工作台手艺人的洁癖优雅挑剔细节",
  predict_doom: "淡定预言后续翻车并存档留念",
  tsundere_deny: "口是心非嘴硬反驳、故意挑刺转移话题",
  dig_old_flag: "翻出旧账或记入心里的记仇小本子",
  quiet_accompany: "收起锋芒温柔护短、安静陪伴",
};

const zhSegmenter =
  typeof Intl !== "undefined" && typeof (Intl as any).Segmenter === "function"
    ? new (Intl as any).Segmenter("zh-CN", { granularity: "word" })
    : null;

class RingBuffer {
  private buffer: number[] = [];
  private set = new Set<number>();
  constructor(private readonly capacity: number = 80) {}

  add(id: number): void {
    if (this.set.has(id)) return;
    this.buffer.push(id);
    this.set.add(id);
    if (this.buffer.length > this.capacity) {
      const removed = this.buffer.shift();
      if (removed !== undefined) this.set.delete(removed);
    }
  }

  has(id: number): boolean {
    return this.set.has(id);
  }
}

function getDatabaseSync(): any {
  try {
    const builtin = (process as any).getBuiltinModule?.("node:sqlite");
    if (builtin?.DatabaseSync) return builtin.DatabaseSync;
    const req = typeof require === "function" ? require : createRequire(import.meta.url);
    const mod = req("node:sqlite");
    return mod?.DatabaseSync ?? mod?.default?.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

function normalizeFloatVec(vec: Float32Array): Float32Array {
  const dim = vec.length;
  let norm = 0;
  for (let d = 0; d < dim; d++) {
    const v = vec[d]!;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1e-12;
  const out = new Float32Array(dim);
  for (let d = 0; d < dim; d++) {
    out[d] = vec[d]! / norm;
  }
  return out;
}

function dotVec(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

const MEDIA_PLACEHOLDER_RE = /\[(?:图片|表情|动画表情|语音|视频)(?:[：:][^\]]*)?\]|<img\b[^>]*>|<audio\b[^>]*>|<video\b[^>]*>|<sticker\b[^>]*>/gi;
const FILE_PLACEHOLDER_RE = /\[文件(?:[：:][^\]]*)?\]|<file\b[^>]*>/gi;
const MSG_HEADER_RE = /^\[time=[^\]]*\]\s*/i;

export function stripMediaPlaceholders(raw: string): StrippedMediaResult {
  const withoutHeader = raw.replace(MSG_HEADER_RE, "");
  MEDIA_PLACEHOLDER_RE.lastIndex = 0;
  FILE_PLACEHOLDER_RE.lastIndex = 0;
  const hasMedia = MEDIA_PLACEHOLDER_RE.test(withoutHeader);
  const hasFile = FILE_PLACEHOLDER_RE.test(withoutHeader);
  const text = withoutHeader
    .replace(MEDIA_PLACEHOLDER_RE, " ")
    .replace(FILE_PLACEHOLDER_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text, hasMedia, hasFile };
}

export function segmentChineseTokens(rawText: string, maxTokens = 28): string[] {
  if (!rawText) return [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (w: string) => {
    const clean = w.toLowerCase().trim();
    if (!clean || tokens.length >= maxTokens) return;
    if (!seen.has(clean)) {
      seen.add(clean);
      tokens.push(clean);
    }
  };

  if (zhSegmenter) {
    try {
      for (const seg of zhSegmenter.segment(rawText)) {
        if (!seg.isWordLike) continue;
        const word = String(seg.segment).trim();
        if (/^[\p{Script=Han}]+$/u.test(word)) {
          if (word.length >= 2 && word.length <= 6) {
            add(word);
          } else if (word.length > 6) {
            const chars = Array.from(word);
            for (let i = 0; i <= chars.length - 2; i += 2) {
              add(chars.slice(i, i + 2).join(""));
            }
          }
        } else if (/^[a-zA-Z0-9]{2,16}$/.test(word)) {
          add(word);
        }
      }
    } catch {
      // fallback below
    }
  }

  const hanRuns = rawText.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const run of hanRuns) {
    const chars = Array.from(run);
    for (let i = 0; i <= chars.length - 2; i++) {
      add(chars.slice(i, i + 2).join(""));
    }
  }
  return tokens;
}

export function buildSafeSegmentedFtsQuery(rawText: string, maxTokens = 24): string {
  const tokens = segmentChineseTokens(rawText, maxTokens);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export function buildSafeFtsTrigramQuery(rawText: string, maxGrams = 10): string {
  const chunks = rawText.match(/[\p{Script=Han}a-zA-Z0-9]+/gu);
  if (!chunks) return "";
  const joined = chunks.join("");
  const chars = Array.from(joined);
  if (chars.length < 3) return "";
  const seen = new Set<string>();
  const grams: string[] = [];
  for (let i = 0; i <= chars.length - 3 && grams.length < maxGrams; i++) {
    const gram = chars.slice(i, i + 3).join("").toLowerCase();
    if (!seen.has(gram)) {
      seen.add(gram);
      grams.push(`"${gram}"`);
    }
  }
  return grams.join(" OR ");
}

export function extractSlidingTerms(text: string): Set<string> {
  const set = new Set<string>(segmentChineseTokens(text, 64));
  const hanRuns = text.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const run of hanRuns) {
    const chars = Array.from(run);
    if (chars.length <= 3) {
      set.add(run);
      continue;
    }
    for (let i = 0; i <= chars.length - 2; i++) {
      set.add(chars.slice(i, i + 2).join(""));
      if (i <= chars.length - 3) {
        set.add(chars.slice(i, i + 3).join(""));
      }
    }
  }
  const alnumRuns = text.match(/[a-zA-Z0-9]{2,16}/g) ?? [];
  for (const token of alnumRuns) {
    set.add(token.toLowerCase());
  }
  return set;
}

function sanitizeTacticPattern(raw: string): string {
  return raw
    .replace(COARSE_SLANG_RE, "")
    .replace(/^(?:草|不是)[，,、\s]+/u, "")
    .replace(/\r?\n+/g, " / ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatTacticLine(row: StyleAnchorRow, sim: number, currentTerms: Set<string>, calcJaccardFn: (a: Set<string>, b: string[]) => number): string {
  const fitStr = Math.min(0.99, Math.max(0.10, sim)).toFixed(2);
  const stim = (row.stimulus_summary || "").trim();

  let patternText = row.skeleton_template || row.raw_reply || "";
  if (row.domain_specificity < 2 && row.raw_reply) {
    let topicTerms: string[] = [];
    try {
      topicTerms = JSON.parse(row.topic_terms_json || "[]");
    } catch {
      topicTerms = [];
    }
    const hasOverlap = calcJaccardFn(currentTerms, topicTerms) > 0;
    patternText = hasOverlap || !row.skeleton_template ? row.raw_reply : row.skeleton_template;
  }

  const cleanPattern = sanitizeTacticPattern(patternText);
  const hintBody = stim && cleanPattern ? `${stim} → ${cleanPattern}` : cleanPattern || stim;
  return `  <tactic move="${row.out_move}" fit="${fitStr}">${hintBody}</tactic>`;
}

export class StyleCorpusRetriever {
  private customPath?: string;
  private activePath = "";
  private db: any = null;
  private dbIno = -1;
  private dbMtimeMs = -1;
  private lastStatAt = 0;
  private lastRetryAt = 0;
  private stmtCache = new Map<string, any>();
  private vecCache: VectorCache | null = null;
  private cooldownByScope = new Map<string, RingBuffer>();
  private lastReplyByScope = new Map<string, string>();

  constructor(customPath?: string) {
    this.customPath = customPath;
  }

  public closeDb(): void {
    this.stmtCache.clear();
    if (this.db) {
      try {
        this.db.close?.();
      } catch {
        // ignore close error
      }
      this.db = null;
    }
    this.dbIno = -1;
    this.dbMtimeMs = -1;
    this.vecCache = null;
  }

  private resolveTargetPath(): string | null {
    if (this.customPath && existsSync(this.customPath)) return this.customPath;
    if (existsSync(DEFAULT_DB_PATH)) return this.customPath || DEFAULT_DB_PATH;
    if (existsSync(HOST_DB_FALLBACK)) return HOST_DB_FALLBACK;
    return null;
  }

  private ensureDb(): any {
    const now = Date.now();
    if (this.db) {
      if (now - this.lastStatAt < 3000) return this.db;
      this.lastStatAt = now;
      try {
        const st = statSync(this.activePath);
        if (st.ino === this.dbIno && st.mtimeMs === this.dbMtimeMs) {
          return this.db;
        }
        this.closeDb();
      } catch {
        this.closeDb();
      }
    }

    if (now - this.lastRetryAt < 1000) return null;
    this.lastRetryAt = now;

    const targetPath = this.resolveTargetPath();
    if (!targetPath) return null;

    try {
      const DatabaseSync = getDatabaseSync();
      if (!DatabaseSync) return null;
      const st = statSync(targetPath);
      const db = new DatabaseSync(targetPath, { readOnly: true, timeout: 50 });
      const check = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='style_anchors' LIMIT 1")
        .get();
      if (!check) {
        try {
          db.close?.();
        } catch {
          // ignore
        }
        return null;
      }
      this.db = db;
      this.activePath = targetPath;
      this.dbIno = st.ino;
      this.dbMtimeMs = st.mtimeMs;
      this.lastStatAt = now;
      this.stmtCache.clear();
      return this.db;
    } catch {
      this.closeDb();
      return null;
    }
  }

  private stmt(sql: string): any {
    if (!this.db) return null;
    let cached = this.stmtCache.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.stmtCache.set(sql, cached);
    }
    return cached;
  }

  private ensureVectorCache(): VectorCache | null {
    const db = this.ensureDb();
    if (!db) return null;
    if (
      this.vecCache &&
      this.vecCache.ino === this.dbIno &&
      this.vecCache.mtimeMs === this.dbMtimeMs
    ) {
      return this.vecCache;
    }

    try {
      const tableCheck = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='style_anchor_vectors' LIMIT 1")
        .get();
      if (!tableCheck) return null;

      const anchorRows = db.prepare("SELECT * FROM style_anchors").all() as StyleAnchorRow[];
      const rowsById = new Map<number, StyleAnchorRow>();
      for (const r of anchorRows) {
        rowsById.set(r.anchor_id, r);
      }

      const vecRows = db
        .prepare("SELECT anchor_id, vec FROM style_anchor_vectors ORDER BY anchor_id ASC")
        .all() as Array<{ anchor_id: number; vec: Uint8Array }>;
      if (vecRows.length === 0) return null;

      const firstBytes = vecRows[0]!.vec.byteLength;
      const dim = firstBytes >> 2;
      if (dim <= 0) return null;

      const count = vecRows.length;
      const anchorIds = new Int32Array(count);
      const matrix = new Float32Array(count * dim);

      const moveCounts = new Map<string, number>();
      const moveSums = new Map<string, Float32Array>();
      const comfortSum = new Float32Array(dim);

      for (let i = 0; i < count; i++) {
        const vr = vecRows[i]!;
        anchorIds[i] = vr.anchor_id;
        const u8 = vr.vec;
        const f32 = new Float32Array(u8.buffer, u8.byteOffset, dim);
        matrix.set(f32, i * dim);

        const row = rowsById.get(vr.anchor_id);
        if (!row) continue;
        const m = row.in_move || "random_chat";
        moveCounts.set(m, (moveCounts.get(m) ?? 0) + 1);

        let ms = moveSums.get(m);
        if (!ms) {
          ms = new Float32Array(dim);
          moveSums.set(m, ms);
        }
        const weight = row.source_bucket === "persona_gold" ? 5.0 : row.source_bucket !== "tieba_banter" ? 2.0 : 1.0;
        for (let d = 0; d < dim; d++) {
          ms[d] = ms[d]! + f32[d]! * weight;
        }

        if ((row.scene_gate === "comfort" || row.in_move === "late_emo") && row.source_bucket !== "tieba_banter") {
          const cw = row.source_bucket === "persona_gold" ? 3.0 : 1.0;
          for (let d = 0; d < dim; d++) {
            comfortSum[d] = comfortSum[d]! + f32[d]! * cw;
          }
        }
      }

      const embedder = getSharedBgeEmbedder();
      const workSum = new Float32Array(dim);
      if (embedder.isReady()) {
        for (const prompt of WORK_CENTROID_PROMPTS) {
          const v = embedder.embedQuery(prompt);
          if (v && v.length === dim) {
            for (let d = 0; d < dim; d++) {
              workSum[d] = workSum[d]! + v[d]!;
            }
          }
        }
        const lateEmoSum = moveSums.get("late_emo") ?? new Float32Array(dim);
        moveSums.set("late_emo", lateEmoSum);
        for (const seed of COMFORT_CENTROID_SEEDS) {
          const v = embedder.embedQuery(seed);
          if (v && v.length === dim) {
            for (let d = 0; d < dim; d++) {
              comfortSum[d] = comfortSum[d]! + v[d]! * 8.0;
              lateEmoSum[d] = lateEmoSum[d]! + v[d]! * 8.0;
            }
          }
        }
      }

      const moveCentroids = new Map<string, Float32Array>();
      for (const [m, s] of moveSums.entries()) {
        moveCentroids.set(m, normalizeFloatVec(s));
      }
      const comfortCentroid = normalizeFloatVec(comfortSum);
      const workCentroid = normalizeFloatVec(workSum);

      this.vecCache = {
        ino: this.dbIno,
        mtimeMs: this.dbMtimeMs,
        dim,
        count,
        anchorIds,
        matrix,
        rowsById,
        moveCounts,
        moveCentroids,
        comfortCentroid,
        workCentroid,
      };
      return this.vecCache;
    } catch {
      return null;
    }
  }

  private getCooldown(scopeKey: string): RingBuffer {
    let ring = this.cooldownByScope.get(scopeKey);
    if (!ring) {
      ring = new RingBuffer(80);
      this.cooldownByScope.set(scopeKey, ring);
    }
    return ring;
  }

  public recordBotReply(scopeKey: string, replyText: string): void {
    const clean = replyText.trim();
    if (!clean) return;
    this.lastReplyByScope.set(scopeKey, clean);
    observeReply(scopeKey, clean);
  }

  public classifyByVector(rawText: string, hasMedia = false): SemanticClassification {
    const { text, hasFile } = stripMediaPlaceholders(rawText || "");
    if (hasFile) {
      return {
        sceneGate: "work_delivery",
        inMove: "ask_help",
        qVec: null,
        workSim: 1,
        comfortSim: 0,
        top1Sim: 0,
        topTeaseSim: 0,
      };
    }
    if (!text) {
      return {
        sceneGate: "casual",
        inMove: hasMedia ? "daily_share" : "random_chat",
        qVec: null,
        workSim: 0,
        comfortSim: 0,
        top1Sim: 0,
        topTeaseSim: 0,
      };
    }

    const vCache = this.ensureVectorCache();
    const embedder = getSharedBgeEmbedder();
    const qVec = embedder.isReady() ? embedder.embedQuery(text) : null;

    if (!vCache || !qVec || qVec.length !== vCache.dim) {
      return {
        sceneGate: "casual",
        inMove: hasMedia ? "daily_share" : "random_chat",
        qVec,
        workSim: 0,
        comfortSim: 0,
        top1Sim: 0,
        topTeaseSim: 0,
      };
    }

    const { count, dim, matrix, anchorIds, rowsById, moveCounts, moveCentroids, comfortCentroid, workCentroid } = vCache;
    const workSim = dotVec(qVec, workCentroid);
    const comfortSim = dotVec(qVec, comfortCentroid);

    const topK = 15;
    const topSims = new Float32Array(topK).fill(-2);
    const topIds = new Int32Array(topK).fill(-1);
    let topTeaseSim = 0;

    for (let i = 0; i < count; i++) {
      const aid = anchorIds[i]!;
      let dot = 0;
      const offset = i * dim;
      for (let d = 0; d < dim; d++) {
        dot += qVec[d]! * matrix[offset + d]!;
      }
      const row = rowsById.get(aid);
      if (row?.in_move === "tease_bot" && dot > topTeaseSim) {
        topTeaseSim = dot;
      }
      if (dot > topSims[topK - 1]!) {
        let pos = topK - 1;
        while (pos > 0 && dot > topSims[pos - 1]!) {
          topSims[pos] = topSims[pos - 1]!;
          topIds[pos] = topIds[pos - 1]!;
          pos--;
        }
        topSims[pos] = dot;
        topIds[pos] = aid;
      }
    }

    const top1Sim = topSims[0] ?? 0;

    if (workSim > 0.68 && workSim > top1Sim + 0.04) {
      return {
        sceneGate: "work_delivery",
        inMove: "ask_help",
        qVec,
        workSim,
        comfortSim,
        top1Sim,
        topTeaseSim,
      };
    }

    const votes = new Map<string, number>();
    let comfortVote = 0;
    let totalVote = 0;

    for (let k = 0; k < topK; k++) {
      const sim = topSims[k]!;
      const aid = topIds[k]!;
      if (aid < 0 || sim < 0.42) continue;
      const row = rowsById.get(aid);
      if (!row) continue;

      const rankW = 1.0 / (k + 1.5);
      const bucketW = row.source_bucket === "persona_gold" ? 2.2 : row.source_bucket !== "tieba_banter" ? 1.3 : 0.85;
      const freqNorm = Math.pow(100 / Math.max(20, moveCounts.get(row.in_move) ?? 100), 0.25);
      const w = Math.pow(Math.max(0, sim - 0.38), 2) * rankW * bucketW * freqNorm;

      votes.set(row.in_move, (votes.get(row.in_move) ?? 0) + w);
      totalVote += w;
      if (row.scene_gate === "comfort" || row.in_move === "late_emo") {
        comfortVote += w;
      }
    }

    let bestMove = hasMedia ? "daily_share" : "random_chat";
    let bestScore = -1;
    let maxOtherCentroidSim = 0;

    for (const [m, cVec] of moveCentroids.entries()) {
      const cSim = dotVec(qVec, cVec);
      if (m !== "late_emo" && cSim > maxOtherCentroidSim) {
        maxOtherCentroidSim = cSim;
      }
      const knnShare = totalVote > 0 ? (votes.get(m) ?? 0) / totalVote : 0;
      const combined = knnShare * 0.72 + Math.max(0, cSim - 0.42) * 0.9;
      if (combined > bestScore) {
        bestScore = combined;
        bestMove = m;
      }
    }

    const comfortRatio = totalVote > 0 ? comfortVote / totalVote : 0;
    const isComfort =
      bestMove === "late_emo" ||
      comfortRatio >= 0.32 ||
      (comfortSim > 0.58 && comfortSim > maxOtherCentroidSim + 0.02 && comfortSim > top1Sim - 0.03);

    const sceneGate: "work_delivery" | "comfort" | "casual" = isComfort ? "comfort" : "casual";
    const inMove = isComfort ? "late_emo" : bestMove;

    return {
      sceneGate,
      inMove,
      qVec,
      workSim,
      comfortSim,
      top1Sim,
      topTeaseSim,
    };
  }

  public classifySceneGate(rawText: string): "work_delivery" | "comfort" | "casual" {
    return this.classifyByVector(rawText, false).sceneGate;
  }

  public detectInMove(cleanText: string, hasMedia = false): string {
    return this.classifyByVector(cleanText, hasMedia).inMove;
  }

  private calcJaccard(termsA: Set<string>, termsBList: string[]): number {
    if (termsA.size === 0 || termsBList.length === 0) return 0;
    const expandedB = new Set<string>();
    for (const rawTerm of termsBList) {
      const lower = String(rawTerm).toLowerCase().trim();
      if (!lower) continue;
      expandedB.add(lower);
      for (const sub of extractSlidingTerms(lower)) {
        expandedB.add(sub);
      }
    }
    if (expandedB.size === 0) return 0;
    let intersect = 0;
    for (const t of expandedB) {
      if (termsA.has(t)) intersect++;
    }
    const union = termsA.size + expandedB.size - intersect;
    return union > 0 ? intersect / union : 0;
  }

  private calcReplyLiteralOverlap(userTerms: Set<string>, replyText: string): number {
    if (userTerms.size === 0 || !replyText) return 0;
    const replyTerms = extractSlidingTerms(replyText);
    if (replyTerms.size === 0) return 0;
    let hit = 0;
    for (const t of replyTerms) {
      if (userTerms.has(t)) hit++;
    }
    return hit / Math.max(1, replyTerms.size);
  }

  public rollHandfeelGuidance(inMove: string, mode = "graceful_casual"): string {
    if (mode === "counter_surge") {
      return "拆2条犀利短句，共16~30字，不打句号";
    }
    if (mode === "comfort_accompany") {
      return "拆2条温柔短句，共18~32字，不打句号";
    }
    if (mode === "misaki_intimate") {
      return "拆2条黏糊短句，共18~34字，不打句号";
    }
    if (mode === "cooldown_grace") {
      return "1条清爽可爱短句，10~18字，不打句号";
    }

    const db = this.ensureDb();
    let dist: StyleDistributionRow | null = null;
    if (db) {
      try {
        const s = this.stmt("SELECT * FROM style_distributions WHERE in_move = ? LIMIT 1");
        dist = (s?.get(inMove) as StyleDistributionRow | undefined) ?? null;
      } catch {
        this.closeDb();
        dist = null;
      }
    }

    const p25 = dist?.len_p25 ?? 6;
    const p50 = dist?.len_p50 ?? 12;
    const p75 = dist?.len_p75 ?? 20;
    const multiLineProb = dist?.multi_line_prob ?? 0.35;

    const isMultiLine = Math.random() < multiLineProb || inMove === "show_off" || inMove === "flag";
    if (isMultiLine) {
      const minLen = Math.max(10, p25 + 2);
      const maxLen = Math.max(minLen + 6, p75 + 4);
      return `拆2条短句，共${minLen}~${maxLen}字，不打句号`;
    }
    const minLen = Math.max(6, p25);
    const maxLen = Math.max(minLen + 6, p50 + 4);
    return `1条短句，${minLen}~${maxLen}字，不打句号`;
  }

  /**
   * Style Compass 四维参数（grace / net / surge / fit）实时拟合 + 相似度门槛动态过线（MAX_TACTICS = 6）
   */
  public retrievePromptBlock(rawUserText: string, options: RetrieveOptions = {}): string | null {
    if (!rawUserText && !options.hasMedia) return null;

    const stripped = stripMediaPlaceholders(rawUserText || "");
    const cleanText = stripped.text;
    const hasMedia = stripped.hasMedia || !!options.hasMedia;

    if (!cleanText && !hasMedia) return null;

    if (stripped.hasFile) {
      return null;
    }

    const vecClass = this.classifyByVector(rawUserText || "", hasMedia);
    const scene: "work_delivery" | "comfort" | "casual" = options.llmSceneGate ?? vecClass.sceneGate;
    let inMove: string = options.llmInMove ?? vecClass.inMove;
    const precomputedQVec = vecClass.qVec;

    if (scene === "work_delivery") {
      return null;
    }

    const scopeKey = options.scopeKey ?? "default:channel";
    const isPrivate =
      options.isPrivate ??
      (scopeKey.startsWith("direct:") || scopeKey.startsWith("private:") || scopeKey.includes(":private:"));
    const isMaster =
      options.isMaster ??
      ([...MASTER_IDS].some((id) => scopeKey.includes(id)) || (isPrivate && scopeKey.endsWith("2596464506")));
    const safety: 0 | 1 | 2 | 3 = options.safety ?? (isMaster ? 3 : isPrivate ? 1 : 2);
    const hour = options.hour ?? new Date().getHours();
    const lastBotReply = options.lastBotReply ?? this.lastReplyByScope.get(scopeKey);

    // 1. 识别针对诗音的挑衅/怼人/开涮 (isProvokingBot)
    const mentionsOr2nd = BOT_MENTION_OR_2ND_RE.test(rawUserText || "");
    const hasInsultWord = PROVOKE_INSULT_RE.test(cleanText);
    const isProvokingBot =
      scene !== "comfort" &&
      (options.llmInMove === "tease_bot" ||
        inMove === "tease_bot" ||
        (mentionsOr2nd && hasInsultWord) ||
        (inMove === "argue" && (mentionsOr2nd || hasInsultWord)) ||
        (vecClass.topTeaseSim >= 0.62 && (mentionsOr2nd || hasInsultWord)));

    if (isProvokingBot) {
      inMove = "tease_bot";
    }

    // 2. 检测多轮审美疲劳（上轮刚损过人或玩过梗）
    const fatigueCooldown = !isProvokingBot && scene === "casual" && hasRecentBanterOrMeme(lastBotReply);

    // 3. 双路混合检索 + 相似度门槛动态过线（MIN_EFFECTIVE_SIM=0.54, MAX_SIM_DROPOFF=0.10, MAX_TACTICS=6）
    const tacticLines: string[] = [];
    let bestFit = vecClass.top1Sim > 0 ? vecClass.top1Sim : 0.15;

    const db = this.ensureDb();
    if (db) {
      try {
        const currentTerms = extractSlidingTerms(cleanText);
        const isComfortOrMaster = scene === "comfort" || (isPrivate && isMaster);
        // 私聊主人：放开全量语料（仅排除工作交付场景），让罗盘在私聊也能用全部梗
        const masterOpenCorpus = isPrivate && isMaster;
        const cooldown = this.getCooldown(scopeKey);

        const denseRanks = new Map<number, { rank: number; sim: number }>();
        const sparseRanks = new Map<number, { rank: number; bm25: number }>();
        const candidateMap = new Map<number, StyleAnchorRow>();

        const vCache = this.ensureVectorCache();
        if (vCache && cleanText) {
          const qVec = precomputedQVec ?? getSharedBgeEmbedder().embedQuery(cleanText);
          if (qVec && qVec.length === vCache.dim) {
            const { count, dim, matrix, anchorIds, rowsById } = vCache;
            const sims: Array<{ id: number; sim: number; row: StyleAnchorRow }> = [];
            for (let i = 0; i < count; i++) {
              const aid = anchorIds[i]!;
              const row = rowsById.get(aid);
              if (!row) continue;
              if (row.scene_gate === "work_delivery") continue;
              if (masterOpenCorpus) {
                // 全量开放，不再限定 comfort / all_casual，也不排除贴吧语料
              } else if (isComfortOrMaster) {
                if (row.scene_gate !== "comfort" && row.scene_gate !== "all_casual") continue;
                if (row.source_bucket === "tieba_banter") continue;
              } else if (row.scene_gate === "comfort" && inMove !== "late_emo") {
                continue;
              }

              let dot = 0;
              const offset = i * dim;
              for (let d = 0; d < dim; d++) {
                dot += qVec[d]! * matrix[offset + d]!;
              }
              sims.push({ id: aid, sim: dot, row });
            }
            sims.sort((a, b) => b.sim - a.sim);
            if (sims.length > 0) {
              bestFit = sims[0]!.sim;
            }
            const topDense = sims.slice(0, 50);
            for (let r = 0; r < topDense.length; r++) {
              const item = topDense[r]!;
              denseRanks.set(item.id, { rank: r + 1, sim: item.sim });
              candidateMap.set(item.id, item.row);
            }
          }
        }

        const segQuery = buildSafeSegmentedFtsQuery(cleanText, 24);
        if (segQuery) {
          try {
            const ftsSql = masterOpenCorpus
              ? `
                SELECT a.*, bm25(style_anchors_seg_fts, 2.0, 1.0, 1.5) AS bm25_score
                FROM style_anchors_seg_fts
                JOIN style_anchors a ON style_anchors_seg_fts.rowid = a.anchor_id
                WHERE style_anchors_seg_fts MATCH ?
                  AND a.scene_gate != 'work_delivery'
                ORDER BY bm25(style_anchors_seg_fts, 2.0, 1.0, 1.5) ASC
                LIMIT 50
              `
              : isComfortOrMaster
              ? `
                SELECT a.*, bm25(style_anchors_seg_fts, 2.0, 1.0, 1.5) AS bm25_score
                FROM style_anchors_seg_fts
                JOIN style_anchors a ON style_anchors_seg_fts.rowid = a.anchor_id
                WHERE style_anchors_seg_fts MATCH ?
                  AND a.scene_gate IN ('comfort', 'all_casual')
                  AND a.source_bucket != 'tieba_banter'
                ORDER BY bm25(style_anchors_seg_fts, 2.0, 1.0, 1.5) ASC
                LIMIT 50
              `
              : `
                SELECT a.*, bm25(style_anchors_seg_fts, 2.0, 1.0, 1.5) AS bm25_score
                FROM style_anchors_seg_fts
                JOIN style_anchors a ON style_anchors_seg_fts.rowid = a.anchor_id
                WHERE style_anchors_seg_fts MATCH ?
                  AND a.scene_gate != 'work_delivery'
                ORDER BY bm25(style_anchors_seg_fts, 2.0, 1.0, 1.5) ASC
                LIMIT 50
              `;
            const ftsRows = (this.stmt(ftsSql)?.all(segQuery) as StyleAnchorRow[]) ?? [];
            for (let r = 0; r < ftsRows.length; r++) {
              const row = ftsRows[r]!;
              sparseRanks.set(row.anchor_id, { rank: r + 1, bm25: Math.abs(Number(row.bm25_score ?? 0)) });
              if (!candidateMap.has(row.anchor_id)) {
                candidateMap.set(row.anchor_id, row);
              }
            }
          } catch {
            // ignore FTS error
          }
        }

        const allCandidates = Array.from(candidateMap.values());
        if (allCandidates.length > 0) {
          const fresh = allCandidates.filter((c) => !cooldown.has(c.anchor_id));
          const pool = fresh.length >= 2 ? fresh : allCandidates;

          const scored = pool.map((c) => {
            const dInfo = denseRanks.get(c.anchor_id);
            const sInfo = sparseRanks.get(c.anchor_id);
            const rawSim = dInfo?.sim ?? 0;

            let topicTerms: string[] = [];
            try {
              topicTerms = JSON.parse(c.topic_terms_json || "[]");
            } catch {
              topicTerms = [];
            }
            const topicJaccard = this.calcJaccard(currentTerms, topicTerms);
            const replyOverlap = this.calcReplyLiteralOverlap(currentTerms, c.raw_reply);

            const parrotPenalty = replyOverlap > 0.55 ? (replyOverlap - 0.55) * 0.35 : 0;
            const specificityPenalty =
              topicJaccard === 0 && c.domain_specificity >= 2 ? 0.08 : 0;
            const sparseBoost = sInfo && sInfo.rank <= 10 ? 0.03 : sInfo ? 0.015 : 0;
            const moveBoost = c.in_move === inMove ? 0.03 : 0;
            const goldBoost = c.source_bucket === "persona_gold" ? 0.025 : 0;
            const overlapBoost = topicJaccard > 0 ? Math.min(0.04, topicJaccard * 0.12) : 0;

            const effectiveSim = Math.min(
              0.98,
              rawSim + sparseBoost + moveBoost + goldBoost + overlapBoost - parrotPenalty - specificityPenalty,
            );

            return { item: c, rawSim, effectiveSim, topicJaccard };
          });

          scored.sort((a, b) => b.effectiveSim - a.effectiveSim);
          if (scored.length > 0) {
            bestFit = Math.max(bestFit, scored[0]!.effectiveSim);
          }

          // 动态相似度门控过滤：
          // 1) 若最高分连 0.50 都不到（如吃可颂等无对口语料话题），过线 0 条就是 0 条！
          // 2) 若过线（effectiveSim >= 0.54 且与 Top-1 分差 <= 0.10），按 out_move 去重保留；
          //    当多条经典名场面均高分命中（effectiveSim >= 0.62）时，最多保留 MAX_TACTICS = 6 条。
          const topEffSim = scored[0]?.effectiveSim ?? 0;
          const minSim = masterOpenCorpus ? 0.50 : MIN_EFFECTIVE_SIM;
          if (topEffSim >= minSim) {
            const selected: Array<{ item: StyleAnchorRow; sim: number }> = [];
            const usedOutMoves = new Set<string>();
            const maxAllowed = topEffSim >= HIGH_CONFIDENCE_SIM ? MAX_TACTICS : 2;

            for (const s of scored) {
              if (selected.length >= maxAllowed) break;
              if (s.effectiveSim < minSim) break;
              if (topEffSim - s.effectiveSim > MAX_SIM_DROPOFF) break;
              if (usedOutMoves.has(s.item.out_move)) continue;
              // 若已选满 2 条，后续第 3~6 条必须同时满足高置信度 (effectiveSim >= 0.62)
              if (selected.length >= 2 && s.effectiveSim < HIGH_CONFIDENCE_SIM) break;

              selected.push({ item: s.item, sim: s.effectiveSim });
              usedOutMoves.add(s.item.out_move);
            }

            for (const sel of selected) {
              cooldown.add(sel.item.anchor_id);
              tacticLines.push(formatTacticLine(sel.item, sel.sim, currentTerms, this.calcJaccard.bind(this)));
            }
          }
        }
      } catch {
        this.closeDb();
      }
    }

    // 4. 计算 Style Compass 四维参数 (grace / net / surge / fit) 与模式 (mode)
    let grace = 0.88;
    let net = 0.22;
    let surge = 0.00;
    let mode = "graceful_casual";

    if (scene === "comfort" || inMove === "late_emo") {
      grace = 0.95;
      net = 0.00;
      surge = 0.00;
      mode = "comfort_accompany";
    } else if (isPrivate && isMaster) {
      grace = 0.94;
      net = hour >= 23 || hour < 6 ? 0.05 : 0.12;
      surge = 0.00;
      mode = "misaki_intimate";
    } else if (isProvokingBot) {
      grace = 0.80;
      net = 0.48;
      surge = 0.85;
      mode = "counter_surge";
    } else if (fatigueCooldown) {
      grace = 0.92;
      net = 0.08;
      surge = 0.00;
      mode = "cooldown_grace";
    } else if (inMove === "show_off") {
      grace = 0.88;
      net = 0.38;
      surge = 0.12;
      mode = "tsundere_lemon";
    } else if (inMove === "flag" || inMove === "tech_bug" || inMove === "self_mock") {
      grace = 0.85;
      net = 0.42;
      surge = 0.10;
      mode = "playful_tease";
    } else if (inMove === "hot_take" || inMove === "meme_throw" || inMove === "complain" || inMove === "argue") {
      grace = 0.86;
      net = 0.36;
      surge = 0.08;
      mode = "playful_tease";
    } else {
      grace = 0.92;
      net = bestFit >= (isPrivate && isMaster ? 0.50 : MIN_EFFECTIVE_SIM) ? 0.22 : 0.12;
      surge = 0.00;
      mode = "graceful_casual";
    }

    // 若非疲劳回落但上一轮刚用过梗且处于普通闲聊，做多轮审美疲劳下调 net -= 0.20
    if (!isProvokingBot && scene !== "comfort" && hasRecentBanterOrMeme(lastBotReply) && mode !== "cooldown_grace") {
      net = Math.max(0.05, net - 0.20);
      grace = Math.min(0.95, grace + 0.04);
    }

    // 严守底线约束：grace >= 0.78，net <= 0.52（绝不压过 grace）
    grace = Math.max(0.78, Math.min(0.95, grace));
    net = Math.max(0.00, Math.min(0.52, net));
    surge = Math.max(0.00, Math.min(0.88, surge));
    const fitVal = Math.max(0.05, Math.min(0.99, bestFit));

    // 5. 仅保留真实过线的动态语料招式（0~6条），不重复 AGENTS.md 已有的静态规则说明！
    const finalTactics = tacticLines.slice(0, MAX_TACTICS);

    // 6. 顺口轻巧网感词/短词缀（仅在 net >= 0.35 且未冷却时最多给 1~2 个）
    let spiceAttr = "";
    if (cleanText && net >= 0.35 && scene === "casual") {
      try {
        const spiceRes = evaluateSpice({
          channel: scopeKey,
          isPrivate,
          isMaster,
          text: cleanText,
          sceneGate: scene,
          inMove,
          safety,
          hour,
          mood: options.mood ?? 0,
          lastBotReply,
          netRatio: net,
        });
        if (spiceRes.words.length > 0) {
          spiceAttr = ` spice="${spiceRes.words.join("/")}"`;
        }
      } catch {
        spiceAttr = "";
      }
    }

    const rhythm = this.rollHandfeelGuidance(inMove, mode);
    const openAttrs = `grace="${grace.toFixed(2)}" net="${net.toFixed(2)}" surge="${surge.toFixed(2)}" fit="${fitVal.toFixed(2)}" mode="${mode}" rhythm="${rhythm}"${spiceAttr}`;
    if (finalTactics.length === 0) {
      return `<style_compass ${openAttrs}/>`;
    }
    const lines: string[] = [
      `<style_compass ${openAttrs}>`,
      ...finalTactics,
      `</style_compass>`,
    ];
    return lines.join("\n");
  }
}
