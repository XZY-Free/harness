/**
 * V11 Desktop Executor 接入层（阶段 8 S08-C07）。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md
 *   S08-W07（4 条不变量）、§"API 范围"（Desktop Bridge 内部命令继续使用签名协议）、
 *   §"迁移与删除"（本地路径必须补 device）、§"阶段验收"（Web 打开本地任务、本地文件输出、
 *   Credential 泄漏扫描）。
 * - ../v11-agentkit-platform/10-core-data-model.md §7.1（workspace_binding.device_id 与
 *   lease.device_id 一致性）、§7.2（Desktop Lease 必含 deviceId）、§6.13（execution_ownership）、
 *   §6.6（tool_call.environment_lease_id）、§6.7（effect_record 与 reconcile）、§6.8
 *   （user_action_request confirmation）、§7.4（file_change.pathRef 结合 binding/device 解释）、
 *   §9 不变量第 11 条（本地路径必须与 Desktop device/binding 一起解释）。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §5.1（tool-call 入口）、
 *   §5.2（effect reconcile）、§5.5（user-action-requests）、§9.6（Desktop 本地路径四重校验）、
 *   §9.8（API 响应不返回 Credential 原值/隐藏思维链/未授权绝对路径/跨租户存在性）。
 * - ../v11-agentkit-platform/09-unified-domain-model.md §6.1（Binding 位置标识只在相应执行域内有效）、
 *   §10 不变量第 19 条（活跃 Invocation 不因另一设备打开 Thread 而迁移）。
 *
 * 关键不变量（W07 自身条款）：
 * - W07-1：Desktop 执行复用既有 Bridge/Browser/QA 能力，不重建。
 * - W07-2：每个 Desktop 命令同时绑定 Invocation + Lease + device + Workspace handle +
 *   权限结果 + deadline（六元组）。
 * - W07-3：浏览器 Cookie/登录态永不进入 model/Event/Trace。
 * - W07-4：高影响提交必须显式确认；超时不等于失败，先做 effect reconcile。
 *
 * 与前序提交组的关系：
 * - 不引入新 schema 表（与 S08-C01~C06 不同）：S08-C07 是"接入"而非"建立"。
 * - 复用 S08-C01（workspace_binding）、S08-C02（environment_lease + execution_ownership）、
 *   S08-C03（tool_call + permission_decision）、S08-C04（user_action_request）、
 *   S08-C05（effect_record + reconcile）、S08-C06（file_change + filesystem_checkpoint）。
 *
 * 跨租户隔离：所有查询按 tenantId 过滤。
 * MySQL 不支持 .returning()：update + select 两步。
 */
import { db } from "@/lib/db/client";
import type { EffectTargetState, VerificationMethod } from "@/lib/persistence/schema/effect";
import type { EnvironmentLease } from "@/lib/persistence/schema/environment";
import type { PermissionDecision } from "@/lib/persistence/schema/permission";
import type { ToolCall } from "@/lib/persistence/schema/tool-call";
import type {
  UserActionRequestType,
  UserActionResolution,
} from "@/lib/persistence/schema/user-action-request";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import {
  type CreateFileChangesInput,
  createFileChanges,
} from "@/lib/v11/capability/artifact-queries";
import {
  type ReconcileEffectInput,
  type ReconcileEffectResult,
  reconcileEffect,
} from "@/lib/v11/capability/effect-queries";
import { getToolCallById } from "@/lib/v11/capability/tool-call-queries";
import {
  getActiveExecutionOwnership,
  getEnvironmentLeaseById,
} from "@/lib/v11/environment/environment-queries";
import {
  assertToolCallAllowed,
  getLatestPermissionDecision,
} from "@/lib/v11/permission/permission-queries";
import {
  type CreateUserActionRequestInput,
  type CreateUserActionRequestResult,
  createUserActionRequest,
  getUserActionRequestById,
} from "@/lib/v11/permission/user-action-queries";
import { getWorkspaceBindingById } from "@/lib/v11/workspace/workspace-queries";

