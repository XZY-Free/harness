/**
 * V11 Artifact + FileChange + FilesystemCheckpoint 仓储（阶段 8 S08-C06）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §7.3-7.4、§5.4（Item 多态 artifact）、
 *   §6.3（invocation_attempt.checkpoint_ref）、§6.6（tool_call.result_artifact_id）、
 *   §9 不变量第 11 条（本地路径必须与 Desktop device/binding 一起解释）。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §5.3（Artifact 上传 API）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W06。
 *
 * 关键不变量：
 * - 三张表都是不可变事实记录（无状态机、无 versionNo 乐观锁）。
 * - Artifact：UNIQUE(itemId) 一对一；会话产物与 Job 产物互斥；contentRef 受管引用；contentHash sha256:。
 * - FileChange：pathRef 相对 WorkspaceBinding；beforeHash/afterHash 按 changeType 互斥。
 * - FilesystemCheckpoint：只恢复文件状态不恢复会话；contentHash sha256:。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - MySQL 不支持 .returning()：update + select 两步。
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  FILE_CHANGE_TYPES,
  type FileChange,
  type FileChangeType,
  type NewFileChange,
  fileChangeTable,
} from "@/lib/persistence/schema/file-change";
import {
  FILESYSTEM_CHECKPOINT_TYPES,
  type FilesystemCheckpoint,
  type FilesystemCheckpointType,
  type NewFilesystemCheckpoint,
  filesystemCheckpointTable,
} from "@/lib/persistence/schema/filesystem-checkpoint";
import {
  type Artifact,
  type NewArtifact,
  RUNTIME_ARTIFACT_TYPES,
  type RuntimeArtifactType,
  VISIBILITY_SCOPES,
  type VisibilityScope,
  artifactTable,
} from "@/lib/persistence/schema/runtime-artifact";
import { isValidContentHash } from "@/lib/v11/capability/content-cache";
import { and, asc, desc, eq, isNotNull, lt } from "drizzle-orm";

// ─── 错误类型 ──────────────────────────────────────────────

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactNotFoundError";
  }
}

/** 非空 itemId 二次插入冲突（员工可见 Artifact Item 一对一）。 */
export class ArtifactItemConflictError extends Error {
  public readonly itemId: string;

  constructor(itemId: string) {
    super(`itemId=${itemId} 已被其他 Artifact 占用（一对一约束）`);
    this.name = "ArtifactItemConflictError";
    this.itemId = itemId;
  }
}

export class FileChangeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileChangeValidationError";
  }
}

export class FileChangeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileChangeNotFoundError";
  }
}

export class FilesystemCheckpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesystemCheckpointValidationError";
  }
}

export class FilesystemCheckpointNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesystemCheckpointNotFoundError";
  }
}

// ─── 校验辅助 ──────────────────────────────────────────────

const VALID_RUNTIME_ARTIFACT_TYPES = new Set<string>(RUNTIME_ARTIFACT_TYPES);
const VALID_VISIBILITY_SCOPES = new Set<string>(VISIBILITY_SCOPES);
const VALID_FILE_CHANGE_TYPES = new Set<string>(FILE_CHANGE_TYPES);
const VALID_FILESYSTEM_CHECKPOINT_TYPES = new Set<string>(FILESYSTEM_CHECKPOINT_TYPES);

export function isRuntimeArtifactType(value: string): value is RuntimeArtifactType {
  return VALID_RUNTIME_ARTIFACT_TYPES.has(value);
}

export function isVisibilityScope(value: string): value is VisibilityScope {
  return VALID_VISIBILITY_SCOPES.has(value);
}

export function isFileChangeType(value: string): value is FileChangeType {
  return VALID_FILE_CHANGE_TYPES.has(value);
}

export function isFilesystemCheckpointType(value: string): value is FilesystemCheckpointType {
  return VALID_FILESYSTEM_CHECKPOINT_TYPES.has(value);
}

/**
 * 校验 pathRef 是否为相对路径（不得为绝对路径）。
 *
 * 拒绝：
 * - 以 / 开头（Unix 绝对路径）
 * - 以 C:\ 或其他盘符开头（Windows 绝对路径）
 * - 以 \\ 开头（UNC 路径）
 * - 空字符串
 */
export function isValidPathRef(pathRef: string): boolean {
  if (!pathRef) return false;
  if (pathRef.startsWith("/")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(pathRef)) return false;
  if (pathRef.startsWith("\\")) return false;
  return true;
}

