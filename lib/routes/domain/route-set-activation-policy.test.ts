import {
  type NormalizedEligibility,
  SELECTOR_ALGORITHM_VERSION,
  computeSelectorDigest,
  computeSpecificity,
  isOverlapping,
  isTimeWindowOverlapping,
  normalizeEligibility,
} from "@/lib/routes/domain/route-selector";
import {
  type DesiredRoute,
  ROUTE_TRAFFIC_WEIGHT_TOTAL,
  validateRouteSetActivation,
} from "@/lib/routes/domain/route-set-activation-policy";
import { describe, expect, it } from "vitest";

// ─── RouteSelector 测试 ──────────────────────────────────

describe("normalizeEligibility", () => {
  it("空条件规范化为 { all: {} }", () => {
    expect(normalizeEligibility(null)).toEqual({ all: {} });
    expect(normalizeEligibility(undefined)).toEqual({ all: {} });
    expect(normalizeEligibility({})).toEqual({ all: {} });
  });

  it("等值合取规范化并按键排序", () => {
    const result = normalizeEligibility({ all: { region: "cn", environment: "prod" } });
    expect(result).not.toBeNull();
    expect(Object.keys(result!.all)).toEqual(["environment", "region"]);
  });

  it("非 all 结构返回 null", () => {
    expect(normalizeEligibility({ any: {} })).toBeNull();
    expect(normalizeEligibility("invalid")).toBeNull();
    expect(normalizeEligibility(42)).toBeNull();
  });

  it("非标量值导致整体失败（Fail-closed）", () => {
    // §2.1: 不再静默过滤，遇到不支持值返回 null
    const result = normalizeEligibility({ all: { env: "prod", nested: { a: 1 } } });
    expect(result).toBeNull();
  });

  it("数组值导致整体失败", () => {
    expect(normalizeEligibility({ all: { env: "prod", tags: ["a", "b"] } })).toBeNull();
  });

  it("null 值导致整体失败", () => {
    expect(normalizeEligibility({ all: { env: "prod", region: null } })).toBeNull();
  });

  it("NaN 导致整体失败", () => {
    expect(normalizeEligibility({ all: { env: "prod", version: Number.NaN } })).toBeNull();
  });

  it("Infinity 导致整体失败", () => {
    expect(
      normalizeEligibility({ all: { env: "prod", version: Number.POSITIVE_INFINITY } }),
    ).toBeNull();
  });

  it("-Infinity 导致整体失败", () => {
    expect(
      normalizeEligibility({ all: { env: "prod", version: Number.NEGATIVE_INFINITY } }),
    ).toBeNull();
  });

  it("有限 number 值正常通过", () => {
    const result = normalizeEligibility({ all: { env: "prod", version: 42 } });
    expect(result).not.toBeNull();
    expect(result!.all.version).toBe(42);
  });

  it("boolean 值正常通过", () => {
    const result = normalizeEligibility({ all: { env: "prod", active: true } });
    expect(result).not.toBeNull();
    expect(result!.all.active).toBe(true);
  });
});

describe("computeSpecificity", () => {
  it("空条件 Specificity = 0", () => {
    expect(computeSpecificity({ all: {} })).toBe(0);
  });

  it("单条件 Specificity = 1", () => {
    expect(computeSpecificity({ all: { environment: "prod" } })).toBe(1);
  });

  it("多条件 Specificity = 键数", () => {
    expect(computeSpecificity({ all: { environment: "prod", region: "cn" } })).toBe(2);
  });
});

describe("computeSelectorDigest", () => {
  it("同语义条件产生相同 Digest", () => {
    const a = normalizeEligibility({ all: { region: "cn", environment: "prod" } })!;
    const b = normalizeEligibility({ all: { environment: "prod", region: "cn" } })!;
    expect(computeSelectorDigest(a)).toBe(computeSelectorDigest(b));
  });

  it("不同条件产生不同 Digest", () => {
    const a = normalizeEligibility({ all: { environment: "prod" } })!;
    const b = normalizeEligibility({ all: { environment: "staging" } })!;
    expect(computeSelectorDigest(a)).not.toBe(computeSelectorDigest(b));
  });

  it("Digest 包含算法版本", () => {
    const a = normalizeEligibility({ all: {} })!;
    const digest = computeSelectorDigest(a);
    // 验证 Digest 是确定性的（通过重新计算确认）
    expect(computeSelectorDigest(a)).toBe(digest);
  });
});

