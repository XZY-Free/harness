/**
 * A2A Mapper（lib/agents/calls/transport/a2a/a2a-mapper.ts）。
 *
 * A2A wire update → AgentCallCandidateEvent（AgentCall 域归一化，04 §6）。
 *
 * 关键边界（专题01 最高级原则）：
 * - A2A 事件必须先成为 AgentCall event/state（经 AgentCallEventIngress），
 *   由 Harness Loop 决定是否继续 / 是否最终完成顶层 Invocation。
 * - A2A completed → AgentCall.completed（绝不直接 parent Invocation.completed）。
 * - A2A failed / correlation lost / stream EOF / endpoint failure →
 *   AgentCall failed/lost（绝不直接 mark parent Invocation lost）。
 * - A2A input-required → AgentCall waiting_user / input-required 事实。
 *
 * 归一化不变量：
 * - 每个 AgentCall 候选事件（有已知 refs 时）都携带 task_id 与 context_id，
 *   供持久化 AgentCallEventIngress 关联；
 * - artifact 语义（text + data）不得丢弃：completed/input-required 的答复/追问
 *   文本与结构化结果取自该 task 最新 artifact 累积；
 * - unknown state 不伪造终态也不静默忽略：抛错由调用方按 protocol_parse_failed
 *   fail closed。
 */

import {
  AgentTransportError,
  type AgentCallCandidateEvent,
} from "@/lib/agents/calls/transport/agent-transport";
import {
  type A2AArtifact,
  type A2AArtifactUpdate,
  type A2AMessage,
  type A2AStreamUpdate,
  type A2ATaskState,
  a2aMessageText,
} from "@/lib/agents/calls/transport/a2a/a2a-types";

/**
 * Mapper 可接受的 status-update 形状。
 *
 * 流事件（A2AStatusUpdate）的 final 为 0.3.0 必需布尔；官方 Task 形态（同步 message/
 * tasks/get 结果）的 status.final 可选。Mapper 只读 state/message，不伪造 final，
 * 故合并为 final 可选的形状（流侧 final 强校验由 parse 路径单独负责）。
 */
export interface A2AMappableStatusUpdate {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: { state: A2ATaskState; message?: A2AMessage | null; final?: boolean };
}

/** Mapper 输入：artifact-update 或 status-update（含官方 Task 形态投影）。 */
export type A2AMappableUpdate = A2AArtifactUpdate | A2AMappableStatusUpdate;

/** 公共 Context 合同键 allowlist（04 §12/§11：只允许公开合同键，绝不加入内部标识）。 */
export const A2A_PUBLIC_CONTEXT_KEYS = new Set([
  "execution_subject",
  "current_datetime",
  "timezone",
  "locale",
  "conversation_context",
  "attachment_references",
  "workspace_context",
]);

/**
 * Start/Resume 共用的唯一公共 Context → A2A message.metadata mapper（04 §12）。
 * 输入是已验证的公共 Context 对象，但只透传 allowlist 内的合同键；内部 ID/trace/
 * tenant/token 等一律不发，输出是对象（绝非 JSON string）。
 */
export function buildA2APublicMessageMetadata(
  invocationContext?: Array<{ context_kind: string; value: unknown }>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const entry of invocationContext ?? []) {
    if (A2A_PUBLIC_CONTEXT_KEYS.has(entry.context_kind)) {
      metadata[entry.context_kind] = entry.value;
    }
  }
  return metadata;
}

/** 公开合同（HR 兼容）：input 型 user_action 的通用严格 JSON Schema。 */
export const A2A_INPUT_ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: {
      type: "string",
      title: "补充信息",
      minLength: 1,
      maxLength: 20_000,
      // 与 resume transport trim 后拒绝纯空白保持一致：至少一个非空白字符。
      pattern: "\\S",
    },
  },
} as const;

/** Task 级最新 artifact 缓存（仅 Mapper 实例内）：TextPart 展示文本 + DataPart 公共结构化结果。 */
export interface A2AArtifactCache {
  get(taskId: string): { text: string | null; data: unknown } | undefined;
  set(taskId: string, artifact: A2AArtifact): void;
}

