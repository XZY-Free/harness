import { describe, expect, it } from "vitest";
import {
  isValidPlanTransition,
  CutoverPlanStateError,
  type CutoverPlanState,
} from "@/lib/control-plane/cutover/domain/cutover-plan";
import {
  isValidItemTransition,
  itemNeedsRequalification,
  itemIsClaimable,
  computeNextAttemptAt,
  type CutoverItemState,
  type QualificationCategory,
} from "@/lib/control-plane/cutover/domain/cutover-item";
import type { ControlPlaneCutoverItem } from "@/lib/control-plane/cutover/domain/cutover-item";

// ─── CutoverPlan 状态机测试 ─────────────────────────────────

describe("isValidPlanTransition", () => {
  it("draft → inventory_complete 允许", () => {
    expect(isValidPlanTransition("draft", "inventory_complete")).toBe(true);
  });

  it("draft → cancelled 允许", () => {
    expect(isValidPlanTransition("draft", "cancelled")).toBe(true);
  });

  it("draft → requalifying 禁止", () => {
    expect(isValidPlanTransition("draft", "requalifying")).toBe(false);
  });

  it("inventory_complete → requalifying 允许", () => {
    expect(isValidPlanTransition("inventory_complete", "requalifying")).toBe(true);
  });

  it("requalifying → ready_to_activate 允许", () => {
    expect(isValidPlanTransition("requalifying", "ready_to_activate")).toBe(true);
  });

  it("requalifying → failed 允许", () => {
    expect(isValidPlanTransition("requalifying", "failed")).toBe(true);
  });

  it("ready_to_activate → activated 允许", () => {
    expect(isValidPlanTransition("ready_to_activate", "activated")).toBe(true);
  });

  it("ready_to_activate → failed 允许", () => {
    expect(isValidPlanTransition("ready_to_activate", "failed")).toBe(true);
  });

  it("activated → draft 禁止（终态）", () => {
    expect(isValidPlanTransition("activated", "draft")).toBe(false);
  });

  it("failed → any 禁止（终态）", () => {
    expect(isValidPlanTransition("failed", "draft")).toBe(false);
    expect(isValidPlanTransition("failed", "requalifying")).toBe(false);
  });

  it("cancelled → any 禁止（终态）", () => {
    expect(isValidPlanTransition("cancelled", "draft")).toBe(false);
  });
});

describe("CutoverPlanStateError", () => {
  it("包含 planId 和状态信息", () => {
    const err = new CutoverPlanStateError("plan-1", "draft", "activated");
    expect(err.name).toBe("CutoverPlanStateError");
    expect(err.planId).toBe("plan-1");
    expect(err.message).toContain("draft");
    expect(err.message).toContain("activated");
  });
});

// ─── CutoverItem 状态机测试 ─────────────────────────────────

describe("isValidItemTransition", () => {
  it("pending → artifact_pending 允许", () => {
    expect(isValidItemTransition("pending", "artifact_pending")).toBe(true);
  });

  it("pending → ready 允许（trusted 直接就绪）", () => {
    expect(isValidItemTransition("pending", "ready")).toBe(true);
  });

  it("artifact_pending → attestation_pending 允许", () => {
    expect(isValidItemTransition("artifact_pending", "attestation_pending")).toBe(true);
  });

  it("attestation_pending → conformance_pending 允许（Runtime需要Conformance）", () => {
    expect(isValidItemTransition("attestation_pending", "conformance_pending")).toBe(true);
  });

  it("attestation_pending → publication_pending 允许（Agent不需要Conformance）", () => {
    expect(isValidItemTransition("attestation_pending", "publication_pending")).toBe(true);
  });

  it("conformance_pending → publication_pending 允许", () => {
    expect(isValidItemTransition("conformance_pending", "publication_pending")).toBe(true);
  });

  it("publication_pending → ready 允许", () => {
    expect(isValidItemTransition("publication_pending", "ready")).toBe(true);
  });

  it("failed → pending 允许（重试）", () => {
    expect(isValidItemTransition("failed", "pending")).toBe(true);
  });

  it("manual_review → pending 允许（人工干预后重试）", () => {
    expect(isValidItemTransition("manual_review", "pending")).toBe(true);
  });

  it("ready → pending 禁止（终态）", () => {
    expect(isValidItemTransition("ready", "pending")).toBe(false);
  });

  it("pending → publication_pending 禁止（需先经过中间步骤）", () => {
    expect(isValidItemTransition("pending", "publication_pending")).toBe(false);
  });
});

