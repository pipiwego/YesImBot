import { randomUUID } from "node:crypto";
import { type Command, type Context, type Logger, Schema, type Session, Universal } from "koishi";
import type { ChannelContext, DeliveredPayload, WillEngine, WillPlugin } from "koishi-plugin-yesimbot";

import { resolvePolicy } from "./policy.js";
import { PolicyRoutingEngine } from "./routing.js";
import { PolicySmartBatchEngine } from "./smart-batch.js";
import type { SmartBatchPreset, WillPolicyConfig } from "./types.js";
import { PolicyWillingnessEngine } from "./willingness.js";

const SmartBatchPresetSchema = (defaults: SmartBatchPreset) =>
  Schema.object({
    minBatchSize: Schema.number().default(defaults.minBatchSize).description("触发判定的最小有效消息数"),
    maxBatchSize: Schema.number().default(defaults.maxBatchSize).description("强制触发判定的最大积压消息数"),
    debounceSeconds: Schema.number().default(defaults.debounceSeconds).description("防抖等待秒数"),
    maxWaitSeconds: Schema.number().default(defaults.maxWaitSeconds).description("单批最长等待秒数"),
    cooldownSeconds: Schema.number().default(defaults.cooldownSeconds).description("发言后硬冷却秒数"),
    longSilenceMinutes: Schema.number().default(defaults.longSilenceMinutes).description("冷场破冰判定分钟数"),
  });

export const WillPolicyConfigSchema: Schema<WillPolicyConfig> = Schema.object({
  engine: Schema.union([
    Schema.const("routing").description("固定规则（routing）"),
    Schema.const("willingness").description("意愿值引擎（willingness）"),
    Schema.const("smart-batch").description("DeepSeek 智能批处理引擎（smart-batch）"),
  ])
    .default("routing")
    .description("该实例使用的决策引擎"),
  priority: Schema.number().default(1000).description("WillEngine 优先级，数值小者先执行"),
  routing: Schema.object({
    direct: Schema.union(["wait", "trigger"]).default("trigger").description("私聊消息"),
    mention: Schema.union(["wait", "trigger"]).default("trigger").description("@ 机器人"),
    mentionAll: Schema.union(["wait", "trigger"]).default("wait").description("@全体成员"),
    mentionHere: Schema.union(["wait", "trigger"]).default("wait").description("@在线成员"),
    quote: Schema.union(["wait", "trigger"]).default("wait").description("引用/回复消息"),
    image: Schema.union(["wait", "trigger"]).default("wait").description("含图片的消息"),
    poke: Schema.union(["wait", "trigger"]).default("wait").description("拍一拍事件"),
    group: Schema.union(["wait", "trigger"]).default("wait").description("普通群消息"),
  }).description("固定规则引擎配置"),
  willingness: Schema.object({
    maxScore: Schema.number().default(100).description("意愿值上限"),
    initialScore: Schema.number().default(0).description("初始意愿值"),
    decayHalfLifeSeconds: Schema.number().default(600).description("意愿值半衰期(秒)"),
    probabilityThreshold: Schema.number().default(55).description("触发概率阈值"),
    probabilityAmplifier: Schema.number().default(0.04).description("超过阈值后的概率放大系数"),
    replyCost: Schema.number().default(35).description("每次成功回复后扣除的意愿值"),
    textGain: Schema.number().default(12).description("普通消息基础增益"),
    mentionGain: Schema.number().default(100).description("被 @ 时的增益"),
    quoteGain: Schema.number().default(15).description("引用/回复时的增益"),
    directGain: Schema.number().default(40).description("私聊时的增益"),
    imageGain: Schema.number().default(8).description("含图片消息的增益"),
    pokeGain: Schema.number().default(80).description("拍一拍事件的增益"),
    keywords: Schema.array(Schema.string()).default([]).description("高兴趣关键词"),
    keywordMultiplier: Schema.number().default(1.2).description("命中关键词时的乘数"),
    defaultMultiplier: Schema.number().default(1).description("未命中关键词时的默认乘数"),
    hotWindowSeconds: Schema.number().default(15).description("热窗口秒数"),
    warmWindowSeconds: Schema.number().default(60).description("温窗口秒数"),
    hotDecayWeight: Schema.number().default(0.3).description("热窗口衰减权重"),
    warmDecayWeight: Schema.number().default(0.7).description("温窗口衰减权重"),
    mentionForce: Schema.boolean().default(false).description("被 @ 时强制触发"),
    quoteForce: Schema.boolean().default(false).description("引用时强制触发"),
    directForce: Schema.boolean().default(false).description("私聊强制触发"),
  }).description("意愿值引擎配置"),
  smartBatch: Schema.object({
    baseURL: Schema.string().default("https://api.deepseek.com/v1").description("DeepSeek API Base URL"),
    apiKey: Schema.string().role("secret").default("").description("DeepSeek API Key"),
    model: Schema.string().default("deepseek-flash").description("判断模型名称"),
    reasoningEffort: Schema.union(["none", "low"]).default("none").description("思考模式（none=关闭思考秒判，low=轻量思考）"),
    scoreThreshold: Schema.number().default(6).description("开口分数阈值（0~9）"),
    directForce: Schema.boolean().default(true).description("私聊消息 VIP 直通"),
    mentionForce: Schema.boolean().default(true).description("被 @ 时 VIP 直通"),
    quoteForce: Schema.boolean().default(true).description("引用回复诗音时 VIP 直通"),
    pokeForce: Schema.boolean().default(true).description("拍一拍诗音时 VIP 直通"),
    forceKeywords: Schema.array(Schema.string())
      .default(["诗音", "诗音酱", "月见", "月见诗音", "Shion", "shion"])
      .description("强唤醒关键词列表"),
    defaultPreset: Schema.union(["small", "large"]).default("small").description("默认群预设档位"),
    smallPreset: SmartBatchPresetSchema({
      minBatchSize: 1,
      maxBatchSize: 5,
      debounceSeconds: 3,
      maxWaitSeconds: 8,
      cooldownSeconds: 12,
      longSilenceMinutes: 20,
    }).description("小群/活跃熟人群预设"),
    largePreset: SmartBatchPresetSchema({
      minBatchSize: 6,
      maxBatchSize: 18,
      debounceSeconds: 6,
      maxWaitSeconds: 25,
      cooldownSeconds: 60,
      longSilenceMinutes: 60,
    }).description("大群/高噪群预设"),
    channelOverrides: Schema.array(
      Schema.object({
        channelId: Schema.string().required(),
        preset: Schema.union(["small", "large"]).default("small"),
      }),
    )
      .default([])
      .description("按群号指定 small/large 档位"),
  }).description("DeepSeek 智能批处理引擎配置"),
}) as unknown as Schema<WillPolicyConfig>;

