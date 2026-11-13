/**
 * R15 第三处（边界行 channelKey）只读核对脚本。
 *
 * 做四件事：
 * 1. 直接从 index.ts 源码里取 `scopeKey()` 的模板串，确认脚本用的格式没有漂移；
 * 2. 枚举 koishi-data/yesimbot/channels/* 目录，推出真实私聊/群聊的 scopeKey；
 * 3. 用 global-store.ts 里**真实的** boundaryChannelKey / selectBoundaries 读库文件
 *    （normalizeGlobalRuleBank → 与运行时同一条解析路径），打印每个频道能读到几条边界；
 * 4. 用 mergeLocalPatterns 走一遍写路径，确认写出的 channelKey 与读路径算出的键一致
 *    （读写同源回归）。
 *
 * 只读：只读 JSON，不写盘。用法：
 *   npx tsx tests/verify-r15-boundaries.mts [--data <json>] [--src <index.ts>] [--self-id 2690928435]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { boundaryChannelKey, createEmptyGlobalRuleBank, mergeLocalPatterns, normalizeGlobalRuleBank, selectBoundaries } from "../src/global-store.js";

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};

const dataPath = argOf("--data", "/srv/appdata/shion-stack/koishi-data/yesimbot/chat-learning-global.json");
const srcPath = argOf("--src", new URL("../src/index.ts", import.meta.url).pathname);
const selfId = argOf("--self-id", "2690928435");
const channelsDir = argOf("--channels", "/srv/appdata/shion-stack/koishi-data/yesimbot/channels");

/** 与 index.ts:scopeKey() 保持同形；下面会用源码模板串断言。 */
function scopeKeyOf(type: "direct" | "guild", platform: string, self: string, channelId: string): string {
  const kind = type === "direct" ? "direct" : "guild";
  return `${kind}:${platform}:${self}:${channelId}`;
}

function fingerprint(scopeKey: string): string {
  return createHash("sha256").update(scopeKey).digest("hex").slice(0, 16);
}

let failures = 0;
const check = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

// 1. scopeKey 格式没有漂移
const src = readFileSync(srcPath, "utf8");
const scopeKeyPattern = /return `\$\{kind\}:\$\{scope\.platform\}:\$\{scope\.selfId\}:\$\{scope\.channelId\}`/;
check(scopeKeyPattern.test(src), "index.ts 的 scopeKey 模板串未漂移", "`${kind}:${scope.platform}:${scope.selfId}:${scope.channelId}`");
check(/const kind = scope\.type === "direct" \? "direct" : "guild"/.test(src), "scopeKey 只有 direct/guild 两态");

// 2. 从 channels 目录推出候选 scope
interface Candidate {
  readonly scopeKey: string;
  readonly label: string;
}
const candidates: Candidate[] = [];
if (existsSync(channelsDir)) {
  for (const name of readdirSync(channelsDir)) {
    if (name.startsWith("direct-")) {
      const rest = name.slice("direct-".length);
      const parts = rest.split("-");
      const platform = parts[0]!;
      const owner = parts.slice(1, -1).join("-");
      const channelId = `private:${owner}`;
      const self = parts.at(-1) ?? selfId;
      candidates.push({ scopeKey: scopeKeyOf("direct", platform, self, channelId), label: name });
      continue;
    }
    if (name.startsWith("guild-")) {
      const rest = name.slice("guild-".length);
      const platform = rest.split("-")[0]!;
      const channelId = rest.slice(platform.length + 1);
      candidates.push({ scopeKey: scopeKeyOf("guild", platform, selfId, channelId), label: name });
    }
  }
}
check(candidates.length > 0, "从 channels 目录推出候选 scope", `${candidates.length} 个`);

// 3. 读库（与运行时同一条解析路径）
const raw = JSON.parse(readFileSync(dataPath, "utf8")) as unknown;
const bank = normalizeGlobalRuleBank(raw);
const rows = bank.boundaries ?? [];
console.log(`\n--- 库内边界（${dataPath}）: ${rows.length} 条 ---`);
for (const row of rows) {
  // id 复核：boundaryId = sha256(channelKey + "\0" + text).slice(0,16)
  const expectedId = createHash("sha256").update(`${row.channelKey}\u0000${row.text}`).digest("hex").slice(0, 16);
  console.log(
    `  key=${row.channelKey} id=${row.id} id_ok=${expectedId === row.id} strength=${row.strength.toFixed(2)} revoked=${row.revokedAt ?? "-"} text=${JSON.stringify(row.text)}`,
  );
}

const seenKeys = new Set(rows.map((row) => row.channelKey));
console.log("\n--- 每个候选频道：运行时键 & selectBoundaries 能读到几条 ---");
const matchedKeys = new Set<string>();
for (const candidate of candidates) {
  const key = boundaryChannelKey(candidate.scopeKey);
  const selected = selectBoundaries(bank, 50, key);
  const same = fingerprint(candidate.scopeKey) === key;
  if (seenKeys.has(key)) matchedKeys.add(key);
  console.log(
    `  ${candidate.label.padEnd(34)} scopeKey=${candidate.scopeKey}\n${"".padEnd(36)}boundaryChannelKey=${key} 读到=${selected.length} 条  (fingerprint 复核=${same})`,
  );
}

console.log("\n--- 结论 ---");
const allKeysCovered = [...seenKeys].every((key) => matchedKeys.has(key));
check(allKeysCovered, "库里每条 boundary 的 channelKey 都能被某个真实频道算出来", `库里 keys=${[...seenKeys].join(",")}`);
for (const key of seenKeys) {
  const owner = candidates.find((candidate) => boundaryChannelKey(candidate.scopeKey) === key);
  console.log(`  key=${key} ← ${owner ? owner.label : "没有匹配的频道（= 永远读不到）"}`);
}

// 4. 写路径回归：mergeLocalPatterns 写出的 channelKey 必须能被读路径取到
const probeScope = candidates.find((candidate) => boundaryChannelKey(candidate.scopeKey) === [...seenKeys][0]) ?? candidates[0];
if (probeScope) {
  const text = "别招惹你了";
  const written = mergeLocalPatterns(createEmptyGlobalRuleBank(), [], [], [], probeScope.scopeKey, Date.now(), { boundaryTexts: [text] });
  const writtenKey = written.boundaries.at(-1)?.channelKey;
  const readBack = selectBoundaries(written, 50, boundaryChannelKey(probeScope.scopeKey));
  check(
    writtenKey === boundaryChannelKey(probeScope.scopeKey),
    "写路径（mergeLocalPatterns）与读路径（selectBoundaries）用同一个 channelKey",
    `写=${writtenKey} 读=${boundaryChannelKey(probeScope.scopeKey)} 回读=${readBack.length} 条`,
  );
  check(readBack.length === 1 && readBack[0]?.text === text, "刚写入的边界能被 selectBoundaries 读回");
}

console.log(`\n${failures === 0 ? "OK：全部核对通过" : `FAILED：${failures} 项不通过`}`);
process.exit(failures === 0 ? 0 : 1);
