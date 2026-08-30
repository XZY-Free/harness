/**
 * Revision 执行资格的唯一 MySQL 实现。
 *
 * 组合低层 Reader（ArtifactEvidence、PublicationEvidence、ConformanceEvidence）
 * + Agent/Runtime 主体读取 + Policy 读取，产出唯一权威 Snapshot。
 *
 * 所有低层 Reader 接受调用方传入的 DB Session 或 Transaction，
 * 本模块禁止内部使用全局 db（规则）。
 *
 * 事实源：docs/architecture/agent-control-plane.md 与 docs/architecture/persistence.md。
 */

import type { ArtifactEvidenceSnapshot } from "@/lib/artifacts/domain/artifact-evidence";
import { loadArtifactEvidenceSnapshot } from "@/lib/artifacts/persistence/artifact-evidence-reader";
import type { ActivePublicationSnapshot } from "@/lib/publications/domain/publication-eligibility";
import { loadActivePublicationSnapshot } from "@/lib/publications/persistence/publication-evidence-reader";
import type { RuntimeConformanceEvidence } from "@/lib/runtime/domain/runtime-conformance-eligibility";
import { loadRuntimeConformanceFacts } from "@/lib/runtime/persistence/runtime-conformance-evidence-reader";
import type {
  AgentTargetEvidenceInput,
  LoadEvidenceInput,
  LoadExactEvidenceInput,
  RevisionExecutionEvidenceReader,
  RuntimeTargetEvidenceInput,
} from "../application/revision-execution-evidence-reader";
import type {
  AgentTargetEvidenceSnapshot,
  PolicyRequirement,
  PolicyRequirementResult,
  PolicyRevisionSnapshot,
  RevisionExecutionEvidenceSnapshot,
  RuntimeTargetEvidenceSnapshot,
} from "../domain/revision-execution-eligibility";
import { EligibilityError } from "../domain/revision-execution-eligibility";

import type { DbOrTx, db as DbType } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { policyRevisionTable, policySetTable } from "@/lib/persistence/schema/control-plane";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { and, eq, isNull } from "drizzle-orm";

/**
 * MySQL 实现的依赖注入。
 *
 * 所有 DB 访问必须通过 dbOrTx 参数，禁止内部使用全局 db。
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
    async loadCurrentEvidence(
      input: LoadEvidenceInput,
    ): Promise<RevisionExecutionEvidenceSnapshot> {
      return loadEvidence(db, input, null);
    },

    async loadExactEvidence(
      input: LoadExactEvidenceInput,
    ): Promise<RevisionExecutionEvidenceSnapshot> {
      return loadEvidence(db, input, input.conformanceRunId);
    },
  };
}

// ─── 内部实现 ─────────────────────────────────────────────

type DbLike = DbOrTx;

/**
 * 核心证据加载逻辑 — loadCurrentEvidence 和 loadExactEvidence 共用，按 target 判别分支。
 *
 * @param dbOrTx 由调用方传入的 DB 实例或事务
 * @param input 加载参数（target 判别联合）
 * @param exactConformanceRunId 非null时使用精确冻结的 conformanceRunId（仅 runtime target）
 */
async function loadEvidence(
  dbOrTx: DbLike,
  input: LoadEvidenceInput,
  exactConformanceRunId: string | null,
): Promise<RevisionExecutionEvidenceSnapshot> {
  // Agent 与 Runtime Authority 分离：按 target 判别分支加载，互不读取对方维度。
  return input.kind === "agent"
    ? loadAgentEvidence(dbOrTx, input)
    : loadRuntimeEvidence(dbOrTx, input, exactConformanceRunId);
}

/**
 * Agent target 证据 — 只读 Agent publication / lifecycle / revision state + policy。
 * 不得触发任何 Runtime artifact / publication / conformance / revision 查询。
 */
