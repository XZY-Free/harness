/**
 * V11 Workspace 仓储：Workspace / WorkspaceBinding / WorkspaceAttachment /
 * WorkspaceAttachmentUse CRUD + 位置优先级 + 跨租户隔离。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §7.1（workspace/binding/attachment）。
 * - ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §9—16（执行位置语义）。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §3.11、3.12（Attachment API）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W01。
 *
 * 关键不变量：
 * - Desktop binding 必须同时有 deviceId 和 locationRef（创建时校验）。
 * - Cloud/Remote/Sandbox binding 不允许有 deviceId（创建时校验）。
 * - Attachment 只能挂在同租户的 WorkspaceBinding 上。
 * - AttachmentUse 只能引用 attached 状态且未过期的 Attachment。
 * - 删除 Attachment 只改状态为 detached，不物理删除（保留历史）。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - MySQL 不支持 .returning()：update + select 两步。
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  type V11Workspace,
  type V11WorkspaceAttachment,
  type V11WorkspaceAttachmentInsert,
  type V11WorkspaceAttachmentUse,
  type V11WorkspaceBinding,
  type V11WorkspaceBindingInsert,
  type V11WorkspaceInsert,
  WORKSPACE_BINDING_TYPES,
  type WorkspaceBindingState,
  type WorkspaceBindingType,
  type WorkspaceKind,
  type WorkspaceLifecycleState,
  workspace,
  workspaceAttachment,
  workspaceAttachmentUse,
  workspaceBinding,
} from "@/lib/v11/schema/workspace";
import { and, eq, isNotNull, lt, ne } from "drizzle-orm";

// ─── 错误类型 ──────────────────────────────────────────────

export class WorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceNotFoundError";
  }
}

export class WorkspaceBindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBindingConflictError";
  }
}

export class WorkspaceAttachmentExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAttachmentExpiredError";
  }
}

export class WorkspaceVersionConflictError extends Error {
  public readonly expectedVersionNo: string;
  public readonly actualVersionNo: string;

  constructor(message: string, expectedVersionNo: string, actualVersionNo: string) {
    super(message);
    this.name = "WorkspaceVersionConflictError";
    this.expectedVersionNo = expectedVersionNo;
    this.actualVersionNo = actualVersionNo;
  }
}

// ─── 校验辅助 ──────────────────────────────────────────────

const VALID_BINDING_TYPES = new Set<string>(WORKSPACE_BINDING_TYPES);
const VALID_WORKSPACE_KINDS = new Set<string>(["personal", "project", "shared", "system"]);

export function isWorkspaceBindingType(value: string): value is WorkspaceBindingType {
  return VALID_BINDING_TYPES.has(value);
}

export function isWorkspaceKind(value: string): value is WorkspaceKind {
  return VALID_WORKSPACE_KINDS.has(value);
}

export function isValidWorkspaceKey(key: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(key);
}

/** 计算位置指纹（sha256: 前缀 + 64 hex）。 */
export function computeLocationFingerprint(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\x00");
  }
  return `sha256:${hash.digest("hex")}`;
}

// ─── Workspace CRUD ────────────────────────────────────────

