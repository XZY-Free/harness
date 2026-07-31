/**
 * V11 员工端共享类型。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform/11-api-and-event-boundaries.md §3.5/§3.6（Item 响应、SSE 投影）
 * - docs/solutions/v11-agentkit-platform/15-machine-contracts-and-conformance.md（错误 Envelope）
 * - lib/v11/schema/conversation.ts（V11Thread/V11ThreadItem/V11ThreadEvent 服务端 schema）
 *
 * 与 HTTP wire 对齐：
 * - 字段名一律使用 snake_case（与服务端 projectItem/projectEvent 输出一致）。
 * - 日期使用 ISO 8601 字符串（服务端 toISOString）。
 * - content / payload 为已脱敏的 JSON，由 reducer 按 item_type/event_type 解读。
 *
 * 不引入服务端 drizzle schema 类型，避免把 node:crypto/MySQL 适配层拉进浏览器 bundle。
 */

import type { DesktopOperationCategory, DesktopOperationResult } from "@/lib/desktop/capabilities";

// ─── Item ────────────────────────────────────────────────────

/** Item 类型（与服务端 THREAD_ITEM_TYPES 一致）。 */
export type V11ClientItemType =
  | "user_message"
  | "user_guidance"
  | "agent_message"
  | "tool_call"
  | "artifact"
  | "job_result"
  | "child_thread"
  | "user_action";

/** Item 状态（与服务端 THREAD_ITEM_STATES 一致）。 */
export type V11ClientItemState = "pending" | "completed" | "failed" | "superseded" | "cancelled";

/**
 * GET /api/v1/threads/{thread_id}/items 返回的 Item 投影（§3.5）。
 *
 * 与服务端 app/api/v1/threads/[thread_id]/items/route.ts 的 projectItem 输出一致。
 */
export interface V11ClientItem {
  readonly id: string;
  readonly turn_id: string;
  readonly item_sequence: number;
  readonly item_type: V11ClientItemType;
  readonly item_state: V11ClientItemState;
  /** 已脱敏的内容 JSON，由 reducer 按 item_type 解读。 */
  readonly content: unknown;
  /** ISO 8601 时间字符串。 */
  readonly created_at: string;
}

/** Item 列表响应（§3.5）。 */
export interface V11ClientItemsResponse {
  readonly items: readonly V11ClientItem[];
  readonly next_cursor: string | null;
  readonly latest_event_cursor: {
    readonly sequence: number;
    readonly event_id: string | null;
  } | null;
}

// ─── Event ───────────────────────────────────────────────────

/**
 * SSE data 投影（§3.6）。
 *
 * 与服务端 app/api/v1/threads/[thread_id]/events/route.ts 的 projectEvent 输出一致。
 * event_type 通过 SSE `event:` 行传递，不在 data 内重复。
 */
export interface V11ClientEventPayload {
  readonly event_id: string;
  readonly sequence: number;
  readonly schema_version: number;
  readonly thread_id: string;
  readonly turn_id: string | null;
  readonly item_id: string | null;
  readonly occurred_at: string;
  /** 已脱敏的事件负载。 */
  readonly payload: unknown;
}

/** 完整 SSE 事件（含 event 行）。 */
export interface V11ClientEvent extends V11ClientEventPayload {
  /** SSE event 行（如 thread.created、turn.accepted、item.created、stream.resumed）。 */
  readonly event_type: string;
}

/** 不进入持久 sequence 的模型正文增量。 */
export interface V11ClientTransientDelta {
  readonly transient_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly occurred_at: string;
  readonly delta: string;
}

// ─── Error ───────────────────────────────────────────────────

/**
 * V11 错误 Envelope（§3.4）。
 *
 * 与服务端 lib/http.ts 的 v11Error 输出一致。
 */
export interface V11ClientErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id: string;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;
  };
}

// ─── 流生命周期 ──────────────────────────────────────────────

