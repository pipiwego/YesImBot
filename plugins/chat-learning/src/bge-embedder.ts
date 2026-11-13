import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const DEFAULT_BGE_DIRS = [
  "/opt/shion/koishi-app/data/yesimbot/style-corpus/bge-model",
  "/srv/appdata/shion-stack/koishi-data/yesimbot/style-corpus/bge-model",
];

const ORT_BINDING_CANDIDATES = [
  "/opt/shion/yesimbot/plugins/chat-learning/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node",
  "/opt/shion/yesimbot/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node",
  "/opt/shion/koishi-app/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node",
  "/srv/appdata/yesimbot-stack/yesimbot/plugins/chat-learning/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node",
  "/srv/appdata/yesimbot-stack/yesimbot/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node",
];

export class BgeEmbedder {
  private vocab = new Map<string, number>();
  private clsId = 101;
  private sepId = 102;
  private unkId = 100;
  private sess: any = null;
  private ready = false;
  public dim = 512;

  constructor(customModelDir?: string) {
    this.init(customModelDir);
  }

  public isReady(): boolean {
    return this.ready && this.sess !== null;
  }

  private init(customModelDir?: string): void {
    try {
      const dirs = customModelDir ? [customModelDir, ...DEFAULT_BGE_DIRS] : DEFAULT_BGE_DIRS;
      let modelDir = "";
      for (const d of dirs) {
        if (d && existsSync(path.join(d, "vocab.txt"))) {
          modelDir = d;
          break;
        }
      }
      if (!modelDir) return;

      const onnxPath = existsSync(path.join(modelDir, "model_small_quantized.onnx"))
        ? path.join(modelDir, "model_small_quantized.onnx")
        : existsSync(path.join(modelDir, "model_quantized.onnx"))
          ? path.join(modelDir, "model_quantized.onnx")
          : "";
      if (!onnxPath) return;

      const vocabText = readFileSync(path.join(modelDir, "vocab.txt"), "utf-8");
      const lines = vocabText.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 0 || i === 0) {
          this.vocab.set(lines[i], i);
        }
      }
      this.clsId = this.vocab.get("[CLS]") ?? 101;
      this.sepId = this.vocab.get("[SEP]") ?? 102;
      this.unkId = this.vocab.get("[UNK]") ?? 100;

      const req = typeof require === "function" ? require : createRequire(import.meta.url);
      let binding: any = null;
      for (const cand of ORT_BINDING_CANDIDATES) {
        if (existsSync(cand)) {
          binding = req(cand);
          break;
        }
      }
      if (!binding) {
        try {
          const ortMain = req.resolve("onnxruntime-node");
          const cand = path.resolve(path.dirname(ortMain), "../bin/napi-v3/linux/x64/onnxruntime_binding.node");
          if (existsSync(cand)) binding = req(cand);
        } catch {
          // ignore
        }
      }
      if (!binding?.InferenceSession) return;

      const sess = new binding.InferenceSession();
      sess.loadModel(onnxPath, {
        intraOpNumThreads: 4,
        interOpNumThreads: 1,
        
      });
      this.sess = sess;
      this.dim = onnxPath.includes("small") ? 512 : 768;
      this.ready = true;
    } catch {
      this.sess = null;
      this.ready = false;
    }
  }

  private isChineseChar(cp: number): boolean {
    return (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2b73f) ||
      (cp >= 0x2b740 && cp <= 0x2b81f) ||
      (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x2f800 && cp <= 0x2fa1f)
    );
  }

  private isPunctOrSymbol(ch: string): boolean {
    return /[\p{P}\p{S}]/u.test(ch);
  }

  public tokenizeIds(text: string, maxLen = 96): number[] {
    const clean = text.toLowerCase().normalize("NFKC").trim();
    const basicTokens: string[] = [];
    let currentWord = "";

    for (const ch of clean) {
      const cp = ch.codePointAt(0) || 0;
      if (/\s/.test(ch) || cp === 0 || cp === 0xfffd) {
        if (currentWord) {
          basicTokens.push(currentWord);
          currentWord = "";
        }
      } else if (this.isChineseChar(cp) || this.isPunctOrSymbol(ch)) {
        if (currentWord) {
          basicTokens.push(currentWord);
          currentWord = "";
        }
        basicTokens.push(ch);
      } else {
        currentWord += ch;
      }
    }
    if (currentWord) basicTokens.push(currentWord);

    const ids: number[] = [this.clsId];
    for (const token of basicTokens) {
      if (ids.length >= maxLen - 1) break;
      const direct = this.vocab.get(token);
      if (direct !== undefined) {
        ids.push(direct);
        continue;
      }
      const chars = Array.from(token);
      let isBad = false;
      let start = 0;
      const subIds: number[] = [];
      while (start < chars.length) {
        let end = chars.length;
        let curId: number | undefined;
        while (start < end) {
          let substr = chars.slice(start, end).join("");
          if (start > 0) substr = "##" + substr;
          const found = this.vocab.get(substr);
          if (found !== undefined) {
            curId = found;
            break;
          }
          end--;
        }
        if (curId === undefined) {
          isBad = true;
          break;
        }
        subIds.push(curId);
        start = end;
      }
      if (isBad) {
        ids.push(this.unkId);
      } else {
        for (const sid of subIds) {
          if (ids.length >= maxLen - 1) break;
          ids.push(sid);
        }
      }
    }
    ids.push(this.sepId);
    return ids;
  }

  public embedQuery(queryText: string): Float32Array | null {
    if (!this.isReady() || !queryText) return null;
    try {
      const fullText = `为这个句子生成表示以用于检索相关文章：${queryText}`;
      const tokenIds = this.tokenizeIds(fullText, 96);
      const seqLen = tokenIds.length;
      const inputIds = new BigInt64Array(seqLen);
      const mask = new BigInt64Array(seqLen);
      const typeIds = new BigInt64Array(seqLen);
      for (let i = 0; i < seqLen; i++) {
        inputIds[i] = BigInt(tokenIds[i]!);
        mask[i] = 1n;
        typeIds[i] = 0n;
      }
      const out = this.sess.run(
        {
          input_ids: { type: "int64", data: inputIds, dims: [1, seqLen] },
          attention_mask: { type: "int64", data: mask, dims: [1, seqLen] },
          token_type_ids: { type: "int64", data: typeIds, dims: [1, seqLen] },
        },
        { last_hidden_state: null },
        {},
      );
      const hidden = out.last_hidden_state.data as Float32Array;
      const dim = out.last_hidden_state.dims[2] as number;
      this.dim = dim;
      const vec = new Float32Array(dim);
      let norm = 0;
      for (let i = 0; i < dim; i++) {
        const v = hidden[i]!;
        vec[i] = v;
        norm += v * v;
      }
      norm = Math.sqrt(norm) || 1e-12;
      for (let i = 0; i < dim; i++) {
        vec[i]! /= norm;
      }
      return vec;
    } catch {
      return null;
    }
  }
}

let sharedEmbedder: BgeEmbedder | null = null;
export function getSharedBgeEmbedder(): BgeEmbedder {
  if (!sharedEmbedder) {
    sharedEmbedder = new BgeEmbedder();
  }
  return sharedEmbedder;
}
