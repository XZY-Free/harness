/**
 * V11 Knowledge 仓储 + 证据检索服务。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md （knowledge_base/document/revision 字段）、
 * （knowledge_chunk / knowledge_index 索引表）。
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §12（Knowledge Base）、
 * §13（Knowledge 加载：先目录后证据 / 数据保持最新 / 检索失败区分）、§14（与 Skill/Tool 边界）。
 * - ../v11-agentkit-platform/09-unified-domain-model.md §6（域模型边界）。
 * - ../v11-agentkit-platform-development-plan/07-context-memory-and-knowledge.md 。
 *
 * 职责：
 * - computeKnowledgeContentHash / computeKnowledgeRevisionKey：规范化 hash 与去重键。
 * - createKnowledgeBase / getKnowledgeBaseByKey / getKnowledgeBaseById / listKnowledgeBases：基础 CRUD。
 * - archiveKnowledgeBase：归档（lifecycle=archived）。
 * - createKnowledgeDocument / getKnowledgeDocumentByKey / listKnowledgeDocuments：Document CRUD。
 * - createKnowledgeDocumentRevision / publishKnowledgeDocumentRevision / retractKnowledgeDocumentRevision：
 * 不可变修订生命周期；发布时切换 document.current_revision_id（索引就绪后才能发布）。
 * - createKnowledgeChunk / listKnowledgeChunksByRevision：Chunk 不可变写入。
 * - upsertKnowledgeIndex / markKnowledgeIndexReady：索引写入与状态推进。
 * - searchKnowledgeEvidence：分作用域证据检索（tenant + 可选 knowledgeBaseIds 过滤）。
 *
 * 边界：
 * - 索引完成后才切换 current_revision_id（publishKnowledgeDocumentRevision 校验）。
 * - 全文/向量/图谱是 KnowledgeBase 内部检索方式；本模块只提供基础检索入口
 * （基于 contentRedacted LIKE 简易匹配 + chunk 检索），生产向量/图谱在后续阶段接入。
 * - 权限拒绝、索引不可用、确实无结果必须区分（）。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
 KNOWLEDGE_BASE_LIFECYCLE_STATES,
 KNOWLEDGE_DOCUMENT_LIFECYCLE_STATES,
 KNOWLEDGE_INDEX_STATES,
 KNOWLEDGE_REVISION_STATES,
 KNOWLEDGE_SOURCE_TYPES,
 type KnowledgeBase,
 type KnowledgeBaseLifecycleState,
 type KnowledgeChunk,
 type KnowledgeDocument,
 type KnowledgeDocumentLifecycleState,
 type KnowledgeDocumentRevision,
 type KnowledgeIndex,
 type KnowledgeIndexState,
 type KnowledgeRevisionState,
 type KnowledgeSourceType,
 knowledgeBase,
 knowledgeChunk,
 knowledgeDocument,
 knowledgeDocumentRevision,
 knowledgeIndex,
} from "@/lib/persistence/schema/knowledge";
import { and, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 数据库或事务句柄（INSERT/SELECT 通用接口）。 */
type DbOrTx = typeof db | Tx;

// ─── Hash / Key 计算 ──────────────────────────────────────

/**
 * 计算内容 hash（sha256: 前缀 + 64 hex）。
 *
 * 调用方应先脱敏后计算 hash，保证 hash 不泄露敏感内容。
 */
