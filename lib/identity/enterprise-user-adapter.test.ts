import {
  type EnterpriseUserAdapter,
  EnterpriseUserAdapterConfigurationError,
  EnterpriseUserAdapterRegistry,
  type EnterpriseUserAdapterSubject,
} from "@/lib/identity/enterprise-user-adapter";
import { describe, expect, it, vi } from "vitest";

const subject: EnterpriseUserAdapterSubject = {
  tenantId: "tenant-100",
  tenantKey: "acme",
  externalSubject: "employee-100",
  email: "employee-100@example.test",
  displayName: "张三",
};

describe("EnterpriseUserAdapterRegistry", () => {
  it("default 模式只使用标准身份形成无企业扩展资料的完整快照", async () => {
    const adapter = new EnterpriseUserAdapterRegistry("default").resolve();

    await expect(adapter.fetchFullProfile(subject)).resolves.toEqual({
      externalSubject: "employee-100",
      email: "employee-100@example.test",
      displayName: "张三",
      status: "active",
      sourceSystem: "snowharness-default",
      attributes: {},
    });
  });

  it("enterprise 模式未注册实现时，以稳定配置错误失败，不回退 default", () => {
    expect(() => new EnterpriseUserAdapterRegistry("enterprise").resolve()).toThrow(
      EnterpriseUserAdapterConfigurationError,
    );
    try {
      new EnterpriseUserAdapterRegistry("enterprise").resolve();
    } catch (error) {
      expect((error as EnterpriseUserAdapterConfigurationError).code).toBe(
        "enterprise_user_adapter_not_registered",
      );
    }
  });

  it("enterprise 模式只使用启动前注册的企业适配器", async () => {
    const fetchFullProfile = vi.fn<EnterpriseUserAdapter["fetchFullProfile"]>().mockResolvedValue({
      externalSubject: "employee-100",
      email: "employee-100@example.test",
      displayName: "张三",
      status: "active",
      sourceSystem: "private-directory",
      attributes: { employeeNo: "E-100" },
    });
    const enterpriseAdapter: EnterpriseUserAdapter = {
      kind: "enterprise",
      fetchFullProfile,
    };
    const registry = new EnterpriseUserAdapterRegistry("enterprise");
    registry.registerEnterpriseAdapter(enterpriseAdapter);

    const selected = registry.resolve();
    await selected.fetchFullProfile(subject);

    expect(selected).toBe(enterpriseAdapter);
    expect(fetchFullProfile).toHaveBeenCalledOnce();
    expect(fetchFullProfile).toHaveBeenCalledWith(subject);
    expect(() => registry.registerEnterpriseAdapter(enterpriseAdapter)).toThrow(
      EnterpriseUserAdapterConfigurationError,
    );
  });
});
