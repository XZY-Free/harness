/**
 * V11 Employee Interaction API route handler 公共助手（S04-C03）。
 *
 * 事实源：../v11-agentkit-platform/11-api-and-event-boundaries.md §3（Employee Interaction API）、
 *         §2.2（身份与授权：Employee API 走员工 SSO Session/OAuth Token）、
 *         §2.3（公共请求头：Idempotency-Key / If-Match / X-Request-ID）、
 *         §2.5（成功与错误格式）。
 *
 * 职责：
 * - resolveEmployeePrincipal：员工身份解析（resolvePrincipal + audience=employee）。
 * - parseThreadSettingsEtag：从 Thread 设置 ETag 提取 versionNo。
 * - v11SchemaInvalid / v11EtagMismatch：错误响应工具（与 admin route-helpers 对齐）。
 * - conversationErrorToResponse：会话域 Error 实例 → HTTP 响应映射。
 *
 * 安全边界：
 * - Employee API 不走 action scope（仅 Admin API 走）；员工身份通过 Thread.ownerUserId 鉴权。
 * - Thread 不存在或非 owner 一律 404 RESOURCE_NOT_FOUND（隐藏式，不泄露存在）。
 * - Agent 必须 enabled 且同租户；否则 404（不泄露存在，§3.1 行 143）。
 */
import { apiError, resourceNotFound } from "@/lib/http";
import {
  ForkSourceTurnMismatchError,
  HandoffAlreadyResolvedError,
  HandoffValidationError,
  HandoffVersionConflictError,
  ItemSupersedeCycleError,
  PendingInputNotFoundError,
  PendingInputNotPendingError,
  PendingInputReorderConflictError,
  PendingInputVersionConflictError,
  ThreadNotAcceptingTurnsError,
  ThreadNotFoundError,
  ThreadVersionConflictError,
  TurnNotFoundError,
  TurnRequiresUserActionError,
  TurnStateConflictError,
} from "@/lib/v11/conversation/errors";
import { AuthenticationError, type Principal, resolvePrincipal } from "@/lib/identity/resolver";
import {
  UserActionAlreadyResolvedError,
  UserActionNotFoundError,
  UserActionResolutionMismatchError,
  UserActionStateError,
  UserActionValidationError,
} from "@/lib/v11/permission/user-action-queries";

// ─── 类型再导出（route handlers 统一从此处 import） ────────
export type { Principal };

// ─── 身份解析 ──────────────────────────────────────────────

/**
 * 解析员工身份（employee audience）。
 *
 * 走 resolvePrincipal(headers, "employee")：
 * - dev 模式返回默认身份。
 * - trusted-headers 模式从 SSO 注入 header 解析。
 *
 * @throws AuthenticationError 缺少身份（trusted-headers 模式缺 header）
 */
export async function resolveEmployeePrincipal(headers: Headers): Promise<Principal> {
  return resolvePrincipal(headers, "employee");
}

/**
 * 把 AuthenticationError 转成 401 响应；非身份错误返回 null。
 */
export function employeeAuthErrorResponse(error: unknown, requestId: string): Response | null {
  if (error instanceof AuthenticationError) {
    return apiError("AUTHENTICATION_REQUIRED", error.message, { requestId });
  }
  return null;
}

// ─── ETag 解析 ────────────────────────────────────────────

/** Thread 设置 ETag 前缀：`thread-settings-{versionNo}`。 */
export const THREAD_SETTINGS_ETAG_PREFIX = "thread-settings-";

/**
 * 从 Thread 设置 ETag 字符串提取 versionNo。
 *
 * ETag 格式：`thread-settings-{versionNo}`（如 `thread-settings-3`）。
 * 解析失败抛错（route 层应捕获并返回 400 REQUEST_SCHEMA_INVALID）。
 *
 * @throws Error ETag 格式非法
 */
export function parseThreadSettingsEtag(etag: string): number {
  if (!etag.startsWith(THREAD_SETTINGS_ETAG_PREFIX)) {
    throw new Error(`非法 Thread 设置 ETag: ${etag}（期望前缀 ${THREAD_SETTINGS_ETAG_PREFIX}）`);
  }
  const versionStr = etag.slice(THREAD_SETTINGS_ETAG_PREFIX.length);
  const versionNo = Number.parseInt(versionStr, 10);
  if (!Number.isFinite(versionNo) || versionNo <= 0) {
    throw new Error(`非法 Thread 设置 ETag 版本号: ${etag}`);
  }
  return versionNo;
}

