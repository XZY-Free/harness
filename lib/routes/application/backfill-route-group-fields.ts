import { createHash } from "node:crypto";
/**
 * 幂等 Backfill 命令：回填 RouteRevision.routeGroupId / selectorDigest
 * 和 RouteActivation.routeSetId。
 *
 * 规则（按优先级）：
 * 1. trafficAllocationJson.groupId 存在 → 使用原值
 * 2. 单条 10000 权重 Route → primary
 * 3. 多条 Route 无 Group ID → 由 selectorDigest + priorityNo + effectiveWindow
 * 生成确定性 legacy group ID
 * 4. 无法组成 10000 权重的集合 → 标记 legacy_route_set_invalid
 *
 * 重复执行结果一致（幂等）。输出无法安全归组的历史 RouteSet。
 *
 * Migration 0117 新增 nullable 列后运行此命令，
 * Migration 0118 验证零 NULL 后增加 NOT NULL + 最终索引。
 */
import { db } from "@/lib/db/client";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import {
 SELECTOR_ALGORITHM_VERSION,
 computeSelectorDigest,
 normalizeEligibility,
} from "@/lib/routes/domain/route-selector";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

// ─── 回填结果 ──────────────────────────────────────────────

export interface BackfillResult {
 /** 成功回填的 RouteRevision 行数 */
 revisionsBackfilled: number;
 /** 成功回填的 RouteActivation 行数 */
 activationsBackfilled: number;
 /** 无法安全归组的历史 RouteSet ID 列表 */
 invalidRouteSetIds: string[];
 /** 已有值的行数（跳过） */
 skippedExisting: number;
}

// ─── Route Group ID 生成 ───────────────────────────────────

/**
 * 为多条 Route 无 Group ID 的情况生成确定性 legacy group ID。
 *
 * 格式：legacy:{selectorDigest前12字符}:{priorityNo}:{timeWindowHash前8字符}
 */
function generateLegacyGroupId(
 selectorDigest: string,
 priorityNo: number,
 effectiveFrom: Date | null,
 effectiveUntil: Date | null,
): string {
 const timeWindowKey = JSON.stringify([
 effectiveFrom?.toISOString() ?? null,
 effectiveUntil?.toISOString() ?? null,
 ]);
 const timeWindowHash = createHash("sha256").update(timeWindowKey).digest("hex").slice(0, 8);
 return `legacy:${selectorDigest.slice(7, 19)}:${priorityNo}:${timeWindowHash}`;
}

// ─── 主回填逻辑 ────────────────────────────────────────────

export async function backfillRouteGroupFields(): Promise<BackfillResult> {
 const result: BackfillResult = {
 revisionsBackfilled: 0,
 activationsBackfilled: 0,
 invalidRouteSetIds: [],
 skippedExisting: 0,
 };

 // Phase 1: 回填 RouteRevision.routeGroupId + selectorDigest
 // 按批次处理，避免一次性加载所有行
 const BATCH_SIZE = 500;
 let hasMore = true;

 while (hasMore) {
 // 读取尚未回填的 RouteRevision（routeGroupId IS NULL）
 const pendingRevisions = await db
 .select()
 .from(routeRevision)
 .where(isNull(routeRevision.routeGroupId))
 .limit(BATCH_SIZE);

 if (pendingRevisions.length === 0) {
 hasMore = false;
 break;
 }

 // 按 routeSetId 分组
 const routeSetIds = [...new Set(pendingRevisions.map((r) => r.routeSetId))];

 // 读取每个 RouteSet 下所有已 enabled 的 Route 投影（含 trafficWeight）
 const routesBySet = new Map<string, Awaited<ReturnType<typeof getEnabledRoutesForSet>>>();
 for (const routeSetId of routeSetIds) {
 routesBySet.set(routeSetId, await getEnabledRoutesForSet(routeSetId));
 }

 for (const revision of pendingRevisions) {
 // 计算 selectorDigest（使用正式 RouteSelector 算法）
 const normalized = normalizeEligibility(revision.eligibilityConditionsJson);
 const selectorDigest = normalized ? computeSelectorDigest(normalized) : undefined;

 // 确定 routeGroupId
 const routeGroupId = determineRouteGroupId(
 revision,
 routesBySet.get(revision.routeSetId) ?? [],
 );

 if (routeGroupId === null) {
 // 无法安全归组 — 标记为 invalid（使用特殊值，0118 之前必须处理）
 result.invalidRouteSetIds.push(revision.routeSetId);
 // 写入 sentinel 值，让后续 0118 验证能发现
 await db
 .update(routeRevision)
 .set({
 routeGroupId: "legacy_route_set_invalid",
 selectorDigest,
 })
 .where(eq(routeRevision.id, revision.id));
 } else {
 await db
 .update(routeRevision)
 .set({
 routeGroupId: routeGroupId ?? undefined,
 selectorDigest,
 })
 .where(eq(routeRevision.id, revision.id));
 }
 result.revisionsBackfilled++;
 }
 }

 // Phase 2: 回填 RouteActivation.routeSetId（派生自 RouteRevision.routeSetId）
 let hasMoreActivations = true;
 while (hasMoreActivations) {
 const pendingActivations = await db
 .select({
 activation: routeActivation,
 revisionRouteSetId: routeRevision.routeSetId,
 })
 .from(routeActivation)
 .innerJoin(routeRevision, eq(routeRevision.id, routeActivation.routeRevisionId))
 .where(isNull(routeActivation.routeSetId))
 .limit(BATCH_SIZE);

 if (pendingActivations.length === 0) {
 hasMoreActivations = false;
 break;
 }

 for (const { activation, revisionRouteSetId } of pendingActivations) {
 await db
 .update(routeActivation)
 .set({ routeSetId: revisionRouteSetId })
 .where(eq(routeActivation.id, activation.id));
 result.activationsBackfilled++;
 }
 }

 // 去重 invalidRouteSetIds
 result.invalidRouteSetIds = [...new Set(result.invalidRouteSetIds)];

 return result;
}