// ─── Item 辅助判断 ────────────────────────────────────────────

function makeItem(overrides: Partial<ControlPlaneCutoverItem>): ControlPlaneCutoverItem {
  return {
    id: "item-1",
    planId: "plan-1",
    tenantId: "t-1",
    subjectType: "agent_revision",
    sourceSubjectId: "rev-1",
    replacementSubjectId: null,
    state: "pending",
    qualificationCategory: "legacy_projection_only",
    attemptCount: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("itemNeedsRequalification", () => {
  it("trusted → 不需要重建", () => {
    expect(itemNeedsRequalification(makeItem({ qualificationCategory: "trusted" }))).toBe(false);
  });

  it("legacy_projection_only 且 ready → 不需要重建", () => {
    expect(
      itemNeedsRequalification(
        makeItem({ qualificationCategory: "legacy_projection_only", state: "ready" }),
      ),
    ).toBe(false);
  });

  it("legacy_projection_only 且 pending → 需要重建", () => {
    expect(
      itemNeedsRequalification(
        makeItem({ qualificationCategory: "legacy_projection_only", state: "pending" }),
      ),
    ).toBe(true);
  });

  it("missing_attestation → 需要重建", () => {
    expect(
      itemNeedsRequalification(makeItem({ qualificationCategory: "missing_attestation" })),
    ).toBe(true);
  });
});

describe("itemIsClaimable", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("pending 无租约 → 可领取", () => {
    expect(itemIsClaimable(makeItem({ state: "pending" }), now)).toBe(true);
  });

  it("ready → 不可领取", () => {
    expect(itemIsClaimable(makeItem({ state: "ready" }), now)).toBe(false);
  });

  it("manual_review → 不可领取", () => {
    expect(itemIsClaimable(makeItem({ state: "manual_review" }), now)).toBe(false);
  });

  it("租约未过期 → 不可领取", () => {
    const future = new Date(now.getTime() + 60_000);
    expect(
      itemIsClaimable(makeItem({ state: "pending", leaseExpiresAt: future }), now),
    ).toBe(false);
  });

  it("租约已过期 → 可领取", () => {
    const past = new Date(now.getTime() - 60_000);
    expect(
      itemIsClaimable(makeItem({ state: "pending", leaseExpiresAt: past }), now),
    ).toBe(true);
  });

  it("nextAttemptAt 在未来 → 不可领取", () => {
    const future = new Date(now.getTime() + 60_000);
    expect(
      itemIsClaimable(makeItem({ state: "pending", nextAttemptAt: future }), now),
    ).toBe(false);
  });

  it("nextAttemptAt 已过 → 可领取", () => {
    const past = new Date(now.getTime() - 60_000);
    expect(
      itemIsClaimable(makeItem({ state: "pending", nextAttemptAt: past }), now),
    ).toBe(true);
  });
});

describe("computeNextAttemptAt", () => {
  it("attemptCount=0 退避为 baseMs", () => {
    const result = computeNextAttemptAt(0, 5_000, 300_000);
    expect(result.getTime()).toBeGreaterThan(Date.now() + 4_000);
    expect(result.getTime()).toBeLessThanOrEqual(Date.now() + 6_000);
  });

  it("attemptCount=3 退避为 baseMs * 2^3 = 40s", () => {
    const result = computeNextAttemptAt(3, 5_000, 300_000);
    expect(result.getTime()).toBeGreaterThan(Date.now() + 35_000);
    expect(result.getTime()).toBeLessThanOrEqual(Date.now() + 45_000);
  });

  it("不超过 maxMs", () => {
    const result = computeNextAttemptAt(20, 5_000, 300_000);
    expect(result.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
  });
});