/**
 * 默认任务级 artifact 缓存实现。
 * 支持官方增量语义：artifact-update 携带 append/lastChunk 时，text/data 追加到
 * 既有累积（跨多个分片），而非仅取最后一次 parts。
 */
export function createA2AArtifactCache(): A2AArtifactCache {
  const store = new Map<string, { text: string[]; data: unknown }>();
  return {
    get: (taskId) => {
      const entry = store.get(taskId);
      if (!entry) return undefined;
      return {
        text: entry.text.length > 0 ? entry.text.join("\n") : null,
        data: entry.data,
      };
    },
    set: (taskId, artifact) => {
      const prev = store.get(taskId) ?? { text: [] as string[], data: undefined };
      const parts = Array.isArray(artifact.parts) ? artifact.parts : [];
      const newTexts = parts
        .filter((p) => typeof p?.text === "string" && p.text.length > 0)
        .map((p) => p.text as string);
      const dataPart = parts.find((p) => p && "data" in p && p.data !== undefined);
      // append === true 或 lastChunk === false → 增量追加；否则为整段最终快照。
      const isAppend = artifact.append === true || artifact.lastChunk === false;
      const text = isAppend ? [...prev.text, ...newTexts] : newTexts;
      store.set(taskId, {
        text,
        data: dataPart?.data !== undefined ? dataPart.data : prev.data,
      });
    },
  };
}

/**
 * A2A update → AgentCallCandidateEvent（callId 关联）。
 *
 * @param callId 当前 AgentCall id。
 * @param sequence 连续 producer sequence。
 * @param update A2A stream update（已通过严格校验：taskId/contextId 非空、
 *   status-update 的 status.final 为布尔）。
 * @param artifacts 任务级最新 artifact 缓存（input-required/completed 的 status.message
 *   缺失时，追问/答复文本与 data 取自该 task 最新 artifact 累积）。
 */
export function mapAgentCallUpdate(
  callId: string,
  sequence: number,
  update: A2AMappableUpdate,
  artifacts: A2AArtifactCache,
): AgentCallCandidateEvent[] {
  const base = {
    producer_event_id: `a2a:${callId}:${sequence}`,
    producer_sequence: sequence,
    schema_version: 1,
    occurred_at: new Date().toISOString(),
  };
  const { taskId, contextId } = update;
  if (update.kind === "artifact-update") {
    const artifact = update.artifact;
    artifacts.set(taskId, artifact);
    return [
      {
        ...base,
        type: "call.started",
        payload: {
          source: "a2a",
          task_id: taskId,
          context_id: contextId,
          artifact_id: artifact.artifactId,
          artifact_name: artifact.name ?? null,
          text: artifactText(artifact),
          data: artifactData(artifact),
        },
      },
    ];
  }
  const state = update.status.state;
  switch (state) {
    case "submitted":
    case "working":
      return [
        {
          ...base,
          type: "call.started",
          payload: {
            source: "a2a",
            task_id: taskId,
            context_id: contextId,
            task_state: state,
            message: a2aMessageText(update.status.message),
          },
        },
      ];
    case "input-required": {
      // status.message 缺失时（HR 官方顺序），追问文本与 data 取最新 artifact 累积。
      const cached = artifacts.get(taskId);
      const text = a2aMessageText(update.status.message) ?? cached?.text ?? null;
      return [
        {
          ...base,
          type: "call.input_required",
          payload: {
            source: "a2a",
            task_id: taskId,
            context_id: contextId,
            request_type: "input",
            purpose: "a2a_input_required",
            prompt: text ?? "Agent 请求补充输入",
            message: text,
            data: cached?.data,
            input_schema: A2A_INPUT_ACTION_SCHEMA,
          },
        },
      ];
    }
    case "completed": {
      const cached = artifacts.get(taskId);
      const text = a2aMessageText(update.status.message) ?? cached?.text ?? null;
      return [
        {
          ...base,
          type: "call.completed",
          payload: {
            source: "a2a",
            task_id: taskId,
            context_id: contextId,
            text,
            data: cached?.data,
          },
        },
      ];
    }
    case "failed":
      return [
        {
          ...base,
          type: "call.failed",
          payload: {
            source: "a2a",
            task_id: taskId,
            context_id: contextId,
            error_code: "REMOTE_TASK_FAILED",
            error_summary: a2aMessageText(update.status.message) ?? "A2A task failed",
          },
        },
      ];
    case "canceled":
      return [
        {
          ...base,
          type: "call.cancelled",
          payload: {
            source: "a2a",
            task_id: taskId,
            context_id: contextId,
            cancelled_by: "remote",
          },
        },
      ];
    case "rejected":
      return [
        {
          ...base,
          type: "call.failed",
          payload: {
            source: "a2a",
            task_id: taskId,
            context_id: contextId,
            error_code: "REMOTE_TASK_REJECTED",
            error_summary: a2aMessageText(update.status.message) ?? "A2A task rejected",
          },
        },
      ];
    case "auth-required":
      return [
        {
          ...base,
          type: "call.failed",
          payload: {
            source: "a2a",
            task_id: taskId,
            context_id: contextId,
            error_code: "REMOTE_AUTH_REQUIRED",
            error_summary: "A2A task requires additional authentication",
          },
        },
      ];
    default:
      // unknown 状态：不伪造终态、不静默忽略 → 归为稳定 protocol_schema 分类。
      // start 首事件同步抛（调用方以其拒绝）；背景时由调用方按 protocol_parse_failed
      // 上报，绝不以裸 Error 漏出。
      throw new AgentTransportError(
        "protocol_schema",
        `A2A unknown task state: ${String(state)}`,
      );
  }
}