// ─── PendingInput ETag 解析 ────────────────────────────────

/** PendingInput 资源 ETag 前缀：`pending-{versionNo}`。 */
export const PENDING_INPUT_ETAG_PREFIX = "pending-";
/** PendingInput 队列 ETag 前缀：`pending-queue-{versionNo}`。 */
export const PENDING_QUEUE_ETAG_PREFIX = "pending-queue-";

/** 构造 PendingInput 资源 ETag（`pending-{versionNo}`）。 */
export function pendingInputEtag(versionNo: number): string {
  return `${PENDING_INPUT_ETAG_PREFIX}${versionNo}`;
}

/** 构造 PendingInput 队列 ETag（`pending-queue-{versionNo}`）。 */
export function pendingQueueEtag(versionNo: number): string {
  return `${PENDING_QUEUE_ETAG_PREFIX}${versionNo}`;
}

/**
 * 从 PendingInput 资源 ETag 提取 versionNo。
 *
 * ETag 格式：`pending-{versionNo}`（如 `pending-3`）。
 * 注意：必须先匹配 `pending-` 而非 `pending-queue-`（队列前缀更长）。
 *
 * @throws Error ETag 格式非法
 */
export function parsePendingInputEtag(etag: string): number {
  if (!etag.startsWith(PENDING_INPUT_ETAG_PREFIX) || etag.startsWith(PENDING_QUEUE_ETAG_PREFIX)) {
    throw new Error(
      `非法 PendingInput 资源 ETag: ${etag}（期望前缀 ${PENDING_INPUT_ETAG_PREFIX}）`,
    );
  }
  const versionStr = etag.slice(PENDING_INPUT_ETAG_PREFIX.length);
  const versionNo = Number.parseInt(versionStr, 10);
  if (!Number.isFinite(versionNo) || versionNo <= 0) {
    throw new Error(`非法 PendingInput 资源 ETag 版本号: ${etag}`);
  }
  return versionNo;
}

/**
 * 从 PendingInput 队列 ETag 提取 versionNo。
 *
 * ETag 格式：`pending-queue-{versionNo}`（如 `pending-queue-3`）。
 *
 * @throws Error ETag 格式非法
 */
export function parsePendingQueueEtag(etag: string): number {
  if (!etag.startsWith(PENDING_QUEUE_ETAG_PREFIX)) {
    throw new Error(
      `非法 PendingInput 队列 ETag: ${etag}（期望前缀 ${PENDING_QUEUE_ETAG_PREFIX}）`,
    );
  }
  const versionStr = etag.slice(PENDING_QUEUE_ETAG_PREFIX.length);
  const versionNo = Number.parseInt(versionStr, 10);
  if (!Number.isFinite(versionNo) || versionNo <= 0) {
    throw new Error(`非法 PendingInput 队列 ETag 版本号: ${etag}`);
  }
  return versionNo;
}

// ─── 错误响应工具 ──────────────────────────────────────────

/** 构造 400 REQUEST_SCHEMA_INVALID 响应。 */
export function v11SchemaInvalid(requestId: string, message: string): Response {
  return apiError("REQUEST_SCHEMA_INVALID", message, { requestId });
}

/** 构造 412 ETAG_MISMATCH 响应（乐观锁冲突）。 */
export function v11EtagMismatch(requestId: string, message: string): Response {
  return apiError("ETAG_MISMATCH", message, { requestId });
}

/**
 * 把会话域 Error 实例映射为 HTTP 响应。
 *
 * 映射规则（与 errors.ts 注释一致）：
 * - ThreadNotFoundError → 404 RESOURCE_NOT_FOUND（隐藏式，不泄露存在）
 * - TurnNotFoundError → 404 RESOURCE_NOT_FOUND
 * - ThreadNotAcceptingTurnsError → 409 BUSINESS_CONSTRAINT_VIOLATION（archived/deleted 禁止新 Turn）
 * - ThreadVersionConflictError → 412 ETAG_MISMATCH
 * - TurnStateConflictError → 409 TURN_ALREADY_TERMINAL
 * - ItemSupersedeCycleError → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - PendingInputNotFoundError → 404 RESOURCE_NOT_FOUND
 * - PendingInputNotPendingError → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - PendingInputReorderConflictError → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - PendingInputVersionConflictError → 412 ETAG_MISMATCH
 *
 * 非 Error 实例返回 null（调用方应向上抛或自行构造响应）。
 */