async function loadAgentEvidence(
  dbOrTx: DbLike,
  input: AgentTargetEvidenceInput,
): Promise<AgentTargetEvidenceSnapshot> {
  // 并行读取 Agent Publication + AgentRevision 行
  const [agentPublication, agentRevisionRow] = await Promise.all([
    loadActivePublicationSnapshot({
      tenantId: input.tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: input.agentRevisionId,
      dbOrTx: dbOrTx,
    }),
    dbOrTx
      .select()
      .from(agentRevisionTable)
      .where(eq(agentRevisionTable.id, input.agentRevisionId))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  // 用 Revision 行的 agentId 加载 Agent 主体
  const agentRow = agentRevisionRow
    ? await dbOrTx
        .select({ id: agentTable.id, lifecycleState: agentTable.lifecycleState })
        .from(agentTable)
        .where(and(eq(agentTable.id, agentRevisionRow.agentId), isNull(agentTable.deletedAt)))
        .limit(1)
        .then((r) => r[0] ?? null)
    : null;

  // 加载 Policy Requirement（Fail-closed，含租户校验）
  const policyRequirement = await loadPolicyRequirementStrict(
    dbOrTx,
    input.policyRevisionId,
    input.tenantId,
  );

  return {
    kind: "agent",
    tenantId: input.tenantId,
    agentRevisionId: input.agentRevisionId,
    agentPublication,
    // 真实读取生命周期状态，禁止硬编码 active
    agentLifecycleState: agentRow?.lifecycleState === "enabled" ? "active" : "archived",
    agentRevisionState:
      agentRevisionRow?.revisionState === "published"
        ? "published"
        : agentRevisionRow?.revisionState === "withdrawn"
          ? "withdrawn"
          : "draft",
    policyRequirement,
  };
}

/**
 * Runtime target 证据 — 只读 Runtime evidence + policy。不读取 Agent 维度。
 */
async function loadRuntimeEvidence(
  dbOrTx: DbLike,
  input: RuntimeTargetEvidenceInput,
  exactConformanceRunId: string | null,
): Promise<RuntimeTargetEvidenceSnapshot> {
  // 并行加载 Runtime Artifact Evidence + Publication + Revision 行
  const [runtimeArtifactEvidence, runtimePublication, runtimeRevisionRow] = await Promise.all([
    loadArtifactEvidenceSnapshot({
      tenantId: input.tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: input.runtimeRevisionId,
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
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.id, input.runtimeRevisionId))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  // 用 Revision 行的 runtimeId 加载 Runtime 主体
  const runtimeRow = runtimeRevisionRow
    ? await dbOrTx
        .select({ id: runtimeTable.id, lifecycleState: runtimeTable.lifecycleState })
        .from(runtimeTable)
        .where(
          and(eq(runtimeTable.id, runtimeRevisionRow.runtimeId), isNull(runtimeTable.deletedAt)),
        )
        .limit(1)
        .then((r) => r[0] ?? null)
    : null;

  // 加载 Conformance 证据
  // 规范化为包含原始 Run/Case 事实 + 从当前 RuntimeRevision 真实读取的期望值。
  // 期望值缺失显式 null 并 fail-closed，禁止空字符串兜底。
  const conformanceRunId = exactConformanceRunId ?? runtimePublication?.conformanceRunId ?? null;
  const conformanceFacts = await loadRuntimeConformanceFacts({
    tenantId: input.tenantId,
    runtimeRevisionId: input.runtimeRevisionId,
    conformanceRunId,
    dbOrTx: dbOrTx,
  });
  const runtimeConformance: RuntimeConformanceEvidence | null = conformanceFacts
    ? {
        run: conformanceFacts.run,
        caseResults: conformanceFacts.caseResults,
        expected: {
          tenantId: input.tenantId,
          runtimeRevisionId: input.runtimeRevisionId,
          runtimeTargetDigest: runtimeRevisionRow?.runtimeTargetDigest ?? null,
          runtimeConfigDigest: runtimeRevisionRow?.configHash ?? null,
          protocolContractRevision: runtimeRevisionRow?.protocolContractRevision ?? null,
          allowedFormats: ["standard_dsse"],
        },
      }
    : null;

  // 加载 Policy Requirement（Fail-closed，含租户校验）
  const policyRequirement = await loadPolicyRequirementStrict(
    dbOrTx,
    input.policyRevisionId,
    input.tenantId,
  );

  return {
    kind: "runtime",
    tenantId: input.tenantId,
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
    runtimeEvidenceKind: runtimeRevisionRow?.runtimeEvidenceKind ?? "hosted_artifact",
    policyRequirement,
  };
}

/** 加载 Policy Requirement，读取失败时抛错（fail-closed）。 */
async function loadPolicyRequirementStrict(
  dbOrTx: DbLike,
  policyRevisionId: string | null,
  tenantId: string,
): Promise<PolicyRequirement> {
  const policyResult = await loadPolicyRequirement(dbOrTx, policyRevisionId, tenantId);
  if (!policyResult.ok) {
    throw new EligibilityError(policyResult.failureCode, policyResult.failureReason);
  }
  return policyResult.requirement;
}

/**
 * 加载 Policy Requirement；缺失或跨租户时 fail-closed。
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
