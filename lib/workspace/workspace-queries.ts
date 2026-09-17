/**
 * Workspace 仓储：Workspace / WorkspaceBinding / WorkspaceAttachment /
 * WorkspaceAttachmentUse CRUD + 位置优先级 + 跨租户隔离。
 *
 * 事实源：
 * - docs/architecture/persistence.md （workspace/binding/attachment）。
 * - docs/architecture/capabilities-and-security.md §9—16（执行位置语义）。
 * - docs/architecture/api-and-events.md 、3.12（Attachment API）。
 * - docs/architecture/capabilities-and-security.md 。
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
import { type DbOrTx, db } from "@/lib/db/client";
import {
  WORKSPACE_BINDING_TYPES,
  type Workspace,
  type WorkspaceAttachment,
  type WorkspaceAttachmentInsert,
  type WorkspaceAttachmentUse,
  type WorkspaceBinding,
  type WorkspaceBindingInsert,
  type WorkspaceBindingType,
  type WorkspaceContinuityMode,
  type WorkspaceInsert,
  type WorkspaceKind,
  type WorkspaceLifecycleState,
  workspace,
  workspaceAttachment,
  workspaceAttachmentUse,
  workspaceBinding,
} from "@/lib/persistence/schema/workspace";
import { and, eq, isNotNull, isNull, lt, ne } from "drizzle-orm";

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

export async function createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
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

  const insert: WorkspaceInsert = {
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

export async function getWorkspaceById(tenantId: string, id: string): Promise<Workspace | null> {
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
): Promise<Workspace | null> {
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
): Promise<Workspace[]> {
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
): Promise<Workspace> {
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
  /**
   * 稳定身份（可选）。
   *
   * 提供时表示「该 Binding 的身份由调用方派生、可重复解析」：插入走幂等语义
   * （重复插入不报错，回读已存在行）。用于语义完全由租户级事实决定的退化契约，
   * 使重复/并发解析落到同一行，而不是每次铸造一条新记录。
   */
  id?: string;
  tenantId: string;
  workspaceId?: string | null;
  bindingType?: WorkspaceBindingType | null;
  continuityMode: WorkspaceContinuityMode;
  deviceId?: string | null;
  locationRef?: string | null;
  storageScopeDigest?: string | null;
  backendKind?: string | null;
  hostIdentity?: string | null;
  storageIdentity?: string | null;
  accessMode?: string | null;
  filesystemSemantics?: unknown;
  checkpointPolicy?: unknown;
  contractDigest: string;
  createdBy: string;
}