export function conversationErrorToResponse(error: unknown, requestId: string): Response | null {
  if (error instanceof ThreadNotFoundError) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${error.threadId}`);
  }
  if (error instanceof TurnNotFoundError) {
    return resourceNotFound(requestId, `Turn 不存在或无权访问: ${error.turnId}`);
  }
  if (error instanceof ThreadNotAcceptingTurnsError) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, {
      requestId,
      details: { thread_id: error.threadId, lifecycle_state: error.lifecycleState },
    });
  }
  if (error instanceof ThreadVersionConflictError) {
    return v11EtagMismatch(
      requestId,
      `Thread 版本冲突：期望 ${error.expected}，实际 ${error.actual}`,
    );
  }
  if (error instanceof TurnStateConflictError) {
    return apiError("TURN_ALREADY_TERMINAL", error.message, {
      requestId,
      details: {
        turn_id: error.turnId,
        turn_state: error.currentState,
        attempted_action: error.attemptedAction,
      },
    });
  }
  if (error instanceof ItemSupersedeCycleError) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, {
      requestId,
      details: { item_id: error.itemId, superseded_by_item_id: error.supersededByItemId },
    });
  }
  if (error instanceof PendingInputNotFoundError) {
    return resourceNotFound(requestId, `PendingInput 不存在或无权访问: ${error.pendingInputId}`);
  }
  if (error instanceof PendingInputNotPendingError) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, {
      requestId,
      details: {
        pending_input_id: error.pendingInputId,
        input_state: error.currentState,
        attempted_action: error.attemptedAction,
      },
    });
  }
  if (error instanceof PendingInputReorderConflictError) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, {
      requestId,
      details: {
        thread_id: error.threadId,
        reason: error.reason,
        expected_ids: error.expectedIds,
        actual_ids: error.actualIds,
      },
    });
  }
  if (error instanceof PendingInputVersionConflictError) {
    return v11EtagMismatch(
      requestId,
      `PendingInput 版本冲突：期望 ${error.expected}，实际 ${error.actual}`,
    );
  }
  if (error instanceof TurnRequiresUserActionError) {
    return apiError("TURN_REQUIRES_USER_ACTION", error.message, {
      requestId,
      details: { turn_id: error.turnId, turn_state: error.currentState },
    });
  }
  if (error instanceof ForkSourceTurnMismatchError) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, {
      requestId,
      details: {
        parent_thread_id: error.parentThreadId,
        source_turn_id: error.sourceTurnId,
      },
    });
  }
  if (error instanceof HandoffValidationError) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, {
      requestId,
      details: { reason: error.reason, code: error.code ?? "RESOLUTION_NOT_ALLOWED" },
    });
  }
  if (error instanceof HandoffAlreadyResolvedError) {
    return apiError("OPERATION_PAYLOAD_CONFLICT", error.message, {
      requestId,
      details: { request_id: error.requestId, current_state: error.currentState },
    });
  }
  if (error instanceof HandoffVersionConflictError) {
    return v11EtagMismatch(
      requestId,
      `Handoff 版本冲突：期望 ${error.expected}，实际 ${error.actual}`,
    );
  }
  // ─── UserAction 域错误（S10-W05） ──────────────────────
  if (error instanceof UserActionNotFoundError) {
    return resourceNotFound(requestId, error.message);
  }
  if (error instanceof UserActionValidationError) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, { requestId });
  }
  if (error instanceof UserActionResolutionMismatchError) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, {
      requestId,
      details: {
        request_type: error.requestType,
        resolution: error.resolution,
      },
    });
  }
  if (error instanceof UserActionStateError) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, { requestId });
  }
  if (error instanceof UserActionAlreadyResolvedError) {
    return apiError("OPERATION_PAYLOAD_CONFLICT", error.message, {
      requestId,
      details: { request_id: error.requestId, current_state: error.currentState },
    });
  }
  return null;
}