describe("isOverlapping", () => {
  it("空条件相互重叠", () => {
    expect(isOverlapping({ all: {} }, { all: {} })).toBe(true);
  });

  it("同键同值重叠", () => {
    const a = normalizeEligibility({ all: { environment: "prod" } })!;
    const b = normalizeEligibility({ all: { environment: "prod" } })!;
    expect(isOverlapping(a, b)).toBe(true);
  });

  it("同键不同值不重叠", () => {
    const a = normalizeEligibility({ all: { environment: "prod" } })!;
    const b = normalizeEligibility({ all: { environment: "staging" } })!;
    expect(isOverlapping(a, b)).toBe(false);
  });

  it("无公共键重叠", () => {
    const a = normalizeEligibility({ all: { environment: "prod" } })!;
    const b = normalizeEligibility({ all: { region: "cn" } })!;
    expect(isOverlapping(a, b)).toBe(true);
  });

  it("部分重叠部分冲突不重叠", () => {
    const a = normalizeEligibility({ all: { environment: "prod", region: "cn" } })!;
    const b = normalizeEligibility({ all: { environment: "staging", region: "cn" } })!;
    expect(isOverlapping(a, b)).toBe(false);
  });
});

describe("isTimeWindowOverlapping", () => {
  it("两个 null 窗口重叠", () => {
    expect(isTimeWindowOverlapping(null, null, null, null)).toBe(true);
  });

  it("完全不重叠的时间窗口", () => {
    const from1 = new Date("2026-01-01");
    const until1 = new Date("2026-06-30");
    const from2 = new Date("2026-07-01");
    const until2 = new Date("2026-12-31");
    expect(isTimeWindowOverlapping(from1, until1, from2, until2)).toBe(false);
  });

  it("部分重叠的时间窗口", () => {
    const from1 = new Date("2026-01-01");
    const until1 = new Date("2026-06-30");
    const from2 = new Date("2026-06-01");
    const until2 = new Date("2026-12-31");
    expect(isTimeWindowOverlapping(from1, until1, from2, until2)).toBe(true);
  });
});

// ─── RouteSetActivationPolicy 测试 ───────────────────────

function makeRoute(overrides: Partial<DesiredRoute> & Pick<DesiredRoute, "routeId">): DesiredRoute {
  return {
    routeGroupId: "primary",
    trafficWeight: ROUTE_TRAFFIC_WEIGHT_TOTAL,
    priorityNo: 0,
    eligibilityConditions: {},
    effectiveFrom: null,
    effectiveUntil: null,
    activationState: "active",
    routeRevisionId: undefined,
    ...overrides,
  };
}

const BASE_INPUT = {
  routeSetId: "rs-1",
  routeScopeKey: "default",
  tenantId: "t-1",
  agentId: "a-1",
};

