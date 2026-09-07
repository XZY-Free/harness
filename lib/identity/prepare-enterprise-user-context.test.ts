import {
  type EnterpriseProfileQualityInput,
  classifyEnterpriseProfileQuality,
  shouldBackoffEnterpriseProfileRefresh,
} from "@/lib/identity/prepare-enterprise-user-context";
import { describe, expect, it } from "vitest";

const base: EnterpriseProfileQualityInput = {
  now: new Date("2026-09-07T00:30:00.000Z"),
  lastVerifiedAt: new Date("2026-09-07T00:00:00.000Z"),
  freshUntil: new Date("2026-09-07T01:00:00.000Z"),
  staleUntil: new Date("2026-09-07T02:00:00.000Z"),
  maxFreshAgeMs: 60 * 60_000,
  maxStaleAgeMs: 2 * 60 * 60_000,
};

describe("classifyEnterpriseProfileQuality", () => {
  it("边界相等即到期，fresh_required 不接受 stale", () => {
    expect(
      classifyEnterpriseProfileQuality({ ...base, now: new Date("2026-09-07T01:00:00.000Z") }),
    ).toBe("stale");
    expect(
      classifyEnterpriseProfileQuality({
        ...base,
        now: new Date("2026-09-07T02:00:00.000Z"),
      }),
    ).toBe("expired");
  });

  it("部署来源收紧期限时取更早截止，不能由放宽策略延长已存观察", () => {
    expect(classifyEnterpriseProfileQuality({ ...base, maxFreshAgeMs: 10 * 60_000 })).toBe("stale");
  });

  it("资料来源失败后只在短退避窗口内禁止重复刷新", () => {
    const updatedAt = new Date("2026-09-07T00:30:00.000Z");
    expect(
      shouldBackoffEnterpriseProfileRefresh({
        lastSyncErrorCode: "source_unavailable",
        updatedAt,
        now: new Date("2026-09-07T00:30:29.999Z"),
      }),
    ).toBe(true);
    expect(
      shouldBackoffEnterpriseProfileRefresh({
        lastSyncErrorCode: "source_unavailable",
        updatedAt,
        now: new Date("2026-09-07T00:30:30.000Z"),
      }),
    ).toBe(false);
    expect(
      shouldBackoffEnterpriseProfileRefresh({
        lastSyncErrorCode: null,
        updatedAt,
        now: new Date("2026-09-07T00:30:01.000Z"),
      }),
    ).toBe(false);
  });
});
