/** 企业扩展资料 Authority：真实 MySQL 的唯一键与独立同步元数据。 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import {
  type EnterpriseUserAdapter,
  type EnterpriseUserAdapterContext,
  EnterpriseUserAdapterRegistry,
  type EnterpriseUserAdapterResult,
} from "@/lib/identity/enterprise-user-adapter";
import {
  getEnterpriseUserProfileFacts,
  upsertEnterpriseProfileSyncState,
  upsertEnterpriseUserAttribute,
} from "@/lib/identity/enterprise-user-profile-queries";
import { syncEnterpriseUserProfile } from "@/lib/identity/enterprise-user-sync";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  enterpriseProfileSyncState,
  userExtensionAttribute,
} from "@/lib/persistence/schema/identity";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

describe("enterprise user profile persistence", () => {
  it("每个用户的扩展属性 key 和同步元数据各自唯一，且不污染 UserIdentity", async () => {
    const tenant = await ensureDefaultTenant();
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "employee-100",
      email: "employee-100@example.test",
      displayName: "张三",
    });

    await upsertEnterpriseUserAttribute(tenant.id, identity.id, {
      attributeKey: "employeeNo",
      valueType: "string",
      value: "E-100",
      sourceSystem: "enterprise-directory",
    });
    await upsertEnterpriseProfileSyncState(tenant.id, identity.id, {
      profileFingerprint: `sha256:${"a".repeat(64)}`,
      lastVerifiedAt: new Date("2026-09-05T00:00:00.000Z"),
      stale: false,
      lastSyncErrorCode: null,
      sourceSystem: "enterprise-directory",
    });

    const facts = await getEnterpriseUserProfileFacts(tenant.id, identity.id);

    expect(facts?.attributes).toHaveLength(1);
    expect(facts?.attributes[0]).toMatchObject({
      attributeKey: "employeeNo",
      valueType: "string",
      stringValue: "E-100",
      numberValue: null,
      booleanValue: null,
      jsonValue: null,
    });
    expect(facts?.syncState).toMatchObject({ stale: false, lastSyncErrorCode: null });
    expect(identity).not.toHaveProperty("employeeNo");

    await expect(
      db.insert(userExtensionAttribute).values({
        userIdentityId: identity.id,
        attributeKey: "employeeNo",
        valueType: "string",
        stringValue: "E-101",
        numberValue: null,
        booleanValue: null,
        jsonValue: null,
        sourceSystem: "enterprise-directory",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(enterpriseProfileSyncState).values({
        userIdentityId: identity.id,
        profileFingerprint: `sha256:${"b".repeat(64)}`,
        lastVerifiedAt: new Date("2026-09-05T00:00:01.000Z"),
        stale: false,
        lastSyncErrorCode: null,
        sourceSystem: "enterprise-directory",
      }),
    ).rejects.toThrow();
  });
});

describe("enterprise user profile snapshot sync", () => {
  async function seedIdentity(externalSubject: string) {
    const tenant = await ensureDefaultTenant();
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject,
      email: `${externalSubject}@example.test`,
      displayName: "旧名称",
    });
    return { tenant, identity };
  }

  function registeredAdapter(
    result: EnterpriseUserAdapterResult,
    onResolve?: (context: EnterpriseUserAdapterContext) => void,
  ): EnterpriseUserAdapter {
    const registry = new EnterpriseUserAdapterRegistry("enterprise");
    registry.registerEnterpriseAdapter({
      kind: "enterprise",
      async resolveUser(context) {
        onResolve?.(context);
        return result;
      },
    });
    return registry.resolve() as EnterpriseUserAdapter;
  }

  function freshResult(profile: Record<string, unknown>): EnterpriseUserAdapterResult {
    return { status: "fresh", profile: profile as never };
  }

  it("完整快照首次写入、同指纹不制造审计噪音、变化删除消失字段", async () => {
    const { tenant, identity } = await seedIdentity("employee-sync-1");
    const adapter = registeredAdapter(
      freshResult({
        externalSubject: "employee-sync-1",
        email: "new@example.test",
        displayName: "新名称",
        status: "active",
        sourceSystem: "deployment-private-directory",
        attributes: {
          employeeNo: "E-001",
          departmentCode: "D-01",
          dataScopes: { plants: ["P1"] },
        },
      }),
    );

    const first = await syncEnterpriseUserProfile({
      subject: {
        tenantId: tenant.id,
        tenantKey: tenant.key,
        externalSubject: "employee-sync-1",
        email: identity.email,
        displayName: identity.displayName,
      },
      userIdentityId: identity.id,
      adapter,
      now: new Date("2026-09-05T01:00:00.000Z"),
    });
    expect(first.profileStatus).toBe("fresh");
    expect(first.userIdentity.email).toBe("new@example.test");
    expect(first.attributes).toMatchObject({ employeeNo: "E-001", departmentCode: "D-01" });

    const second = await syncEnterpriseUserProfile({
      subject: {
        tenantId: tenant.id,
        tenantKey: tenant.key,
        externalSubject: "employee-sync-1",
        email: "new@example.test",
        displayName: "新名称",
      },
      userIdentityId: identity.id,
      adapter,
      now: new Date("2026-09-05T02:00:00.000Z"),
    });
    expect(second.profileFingerprint).toBe(first.profileFingerprint);
    expect(await listAuditEvents({ tenantId: tenant.id, targetId: identity.id })).toHaveLength(1);

    const changedAdapter = registeredAdapter(
      freshResult({
        externalSubject: "employee-sync-1",
        email: "new@example.test",
        displayName: "新名称",
        status: "disabled",
        sourceSystem: "deployment-private-directory",
        attributes: { employeeNo: "E-002" },
      }),
    );
    const changed = await syncEnterpriseUserProfile({
      subject: {
        tenantId: tenant.id,
        tenantKey: tenant.key,
        externalSubject: "employee-sync-1",
        email: "new@example.test",
        displayName: "新名称",
      },
      userIdentityId: identity.id,
      adapter: changedAdapter,
      now: new Date("2026-09-05T03:00:00.000Z"),
    });
    expect(changed.profileStatus).toBe("disabled");
    const facts = await getEnterpriseUserProfileFacts(tenant.id, identity.id);
    expect(facts?.attributes.map((row) => row.attributeKey)).toEqual(["employeeNo"]);
    expect(facts?.syncState).toMatchObject({ stale: false, lastSyncErrorCode: null });
    expect(await listAuditEvents({ tenantId: tenant.id, targetId: identity.id })).toHaveLength(2);
  });

  it("stale 只能由 Adapter 明确授权；unavailable 不得把旧事实自动标记为 stale", async () => {
    const existing = await seedIdentity("employee-sync-2");
    const trustedClaims = { employee_number: "E-002", private_scope: "not-persisted" };
    let receivedContext: EnterpriseUserAdapterContext | undefined;
    const successAdapter = registeredAdapter(
      freshResult({
        externalSubject: "employee-sync-2",
        email: existing.identity.email,
        displayName: existing.identity.displayName,
        status: "active",
        sourceSystem: "deployment-private-directory",
        attributes: { employeeNo: "E-002" },
      }),
      (context) => {
        receivedContext = context;
      },
    );
    await syncEnterpriseUserProfile({
      subject: {
        tenantId: existing.tenant.id,
        tenantKey: existing.tenant.key,
        externalSubject: "employee-sync-2",
        email: existing.identity.email,
        displayName: existing.identity.displayName,
      },
      userIdentityId: existing.identity.id,
      adapter: successAdapter,
      trustedAuthenticationClaims: trustedClaims,
      now: new Date("2026-09-05T04:00:00.000Z"),
    });

    expect(receivedContext?.trustedAuthenticationClaims).toEqual(trustedClaims);
    expect(
      JSON.stringify(await getEnterpriseUserProfileFacts(existing.tenant.id, existing.identity.id)),
    ).not.toContain("not-persisted");

    const unavailableAfterSuccess = await syncEnterpriseUserProfile({
      subject: {
        tenantId: existing.tenant.id,
        tenantKey: existing.tenant.key,
        externalSubject: "employee-sync-2",
        email: existing.identity.email,
        displayName: existing.identity.displayName,
      },
      userIdentityId: existing.identity.id,
      adapter: registeredAdapter({ status: "unavailable" }),
    });
    expect(unavailableAfterSuccess.profileStatus).toBe("unavailable");
    expect(unavailableAfterSuccess.attributes).toEqual({});
    expect(
      (await getEnterpriseUserProfileFacts(existing.tenant.id, existing.identity.id))?.syncState,
    ).toMatchObject({ stale: false, lastSyncErrorCode: "enterprise_adapter_unavailable" });

    const staleAdapter = registeredAdapter({ status: "stale", useLastKnownProfile: true });
    const stale = await syncEnterpriseUserProfile({
      subject: {
        tenantId: existing.tenant.id,
        tenantKey: existing.tenant.key,
        externalSubject: "employee-sync-2",
        email: existing.identity.email,
        displayName: existing.identity.displayName,
      },
      userIdentityId: existing.identity.id,
      adapter: staleAdapter,
    });
    expect(stale.profileStatus).toBe("stale");
    expect(stale.attributes).toEqual({ employeeNo: "E-002" });
    expect(
      (await getEnterpriseUserProfileFacts(existing.tenant.id, existing.identity.id))?.syncState,
    ).toMatchObject({
      stale: true,
      lastSyncErrorCode: null,
    });

    const firstFailure = await seedIdentity("employee-sync-3");
    const unavailableAdapter = registeredAdapter({ status: "unavailable" });
    const unavailable = await syncEnterpriseUserProfile({
      subject: {
        tenantId: firstFailure.tenant.id,
        tenantKey: firstFailure.tenant.key,
        externalSubject: "employee-sync-3",
        email: firstFailure.identity.email,
        displayName: firstFailure.identity.displayName,
      },
      userIdentityId: firstFailure.identity.id,
      adapter: unavailableAdapter,
    });
    expect(unavailable.profileStatus).toBe("unavailable");
    expect(
      await getEnterpriseUserProfileFacts(firstFailure.tenant.id, firstFailure.identity.id),
    ).toMatchObject({
      attributes: [],
      syncState: null,
    });
  });
});
