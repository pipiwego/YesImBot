import type { AgentEntry, AgentMessage } from "@yesimbot/agent-runtime";
import { generateText, type AssistantContent, type LanguageModel } from "ai";
import type { Element } from "koishi";

/** 单次压缩 LLM 调用的默认上限（毫秒）。 */
export const DEFAULT_COMPACT_TIMEOUT_MS = 90_000;

export interface ExecuteCompactInput {
  readonly model: LanguageModel;
  readonly personaName: string;
  readonly persona: string;
  readonly previousMemory: string;
  readonly conversation: string;
  /** 上层取消信号（停止/归档），与内部超时并联 */
  readonly signal?: AbortSignal;
  /** 单次调用上限（毫秒），默认 {@link DEFAULT_COMPACT_TIMEOUT_MS} */
  readonly timeoutMs?: number;
}

export function filterEntriesForCompression(entries: readonly AgentEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.data as AgentMessage;
    if (message.role === "tool") continue;
    if (message.role === "custom") {
      const custom = message as AgentMessage & { type?: string; data?: { user?: { id?: string; name?: string }; elements?: Element[]; text?: string } };
      if (custom.type === "yesimbot.message") {
        const text = elementsText(custom.data?.elements);
        if (text) lines.push(`[${custom.data?.user?.name ?? custom.data?.user?.id ?? "user"}]: ${text}`);
      } else if (custom.type === "yesimbot.event" && custom.data?.text) lines.push(`[事件]: ${custom.data.text}`);
    } else if (message.role === "assistant") {
      const text = assistantText(message.content);
      if (text) lines.push(`[assistant]: ${text}`);
    }
  }
  return lines.join("\n");
}

/**
 * 调模型做一次压缩摘要。
 *
 * 关键约束（R12）：必须带 abortSignal + 硬超时 —— 改前这里既没有 signal 也没有 maxRetries 限制，
 * 一次挂住的 provider 请求会占着频道串行锁不放，把整条频道堵死。
 */
export async function executeCompact(input: ExecuteCompactInput): Promise<string> {
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_COMPACT_TIMEOUT_MS;
  const controller = new AbortController();
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(input.signal?.reason);
  };

  if (input.signal) {
    if (input.signal.aborted) forwardAbort();
    else input.signal.addEventListener("abort", forwardAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort(new Error(`Compaction timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  try {
    const { text } = await generateText({
      model: input.model,
      system: `你正在为 ${input.personaName} 压缩长期对话记忆。保留关系、事实、偏好、未完成事项和重要上下文，不编造内容。`,
      prompt: `<persona>\n${input.persona}\n</persona>\n\n<previous_memory>\n${input.previousMemory || "(none)"}\n</previous_memory>\n\n<conversation>\n${input.conversation}\n</conversation>`,
      abortSignal: controller.signal,
      // 不重试：一旦 provider 抖动，AI SDK 默认的 3 次重试会把一次超时放大成 3 倍。
      maxRetries: 0,
    });
    const summary = text.trim();
    if (!summary) throw new Error("Compaction produced an empty summary.");
    return summary;
  } catch (cause) {
    if (timedOut) throw new Error(`Compaction timed out after ${timeoutMs}ms`);
    throw cause;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", forwardAbort);
  }
}

function assistantText(content: AssistantContent): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
      : "";
}

function elementsText(elements?: readonly Element[]): string {
  return (elements ?? [])
    .map((element) =>
      element.type === "text"
        ? String(element.attrs.content ?? "")
        : element.type === "img" || element.type === "image"
          ? "[图片]"
          : element.type === "file"
            ? "[文件]"
            : element.type === "at"
              ? `@${String(element.attrs.name ?? element.attrs.id ?? "")}`
              : elementsText(element.children),
    )
    .filter(Boolean)
    .join("");
}
