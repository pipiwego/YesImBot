export type LinkKind = "quote" | "reply" | "at" | "adjacent" | "entity";

export type LinkCorrectionAction = "add" | "remove";

export type ResponseIntent = "ack" | "agree" | "question" | "joke" | "roast" | "empathy" | "refuse";

export type InitiationIntent = "share" | "question" | "react" | "recall" | "opinion";

export type GlobalPatternKind = "response" | "initiation";

export type ProactiveEventKind = "global-brain" | "schedule" | "chat-learning";

export interface MessageTurn {
  readonly id: string;
  readonly messageId: string;
  readonly userId: string;
  readonly userName: string | undefined;
  readonly timestamp: number;
  readonly text: string;
  readonly elementKinds: readonly string[];
  readonly hasImage: boolean;
  readonly quoteId: string | undefined;
  readonly quoteType: "quote" | "reply" | undefined;
  readonly mentionIds: readonly string[];
}

export interface MessageLink {
  readonly from: string;
  readonly to: string | null;
  readonly kind: LinkKind;
  readonly confidence: number;
  readonly evidence: readonly string[];
}

export interface LinkCorrection {
  readonly id: string;
  readonly action: LinkCorrectionAction;
  readonly from: string;
  readonly to: string | null;
  readonly kind: LinkKind | "*";
  readonly confidence: number;
  readonly createdAt: number;
  readonly note: string | undefined;
}

export interface ConversationSegment {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly turns: readonly MessageTurn[];
}

export interface ResponsePattern {
  readonly intent: ResponseIntent;
  readonly phrase: string;
  readonly frequency: number;
  readonly sampleIds: readonly string[];
}

export interface InitiationPattern {
  readonly intent: InitiationIntent;
  readonly phrase: string;
  readonly frequency: number;
  readonly sampleIds: readonly string[];
}

export interface LocalChainSampleTurn {
  readonly intent: string;
  readonly speaker: string;
  readonly text: string;
}

export interface LocalChainSample {
  readonly turns: readonly LocalChainSampleTurn[];
}

export interface LocalChainPattern {
  readonly chain: readonly string[];
  readonly frequency: number;
  readonly sample?: LocalChainSample;
  readonly style?: string;
  readonly styleSampleId?: string;
  readonly semantics?: string;
}

export interface GlobalChannelStat {
  readonly key: string;
  readonly frequency: number;
  readonly lastSeenAt: number;
}

export interface GlobalPattern {
  /** 首个 kind，兼容老读者；新读者请用 kinds。 */
  readonly kind: GlobalPatternKind;
  /** 首个 intent，兼容老读者；新读者请用 intents。 */
  readonly intent: string;
  readonly kinds?: readonly GlobalPatternKind[];
  readonly intents?: readonly string[];
  readonly phrase: string;
  readonly channels: readonly GlobalChannelStat[];
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  /** 同一语义簇内的其他措辞（≤4 条），仅 cluster 档写入。 */
  readonly variants?: readonly string[];
  /** 重要性实数，∈[0,1]；缺失按 0.5 处理。 */
  readonly salience?: number;
  /** 观测计数，只增不减（不参与排序）。 */
  readonly hits?: number;
  readonly embedding?: readonly number[];
}

/** 边界型记忆：max 聚合、不衰减、不受 minGlobalChannels 约束。 */
export interface BoundaryMemory {
  readonly id: string;
  readonly text: string;
  /** 首次出现的频道指纹。 */
  readonly channelKey: string;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  /** max 聚合，重复出现不提升。 */
  readonly strength: number;
  /** 命中次数，只用于观测，不进排序。 */
  readonly hits: number;
  /** 置时间戳即失效。 */
  readonly revokedAt?: number;
}

export interface GlobalChainSample {
  readonly turns: readonly LocalChainSampleTurn[];
  readonly channelKey: string;
}

export interface GlobalChainPattern {
  readonly chain: readonly string[];
  readonly samples?: readonly GlobalChainSample[];
  readonly style?: string;
  readonly styleSampleId?: string;
  readonly semantics?: string;
  readonly channels: readonly GlobalChannelStat[];
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface GlobalRuleBank {
  readonly version: number;
  readonly updatedAt: number;
  readonly patterns: readonly GlobalPattern[];
  readonly chains: readonly GlobalChainPattern[];
  readonly templates: readonly MemeTemplate[];
  readonly boundaries?: readonly BoundaryMemory[];
}

export interface MemeTemplate {
  readonly template: string;
  readonly examples: readonly string[];
  readonly usage: string;
  readonly frequency: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface ChatLearningState {
  readonly lastEntryId: string | undefined;
  readonly builtAt: number;
  readonly turns: readonly MessageTurn[];
  readonly links: readonly MessageLink[];
  readonly segments: readonly ConversationSegment[];
  readonly responsePatterns: readonly ResponsePattern[];
  readonly initiationPatterns: readonly InitiationPattern[];
  readonly memeTemplates: readonly MemeTemplate[];
}

export interface ChatLearningConfig {
  readonly maxExamples: number;
  readonly maxMessagesPerExample: number;
  readonly maxHistoryAgeDays: number;
  readonly maxScanMessages: number;
  readonly refreshIntervalMinutes: number;
  readonly maxPromptTokens: number;
  readonly maskNames: boolean;
  readonly blockedUserIds: string[];
  readonly blockedUserPatterns: string[];
  readonly autoBlockBotNames: boolean;
  readonly ignoreBotMentions: boolean;
  readonly observeAllChannels: boolean;
  readonly globalRulePath: string | undefined;
  readonly globalSyncIntervalMinutes: number;
  readonly minGlobalChannels: number;
  readonly maxGlobalPatterns: number;
  readonly summaryModel: string | undefined;
  readonly embeddingModel: string | undefined;
  readonly embeddingSimilarity: number;
  /** 语义聚簇阈值（默认 0.85），低于 embeddingSimilarity 时把措辞记入 variants。 */
  readonly clusterSimilarity?: number;
  readonly maxModelThreads: number;
  readonly maxModelThreadMessages: number;
  readonly reflectionModel: string | undefined;
  readonly finalStyleModel?: string;
  readonly maxInjectedReflections: number;
  readonly injectStyleAsSystem: boolean;
}