/**
 * 校验受管对象引用（不接受公网 http(s):// URL）。
 *
 * 接受：s3:// / oci:// / gs:// / file://internal/... 等受管协议或自定义 scheme。
 * 拒绝：http:// / https:// 公网 URL。
 */
export function isValidManagedRef(ref: string): boolean {
  if (!ref) return false;
  if (ref.startsWith("http://") || ref.startsWith("https://")) return false;
  return true;
}

/**
 * 计算文件内容 hash（sha256: 前缀 + 64 hex）。
 *
 * 用于 Artifact.contentHash / FileChange.beforeHash/afterHash /
 * FilesystemCheckpoint.contentHash。
 */
export function computeFileHash(content: string | Buffer): string {
  const hash = createHash("sha256");
  if (typeof content === "string") {
    hash.update(content, "utf-8");
  } else {
    hash.update(content);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * 校验 FileChange 的 beforeHash/afterHash 与 changeType 互斥关系。
 *
 * - create：beforeHash=null，afterHash 必填。
 * - delete：beforeHash 必填，afterHash=null。
 * - update/rename/move：beforeHash 与 afterHash 都必填。
 *
 * @throws FileChangeValidationError 互斥关系不满足
 */
export function validateFileChangeHashes(
  changeType: FileChangeType,
  beforeHash: string | null,
  afterHash: string | null,
): void {
  if (beforeHash !== null && !isValidContentHash(beforeHash)) {
    throw new FileChangeValidationError(
      `beforeHash 格式非法（需 sha256: 前缀 + 64 hex）: ${beforeHash}`,
    );
  }
  if (afterHash !== null && !isValidContentHash(afterHash)) {
    throw new FileChangeValidationError(
      `afterHash 格式非法（需 sha256: 前缀 + 64 hex）: ${afterHash}`,
    );
  }
  switch (changeType) {
    case "create":
      if (beforeHash !== null) {
        throw new FileChangeValidationError("changeType=create 时 beforeHash 必须为 null");
      }
      if (afterHash === null) {
        throw new FileChangeValidationError("changeType=create 时 afterHash 必填");
      }
      break;
    case "delete":
      if (beforeHash === null) {
        throw new FileChangeValidationError("changeType=delete 时 beforeHash 必填");
      }
      if (afterHash !== null) {
        throw new FileChangeValidationError("changeType=delete 时 afterHash 必须为 null");
      }
      break;
    case "update":
    case "rename":
    case "move":
      if (beforeHash === null) {
        throw new FileChangeValidationError(`changeType=${changeType} 时 beforeHash 必填`);
      }
      if (afterHash === null) {
        throw new FileChangeValidationError(`changeType=${changeType} 时 afterHash 必填`);
      }
      break;
  }
}

// ─── createArtifact ──────────────────────────────────────

export interface CreateArtifactInput {
  tenantId: string;
  invocationId: string;
  /** 会话产物时填（与 turnId 一起）；Job 产物为 null。 */
  threadId?: string | null;
  /** 会话产物时填；Job 产物为 null。 */
  turnId?: string | null;
  /** Job 产物时填；会话产物为 null。 */
  jobId?: string | null;
  /** 员工可见 Artifact Item id（非空时唯一）。 */
  itemId?: string | null;
  artifactType: RuntimeArtifactType;
  displayName: string;
  contentRef: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
  visibilityScope: VisibilityScope;
  expiresAt?: Date | null;
}

/**
 * 创建 Artifact（运行时产物引用）。
 *
 * 关键校验：
 * - tenantId / invocationId / displayName / contentRef / mediaType / contentHash 必填。
 * - contentHash 必须为 sha256: 前缀 + 64 hex。
 * - contentRef 必须为受管引用（不接受公网 http(s)://）。
 * - 会话产物（threadId/turnId 非空）与 Job 产物（jobId 非空）互斥。
 * - artifactType / visibilityScope 必须为合法枚举值。
 * - byteSize 必须为非负整数。
 * - displayName 长度 ≤ 256；contentRef / mediaType 长度限制。
 *
 * @throws ArtifactValidationError 校验失败
 * @throws ArtifactItemConflictError 非空 itemId 已被占用
 */
export async function createArtifact(input: CreateArtifactInput): Promise<Artifact> {
  if (!input.tenantId) throw new ArtifactValidationError("tenantId 不能为空");
  if (!input.invocationId) throw new ArtifactValidationError("invocationId 不能为空");
  if (!input.displayName) throw new ArtifactValidationError("displayName 不能为空");
  if (input.displayName.length > 256) {
    throw new ArtifactValidationError("displayName 长度不能超过 256");
  }
  if (!input.contentRef) throw new ArtifactValidationError("contentRef 不能为空");
  if (input.contentRef.length > 512) {
    throw new ArtifactValidationError("contentRef 长度不能超过 512");
  }
  if (!isValidManagedRef(input.contentRef)) {
    throw new ArtifactValidationError("contentRef 必须是受管引用，不接受公网 http(s):// URL");
  }
  if (!input.mediaType) throw new ArtifactValidationError("mediaType 不能为空");
  if (input.mediaType.length > 128) {
    throw new ArtifactValidationError("mediaType 长度不能超过 128");
  }
  if (!isValidContentHash(input.contentHash)) {
    throw new ArtifactValidationError(
      `contentHash 必须为 sha256: 前缀 + 64 hex: ${input.contentHash}`,
    );
  }
  if (!isRuntimeArtifactType(input.artifactType)) {
    throw new ArtifactValidationError(`非法 artifactType: ${input.artifactType}`);
  }
  if (!isVisibilityScope(input.visibilityScope)) {
    throw new ArtifactValidationError(`非法 visibilityScope: ${input.visibilityScope}`);
  }
  if (!Number.isInteger(input.byteSize) || input.byteSize < 0) {
    throw new ArtifactValidationError(`byteSize 必须为非负整数: ${input.byteSize}`);
  }

  // 会话产物与 Job 产物互斥校验
  const hasThread = input.threadId !== null && input.threadId !== undefined;
  const hasJob = input.jobId !== null && input.jobId !== undefined;
  if (hasThread && hasJob) {
    throw new ArtifactValidationError("会话产物（threadId）与 Job 产物（jobId）互斥，不可同时填写");
  }

  const row: NewArtifact = {
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    threadId: input.threadId ?? null,
    turnId: input.turnId ?? null,
    jobId: input.jobId ?? null,
    itemId: input.itemId ?? null,
    artifactType: input.artifactType,
    displayName: input.displayName,
    contentRef: input.contentRef,
    mediaType: input.mediaType,
    byteSize: input.byteSize,
    contentHash: input.contentHash,
    visibilityScope: input.visibilityScope,
    expiresAt: input.expiresAt ?? null,
  };

  try {
    await db.insert(artifactTable).values(row);
  } catch (err) {
    if (isDuplicateEntryError(err) && input.itemId) {
      throw new ArtifactItemConflictError(input.itemId);
    }
    throw err;
  }

  const [created] = await db
    .select()
    .from(artifactTable)
    .where(eq(artifactTable.contentHash, input.contentHash))
    .orderBy(desc(artifactTable.createdAt))
    .limit(1);
  if (!created) {
    throw new Error("createArtifact: 行未找到");
  }
  return created;
}

// ─── Artifact 查询 ───────────────────────────────────────

/** 按 id 查询 Artifact（跨租户隔离）。不存在返回 null。 */
export async function getArtifactById(
  tenantId: string,
  artifactId: string,
): Promise<Artifact | null> {
  const [row] = await db
    .select()
    .from(artifactTable)
    .where(and(eq(artifactTable.tenantId, tenantId), eq(artifactTable.id, artifactId)))
    .limit(1);
  return row ?? null;
}

/** 按 itemId 查询 Artifact（一对一反向查询；跨租户隔离）。 */
export async function getArtifactByItemId(
  tenantId: string,
  itemId: string,
): Promise<Artifact | null> {
  const [row] = await db
    .select()
    .from(artifactTable)
    .where(and(eq(artifactTable.tenantId, tenantId), eq(artifactTable.itemId, itemId)))
    .limit(1);
  return row ?? null;
}

/** 列出某 Invocation 的全部 Artifact（按 createdAt 升序）。 */
export async function listArtifactsByInvocation(
  tenantId: string,
  invocationId: string,
): Promise<Artifact[]> {
  return db
    .select()
    .from(artifactTable)
    .where(and(eq(artifactTable.tenantId, tenantId), eq(artifactTable.invocationId, invocationId)))
    .orderBy(asc(artifactTable.createdAt), asc(artifactTable.id));
}

/** 列出某 Thread 的全部 Artifact（按 createdAt 升序）。 */
export async function listArtifactsByThread(
  tenantId: string,
  threadId: string,
): Promise<Artifact[]> {
  return db
    .select()
    .from(artifactTable)
    .where(and(eq(artifactTable.tenantId, tenantId), eq(artifactTable.threadId, threadId)))
    .orderBy(asc(artifactTable.createdAt), asc(artifactTable.id));
}

/** 列出某 Job 的全部 Artifact（按 createdAt 升序）。 */
export async function listArtifactsByJob(tenantId: string, jobId: string): Promise<Artifact[]> {
  return db
    .select()
    .from(artifactTable)
    .where(and(eq(artifactTable.tenantId, tenantId), eq(artifactTable.jobId, jobId)))
    .orderBy(asc(artifactTable.createdAt), asc(artifactTable.id));
}

// ─── createFileChanges ───────────────────────────────────

export interface CreateFileChangeItem {
  pathRef: string;
  changeType: FileChangeType;
  beforeHash?: string | null;
  afterHash?: string | null;
  /** 变更结果被上传为 Artifact 时关联；逻辑外键 → Artifact.id。 */
  artifactId?: string | null;
}

export interface CreateFileChangesInput {
  tenantId: string;
  toolCallId: string;
  workspaceBindingId: string;
  changes: readonly CreateFileChangeItem[];
}

/**
 * 批量创建 FileChange（一条 ToolCall 可产生多个文件变更）。
 *
 * 关键校验：
 * - tenantId / toolCallId / workspaceBindingId 必填。
 * - changes 必须为非空数组。
 * - 每个 pathRef 必须为相对路径（不得为绝对路径）。
 * - beforeHash / afterHash 按 changeType 互斥（见 validateFileChangeHashes）。
 * - 单事务批量插入；任一失败回滚全部。
 *
 * @throws FileChangeValidationError 校验失败
 */
export async function createFileChanges(input: CreateFileChangesInput): Promise<FileChange[]> {
  if (!input.tenantId) throw new FileChangeValidationError("tenantId 不能为空");
  if (!input.toolCallId) throw new FileChangeValidationError("toolCallId 不能为空");
  if (!input.workspaceBindingId) {
    throw new FileChangeValidationError("workspaceBindingId 不能为空");
  }
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new FileChangeValidationError("changes 必须是非空数组");
  }

  const rows: NewFileChange[] = input.changes.map((c) => {
    if (!c.pathRef) throw new FileChangeValidationError("pathRef 不能为空");
    if (c.pathRef.length > 512) {
      throw new FileChangeValidationError("pathRef 长度不能超过 512");
    }
    if (!isValidPathRef(c.pathRef)) {
      throw new FileChangeValidationError(`pathRef 必须为相对路径（不得为绝对路径）: ${c.pathRef}`);
    }
    if (!isFileChangeType(c.changeType)) {
      throw new FileChangeValidationError(`非法 changeType: ${c.changeType}`);
    }
    const beforeHash = c.beforeHash ?? null;
    const afterHash = c.afterHash ?? null;
    validateFileChangeHashes(c.changeType, beforeHash, afterHash);
    return {
      tenantId: input.tenantId,
      toolCallId: input.toolCallId,
      workspaceBindingId: input.workspaceBindingId,
      pathRef: c.pathRef,
      changeType: c.changeType,
      beforeHash,
      afterHash,
      artifactId: c.artifactId ?? null,
    };
  });

  await db.transaction(async (tx) => {
    await tx.insert(fileChangeTable).values(rows);
  });

  // 查询刚创建的行（按 toolCallId 过滤，按 createdAt 升序）
  return db
    .select()
    .from(fileChangeTable)
    .where(
      and(
        eq(fileChangeTable.tenantId, input.tenantId),
        eq(fileChangeTable.toolCallId, input.toolCallId),
      ),
    )
    .orderBy(asc(fileChangeTable.createdAt), asc(fileChangeTable.id));
}

// ─── FileChange 查询 ─────────────────────────────────────

/** 按 id 查询 FileChange（跨租户隔离）。 */
export async function getFileChangeById(
  tenantId: string,
  fileChangeId: string,
): Promise<FileChange | null> {
  const [row] = await db
    .select()
    .from(fileChangeTable)
    .where(and(eq(fileChangeTable.tenantId, tenantId), eq(fileChangeTable.id, fileChangeId)))
    .limit(1);
  return row ?? null;
}

/** 列出某 ToolCall 的全部 FileChange（按 createdAt 升序）。 */
export async function listFileChangesByToolCall(
  tenantId: string,
  toolCallId: string,
): Promise<FileChange[]> {
  return db
    .select()
    .from(fileChangeTable)
    .where(and(eq(fileChangeTable.tenantId, tenantId), eq(fileChangeTable.toolCallId, toolCallId)))
    .orderBy(asc(fileChangeTable.createdAt), asc(fileChangeTable.id));
}

/** 列出某 WorkspaceBinding 的 FileChange（按 createdAt 降序；可限 limit）。 */
export async function listFileChangesByWorkspaceBinding(
  tenantId: string,
  workspaceBindingId: string,
  options?: { limit?: number },
): Promise<FileChange[]> {
  const query = db
    .select()
    .from(fileChangeTable)
    .where(
      and(
        eq(fileChangeTable.tenantId, tenantId),
        eq(fileChangeTable.workspaceBindingId, workspaceBindingId),
      ),
    )
    .orderBy(desc(fileChangeTable.createdAt), desc(fileChangeTable.id));
  if (options?.limit && options.limit > 0) {
    return query.limit(options.limit);
  }
  return query;
}

/** 列出关联到某 Artifact 的 FileChange（按 createdAt 升序）。 */
export async function listFileChangesByArtifact(
  tenantId: string,
  artifactId: string,
): Promise<FileChange[]> {
  return db
    .select()
    .from(fileChangeTable)
    .where(and(eq(fileChangeTable.tenantId, tenantId), eq(fileChangeTable.artifactId, artifactId)))
    .orderBy(asc(fileChangeTable.createdAt), asc(fileChangeTable.id));
}

/**
 * 将 FileChange 关联到已上传的 Artifact。
 *
 * 校验：
 * - FileChange 必须存在且跨租户可见。
 * - FileChange.artifactId 必须为 null（防止重复关联）。
 *
 * @throws FileChangeNotFoundError FileChange 不存在或跨租户
 * @throws FileChangeValidationError 已关联到其他 Artifact
 */
export async function linkFileChangeToArtifact(
  tenantId: string,
  fileChangeId: string,
  artifactId: string,
): Promise<FileChange> {
  const current = await getFileChangeById(tenantId, fileChangeId);
  if (!current) {
    throw new FileChangeNotFoundError(`FileChange 不存在或跨租户不可见: ${fileChangeId}`);
  }
  if (current.artifactId !== null) {
    throw new FileChangeValidationError(
      `FileChange ${fileChangeId} 已关联到 Artifact ${current.artifactId}，不可重复关联`,
    );
  }

  await db
    .update(fileChangeTable)
    .set({ artifactId })
    .where(and(eq(fileChangeTable.tenantId, tenantId), eq(fileChangeTable.id, fileChangeId)));

  const [updated] = await db
    .select()
    .from(fileChangeTable)
    .where(and(eq(fileChangeTable.tenantId, tenantId), eq(fileChangeTable.id, fileChangeId)))
    .limit(1);
  if (!updated) {
    throw new Error("linkFileChangeToArtifact: 行未找到");
  }
  return updated;
}

// ─── createFilesystemCheckpoint ──────────────────────────

export interface CreateFilesystemCheckpointInput {
  tenantId: string;
  workspaceBindingId: string;
  invocationId: string;
  checkpointType: FilesystemCheckpointType;
  checkpointRef: string;
  baseRevisionRef?: string | null;
  contentHash: string;
  expiresAt?: Date | null;
}

/**
 * 创建 FilesystemCheckpoint（文件系统状态恢复点）。
 *
 * 关键校验：
 * - tenantId / workspaceBindingId / invocationId / checkpointRef / contentHash 必填。
 * - contentHash 必须为 sha256: 前缀 + 64 hex。
 * - checkpointRef 必须为受管引用（不接受公网 http(s)://）。
 * - checkpointType 必须为合法枚举值。
 *
 * @throws FilesystemCheckpointValidationError 校验失败
 */
export async function createFilesystemCheckpoint(
  input: CreateFilesystemCheckpointInput,
): Promise<FilesystemCheckpoint> {
  if (!input.tenantId) throw new FilesystemCheckpointValidationError("tenantId 不能为空");
  if (!input.workspaceBindingId) {
    throw new FilesystemCheckpointValidationError("workspaceBindingId 不能为空");
  }
  if (!input.invocationId) {
    throw new FilesystemCheckpointValidationError("invocationId 不能为空");
  }
  if (!input.checkpointRef) {
    throw new FilesystemCheckpointValidationError("checkpointRef 不能为空");
  }
  if (input.checkpointRef.length > 512) {
    throw new FilesystemCheckpointValidationError("checkpointRef 长度不能超过 512");
  }
  if (!isValidManagedRef(input.checkpointRef)) {
    throw new FilesystemCheckpointValidationError(
      "checkpointRef 必须是受管引用，不接受公网 http(s):// URL",
    );
  }
  if (!isValidContentHash(input.contentHash)) {
    throw new FilesystemCheckpointValidationError(
      `contentHash 必须为 sha256: 前缀 + 64 hex: ${input.contentHash}`,
    );
  }
  if (!isFilesystemCheckpointType(input.checkpointType)) {
    throw new FilesystemCheckpointValidationError(`非法 checkpointType: ${input.checkpointType}`);
  }
  if (input.baseRevisionRef !== null && input.baseRevisionRef !== undefined) {
    if (input.baseRevisionRef.length > 512) {
      throw new FilesystemCheckpointValidationError("baseRevisionRef 长度不能超过 512");
    }
  }

  const row: NewFilesystemCheckpoint = {
    tenantId: input.tenantId,
    workspaceBindingId: input.workspaceBindingId,
    invocationId: input.invocationId,
    checkpointType: input.checkpointType,
    checkpointRef: input.checkpointRef,
    baseRevisionRef: input.baseRevisionRef ?? null,
    contentHash: input.contentHash,
    expiresAt: input.expiresAt ?? null,
  };

  await db.insert(filesystemCheckpointTable).values(row);

  const [created] = await db
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, input.tenantId),
        eq(filesystemCheckpointTable.workspaceBindingId, input.workspaceBindingId),
        eq(filesystemCheckpointTable.invocationId, input.invocationId),
      ),
    )
    .orderBy(desc(filesystemCheckpointTable.createdAt))
    .limit(1);
  if (!created) {
    throw new Error("createFilesystemCheckpoint: 行未找到");
  }
  return created;
}