const DEBUG_COMMAND_NAME = "yesimbot.will-policy";

const DEBUG_PROBES = new WeakMap<Context, Set<WillPolicyPlugin>>();

const DEBUG_COMMANDS = new WeakMap<Context, Command>();

const DEBUG_ACTION: unique symbol = Symbol("yesimbot.will-policy.debug-action");

type DebugCommand = Command & { [DEBUG_ACTION]?: boolean };

export default class WillPolicyPlugin implements WillPlugin {
  public static readonly name = "yesimbot-will-policy";
  public static readonly reusable = true;
  public static readonly inject = ["yesimbot"];
  public static readonly usage = "提供可克隆、可筛选、可组合的 WillEngine 与 smart-batch 策略";
  public static readonly Config: Schema<WillPolicyConfig> = WillPolicyConfigSchema;

  public readonly ctx: Context;
  public readonly config: WillPolicyConfig;
  public readonly logger: Logger;
  public readonly priority: number;

  private readonly instanceId = randomUUID();
  private disposeWillPlugin?: () => void;
  private readonly activeSmartEngines = new Set<PolicySmartBatchEngine>();
  /** scopeKey → 该频道当前生效的 smart-batch engine，runtime 重建时用它做状态迁移 */
  private readonly smartEnginesByScope = new Map<string, PolicySmartBatchEngine>();

  public constructor(ctx: Context, config: WillPolicyConfig) {
    this.ctx = ctx;
    this.config = config;
    this.priority = config.priority ?? 1000;
    this.logger = ctx.logger("yesimbot.will-policy");
    this.logger.level = ctx.yesimbot.config.logLevel ?? 2;
    ctx.on("ready", this.start.bind(this));
    ctx.on("dispose", this.stop.bind(this));
  }

  public async start(): Promise<void> {
    this.disposeWillPlugin?.();
    this.disposeWillPlugin = this.ctx.yesimbot.agent.will(this);
    this.registerDebugProbe();
    this.logger.success("Will policy plugin started", { instanceId: this.instanceId, engine: this.config.engine });
  }

  public match(session: Session): boolean {
    const matched = this.ctx.filter(session);
    this.logger.debug("will_policy.match", {
      instanceId: this.instanceId,
      priority: this.priority,
      engine: this.config.engine,
      platform: session.platform,
      channelId: session.channelId,
      guildId: session.guildId,
      matched,
    });
    return matched;
  }

  public matchContext(context: ChannelContext): boolean {
    const bot =
      this.ctx.bots.find((candidate) => candidate.platform === context.platform && (!context.selfId || candidate.selfId === context.selfId)) ??
      this.ctx.bots[0];
    if (!bot) {
      this.logger.debug("will_policy.match_context", {
        instanceId: this.instanceId,
        priority: this.priority,
        engine: this.config.engine,
        platform: context.platform,
        channelId: context.channelId,
        guildId: context.type === "direct" ? undefined : context.guildId,
        matched: false,
        reason: "no_bot",
      });
      return false;
    }

    const isDirect = context.type === "direct";

    const session = bot.session({
      type: "message-created",
      subtype: isDirect ? "private" : "group",
      platform: context.platform,
      selfId: context.selfId,
      timestamp: Date.now(),
      channel: { id: context.channelId, type: isDirect ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT },
      ...(!isDirect && context.guildId ? { guild: { id: context.guildId } } : {}),
      ...(isDirect ? { user: { id: context.userId, ...(context.userName ? { name: context.userName } : {}) } } : {}),
    } as never) as Session;
    const matched = this.ctx.filter(session);
    this.logger.debug("will_policy.match_context", {
      instanceId: this.instanceId,
      priority: this.priority,
      engine: this.config.engine,
      platform: context.platform,
      channelId: context.channelId,
      guildId: isDirect ? undefined : context.guildId,
      matched,
    });
    return matched;
  }

