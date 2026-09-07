import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { acceptEnterpriseProfileObservation } from "@/lib/identity/accept-enterprise-profile-observation";
import type {
  EnterpriseProfileObservation,
  EnterpriseProfileSource,
} from "@/lib/identity/enterprise-profile-source";
import { prepareEnterpriseUserContext } from "@/lib/identity/prepare-enterprise-user-context";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

const policy = {
  profileRequirement: "fresh_required" as const,
  allowedFields: ["employeeNo", "departmentCode"] as ("employeeNo" | "departmentCode")[],
};

const source: EnterpriseProfileSource = {
  sourceSystem: "directory",
  trusted: true,
  maxFreshAgeMs: 60 * 60_000,
  maxStaleAgeMs: 2 * 60 * 60_000,
};

async function seedIdentity(status: "active" | "disabled" = "active") {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: `employee-context-${status}`,
    email: "employee@example.test",
    displayName: "员工",
    status,
  });
  return { tenant, identity };
}

function observation(
  tenantId: string,
  externalSubject: string,
  time: string,
): EnterpriseProfileObservation {
  const verifiedAt = new Date(time);
  return {
    tenantId,
    externalSubject,
    sourceSystem: source.sourceSystem,
    attributes: { employeeNo: "E-1", departmentCode: "D-1" },
    verifiedAt,
    freshUntil: new Date(verifiedAt.getTime() + 60 * 60_000),
    staleUntil: new Date(verifiedAt.getTime() + 3 * 60 * 60_000),
  };
}

describe("prepareEnterpriseUserContext", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fresh 命中和 stale_allowed 命中都不刷新企业来源", async () => {
    const { tenant, identity } = await seedIdentity();
    const accepted = observation(tenant.id, identity.externalSubject, "2026-09-07T00:00:00.000Z");
    await acceptEnterpriseProfileObservation({
      observation: accepted,
      source,
      now: accepted.verifiedAt,
    });
    const refresh = vi.fn();
    const sourceWithRefresh = { ...source, refresh };

    const fresh = await prepareEnterpriseUserContext({
      tenantId: tenant.id,
      userIdentityId: identity.id,
      policy,
      source: sourceWithRefresh,
      now: new Date("2026-09-07T00:30:00.000Z"),
    });
    expect(fresh).toMatchObject({ profile_status: "fresh", fields: { employeeNo: "E-1" } });
    expect(refresh).not.toHaveBeenCalled();

    const staleAllowed = await prepareEnterpriseUserContext({
      tenantId: tenant.id,
      userIdentityId: identity.id,
      policy: { profileRequirement: "stale_allowed", allowedFields: policy.allowedFields },
      source: sourceWithRefresh,
      now: new Date("2026-09-07T01:30:00.000Z"),
    });
    expect(staleAllowed?.profile_status).toBe("stale");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("fresh_required 过期时只刷新一次并接纳新观察", async () => {
    const { tenant, identity } = await seedIdentity();
    const old = observation(tenant.id, identity.externalSubject, "2026-09-06T00:00:00.000Z");
    await acceptEnterpriseProfileObservation({ observation: old, source, now: old.verifiedAt });
    const refreshed = observation(tenant.id, identity.externalSubject, "2026-09-07T00:30:00.000Z");
    const refresh = vi.fn().mockResolvedValue({ status: "observed", observation: refreshed });
    const context = await prepareEnterpriseUserContext({
      tenantId: tenant.id,
      userIdentityId: identity.id,
      policy,
      source: { ...source, refresh },
      now: new Date("2026-09-07T00:30:00.000Z"),
    });

    expect(context).toMatchObject({ profile_status: "fresh", fields: { employeeNo: "E-1" } });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("停用身份在刷新前 fail closed", async () => {
    const { tenant, identity } = await seedIdentity("disabled");
    const refresh = vi.fn();
    await expect(
      prepareEnterpriseUserContext({
        tenantId: tenant.id,
        userIdentityId: identity.id,
        policy,
        source: { ...source, refresh },
      }),
    ).rejects.toMatchObject({ code: "enterprise_user_context_disabled" });
    expect(refresh).not.toHaveBeenCalled();
  });
});