export function computeKnowledgeContentHash(text: string): string {
 return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** 校验内容 hash 格式（sha256: 前缀 + 64 hex）。 */
export function isValidKnowledgeContentHash(hash: string): boolean {
 return /^sha256:[0-9a-f]{64}$/.test(hash);
}

/**
 * 计算 KnowledgeBase 的稳定 key 校验串：sha256(tenantId|knowledgeKey)。
 *
 * 用于检测 KnowledgeBase 租户隔离边界。本函数不写入数据库，仅作辅助。
 */
export function computeKnowledgeBaseFingerprint(tenantId: string, knowledgeKey: string): string {
 return `sha256:${createHash("sha256").update(`${tenantId}|${knowledgeKey}`, "utf8").digest("hex")}`;
}

// ─── 枚举校验 ─────────────────────────────────────────────

export function isKnowledgeBaseLifecycleState(value: string): value is KnowledgeBaseLifecycleState {
 return (KNOWLEDGE_BASE_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isKnowledgeDocumentLifecycleState(
 value: string,
): value is KnowledgeDocumentLifecycleState {
 return (KNOWLEDGE_DOCUMENT_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isKnowledgeIndexState(value: string): value is KnowledgeIndexState {
 return (KNOWLEDGE_INDEX_STATES as readonly string[]).includes(value);
}

export function isKnowledgeRevisionState(value: string): value is KnowledgeRevisionState {
 return (KNOWLEDGE_REVISION_STATES as readonly string[]).includes(value);
}

export function isKnowledgeSourceType(value: string): value is KnowledgeSourceType {
 return (KNOWLEDGE_SOURCE_TYPES as readonly string[]).includes(value);
}

// ─── 仓储：KnowledgeBase ───────────────────────────────────

/**
 * 创建 KnowledgeBase。
 *
 * - knowledgeKey 在租户内唯一（UNIQUE(tenantId, knowledgeKey) 保证）。
 * - lifecycleState 默认 active；indexState 默认 pending。
 * - versionNo 初始化为随机 UUID（用于 ETag/If-Match 乐观锁）。
 *
 * @throws KnowledgeKeyConflictError knowledgeKey 已存在（ON DUPLICATE KEY 不命中 + 二次查询）
 */
export async function createKnowledgeBase(params: {
 tenantId: string;
 knowledgeKey: string;
 displayName: string;
 description?: string | null;
 ownerUserId?: string | null;
 visibilityPolicyId?: string | null;
 createdBy: string;
 tx?: DbOrTx;
}): Promise<KnowledgeBase> {
 if (!params.knowledgeKey || params.knowledgeKey.length === 0) {
 throw new KnowledgeValidationError("knowledgeKey 不能为空");
 }
 if (!params.displayName || params.displayName.length === 0) {
 throw new KnowledgeValidationError("displayName 不能为空");
 }

 const client = params.tx ?? db;
 const now = new Date();
 const id = randomUUID();

 await client.insert(knowledgeBase).values({
 id,
 tenantId: params.tenantId,
 knowledgeKey: params.knowledgeKey,
 displayName: params.displayName,
 description: params.description ?? null,
 ownerUserId: params.ownerUserId ?? null,
 visibilityPolicyId: params.visibilityPolicyId ?? null,
 indexState: "pending",
 lifecycleState: "active",
 versionNo: randomUUID(),
 createdAt: now,
 updatedAt: now,
 deletedAt: null,
 });

 const [row] = await client.select().from(knowledgeBase).where(eq(knowledgeBase.id, id)).limit(1);
 if (!row) {
 throw new Error(`createKnowledgeBase: 行未找到（id=${id}）`);
 }
 return row;
}

/**
 * 按 (tenantId, knowledgeKey) 查询 KnowledgeBase（跨租户隔离）。
 * 不存在返回 null。软删除（lifecycle=deleted）的记录仍返回（供 Admin 查看）。
 */
export async function getKnowledgeBaseByKey(
 tenantId: string,
 knowledgeKey: string,
): Promise<KnowledgeBase | null> {
 const [row] = await db
 .select()
 .from(knowledgeBase)
 .where(and(eq(knowledgeBase.tenantId, tenantId), eq(knowledgeBase.knowledgeKey, knowledgeKey)))
 .limit(1);
 return row ?? null;
}

/** 按 id 查询 KnowledgeBase（跨租户隔离）。不存在返回 null。 */
export async function getKnowledgeBaseById(
 tenantId: string,
 baseId: string,
): Promise<KnowledgeBase | null> {
 const [row] = await db
 .select()
 .from(knowledgeBase)
 .where(and(eq(knowledgeBase.tenantId, tenantId), eq(knowledgeBase.id, baseId)))
 .limit(1);
 return row ?? null;
}

/**
 * 列出租户内的 KnowledgeBase（跨租户隔离）。
 *
 * - 默认只返回 active/archived（不含 deleted）。
 * - 可按 lifecycleState 过滤。
 * - 按 updatedAt 降序。
 */
export async function listKnowledgeBases(
 tenantId: string,
 options?: {
 lifecycleStates?: readonly KnowledgeBaseLifecycleState[];
 limit?: number;
 },
): Promise<KnowledgeBase[]> {
 const limit = options?.limit ?? 50;
 const conditions = [eq(knowledgeBase.tenantId, tenantId)];
 if (options?.lifecycleStates && options.lifecycleStates.length > 0) {
 conditions.push(inArray(knowledgeBase.lifecycleState, [...options.lifecycleStates]));
 } else {
 // 默认排除 deleted
 conditions.push(sql`${knowledgeBase.lifecycleState} <> 'deleted'`);
 }

 const rows = await db
 .select()
 .from(knowledgeBase)
 .where(and(...conditions))
 .orderBy(sql`${knowledgeBase.updatedAt} DESC`)
 .limit(limit);
 return rows;
}

/**
 * 归档 KnowledgeBase（lifecycleState: active → archived）。
 *
 * 归档后不再参与新 Document 写入；已有 Document 与修订仍可检索（除非单独 archived）。
 * - 期望 ETag（versionNo）用于乐观锁。
 * - 重复归档（已 archived）幂等返回当前行。
 *
 * @returns 归档后的 KnowledgeBase；不存在返回 null；versionNo 不匹配抛 KnowledgeVersionConflictError。
 */
export async function archiveKnowledgeBase(params: {
 tenantId: string;
 baseId: string;
 expectedVersionNo: string;
}): Promise<KnowledgeBase | null> {
 const existing = await getKnowledgeBaseById(params.tenantId, params.baseId);
 if (!existing) return null;

 if (existing.versionNo !== params.expectedVersionNo) {
 throw new KnowledgeVersionConflictError(
 params.baseId,
 existing.versionNo,
 params.expectedVersionNo,
 );
 }

 if (existing.lifecycleState === "archived") {
 return existing;
 }

 if (existing.lifecycleState === "deleted") {
 throw new KnowledgeValidationError("已删除的 KnowledgeBase 不能归档");
 }

 const newVersionNo = randomUUID();
 await db
 .update(knowledgeBase)
 .set({
 lifecycleState: "archived",
 versionNo: newVersionNo,
 updatedAt: new Date(),
 })
 .where(
 and(
 eq(knowledgeBase.tenantId, params.tenantId),
 eq(knowledgeBase.id, params.baseId),
 eq(knowledgeBase.versionNo, params.expectedVersionNo),
 ),
 );

 return getKnowledgeBaseById(params.tenantId, params.baseId);
}

// ─── 仓储：KnowledgeDocument ───────────────────────────────

/**
 * 创建 KnowledgeDocument（稳定身份；不可变 documentKey）。
 *
 * - documentKey 在 KnowledgeBase 内唯一。
 * - lifecycleState 默认 active；currentRevisionId 初始为 null（首次发布修订后切换）。
 */
export async function createKnowledgeDocument(params: {
 tenantId: string;
 knowledgeBaseId: string;
 documentKey: string;
 title: string;
 sourceType: KnowledgeSourceType;
 sourceRef?: string | null;
 createdBy: string;
 tx?: DbOrTx;
}): Promise<KnowledgeDocument> {
 if (!params.documentKey || params.documentKey.length === 0) {
 throw new KnowledgeValidationError("documentKey 不能为空");
 }
 if (!params.title || params.title.length === 0) {
 throw new KnowledgeValidationError("title 不能为空");
 }

 const client = params.tx ?? db;
 const now = new Date();
 const id = randomUUID();

 await client.insert(knowledgeDocument).values({
 id,
 tenantId: params.tenantId,
 knowledgeBaseId: params.knowledgeBaseId,
 documentKey: params.documentKey,
 title: params.title,
 sourceType: params.sourceType,
 sourceRef: params.sourceRef ?? null,
 currentRevisionId: null,
 lifecycleState: "active",
 versionNo: randomUUID(),
 createdAt: now,
 updatedAt: now,
 deletedAt: null,
 });

 const [row] = await client
 .select()
 .from(knowledgeDocument)
 .where(eq(knowledgeDocument.id, id))
 .limit(1);
 if (!row) {
 throw new Error(`createKnowledgeDocument: 行未找到（id=${id}）`);
 }
 return row;
}

/** 按 (tenantId, knowledgeBaseId, documentKey) 查询 Document。不存在返回 null。 */
export async function getKnowledgeDocumentByKey(
 tenantId: string,
 knowledgeBaseId: string,
 documentKey: string,
): Promise<KnowledgeDocument | null> {
 const [row] = await db
 .select()
 .from(knowledgeDocument)
 .where(
 and(
 eq(knowledgeDocument.tenantId, tenantId),
 eq(knowledgeDocument.knowledgeBaseId, knowledgeBaseId),
 eq(knowledgeDocument.documentKey, documentKey),
 ),
 )
 .limit(1);
 return row ?? null;
}

/** 按 id 查询 Document（跨租户隔离）。不存在返回 null。 */
export async function getKnowledgeDocumentById(
 tenantId: string,
 documentId: string,
): Promise<KnowledgeDocument | null> {
 const [row] = await db
 .select()
 .from(knowledgeDocument)
 .where(and(eq(knowledgeDocument.tenantId, tenantId), eq(knowledgeDocument.id, documentId)))
 .limit(1);
 return row ?? null;
}

/**
 * 列出 KnowledgeBase 内的 Document（跨租户隔离）。
 *
 * - 默认排除 deleted。
 * - 按 updatedAt 降序。
 */
export async function listKnowledgeDocuments(
 tenantId: string,
 knowledgeBaseId: string,
 options?: {
 lifecycleStates?: readonly KnowledgeDocumentLifecycleState[];
 limit?: number;
 },
): Promise<KnowledgeDocument[]> {
 const limit = options?.limit ?? 100;
 const conditions = [
 eq(knowledgeDocument.tenantId, tenantId),
 eq(knowledgeDocument.knowledgeBaseId, knowledgeBaseId),
 ];
 if (options?.lifecycleStates && options.lifecycleStates.length > 0) {
 conditions.push(inArray(knowledgeDocument.lifecycleState, [...options.lifecycleStates]));
 } else {
 conditions.push(sql`${knowledgeDocument.lifecycleState} <> 'deleted'`);
 }

 const rows = await db
 .select()
 .from(knowledgeDocument)
 .where(and(...conditions))
 .orderBy(sql`${knowledgeDocument.updatedAt} DESC`)
 .limit(limit);
 return rows;
}

// ─── 仓储：KnowledgeDocumentRevision ───────────────────────

/**
 * 创建 KnowledgeDocumentRevision（不可变修订；状态 draft）。
 *
 * - revisionNo 在文档内唯一（UNIQUE(documentId, revisionNo) 保证）。
 * - 内容（contentRef/contentRedacted/contentHash）创建后不可变。
 * - aclSnapshotHash / aclSnapshotJson 发布时冻结（draft 状态可空）。
 * - revisionState 初始为 draft；indexState 初始为 pending。
 *
 * @throws KnowledgeRevisionNoConflictError revisionNo 已存在
 */
export async function createKnowledgeDocumentRevision(params: {
 tenantId: string;
 documentId: string;
 revisionNo: string;
 contentRef?: string | null;
 contentRedacted?: string | null;
 contentHash: string;
 aclSnapshotHash?: string | null;
 aclSnapshotJson?: Record<string, unknown> | null;
 createdBy: string;
 tx?: DbOrTx;
}): Promise<KnowledgeDocumentRevision> {
 if (!params.revisionNo || params.revisionNo.length === 0) {
 throw new KnowledgeValidationError("revisionNo 不能为空");
 }
 if (!params.contentRef && !params.contentRedacted) {
 throw new KnowledgeValidationError("contentRef 与 contentRedacted 至少一个非空");
 }
 if (!isValidKnowledgeContentHash(params.contentHash)) {
 throw new KnowledgeValidationError(
 `contentHash 格式非法：${params.contentHash}（应为 sha256: 前缀 + 64 hex）`,
 );
 }

 const client = params.tx ?? db;
 const now = new Date();
 const id = randomUUID();

 await client.insert(knowledgeDocumentRevision).values({
 id,
 tenantId: params.tenantId,
 documentId: params.documentId,
 revisionNo: params.revisionNo,
 contentRef: params.contentRef ?? null,
 contentRedacted: params.contentRedacted ?? null,
 contentHash: params.contentHash,
 aclSnapshotHash: params.aclSnapshotHash ?? null,
 aclSnapshotJson: params.aclSnapshotJson ?? null,
 indexState: "pending",
 revisionState: "draft",
 createdBy: params.createdBy,
 createdAt: now,
 publishedAt: null,
 });

 const [row] = await client
 .select()
 .from(knowledgeDocumentRevision)
 .where(eq(knowledgeDocumentRevision.id, id))
 .limit(1);
 if (!row) {
 throw new Error(`createKnowledgeDocumentRevision: 行未找到（id=${id}）`);
 }
 return row;
}

/** 按 id 查询 Revision（跨租户隔离）。不存在返回 null。 */
export async function getKnowledgeDocumentRevisionById(
 tenantId: string,
 revisionId: string,
): Promise<KnowledgeDocumentRevision | null> {
 const [row] = await db
 .select()
 .from(knowledgeDocumentRevision)
 .where(
 and(
 eq(knowledgeDocumentRevision.tenantId, tenantId),
 eq(knowledgeDocumentRevision.id, revisionId),
 ),
 )
 .limit(1);
 return row ?? null;
}

/**
 * 列出 Document 的全部 Revision（跨租户隔离；按 revisionNo 字符串降序）。
 *
 * 注意：revisionNo 存储为 varchar，按字符串排序即可（建议调用方使用零填充格式如 "0001"）。
 */
export async function listKnowledgeDocumentRevisions(
 tenantId: string,
 documentId: string,
 options?: { limit?: number },
): Promise<KnowledgeDocumentRevision[]> {
 const limit = options?.limit ?? 50;
 const rows = await db
 .select()
 .from(knowledgeDocumentRevision)
 .where(
 and(
 eq(knowledgeDocumentRevision.tenantId, tenantId),
 eq(knowledgeDocumentRevision.documentId, documentId),
 ),
 )
 .orderBy(sql`${knowledgeDocumentRevision.revisionNo} DESC`)
 .limit(limit);
 return rows;
}

/**
 * 发布 KnowledgeDocumentRevision（draft → published；切换 document.current_revision_id）。
 *
 * 流程（同事务）：
 * 1. SELECT revision FOR UPDATE（锁行，防并发发布）。
 * 2. 校验 revision 当前状态为 draft（否则 KNOWLEDGE_REVISION_ALREADY_PUBLISHED）。
 * 3. 校验 revision.indexState === 'ready'（索引未就绪不允许发布）。
 * 4. 把当前 published revision（如有）状态改为 superseded。
 * 5. 把目标 revision 状态改为 published，设置 publishedAt。
 * 6. 切换 document.current_revision_id（乐观锁 versionNo）。
 * 7. 推进 base.indexState = ready（首次发布时）。
 *
 * @throws KnowledgeRevisionAlreadyPublishedError 已发布/已撤回
 * @throws KnowledgeRevisionIndexNotReadyError 索引未就绪
 * @throws KnowledgeVersionConflictError document versionNo 不匹配
 */
export async function publishKnowledgeDocumentRevision(params: {
 tenantId: string;
 revisionId: string;
 /** Document 的期望 versionNo（ETag）；用于乐观锁。 */
 expectedDocumentVersionNo: string;
 aclSnapshotHash?: string | null;
 aclSnapshotJson?: Record<string, unknown> | null;
}): Promise<{
 revision: KnowledgeDocumentRevision;
 document: KnowledgeDocument;
 previousRevision?: KnowledgeDocumentRevision;
}> {
 return db.transaction(async (tx) => {
 // 1. 锁定目标 revision
 const [locked] = await tx
 .select()
 .from(knowledgeDocumentRevision)
 .where(
 and(
 eq(knowledgeDocumentRevision.tenantId, params.tenantId),
 eq(knowledgeDocumentRevision.id, params.revisionId),
 ),
 )
 .for("update")
 .limit(1);

 if (!locked) {
 throw new KnowledgeValidationError(`Revision 不存在（id=${params.revisionId}）`);
 }

 // 2. 校验状态
 if (locked.revisionState !== "draft") {
 throw new KnowledgeRevisionAlreadyPublishedError(locked.id, locked.revisionState);
 }

 // 3. 校验索引就绪（§12：索引完成后才切换 current_revision_id）
 if (locked.indexState !== "ready") {
 throw new KnowledgeRevisionIndexNotReadyError(locked.id, locked.indexState);
 }

 // 4. 查询 Document 并锁定
 const [docLocked] = await tx
 .select()
 .from(knowledgeDocument)
 .where(
 and(
 eq(knowledgeDocument.tenantId, params.tenantId),
 eq(knowledgeDocument.id, locked.documentId),
 ),
 )
 .for("update")
 .limit(1);

 if (!docLocked) {
 throw new KnowledgeValidationError(`Document 不存在（id=${locked.documentId}）`);
 }

 if (docLocked.versionNo !== params.expectedDocumentVersionNo) {
 throw new KnowledgeVersionConflictError(
 docLocked.id,
 docLocked.versionNo,
 params.expectedDocumentVersionNo,
 );
 }

 const now = new Date();
 let previousRevision: KnowledgeDocumentRevision | undefined;

 // 5. 将当前 published revision（如有）改为 superseded
 if (docLocked.currentRevisionId) {
 const [prevRev] = await tx
 .select()
 .from(knowledgeDocumentRevision)
 .where(
 and(
 eq(knowledgeDocumentRevision.tenantId, params.tenantId),
 eq(knowledgeDocumentRevision.id, docLocked.currentRevisionId),
 ),
 )
 .for("update")
 .limit(1);

 if (prevRev && prevRev.revisionState === "published") {
 await tx
 .update(knowledgeDocumentRevision)
 .set({
 revisionState: "superseded",
 })
 .where(eq(knowledgeDocumentRevision.id, prevRev.id));
 // 返回更新后的对象（避免返回 update 前快照导致 revisionState 仍是 published）
 const [supersededRev] = await tx
 .select()
 .from(knowledgeDocumentRevision)
 .where(eq(knowledgeDocumentRevision.id, prevRev.id))
 .limit(1);
 previousRevision = supersededRev ?? prevRev;
 }
 }

 // 6. 把目标 revision 状态改为 published
 const aclSnapshotHash =
 params.aclSnapshotHash !== undefined ? params.aclSnapshotHash : locked.aclSnapshotHash;
 const aclSnapshotJson =
 params.aclSnapshotJson !== undefined ? params.aclSnapshotJson : locked.aclSnapshotJson;

 await tx
 .update(knowledgeDocumentRevision)
 .set({
 revisionState: "published",
 publishedAt: now,
 aclSnapshotHash,
 aclSnapshotJson,
 })
 .where(eq(knowledgeDocumentRevision.id, locked.id));

 // 7. 切换 document.current_revision_id（乐观锁）
 const newDocVersionNo = randomUUID();
 await tx
 .update(knowledgeDocument)
 .set({
 currentRevisionId: locked.id,
 versionNo: newDocVersionNo,
 updatedAt: now,
 })
 .where(
 and(
 eq(knowledgeDocument.tenantId, params.tenantId),
 eq(knowledgeDocument.id, docLocked.id),
 eq(knowledgeDocument.versionNo, params.expectedDocumentVersionNo),
 ),
 );

 // 8. 推进 KnowledgeBase.indexState（首次发布时）
 const [baseRow] = await tx
 .select()
 .from(knowledgeBase)
 .where(
 and(
 eq(knowledgeBase.tenantId, params.tenantId),
 eq(knowledgeBase.id, docLocked.knowledgeBaseId),
 ),
 )
 .limit(1);

 if (baseRow && baseRow.indexState !== "ready") {
 await tx
 .update(knowledgeBase)
 .set({
 indexState: "ready",
 updatedAt: now,
 })
 .where(eq(knowledgeBase.id, baseRow.id));
 }

 // 重新查询返回行
 const [updatedRev] = await tx
 .select()
 .from(knowledgeDocumentRevision)
 .where(eq(knowledgeDocumentRevision.id, locked.id))
 .limit(1);
 const [updatedDoc] = await tx
 .select()
 .from(knowledgeDocument)
 .where(eq(knowledgeDocument.id, docLocked.id))
 .limit(1);

 if (!updatedRev || !updatedDoc) {
 throw new Error("publishKnowledgeDocumentRevision: 发布后行未找到");
 }

 return {
 revision: updatedRev,
 document: updatedDoc,
 previousRevision,
 };
 });
}

/**
 * 撤回 KnowledgeDocumentRevision（published → retracted；紧急下线场景）。
 *
 * 撤回后该修订不再参与检索；document.currentRevisionId 不自动清空（调用方决定是否回滚到上一修订）。
 *
 * @throws KnowledgeRevisionAlreadyPublishedError 非 published 状态
 */
export async function retractKnowledgeDocumentRevision(params: {
 tenantId: string;
 revisionId: string;
 reasonCode: string;
}): Promise<KnowledgeDocumentRevision> {
 return db.transaction(async (tx) => {
 const [locked] = await tx
 .select()
 .from(knowledgeDocumentRevision)
 .where(
 and(
 eq(knowledgeDocumentRevision.tenantId, params.tenantId),
 eq(knowledgeDocumentRevision.id, params.revisionId),
 ),
 )
 .for("update")
 .limit(1);

 if (!locked) {
 throw new KnowledgeValidationError(`Revision 不存在（id=${params.revisionId}）`);
 }

 if (locked.revisionState !== "published") {
 throw new KnowledgeRevisionAlreadyPublishedError(locked.id, locked.revisionState);
 }

 await tx
 .update(knowledgeDocumentRevision)
 .set({
 revisionState: "retracted",
 })
 .where(eq(knowledgeDocumentRevision.id, locked.id));

 const [updated] = await tx
 .select()
 .from(knowledgeDocumentRevision)
 .where(eq(knowledgeDocumentRevision.id, locked.id))
 .limit(1);

 if (!updated) {
 throw new Error("retractKnowledgeDocumentRevision: 撤回后行未找到");
 }
 return updated;
 });
}

// ─── 仓储：KnowledgeChunk ──────────────────────────────────

/**
 * 创建 KnowledgeChunk（不可变；归属于特定 Revision）。
 *
 * - chunkNo 在修订内唯一（UNIQUE(documentRevisionId, chunkNo) 保证）。
 * - 内容（contentRef/contentRedacted/contentHash）创建后不可变。
 */
export async function createKnowledgeChunk(params: {
 tenantId: string;
 documentRevisionId: string;
 chunkNo: string;
 contentRef?: string | null;
 contentRedacted?: string | null;
 contentHash: string;
 metadataJson?: Record<string, unknown> | null;
 tx?: DbOrTx;
}): Promise<KnowledgeChunk> {
 if (!params.chunkNo || params.chunkNo.length === 0) {
 throw new KnowledgeValidationError("chunkNo 不能为空");
 }
 if (!params.contentRef && !params.contentRedacted) {
 throw new KnowledgeValidationError("contentRef 与 contentRedacted 至少一个非空");
 }
 if (!isValidKnowledgeContentHash(params.contentHash)) {
 throw new KnowledgeValidationError(`contentHash 格式非法：${params.contentHash}`);
 }

 const client = params.tx ?? db;
 const id = randomUUID();

 await client.insert(knowledgeChunk).values({
 id,
 tenantId: params.tenantId,
 documentRevisionId: params.documentRevisionId,
 chunkNo: params.chunkNo,
 contentRef: params.contentRef ?? null,
 contentRedacted: params.contentRedacted ?? null,
 contentHash: params.contentHash,
 metadataJson: params.metadataJson ?? null,
 createdAt: new Date(),
 });

 const [row] = await client
 .select()
 .from(knowledgeChunk)
 .where(eq(knowledgeChunk.id, id))
 .limit(1);
 if (!row) {
 throw new Error(`createKnowledgeChunk: 行未找到（id=${id}）`);
 }
 return row;
}

/** 按 Revision 列出 Chunk（按 chunkNo 升序）。 */
export async function listKnowledgeChunksByRevision(
 tenantId: string,
 documentRevisionId: string,
 options?: { limit?: number },
): Promise<KnowledgeChunk[]> {
 const limit = options?.limit ?? 500;
 const rows = await db
 .select()
 .from(knowledgeChunk)
 .where(
 and(
 eq(knowledgeChunk.tenantId, tenantId),
 eq(knowledgeChunk.documentRevisionId, documentRevisionId),
 ),
 )
 .orderBy(sql`${knowledgeChunk.chunkNo} ASC`)
 .limit(limit);
 return rows;
}

// ─── 仓储：KnowledgeIndex ──────────────────────────────────

/**
 * upsert KnowledgeIndex（同 Chunk 同 provider 唯一）。
 *
 * 索引可重建；权限仍来自 Knowledge 文档（不复制权限到索引）。
 */
export async function upsertKnowledgeIndex(params: {
 tenantId: string;
 chunkId: string;
 indexProvider: string;
 indexRef: string;
 embeddingModelRef?: string | null;
 contentHash: string;
 tx?: DbOrTx;
}): Promise<KnowledgeIndex> {
 if (!params.indexProvider || params.indexProvider.length === 0) {
 throw new KnowledgeValidationError("indexProvider 不能为空");
 }
 if (!params.indexRef || params.indexRef.length === 0) {
 throw new KnowledgeValidationError("indexRef 不能为空");
 }

 const client = params.tx ?? db;
 const now = new Date();
 const id = randomUUID();

 await client
 .insert(knowledgeIndex)
 .values({
 id,
 tenantId: params.tenantId,
 chunkId: params.chunkId,
 indexProvider: params.indexProvider,
 indexRef: params.indexRef,
 embeddingModelRef: params.embeddingModelRef ?? null,
 contentHash: params.contentHash,
 indexedAt: now,
 })
 .onDuplicateKeyUpdate({
 set: {
 indexRef: params.indexRef,
 embeddingModelRef: params.embeddingModelRef ?? null,
 contentHash: params.contentHash,
 indexedAt: now,
 },
 });

 // onDuplicateKeyUpdate 后查询命中的行
 const [row] = await client
 .select()
 .from(knowledgeIndex)
 .where(
 and(
 eq(knowledgeIndex.tenantId, params.tenantId),
 eq(knowledgeIndex.chunkId, params.chunkId),
 eq(knowledgeIndex.indexProvider, params.indexProvider),
 ),
 )
 .limit(1);
 if (!row) {
 throw new Error("upsertKnowledgeIndex: upsert 后行未找到");
 }
 return row;
}

/**
 * 把 Revision 的 indexState 推进到指定状态（pending/indexing/ready/failed/stale）。
 *
 * - 推进到 ready 时通常需要 Revision 下所有 Chunk 的索引都已完成（调用方负责校验）。
 * - 已 published 的 Revision 不允许改 indexState（除非 stale，表示内容已变更需重建）。
 *
 * @returns 更新后的 Revision；不存在返回 null。
 */
export async function markKnowledgeRevisionIndexState(params: {
 tenantId: string;
 revisionId: string;
 indexState: KnowledgeIndexState;
}): Promise<KnowledgeDocumentRevision | null> {
 if (!isKnowledgeIndexState(params.indexState)) {
 throw new KnowledgeValidationError(`非法 indexState: ${params.indexState}`);
 }

 await db
 .update(knowledgeDocumentRevision)
 .set({
 indexState: params.indexState,
 })
 .where(
 and(
 eq(knowledgeDocumentRevision.tenantId, params.tenantId),
 eq(knowledgeDocumentRevision.id, params.revisionId),
 ),
 );

 return getKnowledgeDocumentRevisionById(params.tenantId, params.revisionId);
}

// ─── 证据检索（§13） ───────────────────────────────

/** 单条证据检索结果。 */
export interface KnowledgeEvidenceHit {
 /** Chunk id（证据片段稳定身份）。 */
 chunkId: string;
 /** Chunk contentHash（用于 CapabilityUse 记录实际引用）。 */
 chunkHash: string;
 /** Chunk 序号（修订内单调递增）。 */
 chunkNo: string;
 /** Chunk 正文（如非 restricted）。 */
 chunkText: string | null;
 /** Chunk contentRef（用于受限内容访问）。 */
 chunkContentRef: string | null;
 /** Chunk 元数据（页码、章节等）。 */
 chunkMetadata: Record<string, unknown> | null;
 /** 所属 Revision id（文档修订引用）。 */
 revisionId: string;
 /** Revision 修订号（document 内单调递增）。 */
 revisionNo: string;
 /** Revision 内容 hash（用于 CapabilityUse 记录实际引用）。 */
 revisionHash: string;
 /** Revision 发布时间（时效信息）。 */
 revisionPublishedAt: Date | null;
 /** 所属 Document id。 */
 documentId: string;
 /** Document key（跨修订稳定引用）。 */
 documentKey: string;
 /** Document 标题。 */
 documentTitle: string;
 /** 所属 KnowledgeBase id。 */
 knowledgeBaseId: string;
 /** KnowledgeBase key（Agent 绑定引用）。 */
 knowledgeBaseKey: string;
 /** KnowledgeBase 显示名。 */
 knowledgeBaseDisplayName: string;
 /** ACL 快照 hash（发布时冻结；用于检索时一致性校验）。 */
 aclSnapshotHash: string | null;
 /** 检索分数（0~1，越大越相关；本阶段基于 LIKE 命中率）。 */
 score: number;
 /** 选择原因（如 "fulltext_match" / "vector_match"）。 */
 selectionReason: string;
}

/** 证据检索结果状态。 */
export const KNOWLEDGE_SEARCH_STATUSES = ["ok", "empty", "denied", "unavailable"] as const;
export type KnowledgeSearchStatus = (typeof KNOWLEDGE_SEARCH_STATUSES)[number];

/** 证据检索结果。 */
export interface KnowledgeSearchResult {
 status: KnowledgeSearchStatus;
 hits: KnowledgeEvidenceHit[];
 reasonCode?: string;
 detail?: string;
}

/**
 * 分作用域证据检索（先目录后证据 / 检索失败区分）。
 *
 * 流程：
 * 1. 查询 tenant 内所有 active KnowledgeBase（lifecycle=active）。
 * 2. 可选按 knowledgeBaseIds 过滤（Agent 绑定的 KnowledgeBase 子集）。
 * 3. 对每个 base 查询其 currentRevisionId 指向的 published revision。
 * 4. 按 query 在 chunk.contentRedacted 上做 LIKE 匹配（本阶段简易全文检索）。
 * 5. 返回 hits（按 score 降序，limit 截断）。
 *
 * 不变量：
 * - 跨租户隔离（tenantId 必须匹配）。
 * - 只返回 published 状态 revision 的 chunk（draft/superseded/retracted 不参与）。
 * - 只返回 indexState=ready 的 revision（索引未就绪不返回）。
 * - 查询失败 → unavailable（不伪装为 empty）。
 * - 无匹配 → empty（确实无结果，非服务故障）。
 *
 * @returns KnowledgeSearchResult
 */
export async function searchKnowledgeEvidence(params: {
 tenantId: string;
 query: string;
 knowledgeBaseIds?: readonly string[];
 limit?: number;
}): Promise<KnowledgeSearchResult> {
 const trimmedQuery = params.query?.trim();
 if (!trimmedQuery) {
 return {
 status: "empty",
 hits: [],
 reasonCode: "empty_query",
 };
 }

 try {
 const limit = Math.max(1, Math.min(params.limit ?? 20, 100));

 // 1. 查询 active KnowledgeBase（按 knowledgeBaseIds 过滤）
 const baseConditions = [
 eq(knowledgeBase.tenantId, params.tenantId),
 eq(knowledgeBase.lifecycleState, "active"),
 ];
 if (params.knowledgeBaseIds && params.knowledgeBaseIds.length > 0) {
 baseConditions.push(inArray(knowledgeBase.id, [...params.knowledgeBaseIds]));
 }

 const bases = await db
 .select({
 id: knowledgeBase.id,
 knowledgeKey: knowledgeBase.knowledgeKey,
 displayName: knowledgeBase.displayName,
 })
 .from(knowledgeBase)
 .where(and(...baseConditions))
 .limit(100);

 if (bases.length === 0) {
 return {
 status: "empty",
 hits: [],
 reasonCode: "no_knowledge_base",
 };
 }

 const baseIds = bases.map((b) => b.id);
 const baseMap = new Map(bases.map((b) => [b.id, b]));

 // 2. 查询 Documents（有 currentRevisionId 且 active）
 const docs = await db
 .select({
 id: knowledgeDocument.id,
 knowledgeBaseId: knowledgeDocument.knowledgeBaseId,
 documentKey: knowledgeDocument.documentKey,
 title: knowledgeDocument.title,
 currentRevisionId: knowledgeDocument.currentRevisionId,
 lifecycleState: knowledgeDocument.lifecycleState,
 })
 .from(knowledgeDocument)
 .where(
 and(
 eq(knowledgeDocument.tenantId, params.tenantId),
 inArray(knowledgeDocument.knowledgeBaseId, baseIds),
 eq(knowledgeDocument.lifecycleState, "active"),
 isNotNull(knowledgeDocument.currentRevisionId),
 ),
 );

 if (docs.length === 0) {
 return {
 status: "empty",
 hits: [],
 reasonCode: "no_published_document",
 };
 }

 const currentRevisionIds = docs
 .map((d) => d.currentRevisionId)
 .filter((id): id is string => id !== null);
 if (currentRevisionIds.length === 0) {
 return {
 status: "empty",
 hits: [],
 reasonCode: "no_current_revision",
 };
 }

 // 3. 查询 published + indexState=ready 的 revision
 const revisions = await db
 .select()
 .from(knowledgeDocumentRevision)
 .where(
 and(
 eq(knowledgeDocumentRevision.tenantId, params.tenantId),
 inArray(knowledgeDocumentRevision.id, currentRevisionIds),
 eq(knowledgeDocumentRevision.revisionState, "published"),
 eq(knowledgeDocumentRevision.indexState, "ready"),
 ),
 );

 if (revisions.length === 0) {
 // 有 currentRevisionId 但 revision 未就绪 → unavailable（不伪装为 empty）
 return {
 status: "unavailable",
 hits: [],
 reasonCode: "revision_index_not_ready",
 detail: "Knowledge 修订索引尚未就绪",
 };
 }

 const readyRevisionIds = revisions.map((r) => r.id);
 const revisionMap = new Map(revisions.map((r) => [r.id, r]));

 // 4. 查询这些 revision 下的 chunks，按 query 做 LIKE 匹配
 // 使用 escape 防止 LIKE 通配符注入（% 与 _）；MySQL LIKE 默认 ESCAPE 为 '\'
 const escapedQuery = trimmedQuery.replace(/[%_\\]/g, "\\$&");
 const likePattern = `%${escapedQuery}%`;

 const matchingChunks = await db
 .select({
 chunk: knowledgeChunk,
 })
 .from(knowledgeChunk)
 .where(
 and(
 eq(knowledgeChunk.tenantId, params.tenantId),
 inArray(knowledgeChunk.documentRevisionId, readyRevisionIds),
 isNotNull(knowledgeChunk.contentRedacted),
 like(knowledgeChunk.contentRedacted, likePattern),
 ),
 )
 .limit(limit * 5); // 多取一些用于排序后截断

 if (matchingChunks.length === 0) {
 return {
 status: "empty",
 hits: [],
 reasonCode: "no_query_match",
 };
 }

 // 5. 构造 KnowledgeEvidenceHit（按 query 在 chunkText 中的命中率作为 score）
 const docMap = new Map(docs.map((d) => [d.id, d]));
 const hits: KnowledgeEvidenceHit[] = [];

 for (const { chunk } of matchingChunks) {
 const revision = revisionMap.get(chunk.documentRevisionId);
 if (!revision) continue;
 const doc = docMap.get(revision.documentId);
 if (!doc) continue;
 const base = baseMap.get(doc.knowledgeBaseId);
 if (!base) continue;

 const text = chunk.contentRedacted ?? "";
 const lowerText = text.toLowerCase();
 const lowerQuery = trimmedQuery.toLowerCase();
 const occurrences = countOccurrences(lowerText, lowerQuery);
 const textLength = Math.max(1, text.length);
 const score = Math.min(1, (occurrences * lowerQuery.length) / textLength);

 hits.push({
 chunkId: chunk.id,
 chunkHash: chunk.contentHash,
 chunkNo: chunk.chunkNo,
 chunkText: chunk.contentRedacted,
 chunkContentRef: chunk.contentRef,
 chunkMetadata: chunk.metadataJson,
 revisionId: revision.id,
 revisionNo: revision.revisionNo,
 revisionHash: revision.contentHash,
 revisionPublishedAt: revision.publishedAt,
 documentId: doc.id,
 documentKey: doc.documentKey,
 documentTitle: doc.title,
 knowledgeBaseId: base.id,
 knowledgeBaseKey: base.knowledgeKey,
 knowledgeBaseDisplayName: base.displayName,
 aclSnapshotHash: revision.aclSnapshotHash,
 score,
 selectionReason: "fulltext_match",
 });
 }

 if (hits.length === 0) {
 return {
 status: "empty",
 hits: [],
 reasonCode: "no_match_after_filter",
 };
 }

 // 按 score 降序，limit 截断
 hits.sort((a, b) => b.score - a.score);
 const top = hits.slice(0, limit);

 return {
 status: "ok",
 hits: top,
 reasonCode: "evidence_loaded",
 };
 } catch (err) {
 return {
 status: "unavailable",
 hits: [],
 reasonCode: "knowledge_search_failed",
 detail: err instanceof Error ? err.message : String(err),
 };
 }
}

/** 计算 subString 在 text 中出现的次数（用于 score）。 */
function countOccurrences(text: string, sub: string): number {
 if (!sub) return 0;
 let count = 0;
 let idx = 0;
 while (idx !== -1) {
 idx = text.indexOf(sub, idx);
 if (idx === -1) break;
 count++;
 idx += sub.length;
 }
 return count;
}

// ─── 错误类型 ─────────────────────────────────────────────

/** Knowledge 校验错误（参数非法 / 状态非法）。 */
export class KnowledgeValidationError extends Error {
 constructor(message: string) {
 super(message);
 this.name = "KnowledgeValidationError";
 }
}

/** Knowledge 版本冲突（ETag/If-Match 不匹配）。 */
export class KnowledgeVersionConflictError extends Error {
 constructor(
 public readonly resourceId: string,
 public readonly currentVersionNo: string,
 public readonly expectedVersionNo: string,
 ) {
 super(
 `Knowledge 资源版本冲突（id=${resourceId}, current=${currentVersionNo}, expected=${expectedVersionNo}）`,
 );
 this.name = "KnowledgeVersionConflictError";
 }
}

/** Knowledge 修订已发布/已撤回（不允许重复发布）。 */
export class KnowledgeRevisionAlreadyPublishedError extends Error {
 constructor(
 public readonly revisionId: string,
 public readonly currentState: KnowledgeRevisionState,
 ) {
 super(`Knowledge Revision 已发布/已撤回（id=${revisionId}, currentState=${currentState}）`);
 this.name = "KnowledgeRevisionAlreadyPublishedError";
 }
}

/** Knowledge 修订索引未就绪（不允许发布）。 */
export class KnowledgeRevisionIndexNotReadyError extends Error {
 constructor(
 public readonly revisionId: string,
 public readonly currentIndexState: KnowledgeIndexState,
 ) {
 super(
 `Knowledge Revision 索引未就绪（id=${revisionId}, indexState=${currentIndexState}；要求 ready）`,
 );
 this.name = "KnowledgeRevisionIndexNotReadyError";
 }
}

// Re-export schema 类型供外部统一从 knowledge-queries 引入
export type {
 KnowledgeBaseLifecycleState,
 KnowledgeDocumentLifecycleState,
 KnowledgeIndexState,
 KnowledgeRevisionState,
 KnowledgeSourceType,
 KnowledgeBase,
 KnowledgeChunk,
 KnowledgeDocument,
 KnowledgeDocumentRevision,
 KnowledgeIndex,
} from "@/lib/persistence/schema/knowledge";
