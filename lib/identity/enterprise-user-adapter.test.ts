import {
  type EnterpriseUserAdapter,
  EnterpriseUserAdapterConfigurationError,
  EnterpriseUserAdapterRegistry,
  type EnterpriseUserAdapterResult,
  type EnterpriseUserAdapterSubject,
} from "@/lib/identity/enterprise-user-adapter";
import { assertEnterpriseUserAdapterReady } from "@/lib/identity/enterprise-user-bootstrap";
import { describe, expect, it, vi } from "vitest";

const subject: EnterpriseUserAdapterSubject = {
  tenantId: "tenant-100",
  tenantKey: "acme",
  externalSubject: "employee-100",
  email: "employee-100@example.test",
  displayName: "张三",
};

describe("EnterpriseUserAdapterRegistry", () => {
  it("default 模式继续只选择标准身份，不要求企业扩展资料", () => {
    const adapter = new EnterpriseUserAdapterRegistry("default").resolve();

    expect(adapter.kind).toBe("default");
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
    const resolveUser = vi.fn<EnterpriseUserAdapter["resolveUser"]>().mockResolvedValue({
      status: "fresh",
      profile: {
        externalSubject: "employee-100",
        email: "employee-100@example.test",
        displayName: "张三",
        status: "active",
        sourceSystem: "private-directory",
        attributes: { employeeNo: "E-100" },
      },
    } satisfies EnterpriseUserAdapterResult);
    const enterpriseAdapter: EnterpriseUserAdapter = {
      kind: "enterprise",
      resolveUser,
    };
    const registry = new EnterpriseUserAdapterRegistry("enterprise");
    registry.registerEnterpriseAdapter(enterpriseAdapter);

    const selected = registry.resolve();
    if (selected.kind !== "enterprise") throw new Error("未选择 enterprise adapter");
    await selected.resolveUser({
      subject,
      trustedAuthenticationClaims: { employee_number: "E-100" },
    });

    expect(selected).toBe(enterpriseAdapter);
    expect(resolveUser).toHaveBeenCalledOnce();
    expect(resolveUser).toHaveBeenCalledWith({
      subject,
      trustedAuthenticationClaims: { employee_number: "E-100" },
    });
    expect(() => registry.registerEnterpriseAdapter(enterpriseAdapter)).toThrow(
      EnterpriseUserAdapterConfigurationError,
    );
  });

  it("同一 SPI 同时支持 Claims 直转和外部目录补全两种流程", async () => {
    const directClaimsAdapter: EnterpriseUserAdapter = {
      kind: "enterprise",
      async resolveUser(context) {
        const employeeNumber = context.trustedAuthenticationClaims.employee_number;
        if (typeof employeeNumber !== "string") return { status: "unavailable" };
        return {
          status: "fresh",
          profile: {
            externalSubject: context.subject.externalSubject,
            email: context.subject.email,
            displayName: context.subject.displayName,
            status: "active",
            sourceSystem: "claims-directory",
            attributes: { employeeNo: employeeNumber },
          },
        };
      },
    };
    const direct = await directClaimsAdapter.resolveUser({
      subject,
      trustedAuthenticationClaims: { employee_number: "E-100" },
    });
    expect(direct).toMatchObject({
      status: "fresh",
      profile: { attributes: { employeeNo: "E-100" } },
    });

    const directoryLookup = vi.fn(async (directoryKey: string) => ({
      employeeNo: `directory-${directoryKey}`,
      departmentCode: "D-200",
    }));
    const externalEnrichmentAdapter: EnterpriseUserAdapter = {
      kind: "enterprise",
      async resolveUser(context) {
        const directoryKey = context.subject.externalSubject;
        const profile = await directoryLookup(directoryKey);
        return {
          status: "fresh",
          profile: {
            externalSubject: context.subject.externalSubject,
            email: context.subject.email,
            displayName: context.subject.displayName,
            status: "active",
            sourceSystem: "external-directory",
            attributes: profile,
          },
        };
      },
    };
    const enriched = await externalEnrichmentAdapter.resolveUser({
      subject,
      trustedAuthenticationClaims: { directory_access: "verified" },
    });
    expect(directoryLookup).toHaveBeenCalledWith(subject.externalSubject);
    expect(enriched).toMatchObject({
      status: "fresh",
      profile: { attributes: { employeeNo: "directory-employee-100", departmentCode: "D-200" } },
    });
  });

  it("bootstrap readiness 在 default 放行、enterprise 未注册时失败关闭", () => {
    expect(() =>
      assertEnterpriseUserAdapterReady(new EnterpriseUserAdapterRegistry("default")),
    ).not.toThrow();
    expect(() =>
      assertEnterpriseUserAdapterReady(new EnterpriseUserAdapterRegistry("enterprise")),
    ).toThrowError(expect.objectContaining({ code: "enterprise_user_adapter_not_registered" }));
  });
});
