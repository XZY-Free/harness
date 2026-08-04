/**
 * V11 RuntimeConformanceResult 仓储（S05-C06）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.x（RuntimeConformanceResult）、
 *   §15-machine-contracts §5 L94-110
 * - ../v11-agentkit-platform-development-plan/05-runtime-protocol-dispatch-and-agent-loop.md S05-C06
 *
 * 职责：
 * - persistConformanceResults：UPSERT 一批 conformance 结果到 v11RuntimeConformanceResult。
 *   - 每个 (runtimeRevisionId, caseId) UPSERT 一行（passed/reason/adapterDigest/...）。
 *   - 在事务内执行，保证原子性。
 * - listConformanceResultsByRevision：列出 Revision 的全部 conformance 结果。
 * - getConformanceResult：查询单个 (runtimeRevisionId, caseId) 结果。
 * - deleteConformanceResultsByRevision：清空 Revision 的 conformance 结果（重新测试前调用）。
 *
 * 关键约束：
 * - UNIQUE(runtimeRevisionId, caseId)：每个 Revision 每个 case 只有一条结果（UPSERT）。
 * - mandatory case 失败 → Revision 不可路由（由 publishRuntimeRevision 校验，本仓储不强制）。
 * - 失败 case 对应 capability 必须设为 false（应用层联动，本表不强制）。
 * - 可选能力缺失只禁用对应功能，不阻断发布。
 * - capabilities 必须来自探测和一致性测试，管理员不能手工勾选未支持能力。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import type { ConformanceCaseResult } from "@/lib/runtimes/domain/runtime-conformance";
import {
  type V11RuntimeConformanceResult,
  v11RuntimeConformanceResult,
} from "@/lib/v11/schema/runtime";
import { and, asc, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** persistConformanceResults 入参。 */
export interface PersistConformanceResultsParams {
  tenantId: string;
  runtimeRevisionId: string;
  results: ConformanceCaseResult[];
  /** Adapter 制品 digest（同批次结果共享）。 */
  adapterDigest?: string | null;
  /** 测试环境标识（同批次结果共享）。 */
  testEnvironment?: string | null;
  /** 证据引用（同批次结果共享）。 */
  evidenceRef?: string | null;
}

/**
 * 持久化一批 conformance 结果（UPSERT 语义）。
 *
 * 对每个 result，UPSERT 到 v11RuntimeConformanceResult：
 * - 冲突键：UNIQUE(runtimeRevisionId, caseId)。
 * - ON DUPLICATE KEY UPDATE：passed/reason/adapterDigest/testEnvironment/evidenceRef/testedAt/updatedAt。
 * - id 字段：首次插入由 $defaultFn 生成；冲突时保留原 id。
 *
 * 事务内执行，保证原子性（全部成功或全部回滚）。
 *
 * @returns 持久化后的 ConformanceResult 行列表（按 caseId 升序）。
 */
export async function persistConformanceResults(
  params: PersistConformanceResultsParams,
): Promise<V11RuntimeConformanceResult[]> {
  if (params.results.length === 0) return [];

  await db.transaction(async (tx) => {
    for (const result of params.results) {
      await upsertOneResult(tx, params, result);
    }
  });

  return listConformanceResultsByRevision(params.runtimeRevisionId);
}

/** 单条结果 UPSERT。 */
async function upsertOneResult(
  tx: Tx,
  params: PersistConformanceResultsParams,
  result: ConformanceCaseResult,
): Promise<void> {
  const now = new Date();
  const id = randomUUID();
  await tx
    .insert(v11RuntimeConformanceResult)
    .values({
      id,
      runtimeRevisionId: params.runtimeRevisionId,
      tenantId: params.tenantId,
      caseId: result.caseId,
      passed: result.passed,
      reason: result.reason ?? null,
      adapterDigest: params.adapterDigest ?? null,
      testEnvironment: params.testEnvironment ?? null,
      evidenceRef: params.evidenceRef ?? null,
      testedAt: now,
    })
    .onDuplicateKeyUpdate({
      set: {
        passed: result.passed,
        reason: result.reason ?? null,
        adapterDigest: params.adapterDigest ?? null,
        testEnvironment: params.testEnvironment ?? null,
        evidenceRef: params.evidenceRef ?? null,
        testedAt: now,
        updatedAt: now,
      },
    });
}

/**
 * 列出 Revision 的全部 conformance 结果（按 caseId 升序）。
 *
 * 不存在返回空数组。跨租户隔离由调用方保证（revisionId 在租户内可访问）。
 */
export async function listConformanceResultsByRevision(
  runtimeRevisionId: string,
): Promise<V11RuntimeConformanceResult[]> {
  return db
    .select()
    .from(v11RuntimeConformanceResult)
    .where(eq(v11RuntimeConformanceResult.runtimeRevisionId, runtimeRevisionId))
    .orderBy(asc(v11RuntimeConformanceResult.caseId));
}

/**
 * 查询单个 (runtimeRevisionId, caseId) 结果。
 *
 * 不存在返回 null。
 */
export async function getConformanceResult(
  runtimeRevisionId: string,
  caseId: string,
): Promise<V11RuntimeConformanceResult | null> {
  const [row] = await db
    .select()
    .from(v11RuntimeConformanceResult)
    .where(
      and(
        eq(v11RuntimeConformanceResult.runtimeRevisionId, runtimeRevisionId),
        eq(v11RuntimeConformanceResult.caseId, caseId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 清空 Revision 的全部 conformance 结果（重新测试前调用）。
 *
 * @returns 删除的行数。
 */
export async function deleteConformanceResultsByRevision(
  runtimeRevisionId: string,
): Promise<number> {
  const result = await db
    .delete(v11RuntimeConformanceResult)
    .where(eq(v11RuntimeConformanceResult.runtimeRevisionId, runtimeRevisionId));
  return result[0].affectedRows;
}

// ─── Re-exports ────────────────────────────────────────────

export type { V11RuntimeConformanceResult } from "@/lib/v11/schema/runtime";