/** SSE 连接状态。 */
export type V11ClientStreamStatus =
  /** 尚未连接。 */
  | "idle"
  /** 正在建立连接（fetch 未完成 header）。 */
  | "connecting"
  /** 已连接，正在接收 backlog 或实时事件。 */
  | "open"
  /** 收到 stream.backpressure 或网络中断，准备重连。 */
  | "reconnecting"
  /** 服务端告知 EVENT_CURSOR_EXPIRED，已退化为 snapshot 重载。 */
  | "resnapshot"
  /** 用户显式停止或组件卸载，连接已关闭且不会自动重连。 */
  | "closed"
  /** 无法恢复的失败（鉴权失败、404、400 等）。 */
  | "failed";

// ─── 客户端状态 ──────────────────────────────────────────────

/**
 * 员工端 Thread 投影状态。
 *
 *  reducer 输出 = 渲染输入。所有字段都是 immutable。
 *
 * 不变量：
 * - items 按 item_sequence 严格升序，无重复 id。
 * - lastAppliedEventSequence 单调递增，永不倒退。
 * - appliedEventIds 是 lastAppliedEventSequence 的精确历史，用于跨重连去重。
 * - latestEventCursor 与服务端 latest_event_cursor 同步；断线重连以它作为 Last-Event-ID。
 */
export interface V11ThreadProjectionState {
  /** Thread id。 */
  readonly threadId: string;
  /** 当前 Item 投影（按 item_sequence 升序）。 */
  readonly items: readonly V11ClientItem[];
  /** Item id → Item（快速查找，派生于 items）。 */
  readonly itemsById: Readonly<Record<string, V11ClientItem>>;
  /** 已应用的最大 event sequence。 */
  readonly lastAppliedEventSequence: number;
  /** 已应用的 event_id 集合（用于跨重连/重复 SSE 去重）。 */
  readonly appliedEventIds: ReadonlySet<string>;
  /** 服务端告知的 latest_event_cursor（snapshot 时写入）。 */
  readonly latestEventCursor: {
    readonly sequence: number;
    readonly event_id: string | null;
  } | null;
  /**
   * 内部标志：snapshot 之后是否已消费过至少一条新事件。
   *
   * snapshot 后的第一条事件不要求 sequence 严格连续（服务端在 snapshot 期间可能
   * 已写入多条，SSE 重连后从 cursor 补发，第一条不必 = cursor + 1 也算正常）。
   * 之后的每条事件必须严格 sequence = lastApplied + 1，否则视为 gap。
   */
  readonly hasAppliedEventSinceSnapshot: boolean;
  /** SSE 连接状态。 */
  readonly streamStatus: V11ClientStreamStatus;
  /** 当前重连尝试次数（0 = 未处于重连）。用于展示"正在重新连接 2/5"。 */
  readonly reconnectAttempt: number;
  /** 重连次数上限（与 SSE 客户端 maxRetries 一致）。 */
  readonly reconnectMax: number;
  /** 当前可见错误（中文语义 + 可恢复动作已映射）。null 表示无错误。 */
  readonly visibleError: V11ClientVisibleError | null;
  /** snapshot 加载状态。 */
  readonly snapshotStatus: "idle" | "loading" | "ready" | "failed";
}

/** 已映射为员工可理解语义的错误。 */
export interface V11ClientVisibleError {
  /** 稳定错误码（如 EVENT_CURSOR_EXPIRED）。 */
  readonly code: string;
  /** 中文标题（短句）。 */
  readonly title: string;
  /** 中文详细描述。 */
  readonly description: string;
  /** 是否可恢复。 */
  readonly retryable: boolean;
  /** 可恢复动作（用户可读）。 */
  readonly recoveryAction: "reconnect" | "resnapshot" | "reload_page" | "contact_admin" | "none";
  /** 原始 request_id（诊断用，不直接展示给员工）。 */
  readonly requestId: string | null;
}

// ─── Thread 详情（S10-W02） ──────────────────────────────────

