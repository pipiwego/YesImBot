import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult, LanguageModelV3StreamResult } from "@ai-sdk/provider";
import type { LanguageModel, ToolSet } from "ai";
import { Context, Schema } from "koishi";
import { type BaseProviderConfig } from "koishi-plugin-yesimbot";
export const name = "yesimbot-provider-openai";

export const usage = "OpenAI 提供商插件（支持多级模型故障自动回退）";

export const inject = ["yesimbot"];

export const reusable = true;

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    id: Schema.string().default("openai").description("提供商标识"),
    apiKey: Schema.string().role("secret").required().description("API Key"),
    baseURL: Schema.string().description("API Base URL"),
    format: Schema.union([Schema.const("chat"), Schema.const("responses")])
      .default("chat")
      .description("API 格式"),
    chatModels: Schema.array(
      Schema.object({
        id: Schema.string().required().description("模型 ID（可用逗号串联多级回退，如 modelA,modelB,modelC）"),
        toolCall: Schema.boolean().default(true).description("工具调用"),
        reasoning: Schema.boolean().default(false).description("推理"),
      }),
    )
      .role("table")
      .default([{ id: "gpt-4o", toolCall: true, reasoning: true }])
      .description("可用聊天模型列表"),
    embeddingModels: Schema.array(Schema.object({ id: Schema.string().required().description("模型 ID") }))
      .role("table")
      .default([])
      .description("可用嵌入模型列表"),
  }),
  Schema.union([
    Schema.object({ format: Schema.const("chat") }),
    Schema.object({ format: Schema.const("responses"), webSearch: Schema.boolean().default(false).description("启用原生 Web 搜索") }),
  ]),
]);

interface Config extends BaseProviderConfig {
  format: "chat" | "responses";
  webSearch?: boolean;
}

function createFallbackLanguageModel(models: LanguageModelV3[], names: string[], logger: ReturnType<Context["logger"]>): LanguageModelV3 {
  const primary = models[0]!;
  return {
    specificationVersion: "v3",
    provider: primary.provider,
    modelId: names.join(","),
    supportedUrls: primary.supportedUrls,
    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      let lastErr: unknown;
      for (let i = 0; i < models.length; i += 1) {
        try {
          return await models[i]!.doGenerate(options);
        } catch (err) {
          lastErr = err;
          logger.warn(`Model ${names[i]} generate failed, falling back to next candidate...`, err instanceof Error ? err.message : String(err));
        }
      }
      throw lastErr;
    },
    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      let lastErr: unknown;
      for (let i = 0; i < models.length; i += 1) {
        try {
          return await models[i]!.doStream(options);
        } catch (err) {
          lastErr = err;
          logger.warn(`Model ${names[i]} stream failed, falling back to next candidate...`, err instanceof Error ? err.message : String(err));
        }
      }
      throw lastErr;
    },
  };
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(`yesimbot.openai.${config.id}`);
  ctx.on("ready", () => {
    const client = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    const resolveSingle = (id: string): LanguageModel => (config.format === "responses" ? client.responses(id) : client.chat(id));
    const dispose = ctx.yesimbot.model.register({
      id: config.id,
      capabilities: { chat: true, embedding: true },
      chatModels: () => config.chatModels,
      embeddingModels: () => config.embeddingModels ?? [],
      chat: (modelId: string) => {
        const candidates = modelId.split(",").map((s) => s.trim()).filter(Boolean);
        if (candidates.length <= 1) return resolveSingle(modelId);
        const v3Models = candidates.map((c) => resolveSingle(c) as LanguageModelV3);
        return createFallbackLanguageModel(v3Models, candidates, logger);
      },
      embedding: (modelId: string) => client.embedding(modelId),
      tools: (): ToolSet => (config.format === "responses" && config.webSearch ? { web_search: client.tools.webSearch() } : {}),
    });
    ctx.on("dispose", dispose);
  });
}
