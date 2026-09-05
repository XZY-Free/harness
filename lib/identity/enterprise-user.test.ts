/**
 * 企业用户资料合同：无具体企业目录连接器时，仍须保证所有部署方适配器
 * 产出的完整快照有相同的规范化、校验和指纹语义。
 */
import {
  EnterpriseProfileValidationError,
  type EnterpriseUserProfileSnapshot,
  computeEnterpriseProfileFingerprint,
  normalizeEnterpriseUserProfile,
} from "@/lib/identity/enterprise-user";
import { describe, expect, it } from "vitest";

const profile: EnterpriseUserProfileSnapshot = {
  externalSubject: "employee-100",
  email: "employee-100@example.test",
  displayName: "张三",
  status: "active",
  sourceSystem: "enterprise-directory",
  attributes: {
    employeeNo: "E-100",
    departmentCode: "D-01",
    buCode: "BU-01",
    factoryCode: "F-01",
    jobLevel: "L5",
    enterprisePermissions: ["leave:read", "leave:write"],
    dataScopes: [
      { factoryCode: "F-02", scopeType: "factory" },
      { factoryCode: "F-01", scopeType: "factory" },
    ],
  },
};

function expectValidationCode(
  action: () => unknown,
  code:
    | "enterprise_profile_status_invalid"
    | "enterprise_profile_attribute_unknown"
    | "enterprise_profile_attribute_type_invalid",
) {
  try {
    action();
    throw new Error("预期企业资料校验失败");
  } catch (error) {
    expect(error).toBeInstanceOf(EnterpriseProfileValidationError);
    expect((error as EnterpriseProfileValidationError).code).toBe(code);
  }
}

describe("enterprise-user profile normalization", () => {
  it("同一完整企业事实在字段、集合和 JSON 键顺序不同的情况下产生同一指纹", () => {
    const reordered: EnterpriseUserProfileSnapshot = {
      status: "active",
      displayName: "张三",
      email: "employee-100@example.test",
      externalSubject: "employee-100",
      sourceSystem: "enterprise-directory",
      attributes: {
        dataScopes: [
          { scopeType: "factory", factoryCode: "F-01" },
          { scopeType: "factory", factoryCode: "F-02" },
        ],
        enterprisePermissions: ["leave:write", "leave:read"],
        jobLevel: "L5",
        factoryCode: "F-01",
        buCode: "BU-01",
        departmentCode: "D-01",
        employeeNo: "E-100",
      },
    };

    const normalized = normalizeEnterpriseUserProfile(profile);
    const reorderedNormalized = normalizeEnterpriseUserProfile(reordered);

    expect(reorderedNormalized).toEqual(normalized);
    expect(computeEnterpriseProfileFingerprint(reorderedNormalized)).toBe(
      computeEnterpriseProfileFingerprint(normalized),
    );
  });

  it("把企业 disabled 与 inactive 统一映射为 SnowHarness disabled", () => {
    expect(normalizeEnterpriseUserProfile({ ...profile, status: "disabled" }).status).toBe(
      "disabled",
    );
    expect(normalizeEnterpriseUserProfile({ ...profile, status: "inactive" }).status).toBe(
      "disabled",
    );
  });

  it("未知状态、未知字段和字段类型错误均以稳定分类失败关闭", () => {
    expectValidationCode(
      () => normalizeEnterpriseUserProfile({ ...profile, status: "pending" }),
      "enterprise_profile_status_invalid",
    );
    expectValidationCode(
      () =>
        normalizeEnterpriseUserProfile({
          ...profile,
          attributes: { ...profile.attributes, unsupportedAttribute: "value" },
        }),
      "enterprise_profile_attribute_unknown",
    );
    expectValidationCode(
      () =>
        normalizeEnterpriseUserProfile({
          ...profile,
          attributes: { ...profile.attributes, jobLevel: 5 },
        }),
      "enterprise_profile_attribute_type_invalid",
    );
  });
});