/** GET /api/v1/threads/{thread_id} 返回的 Thread 投影。 */
export interface V11ClientThread {
  readonly id: string;
  readonly title: string | null;
  readonly primary_agent_id: string;
  readonly active_goal_id: string | null;
  readonly default_workspace_id: string | null;
  readonly default_model_ref: string | null;
  readonly default_environment_definition_id: string | null;
  readonly lifecycle_state: "active" | "archived" | "deleted";
  readonly last_activity_at: string;
  readonly last_event_sequence: number;
  readonly pending_queue_version_no: number;
  readonly version_no: number;
  readonly created_at: string;
}

/** GET /api/v1/threads/{thread_id} 返回的 Goal 投影。 */
export interface V11ClientGoal {
  readonly id: string;
  readonly thread_id: string;
  readonly objective: string;
  readonly success_criteria: unknown;
  readonly constraints: unknown;
  readonly current_state: unknown;
  readonly goal_state: "active" | "blocked" | "completed" | "cancelled";
  readonly created_at: string;
  readonly completed_at: string | null;
}

/** GET /api/v1/threads/{thread_id}/turns 返回的 Turn 投影。 */
export interface V11ClientTurn {
  readonly id: string;
  readonly turn_sequence: number;
  readonly trigger_type: string;
  readonly trigger_ref: string | null;
  readonly trigger_item_id: string | null;
  readonly turn_state: string;
  readonly active_invocation_id: string | null;
  readonly latest_invocation_id: string | null;
  readonly adopted_invocation_id: string | null;
  readonly final_item_id: string | null;
  readonly error_code: string | null;
  readonly regeneration_no: number;
  readonly accepted_at: string;
  readonly started_at: string | null;
  readonly waiting_at: string | null;
  readonly finished_at: string | null;
}

/** GET /api/v1/threads/{thread_id} 响应体。 */
export interface V11ClientThreadResponse {
  readonly thread: V11ClientThread;
  readonly active_goal: V11ClientGoal | null;
  readonly latest_turn: V11ClientTurn | null;
}

/** GET /api/v1/threads/{thread_id}/turns 响应体。 */
export interface V11ClientTurnsResponse {
  readonly turns: readonly V11ClientTurn[];
}

// ─── PendingInput（S10-W03） ────────────────────────────────

/** PendingInput 状态（与服务端 PENDING_INPUT_STATES 一致）。 */
export type V11ClientPendingInputState = "pending" | "admitted" | "removed";

/** GET /api/v1/threads/{thread_id}/pending-inputs 中的单条 PendingInput 投影。 */
export interface V11ClientPendingInput {
  readonly id: string;
  readonly queue_position: number;
  /** 结构化输入，至少含 type 字段。 */
  readonly input: {
    readonly type: string;
    readonly text?: string;
    readonly [key: string]: unknown;
  };
  /** 资源 ETag（如 "pending-3"）。 */
  readonly etag: string;
}

/** GET /api/v1/threads/{thread_id}/pending-inputs 响应体。 */
export interface V11ClientPendingInputListResponse {
  readonly thread_id: string;
  /** 队列 ETag（如 "pending-queue-5"）。 */
  readonly queue_etag: string;
  readonly pending_inputs: readonly V11ClientPendingInput[];
}

/** POST /api/v1/threads/{thread_id}/pending-inputs 响应体（201）。 */
export interface V11ClientCreatePendingInputResponse {
  readonly pending_input: {
    readonly id: string;
    readonly thread_id: string;
    readonly input_state: V11ClientPendingInputState;
    readonly queue_position: number;
    readonly input: V11ClientPendingInput["input"];
    readonly etag: string;
  };
  readonly queue_etag: string;
}

/** PATCH /api/v1/pending-inputs/{pending_input_id} 响应体（200）。 */
export interface V11ClientEditPendingInputResponse {
  readonly pending_input: {
    readonly id: string;
    readonly thread_id: string;
    readonly input_state: V11ClientPendingInputState;
    readonly queue_position: number;
    readonly input: V11ClientPendingInput["input"];
    readonly etag: string;
  };
  readonly queue_etag: string;
}

/** DELETE /api/v1/pending-inputs/{pending_input_id} 响应体（200）。 */
export interface V11ClientDeletePendingInputResponse {
  readonly pending_input: {
    readonly id: string;
    readonly thread_id: string;
    readonly input_state: "removed";
    readonly removed_at: string;
  };
  readonly queue_etag: string;
}

