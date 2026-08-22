/**
 * RouteSetActivationPolicy — RouteSet 聚合激活不变量校验。
 *
 * 输入目标 RouteSet 的完整 Active 状态，输出校验结果。
 * 不得负责：数据库读取、Route 选择、权重随机、API 错误映射。
 */
import {
  type NormalizedEligibility,
  computeSelectorDigest,
  computeSpecificity,
  isOverlapping,
  isTimeWindowOverlapping,
  normalizeEligibility,
} from "@/lib/routes/domain/route-selector";

export const ROUTE_TRAFFIC_WEIGHT_TOTAL = 10_000;

// ─── 输入类型 ──────────────────────────────────────────────

export interface DesiredRoute {
  routeId: string;
  routeKey?: string;
  routeRevisionId?: string;
  routeGroupId: string;
  agentRevisionId?: string;
  runtimeRevisionId?: string;
  trafficWeight: number;
  priorityNo: number;
  eligibilityConditions: unknown;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  activationState: "active" | "disabled";
}

export interface RouteSetActivationInput {
  routeSetId: string;
  routeScopeKey: string;
  tenantId: string;
  /** null = 基础 Harness RouteSet（无 Agent 资产约束）。 */
  agentId: string | null;
  desiredRoutes: DesiredRoute[];
}

// ─── 输出类型 ──────────────────────────────────────────────

export interface NormalizedRouteGroup {
  routeGroupId: string;
  specificity: number;
  priorityNo: number;
  selectorDigest: string;
  normalizedEligibility: NormalizedEligibility;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  routes: DesiredRoute[];
  totalWeight: number;
}

export interface RouteSetValidationError {
  code: string;
  message: string;
  detail?: unknown;
}

export interface RouteSetActivationResult {
  valid: boolean;
  normalizedGroups: NormalizedRouteGroup[];
  validationErrors: RouteSetValidationError[];
}

// ─── 聚合不变量校验 ──────────────────────────────────────

/**
 * 校验 RouteSet 激活目标状态的聚合不变量。
 *
 * 不变量：
 * 1. Weight 1–10000；Disabled 不参与合计
 * 2. 同组成员 Selector 完全一致（eligibility, priorityNo, specificity, effectiveFrom, effectiveUntil）
 * 3. 每个 Active Group 权重合计 = 10000
 * 4. 同 priorityNo + 同 specificity + eligibility 重叠 + 时间窗口重叠 → 不同 Group 禁止共存
 * 5. Route / RouteRevision 不重复
 * 6. 生效时间合法
 * 7. 权重 10000 在 Group 完整有效窗口内持续成立
 */