export async function createWorkspaceBinding(
  input: CreateWorkspaceBindingInput,
): Promise<WorkspaceBinding> {
  if (!input.tenantId) throw new WorkspaceValidationError("tenantId 不能为空");
  if (input.bindingType && !isWorkspaceBindingType(input.bindingType)) {
    throw new WorkspaceValidationError(`非法 bindingType: ${input.bindingType}`);
  }

  const isNoPlatformWorkspace = input.continuityMode === "NO_PLATFORM_WORKSPACE";
  if (isNoPlatformWorkspace) {
    if (
      input.workspaceId ||
      input.bindingType ||
      input.deviceId ||
      input.locationRef ||
      input.storageScopeDigest ||
      input.backendKind ||
      input.hostIdentity ||
      input.storageIdentity ||
      input.accessMode ||
      input.checkpointPolicy
    ) {
      throw new WorkspaceValidationError("NO_PLATFORM_WORKSPACE 不得携带平台资源定位");
    }
  } else if (
    !input.workspaceId ||
    !input.bindingType ||
    !input.locationRef ||
    !input.backendKind ||
    !input.storageIdentity ||
    !input.accessMode
  ) {
    throw new WorkspaceValidationError(
      "平台 WorkspaceBinding 必须提供 workspaceId、bindingType、locationRef、backendKind、storageIdentity 和 accessMode",
    );
  }

  if (input.accessMode && input.accessMode !== "read" && input.accessMode !== "read_write") {
    throw new WorkspaceValidationError(`非法 WorkspaceBinding accessMode: ${input.accessMode}`);
  }
  if (input.continuityMode === "HOST_AFFINE" && !input.hostIdentity) {
    throw new WorkspaceValidationError("HOST_AFFINE WorkspaceBinding 必须提供 hostIdentity");
  }
  if (input.continuityMode === "CHECKPOINT_RESTORABLE" && !input.checkpointPolicy) {
    throw new WorkspaceValidationError(
      "CHECKPOINT_RESTORABLE WorkspaceBinding 必须提供 checkpointPolicy",
    );
  }
  if (input.continuityMode !== "CHECKPOINT_RESTORABLE" && input.checkpointPolicy) {
    throw new WorkspaceValidationError(
      "非 CHECKPOINT_RESTORABLE WorkspaceBinding 不得携带 checkpointPolicy",
    );
  }

  // Desktop binding 必须同时有 deviceId 和 locationRef。
  if (input.continuityMode === "HOST_AFFINE") {
    if (!input.deviceId) {
      throw new WorkspaceValidationError("HOST_AFFINE WorkspaceBinding 必须同时提供 deviceId");
    }
  } else {
    // Cloud/Remote/Sandbox 不允许有 deviceId（避免误绑定具体设备）。
    if (input.deviceId) {
      throw new WorkspaceValidationError(`${input.continuityMode} binding 不允许设置 deviceId`);
    }
  }

  // 校验 Workspace 存在且同租户。
  const workspaceId = input.workspaceId;
  if (workspaceId) {
    const ws = await getWorkspaceById(input.tenantId, workspaceId);
    if (!ws) throw new WorkspaceNotFoundError(`Workspace ${workspaceId} 不存在`);
    if (ws.lifecycleState === "deleted") {
      throw new WorkspaceValidationError("已删除的 Workspace 不能添加 binding");
    }
  }

  const insert: WorkspaceBindingInsert = {
    ...(input.id ? { id: input.id } : {}),
    tenantId: input.tenantId,
    workspaceId: input.workspaceId ?? null,
    bindingType: input.bindingType ?? null,
    continuityMode: input.continuityMode,
    deviceId: input.deviceId ?? null,
    locationRef: input.locationRef ?? null,
    storageScopeDigest:
      input.storageScopeDigest ??
      (input.locationRef ? computeLocationFingerprint(input.locationRef) : null),
    backendKind: input.backendKind ?? null,
    hostIdentity: input.hostIdentity ?? null,
    storageIdentity: input.storageIdentity ?? null,
    accessMode: input.accessMode ?? null,
    filesystemSemantics: input.filesystemSemantics ?? {
      kind: "unknown",
      caseSensitive: true,
      symlinks: true,
      permissions: true,
      hardlinks: false,
      specialFiles: false,
      xattrsAcl: false,
      mtime: "preserved",
    },
    checkpointPolicy: input.checkpointPolicy ?? null,
    contractDigest: input.contractDigest,
    createdBy: input.createdBy,
  };

  if (input.id) {
    // 稳定身份：并发/重复解析必须落到同一行。`ON DUPLICATE KEY UPDATE` 让后到者安静
    // 落在已存在行上（把主键写成自身即无副作用），再用派生 id 回读 ——
    // 结果是**与解析次数无关**的确定值，这正是退化契约需要的语义。
    await db
      .insert(workspaceBinding)
      .values(insert)
      .onDuplicateKeyUpdate({ set: { id: input.id } });
    const [stabilized] = await db
      .select()
      .from(workspaceBinding)
      .where(and(eq(workspaceBinding.tenantId, input.tenantId), eq(workspaceBinding.id, input.id)))
      .limit(1);
    if (!stabilized) throw new WorkspaceNotFoundError("WorkspaceBinding 幂等创建后回查失败");
    return stabilized;
  }

  await db.insert(workspaceBinding).values(insert);
  // 回查最新一条（没有唯一约束，按 createdAt desc）。
  const [row] = await db
    .select()
    .from(workspaceBinding)
    .where(
      and(
        eq(workspaceBinding.tenantId, input.tenantId),
        input.workspaceId
          ? eq(workspaceBinding.workspaceId, input.workspaceId)
          : isNull(workspaceBinding.workspaceId),
        input.locationRef
          ? eq(workspaceBinding.locationRef, input.locationRef)
          : isNull(workspaceBinding.locationRef),
        eq(workspaceBinding.continuityMode, input.continuityMode),
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
): Promise<WorkspaceBinding | null> {
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
    continuityMode?: WorkspaceContinuityMode;
    bindingType?: WorkspaceBindingType;
    limit?: number;
  },
): Promise<WorkspaceBinding[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [
    eq(workspaceBinding.tenantId, tenantId),
    eq(workspaceBinding.workspaceId, workspaceId),
  ];

  if (options?.continuityMode)
    conditions.push(eq(workspaceBinding.continuityMode, options.continuityMode));
  if (options?.bindingType) {
    conditions.push(eq(workspaceBinding.bindingType, options.bindingType));
  }

  return db
    .select()
    .from(workspaceBinding)
    .where(and(...conditions))
    .limit(limit);
}

/** Continuity contract is immutable; lifecycle is represented by the owning Workspace. */
export async function updateWorkspaceBindingState(): Promise<never> {
  throw new WorkspaceValidationError("WorkspaceBinding 是不可变 Continuity Contract，不能更新状态");
}

// ─── WorkspaceAttachment CRUD ──────────────────────────────

export interface CreateWorkspaceAttachmentInput {
  tenantId: string;
  threadId: string;
  workspaceBindingId: string;
  resourceType: WorkspaceAttachmentInsert["resourceType"];
  resourceRef: string;
  resourceFingerprint?: string;
  displayRef?: string;
  accessMode?: WorkspaceAttachmentInsert["accessMode"];
  attachedBy: string;
  expiresAt?: Date;
}

export interface CreateManagedWorkspaceAttachmentInput {
  id: string;
  tenantId: string;
  threadId: string;
  storageProvider: string;
  resourceRef: string;
  resourceFingerprint: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  attachedBy: string;
}

/** 登记由 SnowHarness FileStorageProvider 保存的原文件。 */
export async function createManagedWorkspaceAttachment(
  input: CreateManagedWorkspaceAttachmentInput,
  executor: DbOrTx = db,
): Promise<WorkspaceAttachment> {
  if (!input.id) throw new WorkspaceValidationError("id 不能为空");
  if (!input.tenantId) throw new WorkspaceValidationError("tenantId 不能为空");
  if (!input.threadId) throw new WorkspaceValidationError("threadId 不能为空");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.storageProvider)) {
    throw new WorkspaceValidationError("storageProvider 格式非法");
  }
  if (!input.resourceRef) throw new WorkspaceValidationError("resourceRef 不能为空");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.resourceFingerprint)) {
    throw new WorkspaceValidationError("resourceFingerprint 必须是 sha256 指纹");
  }
  if (!input.originalFilename || input.originalFilename.length > 512) {
    throw new WorkspaceValidationError("originalFilename 不能为空且不能超过 512 字符");
  }
  if (!input.contentType || input.contentType.length > 255) {
    throw new WorkspaceValidationError("contentType 不能为空且不能超过 255 字符");
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new WorkspaceValidationError("sizeBytes 必须是非负安全整数");
  }
  if (!input.attachedBy) throw new WorkspaceValidationError("attachedBy 不能为空");

  await executor.insert(workspaceAttachment).values({
    id: input.id,
    tenantId: input.tenantId,
    threadId: input.threadId,
    workspaceBindingId: null,
    storageProvider: input.storageProvider,
    resourceType: "file",
    resourceRef: input.resourceRef,
    resourceFingerprint: input.resourceFingerprint,
    displayRef: input.originalFilename.slice(0, 256),
    originalFilename: input.originalFilename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    accessMode: "read",
    attachmentState: "attached",
    attachedBy: input.attachedBy,
  });

  const [created] = await executor
    .select()
    .from(workspaceAttachment)
    .where(
      and(eq(workspaceAttachment.tenantId, input.tenantId), eq(workspaceAttachment.id, input.id)),
    )
    .limit(1);
  if (!created) throw new WorkspaceNotFoundError("WorkspaceAttachment 创建后回查失败");
  return created;
}