// ─── Steer / Interrupt（S10-W03） ──────────────────────────

/** POST /api/v1/turns/{turn_id}/steer 响应体（202 Accepted，异步命令）。 */
export interface V11ClientSteerResponse {
  readonly turn_id: string;
  readonly turn_state: string;
  /** 固定 "queued"：命令已入队，等 Runtime ack。前端不应在 ack 前宣称已引导。 */
  readonly steer_state: "queued";
  readonly guidance_item_id: string;
  readonly command: { readonly id: string; readonly command_state: "queued" };
  readonly event_id: string;
}

/** POST /api/v1/turns/{turn_id}/interrupt 响应体（202 Accepted，异步命令）。 */
export interface V11ClientInterruptResponse {
  readonly turn_id: string;
  readonly turn_state: string;
  /** 固定 "requested"：停止请求已入队，等 Runtime ack。 */
  readonly interrupt_state: "requested";
  readonly command: { readonly id: string; readonly command_state: "queued" };
  /** 固定 true：Stop 不撤销已发生副作用，tool 副作用已生效。 */
  readonly already_completed_effects_preserved: true;
  readonly event_id: string;
}

// ─── Catalog（S10-W04） ─────────────────────────────────────

/** Catalog 资源类型（与服务端 CatalogResourceType 一致）。 */
export type V11ClientCatalogResourceType =
  | "agent"
  | "skill"
  | "tool"
  | "knowledge"
  | "runtime"
  | "model"
  | "connection";

/** GET /api/v1/catalog/options 返回的单条目录条目（§3.1 CatalogSearchItem）。 */
export interface V11ClientCatalogItem {
  readonly resource_type: V11ClientCatalogResourceType;
  readonly resource_id: string;
  readonly display_name: string;
  readonly description: string | null;
  /** lifecycle 状态（如 enabled/disabled）。 */
  readonly lifecycle_state: string;
  readonly visibility_summary: string;
  readonly owner_user_id: string | null;
  readonly tags: readonly string[] | null;
  /** 资源级 ETag（catalog-{revision}）。 */
  readonly etag: string;
}

/** GET /api/v1/catalog/options 响应体。 */
export interface V11ClientCatalogListResponse {
  readonly items: readonly V11ClientCatalogItem[];
  readonly next_cursor: string | null;
  /** 当前租户+employee audience 的 catalogRevision。 */
  readonly catalog_revision: number;
}

// ─── Handoff（S10-W04） ────────────────────────────────────

/** POST /api/v1/threads/{thread_id}:request-handoff 响应体（200）。 */
export interface V11ClientHandoffRequestResponse {
  readonly thread_id: string;
  readonly request_id: string;
  readonly item_id: string;
  readonly invocation_id: string;
  readonly previous_agent_id: string;
  readonly target_agent_id: string;
  readonly target_agent_display_name: string;
  readonly purpose: "handoff";
  readonly request_type: "confirmation";
  readonly request_state: "pending";
  readonly turn_id: string;
  readonly event_ids: readonly string[];
}

/** POST /api/v1/threads/{thread_id}/handoffs/{handoff_id}:resolve 响应体（200）。 */
export interface V11ClientHandoffResolveResponse {
  readonly thread_id: string;
  readonly request_id: string;
  readonly resolution: "approve" | "deny";
  readonly request_state: "resolved";
  readonly handed_off: boolean;
  readonly previous_agent_id: string;
  readonly primary_agent_id: string;
  readonly invocation_id: string;
  readonly invocation_state: string;
  readonly resume_command_id: string;
  readonly resume_command_state: string;
  readonly event_ids: readonly string[];
}

// ─── UserAction 通用解析（S10-W05） ────────────────────────

