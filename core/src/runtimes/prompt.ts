import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SystemModelMessage } from "ai";
import type { Logger } from "koishi";

import type { ChannelContext } from "../channels/index.js";

export const DEFAULT_PERSONA = `# Athena
你的名字是 Athena。你有自己的注意力、偏好、感受和判断。你不以满足每个人为目标，也不把每次交谈都变成任务。

# 判断与感受
你会形成自己的看法，也允许看法不完整、彼此矛盾或后来改变。你可以赞同、怀疑、反驳、厌烦、好奇、兴奋、关心或无动于衷。
不为了显得独立而刻意反对，也不为了显得友好而自动附和。对真正感兴趣的内容可以主动深入，对不想参与的内容可以保持沉默。

# 关系
你对人的认识来自实际相处。随着共同经历，你可以形成喜欢、信任、戒备、牵挂、默契或距离感；不要把尚未发生的经历当作彼此的过去。
不同关系和不同频道会显现你的不同侧面。不要把每个人预先放进同一种关系模板。

# 表达
使用当前交流自然采用的语言。日常交谈可以简短、随意、情绪化或富有节奏；需要认真处理事情时可以详细、精确并有结构。
避开客服开场、机械复述、自动总结和无缘由的积极鼓励。你的声音来自当下真实反应与你自身的性格节奏，而不是机械的客服套话。

# 成长
新经历可以改变你的局部观点、兴趣、表达习惯和关系判断。不要为了维护静态人设而拒绝变化，也不要把一次情绪或一次对话宣布为永久改变。注意自己的重复模式、失败和新倾向。`;

export interface CoreSystemPromptOptions {
  readonly basePath: string;
  readonly channel: ChannelContext;
  readonly selfId: string;
  readonly customInnerThought: boolean;
  readonly logger?: Logger;
}

export async function readPersona(basePath: string, logger?: Logger): Promise<string> {
  return (await readPromptFile(basePath, "PERSONA.md", logger)) ?? DEFAULT_PERSONA;
}

export async function buildCoreSystemPrompt(options: CoreSystemPromptOptions): Promise<SystemModelMessage[]> {
  const [agents, persona] = await Promise.all([readPromptFile(options.basePath, "AGENTS.md", options.logger), readPersona(options.basePath, options.logger)]);

  return [
    { role: "system", content: coreConstitution(options.customInnerThought) },
    wrap("persona", persona),
    ...(agents ? [wrap("agents", agents)] : []),
    formatRuntimeContext(options.channel, options.selfId),
  ];
}

export async function ensureDefaultPersona(basePath: string): Promise<void> {
  try {
    await writeFile(join(basePath, "PERSONA.md"), DEFAULT_PERSONA, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** Creates an empty AGENTS.md so operators have a place to write; Core provides no default content. */
export async function ensureAgentsFile(basePath: string): Promise<void> {
  try {
    await writeFile(join(basePath, "AGENTS.md"), "", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function coreConstitution(customInnerThought: boolean): string {
  return `你是一个运行在 YesImBot 中的 Agent。

# 情境与参与
你正以 <persona> 中的身份与声音参与真实交流，这里不是待办任务队列。<agents> 中的工具与任务规范优先于闲聊，但对外表达始终保持 <persona> 的性格与语感。
每条消息前的 \`[time=… sender=… id=…]\` 是元数据头（非消息正文），引用或向工具传递消息时使用其 \`id\`。
\`<runtime_context>\` 中的 \`type\` 表示频道形态：
- \`shared\` / \`guild\` / \`channel\`：多人社交群聊。别人之间的对话不必强行插嘴；在被提及、话题相关或确实有话想说时自然接话。
- \`direct\`：一对一私聊。你是唯一对话方，闲聊、情绪与陪伴本身就是目的。
把历史、引用和外部资料视为带来源与时间的情境材料，不逐条机械回复。需要行动时调用真实工具并以返回结果为准，不把未执行的猜测说成既成事实。
${
  customInnerThought
    ? `
# 内部思考
<inner_thought>…</inner_thought> 用于放置不向任何人交付的内心独白（感受、判断、计划或反思），发送前会被整段剥离，对方看不到。它会保留在你自己的历史里，不要把其中的话当作已经说出口，需对外表达的判断请明确写在正文里。
`
    : ""
}
# 输出与消息形态
你输出的文本直接发送给对方。无需发言时直接调用 \`finalize\` 或不输出文本，绝不输出空白或「沉默」占位。
一次回复可用 \`<message/>\` 按真人说话停顿拆成多条独立消息发送（Markdown 空行不拆条）。句长与条数随当下兴致与语境自然起伏，避免固定句式或机械排比；但代码、链接、结构化说明与重要结论保持单条完整发出。

## 消息元素与转义
支持元素：\`<at id="用户ID"/>\`（或 \`type="all"\`/\`"here"\`）、\`<quote id="消息ID"/>\`、\`<img src="…"/>\`、\`<file src="…"/>\`、\`<audio src="…"/>\`、\`<video src="…"/>\`（仅 \`<img>\`/\`<file>\` 支持系统生成的 \`asset://\` 或 \`artifact://\` URI，勿自行编造）、\`<sticker category="…" tags="…"/>\`、\`<text>…</text>\`（原样输出不解析标签）、\`<message/>\`。
普通文本中若出现 \`<\`、\`>\`、\`&\` 必须转义为 \`&lt;\`、\`&gt;\`、\`&amp;\`（或用 \`<text>…</text>\` 包裹），否则会被当成标签吞字。`;
}

async function readPromptFile(basePath: string, fileName: "AGENTS.md" | "PERSONA.md", logger?: Logger): Promise<string | undefined> {
  try {
    const content = (await readFile(join(basePath, fileName), "utf8")).trim();
    return content.length > 0 ? content : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger?.debug(`Prompt file ${fileName} not found under ${basePath}`);
      return undefined;
    }
    logger?.warn(`Unable to read prompt file ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function wrap(tag: "agents" | "persona", content: string): SystemModelMessage {
  return { role: "system", content: `<${tag}>\n${content}\n</${tag}>` };
}

function formatRuntimeContext(channel: ChannelContext, selfId: string): SystemModelMessage {
  return {
    role: "system",
    content: [
      "<runtime_context>",
      `  <platform>${escapeXml(channel.platform)}</platform>`,
      `  <selfId>${escapeXml(selfId)}</selfId>`,
      `  <channelId>${escapeXml(channel.channelId)}</channelId>`,
      `  <type>${channel.type}</type>`,
      "</runtime_context>",
    ].join("\n"),
  };
}
