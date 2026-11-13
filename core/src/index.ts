import YesImBotService from "./service.js";

declare module "koishi" {
  interface Context {
    yesimbot: YesImBotService;
  }
}

export default YesImBotService;

export type { ChannelPlugin, WillEngine, WillPlugin, WillState } from "./agents/index.js";

export type { ChannelContext, ChannelKey } from "./channels/index.js";

export * from "./messages/index.js";

export type { Translator } from "./messengers/index.js";

export type { NudgeOptions, PostOptions } from "./runtimes/index.js";

export type * from "./models/index.js";

export type * from "./resources/index.js";

// 供验收用例与排查脚本直接调用事件翻译链路（不参与运行时路径）
export { MilkyTranslator, translateMilkyEvent } from "./platforms/milky.js";

// 供验收用例直接构造卡片工具做离线校验（不参与运行时路径）
export { createSendChatRecordCardTool } from "./agents/tools.js";
