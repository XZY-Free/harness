/**
 * RuntimeRevision 仓储。
 *
 * 事实源：docs/architecture/persistence.md 、
 * docs/architecture/agent-control-plane.md 。
 *
 * 职责：
 * - createDraftRevision：创建 draft Revision（revisionNo 在 Runtime 内单调递增）。
 * - withdrawRevision：published → withdrawn（只阻止新发布/路由，不删除历史引用）。
 * - updateDraftContent：仅 draft 状态可编辑业务内容（published/withdrawn 不可改）。
 * - getRevision/getRevisionsByRuntime/getLatestPublishedRevision：查询。
 *
 * 不可变性约束：
 * - published Revision 业务内容不可修改（protocol_type/endpoint_ref/artifact_ref/capabilities 等）。
 * - withdrawn 只变更 revisionState，不删除行，不修改业务内容。
 * - revisionNo 由 UNIQUE(runtimeId, revisionNo) 约束保证唯一；并发冲突时 fail-loud。
 *
 * Conformance 门禁：
 * - publishRevision 前必须通过 conformance 门禁（4 个 mandatory case）。
 * - 门禁失败抛 RuntimeConformanceCaseFailedError，Revision 保持 draft 状态。
 * - capabilities 必须来自探测和一致性测试，管理员不能手工勾选未支持能力。
 */
import { randomUUID } from "node:crypto";
import { extractArtifactDigest } from "@/lib/artifacts/domain/artifact";
import { db } from "@/lib/db/client";
import {
 type RuntimeRevisionRow,
 type RuntimeRevisionState,
 runtimeRevisionTable,
} from "@/lib/persistence/schema/runtimes";
import { protocolContractRevision } from "@/lib/runtime/domain/runtime-conformance-run";
import { RuntimeRevisionNotFoundError } from "@/lib/runtime/domain/runtime-revision-publication-policy";
import { and, desc, eq, max } from "drizzle-orm";

/** 创建 draft RuntimeRevision 的入参。 */
export interface CreateDraftRuntimeRevisionParams {
 tenantId: string;
 runtimeId: string;
 protocolType: string;
 endpointRef: string;
 runtimeArtifactRef: string;
 runtimeCapabilitiesJson: unknown;
 identityMode: string;
 networkZone: string;
 configHash: string;
 createdBy: string;
}

/**
 * 创建 draft RuntimeRevision。
 *
 * revisionNo 由 Runtime 内最大值 +1 计算（并发冲突由 UNIQUE 约束 fail-loud）。
 * 业务内容在 draft 状态可编辑（updateDraftContent），published 后不可改。
 */
export async function createDraftRuntimeRevision(
 params: CreateDraftRuntimeRevisionParams,
): Promise<RuntimeRevisionRow> {
 const revisionNo = await nextRevisionNo(params.runtimeId);
 const id = randomUUID();
 await db.insert(runtimeRevisionTable).values({
 id,
 runtimeId: params.runtimeId,
 revisionNo,
 protocolType: params.protocolType,
 protocolContractRevision: protocolContractRevision(params.protocolType),
 endpointRef: params.endpointRef,
 runtimeArtifactRef: params.runtimeArtifactRef,
 artifactDigest: extractArtifactDigest(params.runtimeArtifactRef),
 runtimeCapabilitiesJson: params.runtimeCapabilitiesJson,
 identityMode: params.identityMode,
 networkZone: params.networkZone,
 configHash: params.configHash,
 revisionState: "draft",
 createdBy: params.createdBy,
 });

 const [row] = await db
 .select()
 .from(runtimeRevisionTable)
 .where(eq(runtimeRevisionTable.id, id))
 .limit(1);
 if (!row) {
 throw new Error(`createDraftRuntimeRevision: 行未找到（id=${id}）`);
 }
 return row;
}

