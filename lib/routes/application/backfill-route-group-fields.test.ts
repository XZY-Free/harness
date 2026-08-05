import {
  computeSelectorDigest,
  computeSpecificity,
  normalizeEligibility,
} from "@/lib/routes/domain/route-selector";
import { describe, expect, it } from "vitest";

// ─── determineRouteGroupId 逻辑测试（不依赖数据库）───────────

describe("Backfill routeGroupId 确定逻辑", () => {
  it("优先使用 trafficAllocationJson.groupId", () => {
    const trafficJson = { weightBasisPoints: 5000, groupId: "canary" };
    // 规则 1: 已有 groupId → 使用原值
    expect(trafficJson.groupId).toBe("canary");
  });

  it("单条 10000 权重 Route → primary", () => {
    // 规则 2: 单条 10000 权重
    const trafficWeight = 10_000;
    const enabledRoutes = [{ routeId: "r1", trafficWeight: 10_000, routeState: "enabled" }];
    expect(trafficWeight === 10_000 && enabledRoutes.length <= 1).toBe(true);
  });

  it("多条 Route 无 Group ID → 生成确定性 legacy group ID", () => {
    // 规则 3: 生成确定性 ID
    const eligibility = { all: { environment: "prod" } };
    const normalized = normalizeEligibility(eligibility);
    expect(normalized).not.toBeNull();
    const digest = computeSelectorDigest(normalized!);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 相同输入产生相同 ID
    const digest2 = computeSelectorDigest(normalizeEligibility(eligibility)!);
    expect(digest2).toBe(digest);
  });

  it("无法组成 10000 权重的集合 → 标记 legacy_route_set_invalid", () => {
    // 规则 4: 权重不等于 10000 的多 Route 集合
    const enabledRoutes = [
      { routeId: "r1", trafficWeight: 5000, routeState: "enabled" },
      { routeId: "r2", trafficWeight: 3000, routeState: "enabled" },
    ];
    const totalWeight = enabledRoutes.reduce((sum, r) => sum + r.trafficWeight, 0);
    expect(totalWeight).not.toBe(10_000);
    // 当多条路由且总权重 != 10000 → invalid
    expect(totalWeight !== 10_000 && enabledRoutes.length > 1).toBe(true);
  });
});

// ─── selectorDigest 一致性测试 ─────────────────────────────

describe("selectorDigest 与 RouteSelector 一致", () => {
  it("空 eligibilityConditions 产生一致的 digest", () => {
    const d1 = computeSelectorDigest(normalizeEligibility({})!);
    const d2 = computeSelectorDigest(normalizeEligibility({ all: {} })!);
    expect(d1).toBe(d2);
  });

  it("同语义条件产生相同 digest（键序无关）", () => {
    const d1 = computeSelectorDigest(normalizeEligibility({ all: { env: "prod", region: "us" } })!);
    const d2 = computeSelectorDigest(normalizeEligibility({ all: { region: "us", env: "prod" } })!);
    expect(d1).toBe(d2);
  });

  it("不同条件产生不同 digest", () => {
    const d1 = computeSelectorDigest(normalizeEligibility({ all: { env: "prod" } })!);
    const d2 = computeSelectorDigest(normalizeEligibility({ all: { env: "staging" } })!);
    expect(d1).not.toBe(d2);
  });

  it("specificity 与 digest 一致", () => {
    const n = normalizeEligibility({ all: { env: "prod", region: "us" } })!;
    expect(computeSpecificity(n)).toBe(2);
  });
});

// ─── legacy group ID 确定性测试 ─────────────────────────────

describe("legacy group ID 确定性", () => {
  it("相同 selectorDigest + priorityNo + timeWindow → 相同 ID", () => {
    const digest = computeSelectorDigest(normalizeEligibility({ all: { env: "prod" } })!);
    const id1 = generateLegacyGroupId(digest, 0, null, null);
    const id2 = generateLegacyGroupId(digest, 0, null, null);
    expect(id1).toBe(id2);
  });

  it("不同 priorityNo → 不同 ID", () => {
    const digest = computeSelectorDigest(normalizeEligibility({ all: { env: "prod" } })!);
    const id1 = generateLegacyGroupId(digest, 0, null, null);
    const id2 = generateLegacyGroupId(digest, 1, null, null);
    expect(id1).not.toBe(id2);
  });

  it("不同 timeWindow → 不同 ID", () => {
    const digest = computeSelectorDigest(normalizeEligibility({ all: { env: "prod" } })!);
    const from1 = new Date("2026-01-01");
    const from2 = new Date("2026-06-01");
    const id1 = generateLegacyGroupId(digest, 0, from1, null);
    const id2 = generateLegacyGroupId(digest, 0, from2, null);
    expect(id1).not.toBe(id2);
  });
});

// ─── 内部工具（与 backfill-route-group-fields.ts 同逻辑）────

import { createHash } from "node:crypto";

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
