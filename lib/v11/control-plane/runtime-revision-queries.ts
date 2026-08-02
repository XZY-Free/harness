/**
 * V11 RuntimeRevision 仓储。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §4.3、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W02。
 *
 * 职责：
 * - createDraftRevision：创建 draft Revision（revisionNo 在 Runtime 内单调递增）。
 * - publishRevision：兼容入口，委托正式 Runtime 发布应用服务。
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
 * - 门禁失败抛 ConformanceGateError，Revision 保持 draft 状态。
 * - capabilities 必须来自探测和一致性测试，管理员不能手工勾选未支持能力。
 */
import { randomUUID } from "node:crypto";
import { extractArtifactDigest } from "@/lib/artifacts/domain/artifact";
import { publishRuntimeRevisionThroughControlPlane } from "@/lib/compatibility/runtimes/publish-runtime-revision";
import { db } from "@/lib/db/client";
import { protocolContractRevision } from "@/lib/runtimes/domain/runtime-conformance-run";
import {
  type ConformanceCaseResult,
  RuntimeRevisionNotFoundError,
  RuntimeRevisionStateError,
} from "@/lib/runtimes/domain/runtime-revision-publication-policy";
import {
  type RuntimeRevisionState,
  type V11RuntimeRevision,
  v11RuntimeRevision,
} from "@/lib/v11/schema/runtime";
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
): Promise<V11RuntimeRevision> {
  const revisionNo = await nextRevisionNo(params.runtimeId);
  const id = randomUUID();
  await db.insert(v11RuntimeRevision).values({
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
    .from(v11RuntimeRevision)
    .where(eq(v11RuntimeRevision.id, id))
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
): Promise<V11RuntimeRevision> {
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
    .update(v11RuntimeRevision)
    .set(updates)
    .where(
      and(eq(v11RuntimeRevision.id, revisionId), eq(v11RuntimeRevision.revisionState, "draft")),
    );
  if (result[0].affectedRows !== 1) {
    const latest = await getRuntimeRevisionById(revisionId);
    if (!latest) throw new RuntimeRevisionNotFoundError(revisionId);
    throw new RuntimeRevisionImmutableError(revisionId, latest.revisionState);
  }
  return (await getRuntimeRevisionById(revisionId)) as V11RuntimeRevision;
}

/**
 * 发布 RuntimeRevision：draft → published。
 *
 * 正式应用事务同时写入 conformance 投影、PublicationRecord、Revision发布投影、
 * Runtime.currentRevisionId、Audit、Outbox和可选幂等完成。本函数只保留旧签名兼容。
 *
 * @throws RuntimeRevisionNotFoundError Revision 不存在
 * @throws RuntimeRevisionStateError Revision 非 draft 状态
 * @throws ConformanceGateError conformance 门禁失败（事务无写入）
 * @throws RuntimeVersionConflictError Runtime 乐观锁冲突
 */
export async function publishRuntimeRevision(
  tenantId: string,
  revisionId: string,
  runtimeExpectedVersionNo: number,
  conformanceResults: ConformanceCaseResult[],
  options?: {
    /** Adapter 制品 digest（持久化到 conformance 结果行）。 */
    adapterDigest?: string | null;
    /** 测试环境标识（持久化到 conformance 结果行）。 */
    testEnvironment?: string | null;
    /** 证据引用（持久化到 conformance 结果行）。 */
    evidenceRef?: string | null;
  },
): Promise<V11RuntimeRevision> {
  const result = await publishRuntimeRevisionThroughControlPlane({
    tenantId,
    revisionId,
    runtimeExpectedVersionNo,
    conformanceResults,
    conformanceOptions: options,
    actor: {
      tenantId,
      actorType: "system",
      actorId: "runtime-publication-compatibility",
    },
    requestId: `compat-runtime-publish:${randomUUID()}`,
    idempotencyKey: `compat-runtime-publish:${revisionId}`,
  });
  return result.revision as V11RuntimeRevision;
}

/**
 * 撤回 RuntimeRevision：published → withdrawn。
 *
 * - 不删除行，不修改业务内容。
 * - 只阻止新发布或路由引用；已开始的 ExecutionBinding 不受影响。
 * - 不自动变更 Runtime.currentRevisionId（由调用方按业务规则处理）。
 */
export async function withdrawRuntimeRevision(revisionId: string): Promise<V11RuntimeRevision> {
  const current = await getRuntimeRevisionById(revisionId);
  if (!current) {
    throw new RuntimeRevisionNotFoundError(revisionId);
  }
  if (current.revisionState !== "published") {
    throw new RuntimeRevisionStateError(
      revisionId,
      current.revisionState,
      "withdrawn",
      "只有 published 状态可撤回",
    );
  }

  await db
    .update(v11RuntimeRevision)
    .set({ revisionState: "withdrawn" })
    .where(eq(v11RuntimeRevision.id, revisionId));

  return (await getRuntimeRevisionById(revisionId)) as V11RuntimeRevision;
}

/** 按 id 获取 RuntimeRevision。不存在返回 null。 */
export async function getRuntimeRevisionById(
  revisionId: string,
): Promise<V11RuntimeRevision | null> {
  const [row] = await db
    .select()
    .from(v11RuntimeRevision)
    .where(eq(v11RuntimeRevision.id, revisionId))
    .limit(1);
  return row ?? null;
}

/** 按 Runtime 列出所有 Revision（按 revisionNo 降序）。 */
export async function getRevisionsByRuntime(
  runtimeId: string,
  options?: { revisionState?: RuntimeRevisionState },
): Promise<V11RuntimeRevision[]> {
  const conditions = [eq(v11RuntimeRevision.runtimeId, runtimeId)];
  if (options?.revisionState) {
    conditions.push(eq(v11RuntimeRevision.revisionState, options.revisionState));
  }
  return db
    .select()
    .from(v11RuntimeRevision)
    .where(and(...conditions))
    .orderBy(desc(v11RuntimeRevision.revisionNo));
}

/** 获取 Runtime 的最新 published Revision（用于路由查询）。 */
export async function getLatestPublishedRuntimeRevision(
  runtimeId: string,
): Promise<V11RuntimeRevision | null> {
  const list = await db
    .select()
    .from(v11RuntimeRevision)
    .where(
      and(
        eq(v11RuntimeRevision.runtimeId, runtimeId),
        eq(v11RuntimeRevision.revisionState, "published"),
      ),
    )
    .orderBy(desc(v11RuntimeRevision.revisionNo))
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
    .select({ maxNo: max(v11RuntimeRevision.revisionNo) })
    .from(v11RuntimeRevision)
    .where(eq(v11RuntimeRevision.runtimeId, runtimeId));
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
export type { RuntimeRevisionState, V11RuntimeRevision } from "@/lib/v11/schema/runtime";
export { RUNTIME_REVISION_STATES } from "@/lib/v11/schema/runtime";
export {
  RuntimeRevisionNotFoundError,
  RuntimeRevisionStateError,
  RuntimeVersionConflictError,
} from "@/lib/runtimes/domain/runtime-revision-publication-policy";
