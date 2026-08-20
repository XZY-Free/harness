/**
 * Runtime Conformance Evidence Reader — 从数据库读取原始 Conformance Run/Case 事实。
 *
 * 所有模块（RouteSet 激活、Projection、Binding、Hosted Readiness）
 * 必须通过此 Reader 读取 Conformance 事实，不得自行构造 SQL 查询。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案
 */

import { type DbOrTx, db } from "@/lib/db/client";
import type { RuntimeConformanceFacts } from "@/lib/runtime/domain/runtime-conformance-eligibility";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { and, desc, eq } from "drizzle-orm";

/**
 * 读取指定 RuntimeRevision 的最新原始 Conformance Run/Case 事实。
 *
 * 优先返回传入 runId 对应的 Run（用于 Binding 校验冻结的精确 Run）；
 * 未传入 runId 时返回该 Revision 下最新一条 Run。
 *
 * 不存在返回 null。
 *
 * : 接受 dbOrTx 参数，默认全局 db（向后兼容）。
 */
export async function loadRuntimeConformanceFacts(params: {
  tenantId: string;
  runtimeRevisionId: string;
  /** 可选：指定 Run ID（用于 Binding 校验冻结的精确 Run）。 */
  conformanceRunId?: string | null;
  /** : 事务内传入 tx，默认使用全局 db。 */
  dbOrTx?: DbOrTx;
}): Promise<RuntimeConformanceFacts | null> {
  const conn = params.dbOrTx ?? db;
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

  const [run] = await conn
    .select()
    .from(runtimeConformanceRun)
    .where(runQuery)
    .orderBy(desc(runtimeConformanceRun.completedAt))
    .limit(1);

  if (!run) return null;

  const caseResults = await conn
    .select({
      caseId: runtimeConformanceCaseResult.caseId,
      passed: runtimeConformanceCaseResult.passed,
    })
    .from(runtimeConformanceCaseResult)
    .where(eq(runtimeConformanceCaseResult.runId, run.id));

  return {
    run: {
      runId: run.id,
      tenantId: run.tenantId,
      runtimeRevisionId: run.runtimeRevisionId,
      overallResult: run.overallResult,
      runtimeArtifactDigest: run.runtimeArtifactDigest,
      runtimeConfigDigest: run.runtimeConfigDigest,
      protocolContractRevision: run.protocolContractRevision,
      suiteRevision: run.suiteRevision,
      conformanceFormat: run.conformanceFormat,
    },
    caseResults: caseResults.map((c) => ({
      caseId: c.caseId,
      passed: c.passed,
    })),
  };
}