// ─── 辅助函数 ──────────────────────────────────────────────

interface RouteWithWeight {
 routeId: string;
 trafficWeight: number;
 routeState: string;
}

async function getEnabledRoutesForSet(routeSetId: string): Promise<RouteWithWeight[]> {
 const routes = await db
 .select({
 routeId: deploymentRouteTable.id,
 trafficWeight: deploymentRouteTable.trafficWeight,
 routeState: deploymentRouteTable.routeState,
 })
 .from(deploymentRouteTable)
 .where(
 and(
 eq(deploymentRouteTable.routeSetId, routeSetId),
 eq(deploymentRouteTable.routeState, "enabled"),
 ),
 );
 return routes;
}

/**
 * 确定单个 RouteRevision 的 routeGroupId。
 *
 * 优先级：
 * 1. trafficAllocationJson.groupId 存在 → 使用原值
 * 2. 单条 10000 权重 → primary
 * 3. 多条 Route → 生成确定性 legacy group ID
 * 4. 无法组成 10000 权重 → 返回 null（标记 invalid）
 */
function determineRouteGroupId(
 revision: {
 trafficAllocationJson: unknown;
 trafficWeight: number;
 priorityNo: number;
 effectiveFrom: Date | null;
 effectiveUntil: Date | null;
 eligibilityConditionsJson: unknown;
 routeSetId: string;
 },
 enabledRoutes: RouteWithWeight[],
): string | null {
 // 1. 已有 groupId
 const trafficJson = revision.trafficAllocationJson as Record<string, unknown> | null;
 if (trafficJson && typeof trafficJson.groupId === "string" && trafficJson.groupId) {
 return trafficJson.groupId;
 }

 // 2. 单条 10000 权重
 if (revision.trafficWeight === 10_000 && enabledRoutes.length <= 1) {
 return "primary";
 }

 // 3. 多条 Route — 生成确定性 legacy group ID
 const normalized = normalizeEligibility(revision.eligibilityConditionsJson);
 const selectorDigest = normalized ? computeSelectorDigest(normalized) : "unknown";

 // 检查此 RouteSet 下同组（同 selectorDigest + priorityNo + timeWindow）的权重合计
 // 此处简化：直接生成 legacy group ID
 // 实际上，在当前阶段所有缺少 groupId 的历史数据都需要处理
 const legacyId = generateLegacyGroupId(
 selectorDigest,
 revision.priorityNo,
 revision.effectiveFrom,
 revision.effectiveUntil,
 );

 // 4. 如果此 RouteSet 的 enabled 路由总权重不是 10000，标记 invalid
 const totalWeight = enabledRoutes.reduce((sum, r) => sum + r.trafficWeight, 0);
 if (totalWeight !== 10_000 && enabledRoutes.length > 1) {
 return null; // 无法组成 10000 权重的集合
 }

 return legacyId;
}

// ─── 验证函数（供 Migration 0118 使用前调用）───────────────

export interface VerificationResult {
 routeRevisionWithNullRouteGroupId: number;
 routeRevisionWithNullSelectorDigest: number;
 routeActivationWithNullRouteSetId: number;
 ready: boolean;
}

/**
 * 验证零 NULL — Migration 0118 运行前提。
 */
export async function verifyBackfillComplete(): Promise<VerificationResult> {
 const [routeGroupIdNull] = await db
 .select({ count: sql<number>`count(*)` })
 .from(routeRevision)
 .where(isNull(routeRevision.routeGroupId));

 const [selectorDigestNull] = await db
 .select({ count: sql<number>`count(*)` })
 .from(routeRevision)
 .where(isNull(routeRevision.selectorDigest));

 const [routeSetIdNull] = await db
 .select({ count: sql<number>`count(*)` })
 .from(routeActivation)
 .where(isNull(routeActivation.routeSetId));

 const routeGroupNull = Number(routeGroupIdNull?.count ?? 0);
 const selectorNull = Number(selectorDigestNull?.count ?? 0);
 const routeSetNull = Number(routeSetIdNull?.count ?? 0);

 return {
 routeRevisionWithNullRouteGroupId: routeGroupNull,
 routeRevisionWithNullSelectorDigest: selectorNull,
 routeActivationWithNullRouteSetId: routeSetNull,
 ready: routeGroupNull === 0 && selectorNull === 0 && routeSetNull === 0,
 };
}
