import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";

import { createRandomId } from "./id.js";
import type { AgentMessage } from "./message.js";

export type MessageAppendedEvent = { type: "message.appended"; message: AgentMessage } | ({ type: "message.appended"; message: AgentMessage } & TurnScoped);

export type AgentInternalEventInit =
  | AgentInitEvent
  | AgentStopEvent
  | AgentErrorEvent
  | TurnQueuedEvent
  | TurnStartEvent
  | TurnStepEvent
  | TurnDeltaEvent
  | TurnDoneEvent
  | TurnFailedEvent
  | TurnAbortedEvent
  | TurnAbandonedEvent
  | MessageAppendedEvent
  | ToolStartEvent
  | ToolDoneEvent
  | ToolFailedEvent
  | ToolBlockedEvent
  | ToolTimeoutEvent
  | PluginErrorEvent
  | PluginDisabledEvent;

export type AgentInternalEvent<T extends AgentInternalEventInit = AgentInternalEventInit> = T & AgentInternalEventMeta;

export type AgentCustomChannelEvent<T extends keyof AgentCustomChannelEvents = keyof AgentCustomChannelEvents> = AgentCustomChannelEvents[T];

export interface AgentCustomChannelEvents {
  internal: AgentInternalEvent;
  stream: TextStreamPart<ToolSet>;
}

export interface AgentDiagnostic {
  name: string;
  message: string;
  cause?: string;
}

export interface AgentInitEvent {
  type: "agent.init";
}

export interface AgentStopEvent {
  type: "agent.stop";
}

export interface AgentErrorEvent {
  type: "agent.error";
  error: AgentDiagnostic;
}

export interface TurnQueuedEvent extends TurnScoped {
  type: "turn.queued";
}

export interface TurnStartEvent extends TurnScoped {
  type: "turn.start";
}

export interface TurnStepEvent extends TurnScoped {
  type: "turn.step";
  step: number;
  usage?: Partial<LanguageModelUsage>;
  finishReason?: string;
  reasoningText?: string;
}

export interface TurnDeltaEvent extends TurnScoped {
  type: "turn.delta";
  delta: string;
}

export interface TurnDoneEvent extends TurnScoped {
  type: "turn.done";
}

export interface TurnFailedEvent extends TurnScoped {
  type: "turn.failed";
  error: AgentDiagnostic;
}

export interface TurnAbortedEvent extends TurnScoped {
  type: "turn.aborted";
  reason?: string;
}

/**
 * interrupt() 等不到 turn 收尾、放弃等待后发出。
 * 这是 turn 流上的终止事件：消费者必须据此收尾，不能再等 turn.done。
 */
export interface TurnAbandonedEvent extends TurnScoped {
  type: "turn.abandoned";
  /** 该 turn 从开始执行到被放弃的时长（毫秒） */
  elapsedMs: number;
  /** interrupt() 使用的等待上限（毫秒） */
  timeoutMs: number;
  /** 放弃时仍在排队的 turn 数 */
  queueLength?: number;
  reason?: string;
}

export interface ToolStartEvent extends TurnScoped {
  type: "tool.start";
  toolName: string;
  toolCallId?: string;
  args?: unknown;
}

export interface ToolDoneEvent extends TurnScoped {
  type: "tool.done";
  toolName: string;
  toolCallId?: string;
  result?: unknown;
}

export interface ToolFailedEvent extends TurnScoped {
  type: "tool.failed";
  toolName: string;
  toolCallId?: string;
  error: AgentDiagnostic;
  args?: unknown;
}

export interface ToolBlockedEvent extends TurnScoped {
  type: "tool.blocked";
  toolName: string;
  toolCallId?: string;
  reason?: string;
}

export interface ToolTimeoutEvent extends TurnScoped {
  type: "tool.timeout";
  toolName: string;
  toolCallId?: string;
  timeoutMs: number;
}

export interface PluginErrorEvent {
  type: "plugin.error";
  plugin: string;
  error: AgentDiagnostic;
}

export interface PluginDisabledEvent {
  type: "plugin.disabled";
  plugin: string;
  reason?: AgentDiagnostic;
}

export interface AgentInternalEventMeta {
  id: string;
  timestamp: number;
}

interface TurnScoped {
  turnId: string;
}

export function createDiagnostic(error: unknown): AgentDiagnostic {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, cause: formatDiagnosticCause(error.cause) };
  }

  return { name: "UnknownError", message: String(error) };
}

export function createInternalEvent<T extends AgentInternalEventInit>(event: T): AgentInternalEvent<T> {
  return { id: createRandomId(), timestamp: Date.now(), ...event };
}

function formatDiagnosticCause(cause: unknown): string | undefined {
  if (cause === undefined) {
    return undefined;
  }

  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }

  return String(cause);
}
