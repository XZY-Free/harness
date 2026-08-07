/**
 * : Revision 执行资格唯一 MySQL 实现。
 *
 * 组合低层 Reader（ArtifactEvidence、PublicationEvidence、ConformanceEvidence）
 * + Agent/Runtime 主体读取 + Policy 读取，产出唯一权威 Snapshot。
 *
 * 所有低层 Reader 接受调用方传入的 DB Session 或 Transaction，
 * 本模块禁止内部使用全局 db（规则）。
 *
 * 参见：SnowHarness专题01最终差距整改与正式链路收口实施方案 
 */

import type { RevisionExecutionEvidenceSnapshot, PolicyRevisionSnapshot, PolicyRequirementResult } from "../domain/revision-execution-eligibility";
import type { RevisionExecutionEvidenceReader, LoadEvidenceInput, LoadExactEvidenceInput } from "../application/revision-execution-evidence-reader";
import { extractRuntimeCapabilities, EligibilityError } from "../domain/revision-execution-eligibility";

import type { ArtifactEvidenceSnapshot } from "@/lib/artifacts/domain/artifact-evidence";
import { loadArtifactEvidenceSnapshot } from "@/lib/artifacts/persistence/artifact-evidence-reader";
import type { ActivePublicationSnapshot } from "@/lib/publications/domain/publication-eligibility";
import { loadActivePublicationSnapshot } from "@/lib/publications/persistence/publication-evidence-reader";
import { loadConformanceEligibilitySnapshot } from "@/lib/runtimes/persistence/runtime-conformance-evidence-reader";

import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { policyRevisionTable, policySetTable } from "@/lib/persistence/schema/control-plane";
import { and, eq, isNull } from "drizzle-orm";
import type { db as DbType, DbOrTx } from "@/lib/db/client";

/**
 * MySQL 实现的依赖注入。
 *
 * /: 所有 DB 访问必须通过 dbOrTx 参数，禁止内部使用全局 db。
 */
export interface MySqlRevisionExecutionEvidenceReaderDeps {
 db: DbOrTx;
}

/**
 * 创建 MySQL 版 RevisionExecutionEvidenceReader。
 */
export function createMySqlRevisionExecutionEvidenceReader(
 deps: MySqlRevisionExecutionEvidenceReaderDeps,
): RevisionExecutionEvidenceReader {
 const { db } = deps;

 return {
 async loadCurrentEvidence(input: LoadEvidenceInput): Promise<RevisionExecutionEvidenceSnapshot> {
 return loadEvidence(db, input, null);
 },

 async loadExactEvidence(input: LoadExactEvidenceInput): Promise<RevisionExecutionEvidenceSnapshot> {
 return loadEvidence(db, input, input.conformanceRunId);
 },
 };
}

// ─── 内部实现 ─────────────────────────────────────────────

type DbLike = DbOrTx;

/**
 * 核心证据加载逻辑 — loadCurrentEvidence 和 loadExactEvidence 共用。
 *
 * @param dbOrTx DB 实例或事务（: 由调用方传入）
 * @param input 加载参数
 * @param exactConformanceRunId 非null时使用精确冻结的 conformanceRunId
 */
