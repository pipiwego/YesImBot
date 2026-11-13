import type { AgentInternalEvent } from "./event.js";
import { createRandomId } from "./id.js";
import type { AgentMessage } from "./message.js";
import type { AgentState } from "./state.js";
export type AgentCustomEntryData<T extends keyof AgentCustomEntries = keyof AgentCustomEntries> = AgentCustomEntries[T];
export type AgentEntry<T extends keyof AgentCustomEntries = keyof AgentCustomEntries> = T extends keyof AgentCustomEntries
  ? { data: AgentCustomEntryData<T>; id: string; parentId?: string; timestamp: number; type: T }
  : never;
export interface CompactEntryData {
  summary: string;
  lastEntryId: string;
  sourceSession?: string;
  /** 模型压缩不可用时的降级截断（丢弃最老消息），由 conversations 侧写入 */
  degraded?: boolean;
}
export interface AgentCustomEntries {
  compact: CompactEntryData;
  event: AgentInternalEvent;
  message: AgentMessage;
  state: AgentState;
}
export interface CreateEntryOptions {
  id?: string;
  timestamp?: number;
  parentId?: string;
}
export function createEntry<T extends keyof AgentCustomEntries>(type: T, data: AgentCustomEntryData<T>, options: CreateEntryOptions = {}): AgentEntry<T> {
  return { id: options.id ?? createRandomId(), type, data, timestamp: options.timestamp ?? Date.now(), parentId: options.parentId } as AgentEntry<T>;
}
export function createMessageEntry(message: AgentMessage, options: CreateEntryOptions = {}): AgentEntry<"message"> {
  return createEntry("message", message, options);
}
export function createStateEntry(state: AgentState, options: CreateEntryOptions = {}): AgentEntry<"state"> {
  return createEntry("state", state, options);
}
export function createEventEntry(event: AgentInternalEvent, options: CreateEntryOptions = {}): AgentEntry<"event"> {
  return createEntry("event", event, options);
}
