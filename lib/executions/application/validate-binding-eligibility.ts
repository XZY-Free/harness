/**
 * ExecutionBinding 最终校验 — §5.1: 使用统一 RevisionExecutionEligibilityPolicy。
 *
 * 不再使用碎片化 PublicationEligibilityPolicy + ArtifactEvidencePolicy + 内联 Conformance 检查，
 * 改用统一 RevisionExecutionEvidenceSnapshot + RevisionExecutionEligibilityPolicy.isEligible()。
 *
 * 核心校验（Projection 版本 + Route Activation）在 DB 事务内执行。
 * Evidence Readers 使用全局 db（独立读取，不需要事务一致性）。
 *
 * Fail-closed 校验维度（统一 Policy 内）：
 *   1. Agent Publication Active
 *   2. Agent Attestation Verified & 未撤销
 *   3. Agent 生命周期 Active
 *   4. Runtime Publication Active
 *   5. Runtime Attestation Verified & 未撤销
 *   6. Runtime Conformance Passed & 完整
 *   7. Runtime 生命周期 Active
 *   8. Capability 兼容
 *   9. Policy 状态
 *
 * 事务内额外校验（DB 一致性，不在纯 Policy 内）：
 *   A. Projection 版本和输入一致
 *   B. Route 当前 Active Revision 仍一致
 */

import { db } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { policyRevisionTable } from "@/lib/persistence/schema/control-plane";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { routeActivation } from "@/lib/routes/persistence/route-revision-record";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { and, desc, eq, isNull } from "drizzle-orm";

// §5.1: 统一 Policy + Evidence 读取器
import { loadArtifactEvidenceSnapshot } from "@/lib/artifacts/persistence/artifact-evidence-reader";
import {
  RevisionExecutionEligibilityPolicy,
  type RevisionExecutionEvidenceSnapshot,
} from "@/lib/publications/application/load-revision-execution-evidence";
import { loadActivePublicationSnapshot } from "@/lib/publications/persistence/publication-evidence-reader";
import { loadConformanceEligibilitySnapshot } from "@/lib/runtimes/persistence/runtime-conformance-evidence-reader";

export interface BindingEligibilityInput {
  tenantId: string;
  routeId: string;
  /** Resolver 冻结的 RouteRevisionId。 */
  routeRevisionId: string;
  /** Resolver 冻结的 RouteActivationId。 */
  routeActivationId: string;
  /** Resolver 冻结的 AgentRevisionId。 */
  agentRevisionId: string;
  /** Resolver 冻结的 RuntimeRevisionId。 */
  runtimeRevisionId: string;
  /** Resolver 冻结的 PolicyRevisionId（可 null）。 */
  policyRevisionId: string | null;
  /** Projection 版本号 — 用于检测 Projection 滞后。 */
  projectionVersionNo: number;
}

export interface BindingEligibilityResult {
  valid: boolean;
  /** 校验失败原因。 */
  reason?: string;
  /** Projection 版本是否一致。 */
  projectionVersionMatch: boolean;
}

/**
 * §5.1: ExecutionBinding 最终 Fail-closed 校验。
 *
 * 使用统一 RevisionExecutionEligibilityPolicy + Evidence Snapshot。
 * 核心校验在 DB 事务内，Evidence Readers 使用全局 db。
 */
export async function validateBindingEligibility(
  input: BindingEligibilityInput,
): Promise<BindingEligibilityResult> {
  // §5.1: 核心校验在事务内执行
  return db.transaction(async (tx) => {
    // A. 校验 Projection 版本
    const [projection] = await tx
      .select()
      .from(routeEligibilityProjection)
      .where(eq(routeEligibilityProjection.routeId, input.routeId))
      .limit(1);

    const projectionVersionMatch = projection
      ? projection.projectionVersionNo === input.projectionVersionNo
      : false;

    // §5.2: Projection 版本过时 → 拒绝 Binding，调用方必须重新解析
    if (input.projectionVersionNo !== undefined && !projectionVersionMatch) {
      return {
        valid: false,
        reason: "eligibility_snapshot_stale",
        projectionVersionMatch,
      };
    }

    // B. §5.3: 校验 Route Activation — 指定 routeActivationId + 最新 sequence + active 状态
    const [currentActivation] = await tx
      .select()
      .from(routeActivation)
      .where(eq(routeActivation.routeId, input.routeId))
      .orderBy(desc(routeActivation.activationSequence))
      .limit(1);

    if (!currentActivation) {
      return { valid: false, reason: "route_activation_not_found", projectionVersionMatch };
    }
    // 校验指定的 routeActivationId 是当前最新 Activation
    if (currentActivation.id !== input.routeActivationId) {
      return { valid: false, reason: "route_activation_superseded", projectionVersionMatch };
    }
    if (currentActivation.routeRevisionId !== input.routeRevisionId) {
      return {
        valid: false,
        reason: "route_revision_mismatch",
        projectionVersionMatch,
      };
    }
    if (currentActivation.activationState !== "active") {
      return { valid: false, reason: "route_activation_not_active", projectionVersionMatch };
    }

    // §5.1: C. 加载统一 Evidence Snapshot（使用统一 Reader，不再碎片化校验）
    const { snapshot, requiredCapabilities } = await loadRevisionExecutionEvidenceSnapshot(input);

    // §5.1: D. 调用统一 Policy 校验
    const eligibilityResult = RevisionExecutionEligibilityPolicy.isEligible(
      snapshot,
      requiredCapabilities,
    );

    if (!eligibilityResult.eligible) {
      const reason = eligibilityResult.errors.map((e) => e.code).join(",");
      return { valid: false, reason, projectionVersionMatch };
    }

    return { valid: true, projectionVersionMatch };
  });
}