async function loadEvidence(
 dbOrTx: DbLike,
 input: LoadEvidenceInput,
 exactConformanceRunId: string | null,
): Promise<RevisionExecutionEvidenceSnapshot> {
 // : 并行加载所有证据 — 真实读取，禁止硬编码

 // Phase 1: 并行加载 Evidence + Publication + Revision 行
 const [
 agentArtifactEvidence,
 runtimeArtifactEvidence,
 agentPublication,
 runtimePublication,
 agentRevisionRow,
 runtimeRevisionRow,
 ] = await Promise.all([
 loadArtifactEvidenceSnapshot({
 tenantId: input.tenantId,
 artifactType: "agent_revision",
 artifactRevisionId: input.agentRevisionId,
 dbOrTx: dbOrTx,
 }),
 loadArtifactEvidenceSnapshot({
 tenantId: input.tenantId,
 artifactType: "runtime_revision",
 artifactRevisionId: input.runtimeRevisionId,
 dbOrTx: dbOrTx,
 }),
 loadActivePublicationSnapshot({
 tenantId: input.tenantId,
 subjectType: "agent_revision",
 subjectRevisionId: input.agentRevisionId,
 dbOrTx: dbOrTx,
 }),
 loadActivePublicationSnapshot({
 tenantId: input.tenantId,
 subjectType: "runtime_revision",
 subjectRevisionId: input.runtimeRevisionId,
 dbOrTx: dbOrTx,
 }),
 dbOrTx
 .select()
 .from(agentRevisionTable)
 .where(eq(agentRevisionTable.id, input.agentRevisionId))
 .limit(1)
 .then((r) => r[0] ?? null),
 dbOrTx
 .select()
 .from(runtimeRevisionTable)
 .where(eq(runtimeRevisionTable.id, input.runtimeRevisionId))
 .limit(1)
 .then((r) => r[0] ?? null),
 ]);

 // Phase 2: 用 Revision 行的 agentId/runtimeId 加载 Agent/Runtime 主体
 const [agentRow, runtimeRow] = await Promise.all([
 agentRevisionRow
 ? dbOrTx
 .select({ id: agentTable.id, lifecycleState: agentTable.lifecycleState })
 .from(agentTable)
 .where(and(eq(agentTable.id, agentRevisionRow.agentId), isNull(agentTable.deletedAt)))
 .limit(1)
 .then((r) => r[0] ?? null)
 : Promise.resolve(null),
 runtimeRevisionRow
 ? dbOrTx
 .select({ id: runtimeTable.id, lifecycleState: runtimeTable.lifecycleState })
 .from(runtimeTable)
 .where(
 and(eq(runtimeTable.id, runtimeRevisionRow.runtimeId), isNull(runtimeTable.deletedAt)),
 )
 .limit(1)
 .then((r) => r[0] ?? null)
 : Promise.resolve(null),
 ]);

 // Phase 3: 加载 Conformance 证据
 const conformanceRunId = exactConformanceRunId ?? runtimePublication?.conformanceRunId ?? null;
 const runtimeConformance = await loadConformanceEligibilitySnapshot({
 tenantId: input.tenantId,
 runtimeRevisionId: input.runtimeRevisionId,
 conformanceRunId,
 dbOrTx: dbOrTx,
 });

 // Phase 4: : 加载 Policy Requirement（Fail-closed，含租户校验）
 const policyResult = await loadPolicyRequirement(dbOrTx, input.policyRevisionId, input.tenantId);
 if (!policyResult.ok) {
  throw new EligibilityError(policyResult.failureCode, policyResult.failureReason);
 }
 const policyRequirement = policyResult.requirement;

 // : Fail-closed Capability 解析
 const runtimeCapabilities = extractRuntimeCapabilities(runtimeRevisionRow?.runtimeCapabilitiesJson);

 return {
 tenantId: input.tenantId,
 agentRevisionId: input.agentRevisionId,
 agentArtifactEvidence,
 agentPublication,
 // : 真实读取生命周期状态，禁止硬编码 active
 agentLifecycleState: agentRow?.lifecycleState === "enabled" ? "active" : "archived",
 agentRevisionState:
 agentRevisionRow?.revisionState === "published"
 ? "published"
 : agentRevisionRow?.revisionState === "withdrawn"
 ? "withdrawn"
 : "draft",
 runtimeRevisionId: input.runtimeRevisionId,
 runtimeArtifactEvidence,
 runtimePublication,
 runtimeConformance,
 runtimeLifecycleState: runtimeRow?.lifecycleState === "enabled" ? "active" : "retired",
 runtimeRevisionState:
 runtimeRevisionRow?.revisionState === "published"
 ? "published"
 : runtimeRevisionRow?.revisionState === "withdrawn"
 ? "withdrawn"
 : "draft",
 runtimeCapabilities,
 policyRequirement,
 };
}

/**
 * : 加载 Policy Requirement — Fail-closed。
 *
 * policyRevisionId 为 null → Route 未引用 Policy → { kind: "none" }
 * policyRevisionId 非 null → 必须读取完整状态，校验租户范围，返回 PolicyRequirementResult。
 *
 * 失败场景（精确分类）：
 * - policy_revision_not_found: 引用的 Policy 不存在
 * - policy_revision_cross_tenant: Policy 属于其他租户
 */
async function loadPolicyRequirement(
 dbOrTx: DbLike,
 policyRevisionId: string | null,
 tenantId: string,
): Promise<PolicyRequirementResult> {
 // 未引用 Policy → 合法，返回 none
 if (!policyRevisionId) {
  return { ok: true, requirement: { kind: "none" } };
 }

 // 读取 Policy Revision（JOIN PolicySet 表校验租户）
 const [row] = await dbOrTx
 .select({
  id: policyRevisionTable.id,
  revisionState: policyRevisionTable.revisionState,
  publishedAt: policyRevisionTable.publishedAt,
  tenantId: policySetTable.tenantId,
 })
 .from(policyRevisionTable)
 .innerJoin(policySetTable, eq(policyRevisionTable.policySetId, policySetTable.id))
 .where(eq(policyRevisionTable.id, policyRevisionId))
 .limit(1);

 // 引用了但不存在 → fail-closed
 if (!row) {
  return {
   ok: false,
   failureCode: "policy_revision_not_found",
   failureReason: `PolicyRevision ${policyRevisionId} 不存在`,
  };
 }

 // 跨租户 → fail-closed
 if (row.tenantId !== tenantId) {
  return {
   ok: false,
   failureCode: "policy_revision_cross_tenant",
   failureReason: `PolicyRevision ${policyRevisionId} 属于租户 ${row.tenantId}，当前租户 ${tenantId}`,
  };
 }

 // 引用有效 → 返回 referenced
 return {
  ok: true,
  requirement: {
   kind: "referenced",
   policyRevisionId,
   policyRevision: {
    id: row.id,
    revisionState: row.revisionState as PolicyRevisionSnapshot["revisionState"],
    publishedAt: row.publishedAt,
   },
  },
 };
}
