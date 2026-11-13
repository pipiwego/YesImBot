import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateText: vi.fn<(args: { system?: string; prompt: string }) => Promise<{ text: string }>>() }));

vi.mock("ai", () => ({ generateText: mocks.generateText }));

import { enrichSnapshotWithModel } from "../src/enrich.js";
import { applyPatternAnnotations } from "../src/patterns.js";
import type {
  ChatLearningConfig,
  ChatLearningState,
  InitiationPattern,
  ConversationSegment,
  MessageLink,
  MessageTurn,
  ResponsePattern,
} from "../src/types.js";

const config = {
  maxExamples: 3,
  maxMessagesPerExample: 3,
  maxHistoryAgeDays: 30,
  maxScanMessages: 1000,
  refreshIntervalMinutes: 120,
  maxPromptTokens: 1200,
  maskNames: true,
  blockedUserIds: [],
  blockedUserPatterns: [],
  autoBlockBotNames: true,
  ignoreBotMentions: true,
  observeAllChannels: false,
  globalRulePath: undefined,
  globalSyncIntervalMinutes: 30,
  minGlobalChannels: 1,
  maxGlobalPatterns: 20,
  summaryModel: undefined,
  embeddingModel: undefined,
  embeddingSimilarity: 0.92,
  maxModelThreads: 3,
  maxModelThreadMessages: 30,
  reflectionModel: undefined,
  maxInjectedReflections: 3,
  injectStyleAsSystem: false,
} as ChatLearningConfig;

function turn(id: string, timestamp: number, text: string): MessageTurn {
  return {
    id,
    messageId: id,
    userId: id === "m1" ? "u1" : "u2",
    userName: "A",
    timestamp,
    text,
    elementKinds: ["text"],
    hasImage: false,
    quoteId: undefined,
    quoteType: undefined,
    mentionIds: [],
  };
}

const turns = [turn("m1", 1000, "这个方案靠谱吗"), turn("m2", 2000, "确实"), turn("m3", 3000, "笑死"), turn("m4", 4000, "确实")];
const segment: ConversationSegment = { id: "s1", startTime: 1000, endTime: 4000, turns };
const links: MessageLink[] = [
  { from: "m2", to: "m1", kind: "reply", confidence: 1, evidence: [] },
  { from: "m3", to: "m2", kind: "reply", confidence: 1, evidence: [] },
  { from: "m4", to: "m3", kind: "reply", confidence: 1, evidence: [] },
];

const learnedResponse: readonly ResponsePattern[] = [
  { intent: "agree", phrase: "确实", frequency: 8, sampleIds: ["a1", "a2"] },
  { intent: "joke", phrase: "笑死", frequency: 5, sampleIds: ["a3"] },
];
const learnedInitiation: readonly InitiationPattern[] = [{ intent: "question", phrase: "这个方案靠谱吗", frequency: 4, sampleIds: ["a4"] }];
const learnedTemplates = [{ template: "确实{X}", examples: ["确实", "确实啊"], usage: "附和时用", frequency: 8, firstSeenAt: 1, lastSeenAt: 2 }];

function emptySnapshot(): ChatLearningState {
  return {
    lastEntryId: "m4",
    builtAt: Date.now(),
    turns,
    links,
    segments: [segment],
    responsePatterns: [],
    initiationPatterns: [],
    memeTemplates: [],
  };
}

