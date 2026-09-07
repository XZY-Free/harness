import {
  type EnterpriseProfileObservation,
  EnterpriseProfileObservationError,
  type EnterpriseProfileSource,
  validateEnterpriseProfileObservation,
} from "@/lib/identity/enterprise-profile-source";
import { describe, expect, it } from "vitest";

const source: EnterpriseProfileSource = {
  sourceSystem: "directory",
  trusted: true,
  maxFreshAgeMs: 60 * 60_000,
  maxStaleAgeMs: 2 * 60 * 60_000,
};

const now = new Date("2026-09-07T00:00:00.000Z");

function observation(
  overrides: Partial<EnterpriseProfileObservation> = {},
): EnterpriseProfileObservation {
  return {
    tenantId: "tenant-1",
    externalSubject: "employee-1",
    sourceSystem: "directory",
    attributes: { employeeNo: "E-1" },
    verifiedAt: new Date("2026-09-07T00:00:00.000Z"),
    freshUntil: new Date("2026-09-07T00:30:00.000Z"),
    staleUntil: new Date("2026-09-07T01:30:00.000Z"),
    ...overrides,
  };
}

describe("enterprise profile observation contract", () => {
  it("接受合法观察并只返回规范化属性", () => {
    const result = validateEnterpriseProfileObservation(observation(), source, now);
    expect(result.attributes).toEqual({ employeeNo: "E-1" });
  });

  it.each([
    ["sourceSystem 不匹配", { sourceSystem: "other" }],
    ["freshUntil 早于 verifiedAt", { freshUntil: new Date("2026-09-06T23:59:59.000Z") }],
    ["staleUntil 早于 freshUntil", { staleUntil: new Date("2026-09-07T00:29:59.000Z") }],
    ["fresh 超出来源上限", { freshUntil: new Date("2026-09-07T02:00:00.000Z") }],
    ["未来验证时间超过容差", { verifiedAt: new Date("2026-09-07T00:01:01.000Z") }],
  ])("拒绝%s", (_label, overrides) => {
    expect(() => validateEnterpriseProfileObservation(observation(overrides), source, now)).toThrow(
      EnterpriseProfileObservationError,
    );
  });

  it("未受信来源不能接纳", () => {
    expect(() =>
      validateEnterpriseProfileObservation(observation(), { ...source, trusted: false }, now),
    ).toThrowError(/资料来源未受信/);
  });
});