export async function createWorkspaceAttachment(
  input: CreateWorkspaceAttachmentInput,
): Promise<WorkspaceAttachment> {
  if (!input.tenantId) throw new WorkspaceValidationError("tenantId 不能为空");
  if (!input.threadId) throw new WorkspaceValidationError("threadId 不能为空");
  if (!input.resourceRef) throw new WorkspaceValidationError("resourceRef 不能为空");
  if (!input.attachedBy) throw new WorkspaceValidationError("attachedBy 不能为空");

  // 校验 WorkspaceBinding 存在且同租户、active。
  const binding = await getWorkspaceBindingById(input.tenantId, input.workspaceBindingId);
  if (!binding) {
    throw new WorkspaceNotFoundError(`WorkspaceBinding ${input.workspaceBindingId} 不存在`);
  }

  const insert: WorkspaceAttachmentInsert = {
    tenantId: input.tenantId,
    threadId: input.threadId,
    workspaceBindingId: input.workspaceBindingId,
    storageProvider: "binding",
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
): Promise<WorkspaceAttachment | null> {
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
): Promise<WorkspaceAttachment[]> {
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
): Promise<WorkspaceAttachment> {
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
): Promise<WorkspaceAttachmentUse> {
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
): Promise<WorkspaceAttachmentUse[]> {
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