// ─── 错误类型 ──────────────────────────────────────────────

export class DesktopExecutorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopExecutorValidationError";
  }
}

export class DesktopExecutorNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopExecutorNotFoundError";
  }
}

/**
 * Desktop 执行上下文不一致（如 lease.deviceId !== binding.deviceId）。
 *
 * 这是 W07-2 六元组绑定的核心校验失败，调用方必须中止命令执行。
 */
export class DesktopExecutorContextMismatchError extends Error {
  public readonly field: string;
  public readonly expected: string;
  public readonly actual: string;

  constructor(field: string, expected: string, actual: string) {
    super(`Desktop 执行上下文不一致（${field}）：期望 ${expected}，实际 ${actual}`);
    this.name = "DesktopExecutorContextMismatchError";
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * 浏览器状态泄漏（W07-3）：检测到 Cookie/Token/Authorization 原值出现在 Event/Trace payload。
 *
 * 调用方必须拒绝写入并要求重新脱敏。
 */
export class BrowserStateLeakError extends Error {
  public readonly matchedPatterns: readonly string[];

  constructor(matchedPatterns: readonly string[]) {
    super(
      `浏览器状态泄漏：payload 中检测到敏感原值（匹配模式：${matchedPatterns.join(", ")}）；Cookie/登录态不得进入 model/Event/Trace`,
    );
    this.name = "BrowserStateLeakError";
    this.matchedPatterns = matchedPatterns;
  }
}

/**
 * Desktop 命令超时（W07-4）。
 *
 * 超时不等于失败；调用方应转入 reconcileDesktopEffectAfterTimeout 流程。
 */
export class DesktopCommandTimeoutError extends Error {
  public readonly toolCallId: string;
  public readonly deadline: Date;

  constructor(toolCallId: string, deadline: Date) {
    super(`Desktop 命令超时（toolCallId=${toolCallId}，deadline=${deadline.toISOString()}）`);
    this.name = "DesktopCommandTimeoutError";
    this.toolCallId = toolCallId;
    this.deadline = deadline;
  }
}

// ─── 浏览器状态隔离校验（W07-3） ──────────────────────────

/**
 * 浏览器敏感信息泄漏检测模式（W07-3）。
 *
 * 用于扫描 Event/Trace payload JSON 字符串，识别 Cookie/Token/Authorization 原值。
 * 命中任一模式即视为泄漏。
 *
 * 模式同时支持两种格式：
 * - HTTP 头格式：`Cookie: session=abc123`
 * - JSON 格式（JSON.stringify 后）：`"Cookie":"session=abc123"`
 *
 * 关键设计：key 名称后允许可选的 `"` 或 `'`（`["']?`），以兼容 JSON 序列化后
 * key 被引号包裹的情况。
 *
 * 注意：本列表是基础防护，调用方仍应在源头避免写入（不依赖运行时扫描）。
 */
export const BROWSER_STATE_LEAK_PATTERNS = [
  // HTTP Cookie 头（含 Set-Cookie 响应头）
  /(?:^|["\s])Cookie["']?\s*[:=]\s*["']?[^"'&\s]+/i,
  /(?:^|["\s])Set-Cookie["']?\s*[:=]\s*["']?[^"'&\s]+/i,
  // Authorization 头（Bearer/Basic 原值）
  /Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/i,
  // 浏览器 document.cookie
  /document\.cookie\s*[:=]/i,
  // 常见 token 字段名（access_token/refresh_token/id_token 原值）
  /(?:access_token|refresh_token|id_token)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{20,}/i,
  // session id 原值（≥20 字符）
  /(?:session_id|sessionid|JSESSIONID|PHPSESSID)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{20,}/i,
] as const;

/**
 * 扫描 payload JSON 字符串是否包含浏览器敏感信息原值（W07-3）。
 *
 * - payload 必须为字符串或可 JSON 序列化的对象。
 * - 命中任一 BROWSER_STATE_LEAK_PATTERNS 模式即视为泄漏。
 * - 返回命中的模式描述列表（供调用方日志记录与错误展示）。
 *
 * 注意：本函数是兜底校验，调用方仍应在源头避免写入 Cookie/Token。
 *
 * @returns 命中的模式描述列表（空数组表示无泄漏）
 */
export function scanPayloadForCookieLeaks(payload: unknown): string[] {
  if (payload === null || payload === undefined) return [];
  let text: string;
  if (typeof payload === "string") {
    text = payload;
  } else if (typeof payload === "object") {
    try {
      text = JSON.stringify(payload);
    } catch {
      // 不可序列化对象无法扫描，视为安全（调用方应在源头处理）
      return [];
    }
  } else {
    return [];
  }

  const matched: string[] = [];
  for (const pattern of BROWSER_STATE_LEAK_PATTERNS) {
    if (pattern.test(text)) {
      matched.push(pattern.source);
    }
  }
  return matched;
}

/**
 * 断言 payload 可安全写入 Event/Trace（W07-3）。
 *
 * @throws BrowserStateLeakError 检测到 Cookie/Token/Authorization 原值
 */
export function assertPayloadSafeForPersistence(payload: unknown): void {
  const matched = scanPayloadForCookieLeaks(payload);
  if (matched.length > 0) {
    throw new BrowserStateLeakError(matched);
  }
}

// ─── DesktopExecutionContext（W07-2 六元组） ──────────────

/**
 * Desktop 执行上下文：每个命令绑定的六元组（W07-2）。
 *
 * - invocationId：所属 Invocation
 * - leaseId：EnvironmentLease（Desktop Lease 必含 deviceId）
 * - deviceId：执行设备（lease.deviceId === binding.deviceId）
 * - workspaceBindingId：Workspace handle（路径解释所必需）
 * - permissionDecisionId：权限结果（latest PermissionDecision，必须为 allow）
 * - deadline：命令超时时间（超时后转入 effect reconcile，不自动重放）
 */
export interface DesktopExecutionContext {
  tenantId: string;
  toolCallId: string;
  invocationId: string;
  lease: EnvironmentLease;
  deviceId: string;
  workspaceBinding: WorkspaceBinding;
  permissionDecision: PermissionDecision;
  toolCall: ToolCall;
  deadline: Date;
}

export interface BuildDesktopExecutionContextInput {
  tenantId: string;
  toolCallId: string;
  /** WorkspaceBinding id（路径解释所必需）。 */
  workspaceBindingId: string;
  /**
   * 命令超时时间（W07-2 deadline）。
   * 超时后调用方应转入 reconcileDesktopEffectAfterTimeout，不自动重放。
   */
  deadline: Date;
}

/**
 * 构建 Desktop 执行上下文（W07-2 六元组）。
 *
 * 步骤：
 * 1. 查询 ToolCall（必填，跨租户隔离）。
 * 2. 查询最新 PermissionDecision（必须为 allow，否则抛 ToolCallBlockedError/ToolCallPausedError）。
 * 3. 查询 ToolCall.environmentLeaseId 对应的 EnvironmentLease（必填）。
 * 4. 查询 WorkspaceBinding（必填，跨租户隔离）。
 * 5. 查询 Invocation 当前 active execution_ownership（必须存在）。
 * 6. 组装六元组返回（不校验一致性；由 validateDesktopExecutionContext 完成）。
 *
 * @throws DesktopExecutorNotFoundError ToolCall/Lease/Binding/Ownership 不存在
 * @throws ToolCallBlockedError 权限决策为 block
 * @throws ToolCallPausedError 权限决策为 pause（等待用户操作）
 */
export async function buildDesktopExecutionContext(
  input: BuildDesktopExecutionContextInput,
): Promise<DesktopExecutionContext> {
  if (!input.tenantId) {
    throw new DesktopExecutorValidationError("tenantId 不能为空");
  }
  if (!input.toolCallId) {
    throw new DesktopExecutorValidationError("toolCallId 不能为空");
  }
  if (!input.workspaceBindingId) {
    throw new DesktopExecutorValidationError("workspaceBindingId 不能为空");
  }
  if (!input.deadline || !(input.deadline instanceof Date)) {
    throw new DesktopExecutorValidationError("deadline 必须是 Date");
  }

  // 1. 查询 ToolCall
  const toolCall = await getToolCallById({
    tenantId: input.tenantId,
    toolCallId: input.toolCallId,
  });
  if (!toolCall) {
    throw new DesktopExecutorNotFoundError(`ToolCall 不存在或跨租户不可见: ${input.toolCallId}`);
  }
  if (!toolCall.environmentLeaseId) {
    throw new DesktopExecutorNotFoundError(
      `ToolCall ${input.toolCallId} 未绑定 environmentLeaseId（Desktop 命令必须绑定 Lease）`,
    );
  }

  // 2. 权限决策（allow/pause/block；非 allow 抛错）
  const permissionDecision = await assertToolCallAllowed(input.tenantId, input.toolCallId);

  // 3. 查询 EnvironmentLease
  const lease = await getEnvironmentLeaseById(input.tenantId, toolCall.environmentLeaseId);
  if (!lease) {
    throw new DesktopExecutorNotFoundError(
      `EnvironmentLease 不存在或跨租户不可见: ${toolCall.environmentLeaseId}`,
    );
  }
  if (!lease.deviceId) {
    throw new DesktopExecutorValidationError(
      `EnvironmentLease ${lease.id} 无 deviceId（Desktop Lease 必含 deviceId）`,
    );
  }

  // 4. 查询 WorkspaceBinding
  const workspaceBinding = await getWorkspaceBindingById(input.tenantId, input.workspaceBindingId);
  if (!workspaceBinding) {
    throw new DesktopExecutorNotFoundError(
      `WorkspaceBinding 不存在或跨租户不可见: ${input.workspaceBindingId}`,
    );
  }

  // 5. 查询 active execution_ownership（不强制 leaseEpoch 一致；由 validate 校验）
  // 注意：getActiveExecutionOwnership 不接受 tenantId，跨租户隔离由 ToolCall/Lease 已保证。
  // 若 invocation 被跨租户伪造，ownership 查询会返回 null（即 ToolCall 不属于该租户）。
  const _ownership = await getActiveExecutionOwnership(toolCall.invocationId);
  if (!_ownership) {
    throw new DesktopExecutorNotFoundError(
      `Invocation ${toolCall.invocationId} 无 active execution_ownership（执行权未持有或已释放）`,
    );
  }

  return {
    tenantId: input.tenantId,
    toolCallId: input.toolCallId,
    invocationId: toolCall.invocationId,
    lease,
    deviceId: lease.deviceId,
    workspaceBinding,
    permissionDecision,
    toolCall,
    deadline: input.deadline,
  };
}

/**
 * 校验 Desktop 执行上下文一致性（W07-2 + §9.6 四重校验）。
 *
 * 校验规则：
 * - lease.tenantId === binding.tenantId === toolCall.tenantId（租户一致）
 * - lease.deviceId === binding.deviceId（Desktop 设备一致；§7.2 L543）
 * - lease.invocationId === toolCall.invocationId（Lease 归属 Invocation）
 * - lease.leaseState === "active"（Lease 必须为 active 状态）
 * - lease.expiresAt 未过期或为 null（null 表示不过期）
 * - workspaceBinding.bindingState === "active"（Binding 必须为 active 状态）
 * - workspaceBinding.bindingType === "desktop"（Desktop 命令必须使用 Desktop binding）
 * - permissionDecision.decision === "allow"（权限必须允许）
 * - deadline 未过期（过期抛 DesktopCommandTimeoutError，调用方应转入 reconcile 流程）
 *
 * @throws DesktopExecutorContextMismatchError 一致性校验失败
 * @throws DesktopCommandTimeoutError deadline 已过期
 */
export async function validateDesktopExecutionContext(
  ctx: DesktopExecutionContext,
  now: Date = new Date(),
): Promise<void> {
  // 租户一致
  if (ctx.lease.tenantId !== ctx.tenantId) {
    throw new DesktopExecutorContextMismatchError(
      "lease.tenantId",
      ctx.tenantId,
      ctx.lease.tenantId,
    );
  }
  if (ctx.workspaceBinding.tenantId !== ctx.tenantId) {
    throw new DesktopExecutorContextMismatchError(
      "workspaceBinding.tenantId",
      ctx.tenantId,
      ctx.workspaceBinding.tenantId,
    );
  }
  if (ctx.toolCall.tenantId !== ctx.tenantId) {
    throw new DesktopExecutorContextMismatchError(
      "toolCall.tenantId",
      ctx.tenantId,
      ctx.toolCall.tenantId,
    );
  }

  // 设备一致（§7.2 L543：binding.device_id 必须等于 lease.device_id）
  if (!ctx.workspaceBinding.deviceId) {
    throw new DesktopExecutorValidationError(
      `WorkspaceBinding ${ctx.workspaceBinding.id} 无 deviceId（Desktop binding 必含 deviceId）`,
    );
  }
  if (ctx.lease.deviceId !== ctx.workspaceBinding.deviceId) {
    throw new DesktopExecutorContextMismatchError(
      "deviceId (lease vs binding)",
      ctx.lease.deviceId ?? "",
      ctx.workspaceBinding.deviceId,
    );
  }

  // Lease 归属 Invocation
  if (ctx.lease.invocationId !== ctx.invocationId) {
    throw new DesktopExecutorContextMismatchError(
      "lease.invocationId",
      ctx.invocationId,
      ctx.lease.invocationId,
    );
  }

  // Lease 状态必须为 active
  if (ctx.lease.leaseState !== "active") {
    throw new DesktopExecutorContextMismatchError(
      "lease.leaseState",
      "active",
      ctx.lease.leaseState,
    );
  }

  // Lease 未过期
  if (ctx.lease.expiresAt && ctx.lease.expiresAt.getTime() <= now.getTime()) {
    throw new DesktopExecutorContextMismatchError(
      "lease.expiresAt",
      `> ${now.toISOString()}`,
      ctx.lease.expiresAt.toISOString(),
    );
  }

  // Binding 状态必须为 active
  if (ctx.workspaceBinding.bindingState !== "active") {
    throw new DesktopExecutorContextMismatchError(
      "workspaceBinding.bindingState",
      "active",
      ctx.workspaceBinding.bindingState,
    );
  }

  // Binding 类型必须为 desktop
  if (ctx.workspaceBinding.bindingType !== "desktop") {
    throw new DesktopExecutorContextMismatchError(
      "workspaceBinding.bindingType",
      "desktop",
      ctx.workspaceBinding.bindingType,
    );
  }

  // 权限决策必须为 allow
  if (ctx.permissionDecision.decision !== "allow") {
    throw new DesktopExecutorContextMismatchError(
      "permissionDecision.decision",
      "allow",
      ctx.permissionDecision.decision,
    );
  }

  // deadline 检查（W07-4：超时不等于失败，先做 effect reconcile）
  if (ctx.deadline.getTime() <= now.getTime()) {
    throw new DesktopCommandTimeoutError(ctx.toolCallId, ctx.deadline);
  }
}

// ─── 高影响提交确认编排（W07-4） ──────────────────────────

export interface PrepareHighImpactConfirmationInput {
  tenantId: string;
  threadId: string;
  turnId: string;
  invocationId: string;
  toolCallId: string;
  /** 副作用描述（人类可读，脱敏）。 */
  purpose?: string | null;
  /** 副作用详情（JSON 对象，供前端渲染确认 UI）。 */
  promptJson: unknown;
  /** 确认请求超时时间（默认 24h）。 */
  expiresAt?: Date | null;
}

/**
 * 准备高影响提交确认（W07-4）。
 *
 * 在 Desktop 命令产生高影响副作用前，创建 UserActionRequest（requestType=confirmation），
 * 暂停命令执行等待用户 approve/deny。
 *
 * 关键约束：
 * - 调用前必须已通过 validateDesktopExecutionContext。
 * - promptJson 必须经过 assertPayloadSafeForPersistence 扫描（W07-3 Cookie 隔离）。
 * - 创建后调用方应阻塞等待 UserActionRequest 解析（approve → 继续；deny → 取消）。
 * - 超时（expired）后调用方应转入 reconcileDesktopEffectAfterTimeout。
 *
 * @throws BrowserStateLeakError promptJson 含 Cookie/Token 原值
 */
export async function prepareHighImpactConfirmation(
  input: PrepareHighImpactConfirmationInput,
): Promise<CreateUserActionRequestResult> {
  if (!input.tenantId) {
    throw new DesktopExecutorValidationError("tenantId 不能为空");
  }
  if (!input.threadId) {
    throw new DesktopExecutorValidationError("threadId 不能为空");
  }
  if (!input.turnId) {
    throw new DesktopExecutorValidationError("turnId 不能为空");
  }
  if (!input.invocationId) {
    throw new DesktopExecutorValidationError("invocationId 不能为空");
  }
  if (!input.toolCallId) {
    throw new DesktopExecutorValidationError("toolCallId 不能为空");
  }
  if (!input.promptJson || typeof input.promptJson !== "object") {
    throw new DesktopExecutorValidationError("promptJson 必须是对象");
  }

  // W07-3：promptJson 不得含 Cookie/Token 原值
  assertPayloadSafeForPersistence(input.promptJson);

  const createInput: CreateUserActionRequestInput = {
    tenantId: input.tenantId,
    threadId: input.threadId,
    turnId: input.turnId,
    invocationId: input.invocationId,
    toolCallId: input.toolCallId,
    requestType: "confirmation",
    purpose: input.purpose ?? null,
    promptJson: input.promptJson,
    expiresAt: input.expiresAt ?? null,
  };

  return createUserActionRequest(createInput);
}

/**
 * 查询高影响确认请求的当前解析状态。
 *
 * 调用方在 prepareHighImpactConfirmation 后轮询本函数：
 * - state=pending：继续等待
 * - state=resolved + resolution=approve：继续执行
 * - state=resolved + resolution=deny：取消命令（不自动重放）
 * - state=expired：转入 reconcileDesktopEffectAfterTimeout
 *
 * @throws DesktopExecutorNotFoundError UserActionRequest 不存在或跨租户
 */
export async function getHighImpactConfirmationState(
  tenantId: string,
  userActionRequestId: string,
): Promise<{
  state: "pending" | "resolved" | "expired";
  resolution: UserActionResolution | null;
}> {
  const request = await getUserActionRequestById(tenantId, userActionRequestId);
  if (!request) {
    throw new DesktopExecutorNotFoundError(
      `UserActionRequest 不存在或跨租户不可见: ${userActionRequestId}`,
    );
  }
  return {
    state: request.requestState,
    resolution: request.resolution,
  };
}

// ─── 超时核对编排（W07-4 + S08-C05 reconcileEffect） ───────

export interface ReconcileDesktopEffectAfterTimeoutInput {
  tenantId: string;
  toolCallId: string;
  /** 调用路径（默认 gateway；admin 长期核对也支持）。 */
  path?: ReconcileEffectInput["path"];
  /** 核对方式（gateway 路径仅允许 provider_query）。 */
  verificationMethod: VerificationMethod;
  /** 各目标的核对结果。 */
  targetUpdates: ReconcileEffectInput["targetUpdates"];
  /** Gateway 路径必填：必须与原 ToolCall.operationId 一致。 */
  expectedOperationId?: string;
  /** 整体证据；不传则不改。 */
  evidenceJson?: unknown | null;
  /** 整体外部结果引用；不传则不改。 */
  externalResultRef?: string | null;
  /** 调用者标识（用于审计）。 */
  reconciledBy?: string;
}

/**
 * Desktop 命令超时后核对副作用（W07-4）。
 *
 * 关键规则（W07-4 + §6.5）：
 * - 超时不等于失败：先核对目标状态，再决定是否重试。
 * - unknown_effect 不自动重放（§10 第 9 条）；只允许重试明确失败且安全的目标。
 * - 调用 S08-C05 reconcileEffect 完成同事务更新：effect_record + effect_target + tool_call.call_state。
 * - ThreadEvent/AuditEvent 不在本函数写入；由调用方在更高层补充。
 *
 * @throws EffectNotFoundError EffectRecord 不存在
 * @throws EffectAlreadyConfirmedError EffectRecord 已进入终态
 * @throws EffectTargetNotFoundError targetHash 不匹配
 * @throws EffectOperationMismatchError operation_id 不匹配（gateway 路径）
 * @throws EffectVerificationMethodNotAllowedError 方法不被当前路径允许
 */
export async function reconcileDesktopEffectAfterTimeout(
  input: ReconcileDesktopEffectAfterTimeoutInput,
): Promise<ReconcileEffectResult> {
  if (!input.tenantId) {
    throw new DesktopExecutorValidationError("tenantId 不能为空");
  }
  if (!input.toolCallId) {
    throw new DesktopExecutorValidationError("toolCallId 不能为空");
  }

  return reconcileEffect({
    tenantId: input.tenantId,
    toolCallId: input.toolCallId,
    path: input.path ?? "gateway",
    verificationMethod: input.verificationMethod,
    targetUpdates: input.targetUpdates,
    expectedOperationId: input.expectedOperationId,
    evidenceJson: input.evidenceJson ?? null,
    externalResultRef: input.externalResultRef ?? null,
    reconciledBy: input.reconciledBy,
  });
}

// ─── Desktop 文件变更记录（W07 + S08-C06 createFileChanges） ─

/**
 * 记录 Desktop 命令产生的文件变更（W07 + §7.4 + S08-C06）。
 *
 * 包装 S08-C06 createFileChanges，自动注入 Desktop 执行上下文的 workspaceBindingId。
 * 调用方只需提供 toolCallId 和 changes 列表。
 *
 * 关键约束：
 * - pathRef 必须为相对路径（由 createFileChanges 校验）。
 * - beforeHash/afterHash 按 changeType 互斥（由 validateFileChangeHashes 校验）。
 * - 跨租户隔离：ctx.tenantId 必须与 createFileChanges 的 tenantId 一致。
 */
export async function recordDesktopFileChanges(
  ctx: DesktopExecutionContext,
  changes: CreateFileChangesInput["changes"],
): Promise<ReturnType<typeof createFileChanges>> {
  if (ctx.tenantId !== ctx.workspaceBinding.tenantId) {
    throw new DesktopExecutorContextMismatchError(
      "tenantId (ctx vs binding)",
      ctx.workspaceBinding.tenantId,
      ctx.tenantId,
    );
  }
  return createFileChanges({
    tenantId: ctx.tenantId,
    toolCallId: ctx.toolCallId,
    workspaceBindingId: ctx.workspaceBinding.id,
    changes,
  });
}

// ─── 辅助：查询 ToolCall 当前 effect_state（W07-4 决策依据） ─

/**
 * 查询 ToolCall 当前的权限决策（用于 Desktop 执行器在 deadline 前后判断是否可继续）。
 *
 * 返回 null 表示尚未评估（调用方应先调用 recordPermissionDecision）。
 */
export async function getCurrentPermissionDecision(
  tenantId: string,
  toolCallId: string,
): Promise<PermissionDecision | null> {
  return getLatestPermissionDecision(tenantId, toolCallId);
}

// ─── 导出复用类型 ─────────────────────────────────────────

export type { EffectTargetState, ReconcileEffectInput, ReconcileEffectResult, VerificationMethod };
export type { CreateUserActionRequestInput, CreateUserActionRequestResult };
export type { UserActionRequestType, UserActionResolution };
export type { EnvironmentLease, PermissionDecision, ToolCall, WorkspaceBinding };

// 保留 db 引用以便未来扩展（当前接入层不直接操作 db）
void db;