  public setup(scope: ChannelContext): WillEngine {
    const resolved = resolvePolicy(this.config);
    const scopeKey = `${scope.platform}:${scope.channelId}`;
    const previous = this.smartEnginesByScope.get(scopeKey);
    this.logger.debug("resolve_will_policy", { engine: resolved.engine, channelId: scope.channelId });

    if (resolved.engine === "smart-batch") {
      const engine = new PolicySmartBatchEngine(
        scope,
        resolved.smartBatch,
        this.logger,
        (options) => this.ctx.yesimbot.messenger.nudge(scope, options),
        (cb) =>
          this.ctx.on("yesimbot/delivered", (payload: DeliveredPayload) => {
            if (payload.platform === scope.platform && payload.channel.id === scope.channelId) {
              cb(payload.messageId, payload.text);
            }
          }),
      );
      if (previous) {
        // runtime 重建：先把旧池/冷却/追问窗口迁到新 engine，再停旧 engine（停定时器 + delivered 监听）。
        // 顺序不能反：adoptStateFrom 会读旧 engine 的私有状态，stop() 之后虽然状态还在，但语义上应先迁移。
        const migrated = engine.adoptStateFrom(previous);
        previous.stop();
        this.activeSmartEngines.delete(previous);
        this.logger.info("will_policy.engine_migrated", {
          instanceId: this.instanceId,
          platform: scope.platform,
          channelId: scope.channelId,
          pending: migrated.pending,
          cooldownRemainMs: migrated.cooldownRemainMs,
          lastBotReplyAgoMs: migrated.lastBotReplyAgoMs,
          previousEvaluating: migrated.previousEvaluating,
        });
      }
      this.smartEnginesByScope.set(scopeKey, engine);
      this.activeSmartEngines.add(engine);
      return engine;
    }

    // 非 smart-batch（含引擎类型切换）：旧 smart engine 必须显式停掉并解除索引，不能只丢引用
    if (previous) {
      previous.stop();
      this.activeSmartEngines.delete(previous);
      this.smartEnginesByScope.delete(scopeKey);
      this.logger.info("will_policy.engine_released", {
        instanceId: this.instanceId,
        platform: scope.platform,
        channelId: scope.channelId,
        engine: resolved.engine,
      });
    }

    if (resolved.engine === "routing") {
      return new PolicyRoutingEngine(resolved.routing, this.logger);
    }
    return new PolicyWillingnessEngine(resolved.willingness, this.logger);
  }

  public async stop(): Promise<void> {
    for (const engine of this.smartEnginesByScope.values()) {
      engine.stop();
    }
    this.smartEnginesByScope.clear();
    for (const engine of this.activeSmartEngines) {
      engine.stop();
    }
    this.activeSmartEngines.clear();

    const root = this.ctx.root;
    const probes = DEBUG_PROBES.get(root);
    probes?.delete(this);
    if (probes?.size === 0) {
      DEBUG_COMMANDS.get(root)?.dispose();
      DEBUG_COMMANDS.delete(root);
      DEBUG_PROBES.delete(root);
    }
    this.disposeWillPlugin?.();
    this.disposeWillPlugin = undefined;
  }

  private registerDebugProbe(): void {
    const root = this.ctx.root;
    const probes = DEBUG_PROBES.get(root) ?? new Set<WillPolicyPlugin>();
    probes.add(this);
    DEBUG_PROBES.set(root, probes);

    let command = DEBUG_COMMANDS.get(root);
    if (!command) {
      command = root.command(DEBUG_COMMAND_NAME, "检查当前 WillEngine 策略实例", { authority: 4 });
      DEBUG_COMMANDS.set(root, command);
    }
    const debugCommand = command as DebugCommand;
    if (debugCommand[DEBUG_ACTION]) return;
    Object.defineProperty(debugCommand, DEBUG_ACTION, { value: true });
    debugCommand.action(async ({ session }) => {
      if (!session) return;
      const matches = [...probes].filter((probe) => probe.ctx.filter(session));
      if (matches.length === 0) return;
      return matches.map((probe) => probe.instanceDescription()).join("\n");
    });
  }

  private instanceDescription(): string {
    return [`WillPolicy[${this.instanceId.slice(0, 8)}]`, `engine=${this.config.engine}`, `priority=${this.priority}`].join(" ");
  }
}

export {
  classifyHttpStatus,
  classifyJudgeError,
  DeepSeekJudge,
  parseJudgeJson,
  STATIC_SYSTEM_PROMPT,
  tryParseJudgeJson,
} from "./deepseek-judge.js";
export type { EvaluateOptions, JudgeDecision, JudgeFailureKind, JudgeLogger } from "./deepseek-judge.js";
export { PolicySmartBatchEngine } from "./smart-batch.js";
