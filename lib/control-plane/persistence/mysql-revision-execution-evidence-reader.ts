/**
 * §03.3: Revision 执行资格唯一 MySQL 实现。
 *
 * 组合低层 Reader（ArtifactEvidence、PublicationEvidence、ConformanceEvidence）
 * + Agent/Runtime 主体读取 + Policy 读取，产出唯一权威 Snapshot。
 *
 * 所有低层 Reader 接受调用方传入的 DB Session 或 Transaction，
 * 本模块禁止内部使用全局 db（§03.3 规则）。
 *
 * 参见：SnowHarness专题01最终差距整改与正式链路收口实施方案 §03.3
 */

import type { RevisionExecutionEvidenceSnapshot, PolicyRevisionSnapshot } from "../domain/revision-execution-eligibility";
import type { RevisionExecutionEvidenceReader, LoadEvidenceInput, LoadExactEvidenceInput } from "../application/revision-execution-evidence-reader";
import { extractRuntimeCapabilities, EligibilityError } from "../domain/revision-execution-eligibility";

import type { ArtifactEvidenceSnapshot } from "@/lib/artifacts/domain/artifact-evidence";
import { loadArtifactEvidenceSnapshot } from "@/lib/artifacts/persistence/artifact-evidence-reader";
import type { ActivePublicationSnapshot } from "@/lib/publications/domain/publication-eligibility";
import { loadActivePublicationSnapshot } from "@/lib/publications/persistence/publication-evidence-reader";
import { loadConformanceEligibilitySnapshot } from "@/lib/runtimes/persistence/runtime-conformance-evidence-reader";

import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { policyRevisionTable } from "@/lib/persistence/schema/control-plane";
import { and, eq, isNull } from "drizzle-orm";
import type { db as DbType } from "@/lib/db/client";

/**
 * MySQL 实现的依赖注入。
 *
 * §03.3: 所有 DB 访问必须通过 db 参数，禁止内部使用全局 db。
 */
export interface MySqlRevisionExecutionEvidenceReaderDeps {
  db: typeof DbType;
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

type DbLike = typeof DbType;

/**
 * 核心证据加载逻辑 — loadCurrentEvidence 和 loadExactEvidence 共用。
 *
 * @param dbOrTx DB 实例或事务（§03.3: 由调用方传入）
 * @param input 加载参数
 * @param exactConformanceRunId 非null时使用精确冻结的 conformanceRunId
 */
async function loadEvidence(
  dbOrTx: DbLike,
  input: LoadEvidenceInput,
  exactConformanceRunId: string | null,
): Promise<RevisionExecutionEvidenceSnapshot> {
  // §03.6: 并行加载所有证据 — 真实读取，禁止硬编码

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
    }),
    loadArtifactEvidenceSnapshot({
      tenantId: input.tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: input.runtimeRevisionId,
    }),
    loadActivePublicationSnapshot({
      tenantId: input.tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: input.agentRevisionId,
    }),
    loadActivePublicationSnapshot({
      tenantId: input.tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: input.runtimeRevisionId,
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
  });

  // Phase 4: §03.4: 加载 Policy Revision 快照（真实读取，不再仅存 id）
  const policyRevision = await loadPolicyRevisionSnapshot(dbOrTx, input.policyRevisionId);

  // §03.5: Fail-closed Capability 解析
  const runtimeCapabilities = extractRuntimeCapabilities(runtimeRevisionRow?.runtimeCapabilitiesJson);

  return {
    tenantId: input.tenantId,
    agentRevisionId: input.agentRevisionId,
    agentArtifactEvidence,
    agentPublication,
    // §03.6: 真实读取生命周期状态，禁止硬编码 active
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
    policyRevision,
  };
}

/**
 * §03.4: 加载 Policy Revision 快照。
 *
 * policyRevisionId 为 null → Route 未引用 Policy → 返回 null
 * policyRevisionId 非 null → 必须读取完整状态（id, revisionState, publishedAt, withdrawnAt）
 */
async function loadPolicyRevisionSnapshot(
  dbOrTx: DbLike,
  policyRevisionId: string | null,
): Promise<PolicyRevisionSnapshot | null> {
  if (!policyRevisionId) return null;

  const [row] = await dbOrTx
    .select({
      id: policyRevisionTable.id,
      revisionState: policyRevisionTable.revisionState,
      publishedAt: policyRevisionTable.publishedAt,
    })
    .from(policyRevisionTable)
    .where(eq(policyRevisionTable.id, policyRevisionId))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    revisionState: row.revisionState as PolicyRevisionSnapshot["revisionState"],
    publishedAt: row.publishedAt,
  };
}