export interface CreateWorkspaceInput {
  tenantId: string;
  workspaceKey: string;
  displayName: string;
  description?: string;
  workspaceKind?: WorkspaceKind;
  ownerUserId?: string;
  defaultEnvironmentDefinitionId?: string;
  defaultBindingId?: string;
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<V11Workspace> {
  if (!input.tenantId) throw new WorkspaceValidationError("tenantId 不能为空");
  if (!isValidWorkspaceKey(input.workspaceKey)) {
    throw new WorkspaceValidationError(
      "workspaceKey 必须以字母数字开头，长度 1-128，仅允许字母数字、下划线、连字符",
    );
  }
  if (!input.displayName) throw new WorkspaceValidationError("displayName 不能为空");
  if (input.workspaceKind && !isWorkspaceKind(input.workspaceKind)) {
    throw new WorkspaceValidationError(`非法 workspaceKind: ${input.workspaceKind}`);
  }

  const insert: V11WorkspaceInsert = {
    tenantId: input.tenantId,
    workspaceKey: input.workspaceKey,
    displayName: input.displayName,
    description: input.description ?? null,
    workspaceKind: input.workspaceKind ?? "personal",
    ownerUserId: input.ownerUserId ?? null,
    defaultEnvironmentDefinitionId: input.defaultEnvironmentDefinitionId ?? null,
    defaultBindingId: input.defaultBindingId ?? null,
  };

  const [row] = await db.insert(workspace).values(insert);
  // MySQL 不支持 .returning()，回查。
  const created = await getWorkspaceByKey(input.tenantId, input.workspaceKey);
  if (!created) throw new WorkspaceNotFoundError("Workspace 创建后回查失败");
  return created;
}

export async function getWorkspaceById(tenantId: string, id: string): Promise<V11Workspace | null> {
  const [row] = await db
    .select()
    .from(workspace)
    .where(and(eq(workspace.tenantId, tenantId), eq(workspace.id, id)))
    .limit(1);
  return row ?? null;
}

export async function getWorkspaceByKey(
  tenantId: string,
  workspaceKey: string,
): Promise<V11Workspace | null> {
  const [row] = await db
    .select()
    .from(workspace)
    .where(and(eq(workspace.tenantId, tenantId), eq(workspace.workspaceKey, workspaceKey)))
    .limit(1);
  return row ?? null;
}

export async function listWorkspaces(
  tenantId: string,
  options?: {
    ownerUserId?: string;
    workspaceKind?: WorkspaceKind;
    lifecycleState?: WorkspaceLifecycleState;
    limit?: number;
  },
): Promise<V11Workspace[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [eq(workspace.tenantId, tenantId)];

  if (options?.ownerUserId) {
    conditions.push(eq(workspace.ownerUserId, options.ownerUserId));
  }
  if (options?.workspaceKind) {
    conditions.push(eq(workspace.workspaceKind, options.workspaceKind));
  }
  // 默认排除 deleted（除非显式查询）。
  if (options?.lifecycleState) {
    conditions.push(eq(workspace.lifecycleState, options.lifecycleState));
  } else {
    conditions.push(ne(workspace.lifecycleState, "deleted"));
  }

  return db
    .select()
    .from(workspace)
    .where(and(...conditions))
    .limit(limit);
}

export async function archiveWorkspace(
  tenantId: string,
  id: string,
  expectedVersionNo: string,
): Promise<V11Workspace> {
  const current = await getWorkspaceById(tenantId, id);
  if (!current) throw new WorkspaceNotFoundError(`Workspace ${id} 不存在`);
  if (current.versionNo !== expectedVersionNo) {
    throw new WorkspaceVersionConflictError(
      `Workspace 版本号不匹配：期望 ${expectedVersionNo}，实际 ${current.versionNo}`,
      expectedVersionNo,
      current.versionNo,
    );
  }
  if (current.lifecycleState === "deleted") {
    throw new WorkspaceValidationError("已删除的 Workspace 不能归档");
  }

  await db
    .update(workspace)
    .set({
      lifecycleState: "archived",
      updatedAt: new Date(),
      versionNo: crypto.randomUUID(),
    })
    .where(and(eq(workspace.tenantId, tenantId), eq(workspace.id, id)));

  const updated = await getWorkspaceById(tenantId, id);
  if (!updated) throw new WorkspaceNotFoundError("Workspace 归档后回查失败");
  return updated;
}

// ─── WorkspaceBinding CRUD ─────────────────────────────────

export interface CreateWorkspaceBindingInput {
  tenantId: string;
  workspaceId: string;
  bindingType: WorkspaceBindingType;
  deviceId?: string;
  environmentDefinitionId?: string;
  locationRef: string;
  locationFingerprint?: string;
}

export async function createWorkspaceBinding(
  input: CreateWorkspaceBindingInput,
): Promise<V11WorkspaceBinding> {
  if (!input.tenantId) throw new WorkspaceValidationError("tenantId 不能为空");
  if (!isWorkspaceBindingType(input.bindingType)) {
    throw new WorkspaceValidationError(`非法 bindingType: ${input.bindingType}`);
  }
  if (!input.locationRef) throw new WorkspaceValidationError("locationRef 不能为空");

  // Desktop binding 必须同时有 deviceId 和 locationRef。
  if (input.bindingType === "desktop") {
    if (!input.deviceId) {
      throw new WorkspaceValidationError("Desktop binding 必须同时提供 deviceId");
    }
  } else {
    // Cloud/Remote/Sandbox 不允许有 deviceId（避免误绑定具体设备）。
    if (input.deviceId) {
      throw new WorkspaceValidationError(
        `${input.bindingType} binding 不允许设置 deviceId（仅 desktop 允许）`,
      );
    }
  }

  // 校验 Workspace 存在且同租户。
  const ws = await getWorkspaceById(input.tenantId, input.workspaceId);
  if (!ws) throw new WorkspaceNotFoundError(`Workspace ${input.workspaceId} 不存在`);
  if (ws.lifecycleState === "deleted") {
    throw new WorkspaceValidationError("已删除的 Workspace 不能添加 binding");
  }

  const insert: V11WorkspaceBindingInsert = {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    bindingType: input.bindingType,
    deviceId: input.deviceId ?? null,
    environmentDefinitionId: input.environmentDefinitionId ?? null,
    locationRef: input.locationRef,
    locationFingerprint: input.locationFingerprint ?? computeLocationFingerprint(input.locationRef),
  };

  await db.insert(workspaceBinding).values(insert);
  // 回查最新一条（没有唯一约束，按 createdAt desc）。
  const [row] = await db
    .select()
    .from(workspaceBinding)
    .where(
      and(
        eq(workspaceBinding.tenantId, input.tenantId),
        eq(workspaceBinding.workspaceId, input.workspaceId),
        eq(workspaceBinding.locationRef, input.locationRef),
        eq(workspaceBinding.bindingType, input.bindingType),
      ),
    )
    .orderBy(workspaceBinding.createdAt)
    .limit(1);
  if (!row) throw new WorkspaceNotFoundError("WorkspaceBinding 创建后回查失败");
  return row;
}

export async function getWorkspaceBindingById(
  tenantId: string,
  id: string,
): Promise<V11WorkspaceBinding | null> {
  const [row] = await db
    .select()
    .from(workspaceBinding)
    .where(and(eq(workspaceBinding.tenantId, tenantId), eq(workspaceBinding.id, id)))
    .limit(1);
  return row ?? null;
}

export async function listWorkspaceBindings(
  tenantId: string,
  workspaceId: string,
  options?: {
    bindingState?: WorkspaceBindingState;
    bindingType?: WorkspaceBindingType;
    limit?: number;
  },
): Promise<V11WorkspaceBinding[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [
    eq(workspaceBinding.tenantId, tenantId),
    eq(workspaceBinding.workspaceId, workspaceId),
  ];

  if (options?.bindingState) {
    conditions.push(eq(workspaceBinding.bindingState, options.bindingState));
  } else {
    // 默认排除 revoked。
    conditions.push(ne(workspaceBinding.bindingState, "revoked"));
  }
  if (options?.bindingType) {
    conditions.push(eq(workspaceBinding.bindingType, options.bindingType));
  }

  return db
    .select()
    .from(workspaceBinding)
    .where(and(...conditions))
    .limit(limit);
}

export async function updateWorkspaceBindingState(
  tenantId: string,
  id: string,
  newState: WorkspaceBindingState,
  expectedVersionNo: string,
): Promise<V11WorkspaceBinding> {
  const current = await getWorkspaceBindingById(tenantId, id);
  if (!current) throw new WorkspaceNotFoundError(`WorkspaceBinding ${id} 不存在`);
  if (current.versionNo !== expectedVersionNo) {
    throw new WorkspaceVersionConflictError(
      "WorkspaceBinding 版本号不匹配",
      expectedVersionNo,
      current.versionNo,
    );
  }
  if (current.bindingState === "revoked" && newState !== "revoked") {
    throw new WorkspaceValidationError("已撤销的 binding 不能恢复");
  }

  await db
    .update(workspaceBinding)
    .set({
      bindingState: newState,
      lastVerifiedAt: newState === "active" ? new Date() : current.lastVerifiedAt,
      updatedAt: new Date(),
      versionNo: crypto.randomUUID(),
    })
    .where(and(eq(workspaceBinding.tenantId, tenantId), eq(workspaceBinding.id, id)));

  const updated = await getWorkspaceBindingById(tenantId, id);
  if (!updated) throw new WorkspaceNotFoundError("WorkspaceBinding 更新后回查失败");
  return updated;
}

// ─── WorkspaceAttachment CRUD ──────────────────────────────

export interface CreateWorkspaceAttachmentInput {
  tenantId: string;
  threadId: string;
  workspaceBindingId: string;
  resourceType: V11WorkspaceAttachmentInsert["resourceType"];
  resourceRef: string;
  resourceFingerprint?: string;
  displayRef?: string;
  accessMode?: V11WorkspaceAttachmentInsert["accessMode"];
  attachedBy: string;
  expiresAt?: Date;
}

export async function createWorkspaceAttachment(
  input: CreateWorkspaceAttachmentInput,
): Promise<V11WorkspaceAttachment> {
  if (!input.tenantId) throw new WorkspaceValidationError("tenantId 不能为空");
  if (!input.threadId) throw new WorkspaceValidationError("threadId 不能为空");
  if (!input.resourceRef) throw new WorkspaceValidationError("resourceRef 不能为空");
  if (!input.attachedBy) throw new WorkspaceValidationError("attachedBy 不能为空");

  // 校验 WorkspaceBinding 存在且同租户、active。
  const binding = await getWorkspaceBindingById(input.tenantId, input.workspaceBindingId);
  if (!binding) {
    throw new WorkspaceNotFoundError(`WorkspaceBinding ${input.workspaceBindingId} 不存在`);
  }
  if (binding.bindingState !== "active") {
    throw new WorkspaceValidationError(
      `WorkspaceBinding 状态非 active（当前 ${binding.bindingState}），不能挂载 Attachment`,
    );
  }

  const insert: V11WorkspaceAttachmentInsert = {
    tenantId: input.tenantId,
    threadId: input.threadId,
    workspaceBindingId: input.workspaceBindingId,
    resourceType: input.resourceType,
    resourceRef: input.resourceRef,
    resourceFingerprint: input.resourceFingerprint ?? computeLocationFingerprint(input.resourceRef),
    displayRef: input.displayRef ?? null,
    accessMode: input.accessMode ?? "read",
    attachmentState: "attached",
    attachedBy: input.attachedBy,
    expiresAt: input.expiresAt ?? null,
  };

  await db.insert(workspaceAttachment).values(insert);
  // 回查最新一条。
  const [row] = await db
    .select()
    .from(workspaceAttachment)
    .where(
      and(
        eq(workspaceAttachment.tenantId, input.tenantId),
        eq(workspaceAttachment.workspaceBindingId, input.workspaceBindingId),
        eq(workspaceAttachment.resourceRef, input.resourceRef),
        eq(workspaceAttachment.attachedBy, input.attachedBy),
      ),
    )
    .orderBy(workspaceAttachment.createdAt)
    .limit(1);
  if (!row) throw new WorkspaceNotFoundError("WorkspaceAttachment 创建后回查失败");
  return row;
}

export async function getWorkspaceAttachmentById(
  tenantId: string,
  id: string,
): Promise<V11WorkspaceAttachment | null> {
  const [row] = await db
    .select()
    .from(workspaceAttachment)
    .where(and(eq(workspaceAttachment.tenantId, tenantId), eq(workspaceAttachment.id, id)))
    .limit(1);
  return row ?? null;
}

export async function listWorkspaceAttachmentsByThread(
  tenantId: string,
  threadId: string,
  options?: { includeDetached?: boolean; limit?: number },
): Promise<V11WorkspaceAttachment[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [
    eq(workspaceAttachment.tenantId, tenantId),
    eq(workspaceAttachment.threadId, threadId),
  ];

  if (!options?.includeDetached) {
    // 默认只返回 attached（detached/expired 不返回）。
    conditions.push(eq(workspaceAttachment.attachmentState, "attached"));
  }

  return db
    .select()
    .from(workspaceAttachment)
    .where(and(...conditions))
    .limit(limit);
}

export async function detachWorkspaceAttachment(
  tenantId: string,
  id: string,
  expectedVersionNo: string,
): Promise<V11WorkspaceAttachment> {
  const current = await getWorkspaceAttachmentById(tenantId, id);
  if (!current) throw new WorkspaceNotFoundError(`WorkspaceAttachment ${id} 不存在`);
  if (current.versionNo !== expectedVersionNo) {
    throw new WorkspaceVersionConflictError(
      "WorkspaceAttachment 版本号不匹配",
      expectedVersionNo,
      current.versionNo,
    );
  }
  if (current.attachmentState === "detached") {
    throw new WorkspaceValidationError("Attachment 已卸载，无需重复操作");
  }

  await db
    .update(workspaceAttachment)
    .set({
      attachmentState: "detached",
      updatedAt: new Date(),
      versionNo: crypto.randomUUID(),
    })
    .where(and(eq(workspaceAttachment.tenantId, tenantId), eq(workspaceAttachment.id, id)));

  const updated = await getWorkspaceAttachmentById(tenantId, id);
  if (!updated) throw new WorkspaceNotFoundError("WorkspaceAttachment 卸载后回查失败");
  return updated;
}

/**
 * 扫描过期 Attachment，将过期且仍为 attached 的 Attachment 转为 expired。
 * 通常由后台 Job 调用；不直接在请求路径执行。
 */
export async function markExpiredWorkspaceAttachments(now: Date = new Date()): Promise<number> {
  const expired = await db
    .select({ id: workspaceAttachment.id, tenantId: workspaceAttachment.tenantId })
    .from(workspaceAttachment)
    .where(
      and(
        eq(workspaceAttachment.attachmentState, "attached"),
        isNotNull(workspaceAttachment.expiresAt),
        lt(workspaceAttachment.expiresAt, now),
      ),
    );

  if (expired.length === 0) return 0;

  for (const row of expired) {
    await db
      .update(workspaceAttachment)
      .set({
        attachmentState: "expired",
        updatedAt: now,
        versionNo: crypto.randomUUID(),
      })
      .where(
        and(eq(workspaceAttachment.tenantId, row.tenantId), eq(workspaceAttachment.id, row.id)),
      );
  }
  return expired.length;
}

// ─── WorkspaceAttachmentUse CRUD ───────────────────────────

export interface CreateWorkspaceAttachmentUseInput {
  tenantId: string;
  turnId: string;
  workspaceAttachmentId: string;
}

/**
 * 为 Turn 创建 Attachment 使用记录。
 * - 校验 Attachment 存在、同租户、attached 状态、未过期。
 * - UNIQUE(turnId, workspaceAttachmentId) 冲突时返回已有记录（幂等）。
 */
export async function createWorkspaceAttachmentUse(
  input: CreateWorkspaceAttachmentUseInput,
): Promise<V11WorkspaceAttachmentUse> {
  if (!input.tenantId) throw new WorkspaceValidationError("tenantId 不能为空");
  if (!input.turnId) throw new WorkspaceValidationError("turnId 不能为空");
  if (!input.workspaceAttachmentId) {
    throw new WorkspaceValidationError("workspaceAttachmentId 不能为空");
  }

  // 校验 Attachment 状态。
  const attachment = await getWorkspaceAttachmentById(input.tenantId, input.workspaceAttachmentId);
  if (!attachment) {
    throw new WorkspaceNotFoundError(`WorkspaceAttachment ${input.workspaceAttachmentId} 不存在`);
  }
  if (attachment.attachmentState !== "attached") {
    throw new WorkspaceValidationError(
      `Attachment 状态非 attached（当前 ${attachment.attachmentState}），不能创建使用记录`,
    );
  }
  if (attachment.expiresAt && attachment.expiresAt < new Date()) {
    throw new WorkspaceAttachmentExpiredError(`Attachment ${input.workspaceAttachmentId} 已过期`);
  }

  // 幂等：UNIQUE(turnId, workspaceAttachmentId) 冲突时回查。
  try {
    await db.insert(workspaceAttachmentUse).values({
      tenantId: input.tenantId,
      turnId: input.turnId,
      workspaceAttachmentId: input.workspaceAttachmentId,
    });
  } catch (err) {
    // 回查已存在记录。
    const [existing] = await db
      .select()
      .from(workspaceAttachmentUse)
      .where(
        and(
          eq(workspaceAttachmentUse.tenantId, input.tenantId),
          eq(workspaceAttachmentUse.turnId, input.turnId),
          eq(workspaceAttachmentUse.workspaceAttachmentId, input.workspaceAttachmentId),
        ),
      )
      .limit(1);
    if (existing) return existing;
    throw err;
  }

  const [row] = await db
    .select()
    .from(workspaceAttachmentUse)
    .where(
      and(
        eq(workspaceAttachmentUse.tenantId, input.tenantId),
        eq(workspaceAttachmentUse.turnId, input.turnId),
        eq(workspaceAttachmentUse.workspaceAttachmentId, input.workspaceAttachmentId),
      ),
    )
    .limit(1);
  if (!row) throw new WorkspaceNotFoundError("WorkspaceAttachmentUse 创建后回查失败");
  return row;
}

export async function listWorkspaceAttachmentUsesByTurn(
  tenantId: string,
  turnId: string,
): Promise<V11WorkspaceAttachmentUse[]> {
  return db
    .select()
    .from(workspaceAttachmentUse)
    .where(
      and(eq(workspaceAttachmentUse.tenantId, tenantId), eq(workspaceAttachmentUse.turnId, turnId)),
    );
}

// ─── 位置优先级解析（§9—16）────────────────────────────────

/**
 * 位置优先级输入（按 §9—16 规则解析）。
 * 优先级从高到低：
 * 1. user_explicit：用户明确指定的位置（如 Attachment 显式位置）。
 * 2. current_object：当前对象位置（Thread 默认 Workspace）。
 * 3. tool_explicit：Tool 显式指定的位置。
 * 4. temporary：临时目录（fallback，不推荐用于持久数据）。
 * 5. default_workspace：默认 Workspace。
 */
export type WorkspaceLocationPriority =
  | "user_explicit"
  | "current_object"
  | "tool_explicit"
  | "temporary"
  | "default_workspace";

export interface ResolvedWorkspaceLocation {
  priority: WorkspaceLocationPriority;
  workspaceBindingId: string | null;
  /** 临时目录 fallback 时为 null（不在 WorkspaceBinding 范围内）。 */
  isTemporary: boolean;
  reason: string;
}

/**
 * 解析 ToolCall 的工作位置。
 * 按优先级返回第一个匹配的位置。
 */
export function resolveWorkspaceLocation(options: {
  userExplicitBindingId?: string;
  currentObjectBindingId?: string;
  toolExplicitBindingId?: string;
  defaultWorkspaceBindingId?: string;
  allowTemporary?: boolean;
}): ResolvedWorkspaceLocation {
  if (options.userExplicitBindingId) {
    return {
      priority: "user_explicit",
      workspaceBindingId: options.userExplicitBindingId,
      isTemporary: false,
      reason: "用户明确指定位置",
    };
  }
  if (options.currentObjectBindingId) {
    return {
      priority: "current_object",
      workspaceBindingId: options.currentObjectBindingId,
      isTemporary: false,
      reason: "当前对象位置",
    };
  }
  if (options.toolExplicitBindingId) {
    return {
      priority: "tool_explicit",
      workspaceBindingId: options.toolExplicitBindingId,
      isTemporary: false,
      reason: "Tool 明确指定位置",
    };
  }
  if (options.allowTemporary) {
    return {
      priority: "temporary",
      workspaceBindingId: null,
      isTemporary: true,
      reason: "临时目录（fallback）",
    };
  }
  if (options.defaultWorkspaceBindingId) {
    return {
      priority: "default_workspace",
      workspaceBindingId: options.defaultWorkspaceBindingId,
      isTemporary: false,
      reason: "默认 Workspace",
    };
  }
  return {
    priority: "default_workspace",
    workspaceBindingId: null,
    isTemporary: false,
    reason: "无可用 WorkspaceBinding",
  };
}