// ─── FilesystemCheckpoint 查询 ───────────────────────────

/** 按 id 查询 FilesystemCheckpoint（跨租户隔离）。 */
export async function getFilesystemCheckpointById(
  tenantId: string,
  checkpointId: string,
): Promise<FilesystemCheckpoint | null> {
  const [row] = await db
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, tenantId),
        eq(filesystemCheckpointTable.id, checkpointId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 列出某 Invocation 的全部 FilesystemCheckpoint（按 createdAt 降序）。 */
export async function listFilesystemCheckpointsByInvocation(
  tenantId: string,
  invocationId: string,
): Promise<FilesystemCheckpoint[]> {
  return db
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, tenantId),
        eq(filesystemCheckpointTable.invocationId, invocationId),
      ),
    )
    .orderBy(desc(filesystemCheckpointTable.createdAt), desc(filesystemCheckpointTable.id));
}

/** 列出某 WorkspaceBinding 的 FilesystemCheckpoint（按 createdAt 降序）。 */
export async function listFilesystemCheckpointsByWorkspaceBinding(
  tenantId: string,
  workspaceBindingId: string,
): Promise<FilesystemCheckpoint[]> {
  return db
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, tenantId),
        eq(filesystemCheckpointTable.workspaceBindingId, workspaceBindingId),
      ),
    )
    .orderBy(desc(filesystemCheckpointTable.createdAt), desc(filesystemCheckpointTable.id));
}