/** POST /api/v1/threads/{thread_id}/user-actions/{request_id}:resolve 响应体（200）。 */
export interface V11ClientUserActionResolveResponse {
  readonly thread_id: string;
  readonly request_id: string;
  readonly request_type: "confirmation" | "auth" | "grant" | "input";
  readonly purpose: string | null;
  readonly resolution: "approve" | "deny" | "submit" | "cancel";
  readonly request_state: "resolved";
  readonly invocation_id: string;
  readonly invocation_state: string;
  readonly resume_command_id: string;
  readonly resume_command_state: string;
  readonly grant_id?: string;
  readonly event_ids: readonly string[];
}

// ─── Environment / Desktop 任务操作台（S10-W06） ───────────

/** 环境类型（与服务端 ENVIRONMENT_TYPES 一致）。 */
export type V11ClientEnvironmentType = "desktop" | "cloud" | "remote" | "sandbox";

/** Lease 状态（与服务端 ENVIRONMENT_LEASE_STATES 一致）。 */
export type V11ClientEnvironmentLeaseState =
  | "allocated"
  | "active"
  | "releasing"
  | "released"
  | "expired"
  | "lost";

/**
 * 员工端可见的 Environment 可用性状态。
 *
 * 推导规则：
 * - no_environment：Thread 未配置 default_environment_definition_id。
 * - cloud：Environment 类型为 cloud/remote/sandbox，或 Desktop Lease 状态为 active 但设备非本机。
 * - online_desktop：Desktop Lease active + 设备在线 + 是当前 Desktop 设备。
 * - pending_device：Desktop Lease active 但设备离线，或 leaseState 为 allocated/releasing。
 * - offline_desktop：Desktop Lease 终态（released/expired/lost）或 ExecutionOwnership released/lost。
 */
export type V11ClientEnvironmentAvailability =
  | "no_environment"
  | "cloud"
  | "online_desktop"
  | "pending_device"
  | "offline_desktop";

/** EnvironmentDefinition 投影（GET /threads/{id}/environment 返回）。 */
export interface V11ClientEnvironmentDefinition {
  readonly id: string;
  readonly environment_key: string;
  readonly display_name: string;
  readonly description: string | null;
  readonly environment_type: V11ClientEnvironmentType;
  readonly lifecycle_state: "active" | "archived" | "deleted";
}

/** EnvironmentLease 投影。 */
export interface V11ClientEnvironmentLease {
  readonly id: string;
  readonly environment_definition_id: string;
  readonly invocation_id: string;
  readonly attempt_id: string;
  /** Desktop Lease 必含；Cloud/Remote/Sandbox 为 null。 */
  readonly device_id: string | null;
  readonly lease_state: V11ClientEnvironmentLeaseState;
  readonly allocated_at: string;
  readonly last_heartbeat_at: string | null;
  readonly expires_at: string | null;
  readonly released_at: string | null;
}

/** ExecutionOwnership 投影。 */
export interface V11ClientExecutionOwnership {
  readonly id: string;
  readonly invocation_id: string;
  readonly device_id: string | null;
  readonly environment_lease_id: string | null;
  readonly ownership_state: "active" | "released" | "lost";
  readonly lease_epoch: number;
  readonly acquired_at: string;
  readonly last_heartbeat_at: string | null;
  readonly released_at: string | null;
}

/** GET /api/v1/threads/{thread_id}/environment 响应体。 */
export interface V11ClientEnvironmentStatusResponse {
  readonly thread_id: string;
  /** 当前 Thread 配置的默认 EnvironmentDefinition；null 表示未配置。 */
  readonly environment_definition: V11ClientEnvironmentDefinition | null;
  /** 当前 active Invocation 的 Lease；null 表示无活跃 Lease。 */
  readonly active_lease: V11ClientEnvironmentLease | null;
  /** 当前 active Invocation 的 ExecutionOwnership；null 表示无活跃 ownership。 */
  readonly active_ownership: V11ClientExecutionOwnership | null;
  /** 推导后的可用性状态（前端渲染依据）。 */
  readonly availability: V11ClientEnvironmentAvailability;
  /** 当前 active Invocation id；null 表示无活跃 Invocation。 */
  readonly active_invocation_id: string | null;
  /** S10-W07：接管条件聚合（无 active ownership 时为空 conditions）。 */
  readonly takeover_conditions: V11ClientTakeoverConditions;
}