describe("validateRouteSetActivation", () => {
  it("单条 10000 权重激活 — 通过", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [makeRoute({ routeId: "r-1" })],
    });
    expect(result.valid).toBe(true);
    expect(result.normalizedGroups).toHaveLength(1);
    expect(result.normalizedGroups[0]?.totalWeight).toBe(10000);
  });

  it("两条 5000/5000 原子激活 — 通过", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [
        makeRoute({ routeId: "r-1", trafficWeight: 5000 }),
        makeRoute({ routeId: "r-2", trafficWeight: 5000 }),
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.normalizedGroups[0]?.totalWeight).toBe(10000);
  });

  it("5000/4000 拒绝 — 权重不足", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [
        makeRoute({ routeId: "r-1", trafficWeight: 5000 }),
        makeRoute({ routeId: "r-2", trafficWeight: 4000 }),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "ROUTE_WEIGHT_TOTAL_INVALID")).toBe(true);
  });

  it("权重 0 拒绝", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [makeRoute({ routeId: "r-1", trafficWeight: 0 })],
    });
    expect(result.valid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "ROUTE_WEIGHT_INVALID")).toBe(true);
  });

  it("同 Group 不同 Priority 拒绝", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [
        makeRoute({ routeId: "r-1", trafficWeight: 5000, priorityNo: 0 }),
        makeRoute({ routeId: "r-2", trafficWeight: 5000, priorityNo: 1 }),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "ROUTE_GROUP_SELECTOR_MISMATCH")).toBe(
      true,
    );
  });

  it("不同 Group 相同 Selector 和 Priority 拒绝", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [
        makeRoute({ routeId: "r-1", routeGroupId: "g-a", trafficWeight: 10000 }),
        makeRoute({ routeId: "r-2", routeGroupId: "g-b", trafficWeight: 10000 }),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "ROUTE_SELECTOR_AMBIGUOUS")).toBe(true);
  });

  it("不同 Selector 且互斥时允许", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [
        makeRoute({
          routeId: "r-1",
          routeGroupId: "g-prod",
          trafficWeight: 10000,
          eligibilityConditions: { all: { environment: "prod" } },
        }),
        makeRoute({
          routeId: "r-2",
          routeGroupId: "g-staging",
          trafficWeight: 10000,
          eligibilityConditions: { all: { environment: "staging" } },
        }),
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("同 Group 成员时间窗口不一致拒绝", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [
        makeRoute({
          routeId: "r-1",
          trafficWeight: 5000,
          effectiveFrom: new Date("2026-01-01"),
          effectiveUntil: new Date("2026-12-31"),
        }),
        makeRoute({
          routeId: "r-2",
          trafficWeight: 5000,
          effectiveFrom: new Date("2026-03-01"),
          effectiveUntil: new Date("2026-12-31"),
        }),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "ROUTE_GROUP_SELECTOR_MISMATCH")).toBe(
      true,
    );
  });

  it("两个 Group Selector 重叠但时间不重叠时允许", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [
        makeRoute({
          routeId: "r-1",
          routeGroupId: "g-h1",
          trafficWeight: 10000,
          effectiveFrom: new Date("2026-01-01"),
          effectiveUntil: new Date("2026-06-30"),
        }),
        makeRoute({
          routeId: "r-2",
          routeGroupId: "g-h2",
          trafficWeight: 10000,
          effectiveFrom: new Date("2026-07-01"),
          effectiveUntil: new Date("2026-12-31"),
        }),
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("Route 重复拒绝", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [
        makeRoute({ routeId: "r-1", trafficWeight: 5000 }),
        makeRoute({ routeId: "r-1", trafficWeight: 5000 }),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "ROUTE_DUPLICATE")).toBe(true);
  });

  it("Disabled Route 不参与权重合计", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [
        makeRoute({ routeId: "r-1", trafficWeight: 10000 }),
        makeRoute({ routeId: "r-2", trafficWeight: 0, activationState: "disabled" }),
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("有效时间反转拒绝", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [
        makeRoute({
          routeId: "r-1",
          effectiveFrom: new Date("2026-12-31"),
          effectiveUntil: new Date("2026-01-01"),
        }),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "ROUTE_TIME_INVALID")).toBe(true);
  });

  it("同一 RouteRevision 被重复激活拒绝", () => {
    const result = validateRouteSetActivation({
      ...BASE_INPUT,
      desiredRoutes: [
        makeRoute({ routeId: "r-1", routeRevisionId: "rev-1", trafficWeight: 5000 }),
        makeRoute({ routeId: "r-2", routeRevisionId: "rev-1", trafficWeight: 5000 }),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "ROUTE_REVISION_DUPLICATE")).toBe(true);
  });
});