export function validateRouteSetActivation(
  input: RouteSetActivationInput,
): RouteSetActivationResult {
  const errors: RouteSetValidationError[] = [];
  const activeRoutes = input.desiredRoutes.filter((r) => r.activationState === "active");

  // 1. Weight 范围校验
  for (const route of activeRoutes) {
    if (
      !Number.isInteger(route.trafficWeight) ||
      route.trafficWeight < 1 ||
      route.trafficWeight > ROUTE_TRAFFIC_WEIGHT_TOTAL
    ) {
      errors.push({
        code: "ROUTE_WEIGHT_INVALID",
        message: `Route ${route.routeId} 权重 ${route.trafficWeight} 不在 1–${ROUTE_TRAFFIC_WEIGHT_TOTAL} 范围内`,
      });
    }
  }

  // 5. Route 不重复
  const routeIds = new Set<string>();
  for (const route of input.desiredRoutes) {
    if (routeIds.has(route.routeId)) {
      errors.push({
        code: "ROUTE_DUPLICATE",
        message: `Route ${route.routeId} 在目标集合中出现两次`,
      });
    }
    routeIds.add(route.routeId);
  }

  // 5. RouteRevision 不重复
  const revisionIds = new Set<string>();
  for (const route of activeRoutes) {
    if (route.routeRevisionId) {
      if (revisionIds.has(route.routeRevisionId)) {
        errors.push({
          code: "ROUTE_REVISION_DUPLICATE",
          message: `RouteRevision ${route.routeRevisionId} 被重复激活`,
        });
      }
      revisionIds.add(route.routeRevisionId);
    }
  }

  // 6. 生效时间合法
  for (const route of input.desiredRoutes) {
    if (
      route.effectiveFrom &&
      route.effectiveUntil &&
      route.effectiveFrom >= route.effectiveUntil
    ) {
      errors.push({
        code: "ROUTE_TIME_INVALID",
        message: `Route ${route.routeId} effectiveFrom >= effectiveUntil`,
      });
    }
  }

  // 按 routeGroupId 分组
  const groupMap = new Map<string, DesiredRoute[]>();
  for (const route of activeRoutes) {
    const existing = groupMap.get(route.routeGroupId) ?? [];
    existing.push(route);
    groupMap.set(route.routeGroupId, existing);
  }

  // 规范化每个 Group
  const normalizedGroups: NormalizedRouteGroup[] = [];
  for (const [groupId, routes] of groupMap) {
    const first = routes[0];
    if (!first) continue;

    // 规范化 Eligibility
    const normalizedEligibility = normalizeEligibility(first.eligibilityConditions);
    if (!normalizedEligibility) {
      errors.push({
        code: "ROUTE_ELIGIBILITY_INVALID",
        message: `Route Group ${groupId} Eligibility 条件格式非法`,
      });
      continue;
    }

    const specificity = computeSpecificity(normalizedEligibility);
    const selectorDigest = computeSelectorDigest(normalizedEligibility);
    const totalWeight = routes.reduce((sum, r) => sum + r.trafficWeight, 0);

    // 2. 同组成员 Selector 完全一致
    for (const route of routes) {
      const routeNormalized = normalizeEligibility(route.eligibilityConditions);
      if (!routeNormalized) {
        errors.push({
          code: "ROUTE_GROUP_SELECTOR_MISMATCH",
          message: `Route ${route.routeId} Eligibility 格式非法`,
        });
        continue;
      }
      const routeDigest = computeSelectorDigest(routeNormalized);
      if (routeDigest !== selectorDigest) {
        errors.push({
          code: "ROUTE_GROUP_SELECTOR_MISMATCH",
          message: `Route ${route.routeId} 与同组 ${groupId} Selector 不一致 (digest: ${routeDigest} vs ${selectorDigest})`,
        });
      }
      if (route.priorityNo !== first.priorityNo) {
        errors.push({
          code: "ROUTE_GROUP_SELECTOR_MISMATCH",
          message: `Route ${route.routeId} priorityNo ${route.priorityNo} 与同组 ${groupId} 的 ${first.priorityNo} 不一致`,
        });
      }
      // 时间窗口一致性
      if (
        (route.effectiveFrom?.getTime() ?? null) !== (first.effectiveFrom?.getTime() ?? null) ||
        (route.effectiveUntil?.getTime() ?? null) !== (first.effectiveUntil?.getTime() ?? null)
      ) {
        errors.push({
          code: "ROUTE_GROUP_SELECTOR_MISMATCH",
          message: `Route ${route.routeId} 有效时间窗口与同组 ${groupId} 不一致`,
        });
      }
    }

    // 3. Active Group 权重合计 = 10000
    if (totalWeight !== ROUTE_TRAFFIC_WEIGHT_TOTAL) {
      errors.push({
        code: "ROUTE_WEIGHT_TOTAL_INVALID",
        message: `Route Group ${groupId} 权重合计 ${totalWeight}，不等于 ${ROUTE_TRAFFIC_WEIGHT_TOTAL}`,
        detail: { groupId, totalWeight, expected: ROUTE_TRAFFIC_WEIGHT_TOTAL },
      });
    }

    normalizedGroups.push({
      routeGroupId: groupId,
      specificity,
      priorityNo: first.priorityNo,
      selectorDigest,
      normalizedEligibility,
      effectiveFrom: first.effectiveFrom,
      effectiveUntil: first.effectiveUntil,
      routes,
      totalWeight,
    });
  }

  // 4. 不同 Group 冲突检测：同 priorityNo + 同 specificity +3eligibility 重叠 + 时间窗口重叠
  for (let i = 0; i < normalizedGroups.length; i++) {
    for (let j = i + 1; j < normalizedGroups.length; j++) {
      const left = normalizedGroups[i];
      const right = normalizedGroups[j];
      if (!left || !right) continue;

      if (left.priorityNo !== right.priorityNo) continue;
      if (left.specificity !== right.specificity) continue;
      if (!isOverlapping(left.normalizedEligibility, right.normalizedEligibility)) continue;
      if (
        !isTimeWindowOverlapping(
          left.effectiveFrom,
          left.effectiveUntil,
          right.effectiveFrom,
          right.effectiveUntil,
        )
      )
        continue;

      errors.push({
        code: "ROUTE_SELECTOR_AMBIGUOUS",
        message: `Route Group ${left.routeGroupId} 与 ${right.routeGroupId} 在相同 Priority(${left.priorityNo})、Specificity(${left.specificity}) 下 Eligibility 和时间窗口重叠`,
        detail: {
          leftGroupId: left.routeGroupId,
          rightGroupId: right.routeGroupId,
          priorityNo: left.priorityNo,
          specificity: left.specificity,
        },
      });
    }
  }

  return {
    valid: errors.length === 0,
    normalizedGroups,
    validationErrors: errors,
  };
}
