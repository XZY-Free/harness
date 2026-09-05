import {
  EnterpriseUserAccessPolicyError,
  EnterpriseUserContextRequirementError,
  buildEnterpriseUserContext,
  parseEnterpriseUserAccessPolicy,
} from "@/lib/identity/enterprise-user-access-policy";
import { describe, expect, it } from "vitest";

describe("企业用户安全投影策略", () => {
  it("未声明时使用 none，声明 permissions/dataScopes 或未知字段时拒绝", () => {
    expect(parseEnterpriseUserAccessPolicy({})).toEqual({
      profileRequirement: "none",
      allowedFields: [],
    });
    for (const raw of [
      {
        enterprise_user_context: {
          profile_requirement: "stale_allowed",
          allowed_fields: ["enterprisePermissions"],
        },
      },
      {
        enterprise_user_context: {
          profile_requirement: "stale_allowed",
          allowed_fields: ["unknown"],
        },
      },
      {
        enterprise_user_context: {
          profile_requirement: "none",
          allowed_fields: ["employeeNo"],
        },
      },
    ]) {
      expect(() => parseEnterpriseUserAccessPolicy(raw)).toThrow(EnterpriseUserAccessPolicyError);
    }
  });

  it("按 allowlist 投影字段，绝不带出未允许字段", () => {
    const policy = parseEnterpriseUserAccessPolicy({
      enterprise_user_context: {
        profile_requirement: "stale_allowed",
        allowed_fields: ["employeeNo", "departmentCode"],
      },
    });
    const context = buildEnterpriseUserContext(policy, {
      profileStatus: "stale",
      lastVerifiedAt: new Date("2026-09-05T00:00:00.000Z"),
      attributes: {
        employeeNo: "E-001",
        departmentCode: "D-01",
        enterprisePermissions: ["payroll.read"],
      },
    });
    expect(context).toEqual({
      context_version: "1",
      profile_status: "stale",
      last_verified_at: "2026-09-05T00:00:00.000Z",
      fields: { departmentCode: "D-01", employeeNo: "E-001" },
    });
  });

  it("fresh_required 在 stale/unavailable/disabled 时 fail closed", () => {
    const policy = parseEnterpriseUserAccessPolicy({
      enterprise_user_context: {
        profile_requirement: "fresh_required",
        allowed_fields: [],
      },
    });
    for (const profileStatus of ["stale", "unavailable", "disabled"] as const) {
      expect(() =>
        buildEnterpriseUserContext(policy, {
          profileStatus,
          lastVerifiedAt: profileStatus === "unavailable" ? null : new Date(),
          attributes: {},
        }),
      ).toThrow(EnterpriseUserContextRequirementError);
    }
  });
});