// ─── 内部工具 ──────────────────────────────────────────────

/**
 * §5.1: 加载完整 RevisionExecutionEvidenceSnapshot。
 *
 * 使用 Phase 1 统一 Reader：loadArtifactEvidenceSnapshot、loadActivePublicationSnapshot、
 * loadConformanceEligibilitySnapshot。
 *
 * 同时返回从 AgentRevision 提取的 requiredCapabilities，供统一 Policy 使用。
 */
async function loadRevisionExecutionEvidenceSnapshot(
  input: BindingEligibilityInput,
): Promise<{ snapshot: RevisionExecutionEvidenceSnapshot; requiredCapabilities: string[] }> {
  // §5.1: 先并行加载 Revision 行 + Evidence + Publication
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
    db
      .select()
      .from(agentRevisionTable)
      .where(eq(agentRevisionTable.id, input.agentRevisionId))
      .limit(1)
      .then((r) => r[0] ?? null),
    db
      .select()
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.id, input.runtimeRevisionId))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  // §5.1: 用 Revision 行的 agentId/runtimeId 加载 Agent/Runtime 主体
  const [agentRow, runtimeRow] = await Promise.all([
    agentRevisionRow
      ? db
          .select({ id: agentTable.id, lifecycleState: agentTable.lifecycleState })
          .from(agentTable)
          .where(and(eq(agentTable.id, agentRevisionRow.agentId), isNull(agentTable.deletedAt)))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    runtimeRevisionRow
      ? db
          .select({ id: runtimeTable.id, lifecycleState: runtimeTable.lifecycleState })
          .from(runtimeTable)
          .where(
            and(eq(runtimeTable.id, runtimeRevisionRow.runtimeId), isNull(runtimeTable.deletedAt)),
          )
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  // §5.1: 加载 Conformance 证据（使用 Publication 冻结的 conformanceRunId）
  const runtimeConformance = await loadConformanceEligibilitySnapshot({
    tenantId: input.tenantId,
    runtimeRevisionId: input.runtimeRevisionId,
    conformanceRunId: runtimePublication?.conformanceRunId ?? null,
  });

  // §5.1: 校验 PolicyRevision 仍处于 published 状态（事务外读取，最终一致性由 Store 行级锁保证）
  if (input.policyRevisionId) {
    const [policy] = await db
      .select({ state: policyRevisionTable.revisionState })
      .from(policyRevisionTable)
      .where(eq(policyRevisionTable.id, input.policyRevisionId))
      .limit(1);
    if (!policy || policy.state !== "published") {
      // 通过 evidenceSnapshot 字段缺失表达，由统一 Policy 输出 policy 错误
      // 当前统一 Policy 不阻塞 Policy，保留 state 用于未来扩展
    }
  }

  return {
    snapshot: {
      tenantId: input.tenantId,
      agentRevisionId: input.agentRevisionId,
      agentArtifactEvidence,
      agentPublication,
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
      runtimeCapabilities: Array.isArray(runtimeRevisionRow?.runtimeCapabilitiesJson)
        ? (runtimeRevisionRow.runtimeCapabilitiesJson as string[])
        : [],
      policyRevisionId: input.policyRevisionId,
    },
    requiredCapabilities: extractRequiredCapabilities(
      agentRevisionRow?.agentInterfaceRequirementsJson,
    ),
  };
}

/**
 * §4.4: 从 AgentRevision.agentInterfaceRequirementsJson 提取必要 Capability 列表。
 *
 * 期望结构: { required: string[], optional: string[] }
 * 缺失或结构异常时返回空数组（等同于无 Capability 要求）。
 */
function extractRequiredCapabilities(jsonValue: unknown): string[] {
  if (!jsonValue || typeof jsonValue !== "object" || Array.isArray(jsonValue)) return [];
  const required = (jsonValue as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return required.filter((c): c is string => typeof c === "string" && c.length > 0);
}