/** 接管条件聚合（GET /environment 返回）。 */
export interface V11ClientTakeoverConditions {
  /** 是否允许接管。 */
  readonly can_takeover: boolean;
  /** 阻塞原因列表（中文，前端直接展示）。 */
  readonly blocking_reasons: readonly string[];
  /** 未完成 ToolCall 数量（proposed/paused/running）。 */
  readonly pending_tool_calls: number;
  /** unknown_effect 状态的 EffectRecord 数量。 */
  readonly unknown_effects: number;
  /** 该 Invocation 持有的活跃写锁数量。 */
  readonly active_write_locks: number;
  /** owner 心跳是否陈旧（超过阈值）。 */
  readonly owner_heartbeat_stale: boolean;
  /** 当前 owner 设备 id（如有）。 */
  readonly owner_device_id: string | null;
  /** 当前 ownership id（如有）。 */
  readonly ownership_id: string | null;
}

/** POST /api/v1/threads/{thread_id}/environment:takeover 响应体（S10-W07）。 */
export interface V11ClientTakeoverResponse {
  readonly thread_id: string;
  readonly ownership_id: string;
  readonly lease_id: string | null;
  readonly revoked_lock_ids: readonly string[];
  readonly event_id: string;
  readonly previous_lease_epoch: number;
  readonly reason_code: string;
}

// ─── Desktop 本地操作（S10-W06） ──────────────────────────

/**
 * 本地操作类别（操作面板分组依据）。
 *
 * 与底层 `DesktopOperationCategory` 同源；V11 客户端类型不重复定义，
 * 直接复用底层类型，避免双源不一致。
 */
export type V11DesktopOperationCategory = DesktopOperationCategory;

/**
 * 本地操作执行结果。
 *
 * 与底层 `DesktopOperationResult` 同源；V11 客户端类型不重复定义。
 */
export type V11DesktopOperationResult = DesktopOperationResult;

/** Desktop 操作能力描述（操作面板展示）。 */
export interface V11DesktopOperationCapability {
  readonly category: V11DesktopOperationCategory;
  readonly operation: string;
  readonly display_name: string;
  readonly description: string;
  /** 是否高影响（需要 UserAction 确认）。 */
  readonly high_impact: boolean;
  /** 是否当前可用（依赖 Desktop 环境 + 权限）。 */
  readonly enabled: boolean;
}

// ─── Reducer Action ──────────────────────────────────────────

/** Reducer 输入。 */
export type V11ThreadProjectionAction =
  /** 加载 snapshot 成功；重置 lastAppliedEventSequence 为 latest_event_cursor.sequence。 */
  | {
      readonly type: "snapshot.loaded";
      readonly items: readonly V11ClientItem[];
      readonly latestEventCursor: {
        readonly sequence: number;
        readonly event_id: string | null;
      } | null;
    }
  /** snapshot 加载失败。 */
  | { readonly type: "snapshot.failed"; readonly error: V11ClientVisibleError }
  /** snapshot 开始加载。 */
  | { readonly type: "snapshot.loading" }
  /** SSE 事件到达（已通过去重和 sequence 检查）。 */
  | { readonly type: "event.received"; readonly event: V11ClientEvent }
  /** response.delta 到达；只更新临时 Agent Item，不推进持久游标。 */
  | { readonly type: "stream.delta"; readonly event: V11ClientTransientDelta }
  /** SSE 状态变化；reconnecting 时携带尝试次数与上限。 */
  | {
      readonly type: "stream.status";
      readonly status: V11ClientStreamStatus;
      readonly reconnectAttempt?: number;
      readonly reconnectMax?: number;
    }
  /** 服务端告知 cursor 过期，需要 resnapshot。 */
  | { readonly type: "stream.cursor_expired"; readonly error: V11ClientVisibleError }
  /** 出现不可恢复错误。 */
  | { readonly type: "stream.failed"; readonly error: V11ClientVisibleError };