/** 获取某 WorkspaceBinding 的最近一条 FilesystemCheckpoint（按 createdAt 降序取首条）。 */
export async function getLatestFilesystemCheckpoint(
  tenantId: string,
  workspaceBindingId: string,
): Promise<FilesystemCheckpoint | null> {
  const [row] = await db
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, tenantId),
        eq(filesystemCheckpointTable.workspaceBindingId, workspaceBindingId),
      ),
    )
    .orderBy(desc(filesystemCheckpointTable.createdAt), desc(filesystemCheckpointTable.id))
    .limit(1);
  return row ?? null;
}

/** 列出已过期的 FilesystemCheckpoint（expiresAt IS NOT NULL AND expiresAt < now；用于清理任务）。 */
export async function listExpiredFilesystemCheckpoints(
  tenantId: string,
  now: Date = new Date(),
): Promise<FilesystemCheckpoint[]> {
  return db
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, tenantId),
        isNotNull(filesystemCheckpointTable.expiresAt),
        lt(filesystemCheckpointTable.expiresAt, now),
      ),
    );
}

// ─── 辅助：DuplicateEntry 检测 ───────────────────────────

/** MySQL ER_DUP_ENTRY 错误检测（用于 UNIQUE 冲突区分）。 */
function isDuplicateEntryError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; errno?: number };
  return e.code === "ER_DUP_ENTRY" || e.errno === 1062;
}
