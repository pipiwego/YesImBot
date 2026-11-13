export type Decision = "wait" | "trigger";

export interface PolicyRoutingConfig {
  readonly direct: Decision;
  readonly mention: Decision;
  readonly mentionAll: Decision;
  readonly mentionHere: Decision;
  readonly quote: Decision;
  readonly image: Decision;
  readonly poke: Decision;
  readonly group: Decision;
}

export interface PolicyWillingnessConfig {
  readonly maxScore: number;
  readonly initialScore: number;
  readonly decayHalfLifeSeconds: number;
  readonly probabilityThreshold: number;
  readonly probabilityAmplifier: number;
  readonly replyCost: number;
  readonly textGain: number;
  readonly mentionGain: number;
  readonly quoteGain: number;
  readonly directGain: number;
  readonly imageGain: number;
  readonly pokeGain: number;
  readonly keywords: string[];
  readonly keywordMultiplier: number;
  readonly defaultMultiplier: number;
  readonly hotWindowSeconds: number;
  readonly warmWindowSeconds: number;
  readonly hotDecayWeight: number;
  readonly warmDecayWeight: number;
  readonly mentionForce: boolean;
  readonly quoteForce: boolean;
  readonly directForce: boolean;
}

export interface SmartBatchPreset {
  readonly minBatchSize: number;
  readonly maxBatchSize: number;
  readonly debounceSeconds: number;
  readonly maxWaitSeconds: number;
  readonly cooldownSeconds: number;
  readonly longSilenceMinutes: number;
}

export interface ChannelPresetOverride {
  readonly channelId: string;
  readonly preset: "small" | "large";
}

export interface PolicySmartBatchConfig {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort: "none" | "low";
  readonly scoreThreshold: number;
  readonly directForce: boolean;
  readonly mentionForce: boolean;
  readonly quoteForce: boolean;
  readonly pokeForce: boolean;
  readonly forceKeywords: string[];
  readonly defaultPreset: "small" | "large";
  readonly smallPreset: SmartBatchPreset;
  readonly largePreset: SmartBatchPreset;
  readonly channelOverrides: ChannelPresetOverride[];
}

export interface WillPolicyConfig {
  readonly engine: "routing" | "willingness" | "smart-batch";
  readonly routing?: PolicyRoutingConfig;
  readonly willingness?: PolicyWillingnessConfig;
  readonly smartBatch?: Partial<PolicySmartBatchConfig>;
  readonly priority?: number;
}

export function defaultRoutingConfig(): PolicyRoutingConfig {
  return { direct: "trigger", mention: "trigger", mentionAll: "wait", mentionHere: "wait", quote: "wait", image: "wait", poke: "wait", group: "wait" };
}

export function defaultWillingnessConfig(): PolicyWillingnessConfig {
  return {
    maxScore: 100,
    initialScore: 0,
    decayHalfLifeSeconds: 600,
    probabilityThreshold: 55,
    probabilityAmplifier: 0.04,
    replyCost: 35,
    textGain: 12,
    mentionGain: 100,
    quoteGain: 15,
    directGain: 40,
    imageGain: 8,
    pokeGain: 80,
    keywords: [],
    keywordMultiplier: 1.2,
    defaultMultiplier: 1,
    hotWindowSeconds: 15,
    warmWindowSeconds: 60,
    hotDecayWeight: 0.3,
    warmDecayWeight: 0.7,
    mentionForce: false,
    quoteForce: false,
    directForce: false,
  };
}

export function defaultSmartBatchConfig(): PolicySmartBatchConfig {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    model: "deepseek-flash",
    reasoningEffort: "none",
    scoreThreshold: 6,
    directForce: true,
    mentionForce: true,
    quoteForce: true,
    pokeForce: true,
    forceKeywords: ["诗音", "诗音酱", "月见", "月见诗音", "Shion", "shion"],
    defaultPreset: "small",
    smallPreset: {
      minBatchSize: 1,
      maxBatchSize: 5,
      debounceSeconds: 3,
      maxWaitSeconds: 8,
      cooldownSeconds: 12,
      longSilenceMinutes: 20,
    },
    largePreset: {
      minBatchSize: 6,
      maxBatchSize: 18,
      debounceSeconds: 6,
      maxWaitSeconds: 25,
      cooldownSeconds: 60,
      longSilenceMinutes: 60,
    },
    channelOverrides: [],
  };
}