function previousState(): ChatLearningState {
  return { ...emptySnapshot(), responsePatterns: learnedResponse, initiationPatterns: learnedInitiation, memeTemplates: learnedTemplates };
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

afterEach(() => {
  mocks.generateText.mockReset();
});

describe("空标注不得覆盖已学规律（R15 缺陷 2）", () => {
  it("模型返回 messages:[] 时保留旧值，只记 info", async () => {
    mocks.generateText.mockResolvedValue({ text: JSON.stringify({ messages: [] }) });
    const log = logger();

    const result = await enrichSnapshotWithModel(emptySnapshot(), previousState(), {
      model: { modelId: "test-model" } as never,
      config,
      logger: log,
      modelId: "test-model",
    });

    expect(result.responsePatterns).toEqual(learnedResponse);
    expect(result.initiationPatterns).toEqual(learnedInitiation);
    expect(result.memeTemplates).toEqual(learnedTemplates);
    expect(log.info).toHaveBeenCalledWith(
      "chat_learning.model_enrich_annotation_kept",
      expect.objectContaining({ reason: "empty_annotation", applied: false, kept: 3 }),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("模型把整段判成 noise（成功但零标签）时同样保留旧值 + info", async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        messages: [
          { id: "t0-m0", role: "noise", intent: "noise" },
          { id: "t0-m1", role: "noise", intent: "noise" },
          { id: "t0-m2", role: "noise", intent: "noise" },
          { id: "t0-m3", role: "noise", intent: "noise" },
        ],
      }),
    });
    const log = logger();

    const result = await enrichSnapshotWithModel(emptySnapshot(), previousState(), {
      model: { modelId: "test-model" } as never,
      config,
      logger: log,
      modelId: "test-model",
    });

    expect(result.responsePatterns).toEqual(learnedResponse);
    expect(result.initiationPatterns).toEqual(learnedInitiation);
    expect(log.info).toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("解析失败时保留旧值并 warn", async () => {
    mocks.generateText.mockResolvedValue({ text: "抱歉，我无法完成这个标注" });
    const log = logger();

    const result = await enrichSnapshotWithModel(emptySnapshot(), previousState(), {
      model: { modelId: "test-model" } as never,
      config,
      logger: log,
      modelId: "test-model",
    });

    expect(result.responsePatterns).toEqual(learnedResponse);
    expect(result.initiationPatterns).toEqual(learnedInitiation);
    expect(result.memeTemplates).toEqual(learnedTemplates);
    expect(log.warn).toHaveBeenCalledWith(
      "chat_learning.model_enrich_annotation_failed",
      expect.objectContaining({ reason: "parse_error" }),
    );
    expect(log.info).not.toHaveBeenCalled();
  });

  it("上游报错时保留旧值并 warn（区分于真空）", async () => {
    mocks.generateText.mockRejectedValue(new Error("upstream 502"));
    const log = logger();

    const result = await enrichSnapshotWithModel(emptySnapshot(), previousState(), {
      model: { modelId: "test-model" } as never,
      config,
      logger: log,
      modelId: "test-model",
    });

    expect(result.responsePatterns).toEqual(learnedResponse);
    expect(log.warn).toHaveBeenCalledWith(
      "chat_learning.model_enrich_annotation_failed",
      expect.objectContaining({ reason: "model_error", detail: "upstream 502" }),
    );
  });

  it("没有可标注线程时保留旧值并记 info（不是 warn）", async () => {
    const log = logger();
    const noThreads: ChatLearningState = { ...emptySnapshot(), turns: [], links: [], segments: [] };

    const result = await enrichSnapshotWithModel(noThreads, previousState(), {
      model: { modelId: "test-model" } as never,
      config,
      logger: log,
      modelId: "test-model",
    });

    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(result.responsePatterns).toEqual(learnedResponse);
    expect(log.info).toHaveBeenCalledWith(
      "chat_learning.model_enrich_annotation_kept",
      expect.objectContaining({ reason: "no_threads" }),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("有真实新标注时才替换，且只保留为空的那一侧", async () => {
    mocks.generateText.mockImplementation(async (args) =>
      args.system ? { text: JSON.stringify({ messages: [{ id: "t0-m3", role: "response", intent: "agree" }] }) } : { text: JSON.stringify({ templates: [] }) },
    );
    const log = logger();

    const result = await enrichSnapshotWithModel(emptySnapshot(), previousState(), {
      model: { modelId: "test-model" } as never,
      config,
      logger: log,
      modelId: "test-model",
    });

    expect(result.responsePatterns).toHaveLength(1);
    expect(result.responsePatterns[0]).toMatchObject({ phrase: "确实", intent: "agree" });
    // initiation 侧为空 → 保留旧值，并记一条 info（不是静默清零）
    expect(result.initiationPatterns).toEqual(learnedInitiation);
    expect(log.info).toHaveBeenCalledWith(
      "chat_learning.model_enrich_annotation_kept",
      expect.objectContaining({ reason: "partial_empty", keptInitiation: 1 }),
    );
  });
});

describe("applyPatternAnnotations", () => {
  const baseline = { responsePatterns: learnedResponse, initiationPatterns: learnedInitiation };

  it("failed/parse_error → 原样返回旧值 + warn", () => {
    const applied = applyPatternAnnotations(baseline, { status: "failed", reason: "parse_error", detail: "bad json" });
    expect(applied.applied).toBe(false);
    expect(applied.level).toBe("warn");
    expect(applied.responsePatterns).toBe(learnedResponse);
    expect(applied.keptResponse).toBe(2);
    expect(applied.keptInitiation).toBe(1);
  });

  it("ok 但两侧都空 → 保留旧值 + info", () => {
    const applied = applyPatternAnnotations(baseline, { status: "ok", snapshot: { responsePatterns: [], initiationPatterns: [] } });
    expect(applied.applied).toBe(false);
    expect(applied.level).toBe("info");
    expect(applied.reason).toBe("empty_annotation");
    expect(applied.initiationPatterns).toBe(learnedInitiation);
  });

  it("旧值本来就是空时，空结果不会误报 warn", () => {
    const applied = applyPatternAnnotations({ responsePatterns: [], initiationPatterns: [] }, { status: "ok", snapshot: { responsePatterns: [], initiationPatterns: [] } });
    expect(applied.level).toBe("info");
    expect(applied.keptResponse).toBe(0);
  });
});