function artifactText(artifact: A2AArtifact): string | null {
  const parts = Array.isArray(artifact.parts) ? artifact.parts : [];
  const texts = parts
    .filter((p) => typeof p?.text === "string" && p.text.length > 0)
    .map((p) => p.text as string);
  return texts.length > 0 ? texts.join("\n") : null;
}

function artifactData(artifact: A2AArtifact): unknown {
  const parts = Array.isArray(artifact.parts) ? artifact.parts : [];
  const dataPart = parts.find((p) => p && "data" in p && p.data !== undefined);
  return dataPart?.data;
}

/** 解析 SSE 流的一行 data JSON。 */
export function parseAgentCallUpdate(
  raw: string,
): A2AStreamUpdate | import("@/lib/agents/calls/transport/a2a/a2a-types").JsonRpcResponse | null {
  let parsed: import("@/lib/agents/calls/transport/a2a/a2a-types").JsonRpcResponse<A2AStreamUpdate> | A2AStreamUpdate;
  try {
    parsed = JSON.parse(raw) as import("@/lib/agents/calls/transport/a2a/a2a-types").JsonRpcResponse<A2AStreamUpdate>;
  } catch {
    throw new Error("A2A SSE data 不是合法 JSON");
  }
  // JSON-RPC envelope（有 result/error 字段）→ 解包。
  if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) {
    const envelope = parsed as import("@/lib/agents/calls/transport/a2a/a2a-types").JsonRpcResponse<A2AStreamUpdate>;
    if (envelope.error) {
      return envelope; // 调用方按 error 处理
    }
    return envelope.result ?? null;
  }
  return parsed as A2AStreamUpdate;
}

export function isA2AStreamUpdate(v: unknown): v is A2AStreamUpdate {
  return !!v && typeof v === "object" && "kind" in v && "taskId" in v;
}

export function isRpcError(
  v: unknown,
): v is import("@/lib/agents/calls/transport/a2a/a2a-types").JsonRpcResponse & {
  error: NonNullable<import("@/lib/agents/calls/transport/a2a/a2a-types").JsonRpcResponse["error"]>;
} {
  return !!v && typeof v === "object" && "error" in v && !("kind" in v);
}
