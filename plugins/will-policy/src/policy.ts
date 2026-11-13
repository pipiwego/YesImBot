import {
  defaultRoutingConfig,
  defaultSmartBatchConfig,
  defaultWillingnessConfig,
  type PolicyRoutingConfig,
  type PolicySmartBatchConfig,
  type PolicyWillingnessConfig,
  type WillPolicyConfig,
} from "./types.js";

export interface ResolvedPolicy {
  readonly engine: "routing" | "willingness" | "smart-batch";
  readonly routing: PolicyRoutingConfig;
  readonly willingness: PolicyWillingnessConfig;
  readonly smartBatch: PolicySmartBatchConfig;
}

export function resolvePolicy(config: WillPolicyConfig): ResolvedPolicy {
  const defSmart = defaultSmartBatchConfig();
  const rawSmart = config.smartBatch ?? {};
  return {
    engine: config.engine,
    routing: { ...defaultRoutingConfig(), ...config.routing },
    willingness: { ...defaultWillingnessConfig(), ...config.willingness },
    smartBatch: {
      ...defSmart,
      ...rawSmart,
      apiKey: rawSmart.apiKey || defSmart.apiKey,
      smallPreset: { ...defSmart.smallPreset, ...(rawSmart.smallPreset ?? {}) },
      largePreset: { ...defSmart.largePreset, ...(rawSmart.largePreset ?? {}) },
      forceKeywords: rawSmart.forceKeywords ?? defSmart.forceKeywords,
      channelOverrides: rawSmart.channelOverrides ?? defSmart.channelOverrides,
    },
  };
}