/** 仅 draft 状态可编辑业务内容；published/withdrawn 抛错（不可变）。 */
export async function updateDraftRuntimeRevisionContent(
 revisionId: string,
 patch: {
 protocolType?: string;
 endpointRef?: string;
 runtimeArtifactRef?: string;
 runtimeCapabilitiesJson?: unknown;
 identityMode?: string;
 networkZone?: string;
 configHash?: string;
 },
): Promise<RuntimeRevisionRow> {
 const current = await getRuntimeRevisionById(revisionId);
 if (!current) {
 throw new RuntimeRevisionNotFoundError(revisionId);
 }
 if (current.revisionState !== "draft") {
 throw new RuntimeRevisionImmutableError(revisionId, current.revisionState);
 }

 const updates: Record<string, unknown> = {};
 if (patch.protocolType !== undefined) {
 updates.protocolType = patch.protocolType;
 updates.protocolContractRevision = protocolContractRevision(patch.protocolType);
 }
 if (patch.endpointRef !== undefined) updates.endpointRef = patch.endpointRef;
 if (patch.runtimeArtifactRef !== undefined) {
 updates.runtimeArtifactRef = patch.runtimeArtifactRef;
 updates.artifactId = null;
 updates.artifactDigest = null;
 }
 if (patch.runtimeCapabilitiesJson !== undefined) {
 updates.runtimeCapabilitiesJson = patch.runtimeCapabilitiesJson;
 }
 if (patch.identityMode !== undefined) updates.identityMode = patch.identityMode;
 if (patch.networkZone !== undefined) updates.networkZone = patch.networkZone;
 if (patch.configHash !== undefined) updates.configHash = patch.configHash;

 if (Object.keys(updates).length === 0) return current;

 const result = await db
 .update(runtimeRevisionTable)
 .set(updates)
 .where(
 and(eq(runtimeRevisionTable.id, revisionId), eq(runtimeRevisionTable.revisionState, "draft")),
 );
 if (result[0].affectedRows !== 1) {
 const latest = await getRuntimeRevisionById(revisionId);
 if (!latest) throw new RuntimeRevisionNotFoundError(revisionId);
 throw new RuntimeRevisionImmutableError(revisionId, latest.revisionState);
 }
 return (await getRuntimeRevisionById(revisionId)) as RuntimeRevisionRow;
}

/** 按 id 获取 RuntimeRevision。不存在返回 null。 */
export async function getRuntimeRevisionById(
 revisionId: string,
): Promise<RuntimeRevisionRow | null> {
 const [row] = await db
 .select()
 .from(runtimeRevisionTable)
 .where(eq(runtimeRevisionTable.id, revisionId))
 .limit(1);
 return row ?? null;
}

/** 按 Runtime 列出所有 Revision（按 revisionNo 降序）。 */
export async function getRevisionsByRuntime(
 runtimeId: string,
 options?: { revisionState?: RuntimeRevisionState },
): Promise<RuntimeRevisionRow[]> {
 const conditions = [eq(runtimeRevisionTable.runtimeId, runtimeId)];
 if (options?.revisionState) {
 conditions.push(eq(runtimeRevisionTable.revisionState, options.revisionState));
 }
 return db
 .select()
 .from(runtimeRevisionTable)
 .where(and(...conditions))
 .orderBy(desc(runtimeRevisionTable.revisionNo));
}

/** 获取 Runtime 的最新 published Revision（用于路由查询）。 */
export async function getLatestPublishedRuntimeRevision(
 runtimeId: string,
): Promise<RuntimeRevisionRow | null> {
 const list = await db
 .select()
 .from(runtimeRevisionTable)
 .where(
 and(
 eq(runtimeRevisionTable.runtimeId, runtimeId),
 eq(runtimeRevisionTable.revisionState, "published"),
 ),
 )
 .orderBy(desc(runtimeRevisionTable.revisionNo))
 .limit(1);
 return list[0] ?? null;
}

/**
 * 计算 Runtime 内下一个 revisionNo（max +1）。
 *
 * 并发安全：UNIQUE(runtimeId, revisionNo) 约束保证唯一；并发冲突时 fail-loud。
 */
async function nextRevisionNo(runtimeId: string): Promise<number> {
 const [row] = await db
 .select({ maxNo: max(runtimeRevisionTable.revisionNo) })
 .from(runtimeRevisionTable)
 .where(eq(runtimeRevisionTable.runtimeId, runtimeId));
 const currentMax = row?.maxNo;
 if (currentMax === null || currentMax === undefined) return 1;
 return currentMax + 1;
}

/** RuntimeRevision 不可变错误。 */
export class RuntimeRevisionImmutableError extends Error {
 constructor(
 public readonly revisionId: string,
 public readonly state: RuntimeRevisionState,
 ) {
 super(`RuntimeRevision ${revisionId} 状态为 ${state}，业务内容不可修改`);
 this.name = "RuntimeRevisionImmutableError";
 }
}

/** Re-export 供外部统一从本模块引入类型。 */
export type {
 RuntimeRevisionState,
 RuntimeRevisionRow,
} from "@/lib/persistence/schema/runtimes";
export { RUNTIME_REVISION_STATES } from "@/lib/persistence/schema/runtimes";
export {
 RuntimeRevisionNotFoundError,
 RuntimeRevisionStateError,
 RuntimePublicationVersionConflictError,
} from "@/lib/runtime/domain/runtime-revision-publication-policy";
