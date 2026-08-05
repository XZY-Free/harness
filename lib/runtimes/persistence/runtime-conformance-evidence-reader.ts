/**
 * Runtime Conformance Evidence Reader — 从数据库读取 Conformance 资格快照。
 *
 * 所有模块（RouteSet 激活、Projection、Binding、Hosted Readiness）
 * 必须通过此 Reader 读取 Conformance 证据，不得自行构造 SQL 查询。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §1.3
 */

import { db } from "@/lib/db/client";
import type { ConformanceEligibilitySnapshot } from "@/lib/runtimes/domain/runtime-conformance-eligibility";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { and, desc, eq } from "drizzle-orm";

/**
 * 读取指定 RuntimeRevision 的最新有效 Conformance 资格快照。
 *
 * 优先返回传入 runId 对应的 Run（用于 Binding 校验冻结的精确 Run）；
 * 未传入 runId 时返回该 Revision 下最新一条 Run。
 *
 * 不存在返回 null。
 */
export async function loadConformanceEligibilitySnapshot(params: {
  tenantId: string;
  runtimeRevisionId: string;
  /** 可选：指定 Run ID（用于 Binding 校验冻结的精确 Run）。 */
  conformanceRunId?: string | null;
}): Promise<ConformanceEligibilitySnapshot | null> {
  const runQuery = params.conformanceRunId
    ? and(
        eq(runtimeConformanceRun.id, params.conformanceRunId),
        eq(runtimeConformanceRun.tenantId, params.tenantId),
        eq(runtimeConformanceRun.runtimeRevisionId, params.runtimeRevisionId),
      )
    : and(
        eq(runtimeConformanceRun.tenantId, params.tenantId),
        eq(runtimeConformanceRun.runtimeRevisionId, params.runtimeRevisionId),
      );

  const [run] = await db
    .select()
    .from(runtimeConformanceRun)
    .where(runQuery)
    .orderBy(desc(runtimeConformanceRun.completedAt))
    .limit(1);

  if (!run) return null;

  const caseResults = await db
    .select({
      caseId: runtimeConformanceCaseResult.caseId,
      passed: runtimeConformanceCaseResult.passed,
    })
    .from(runtimeConformanceCaseResult)
    .where(eq(runtimeConformanceCaseResult.runId, run.id));

  return {
    runId: run.id,
    tenantId: run.tenantId,
    runtimeRevisionId: run.runtimeRevisionId,
    overallResult: run.overallResult,
    runtimeArtifactDigest: run.runtimeArtifactDigest,
    runtimeConfigDigest: run.runtimeConfigDigest,
    protocolContractRevision: run.protocolContractRevision,
    suiteRevision: run.suiteRevision,
    conformanceFormat: run.conformanceFormat,
    caseResults: caseResults.map((c) => ({
      caseId: c.caseId,
      passed: c.passed,
    })),
  };
}
