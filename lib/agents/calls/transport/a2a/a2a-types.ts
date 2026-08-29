/**
 * A2A 0.3.0 wire 类型（lib/agents/calls/transport/a2a/a2a-types.ts）。
 *
 * A2A 是「AgentCall → 外部 Agent」的通信协议，不是 SnowHarness Runtime Protocol。
 * 本文件只定义 A2A wire 的冻结子集（04 §4，不实现 A2A 1.x 兼容层）。
 *
 * 官方 0.3.0 合同约束：
 * - status-update 的 status.final 为必需布尔字段；
 * - Task/status/artifact 的 taskId/contextId/artifactId 严格非空字符串；
 * - artifact 支持 append/lastChunk 增量累积（非仅最后一次 parts）。
 */

/** A2A Task state（0.3.0 冻结子集）。 */
export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "auth-required"
  | "unknown";

/** A2A status-update 事件（SSE JSON-RPC result）。 */
export interface A2AStatusUpdate {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: { state: A2ATaskState; message?: A2AMessage | null; final: boolean };
}

/** A2A artifact-update 事件。 */
export interface A2AArtifactUpdate {
  kind: "artifact-update";
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
}

export type A2AStreamUpdate = A2AStatusUpdate | A2AArtifactUpdate;

/** A2A Message（role/parts）。 */
export interface A2AMessage {
  role: string;
  parts: A2APart[];
}

/** A2A Part（TextPart 展示文本 / DataPart 公共结构化结果）。 */
export interface A2APart {
  kind: string;
  text?: string;
  data?: unknown;
}

/** A2A Artifact（parts 携带展示文本与结构化结果；append/lastChunk 支持增量累积）。 */
export interface A2AArtifact {
  artifactId: string;
  name?: string;
  parts?: A2APart[];
  /** 增量片段：为 true 时 text/data 追加到既有累积而非覆盖。 */
  append?: boolean;
  /** 最后一个增量片段（官方 lastChunk）。 */
  lastChunk?: boolean;
}

/** A2A Task（官方 message/send 同步结果形态）。 */
export interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: A2ATaskState; message?: A2AMessage | null; final?: boolean };
  artifacts?: A2AArtifact[];
}

/** JSON-RPC 响应（SSE data 或同步响应）。 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: { code?: number; message?: string; data?: unknown };
}

/** A2A Agent Card（probeCapabilities 数据源，仅取必需字段）。 */
export interface A2AAgentCard {
  name?: string;
  url?: string;
  version?: string;
  /** A2A 0.3.0 协议版本；须等于 "0.3.0"，version 仅是 Agent 自身版本。 */
  protocolVersion?: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  skills?: Array<{ id?: string; name?: string }>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

/** 从 Message parts 提取文本。 */
export function a2aMessageText(
  message: A2AMessage | null | undefined,
): string | null {
  if (!message || !Array.isArray(message.parts)) return null;
  const texts = message.parts
    .map((p) => (typeof p?.text === "string" ? p.text : null))
    .filter((t): t is string => t !== null);
  return texts.length > 0 ? texts.join("\n") : null;
}
