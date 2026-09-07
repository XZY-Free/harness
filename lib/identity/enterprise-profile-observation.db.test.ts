import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  EnterpriseProfileAcceptanceError,
  acceptEnterpriseProfileObservation,
} from "@/lib/identity/accept-enterprise-profile-observation";
import type {
  EnterpriseProfileObservation,
  EnterpriseProfileSource,
} from "@/lib/identity/enterprise-profile-source";
import { getEnterpriseUserProfileFacts } from "@/lib/identity/enterprise-user-profile-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { getUserIdentityById, upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

const source: EnterpriseProfileSource = {
  sourceSystem: "directory",
  trusted: true,
  maxFreshAgeMs: 60 * 60_000,
  maxStaleAgeMs: 2 * 60 * 60_000,
};

describe("acceptEnterpriseProfileObservation", () => {
  it("只保存企业属性和期限，不改写标准身份字段", async () => {
    const tenant = await ensureDefaultTenant();
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "employee-accept-1",
      email: "old@example.test",
      displayName: "旧名称",
    });
    const observation: EnterpriseProfileObservation = {
      tenantId: tenant.id,
      externalSubject: identity.externalSubject,
      sourceSystem: source.sourceSystem,
      attributes: { employeeNo: "E-1", departmentCode: "D-1" },
      verifiedAt: new Date("2026-09-07T00:00:00.000Z"),
      freshUntil: new Date("2026-09-07T00:30:00.000Z"),
      staleUntil: new Date("2026-09-07T01:30:00.000Z"),
    };

    await acceptEnterpriseProfileObservation({ observation, source, now: observation.verifiedAt });

    const facts = await getEnterpriseUserProfileFacts(tenant.id, identity.id);
    expect(await getUserIdentityById(identity.id)).toMatchObject({
      email: "old@example.test",
      displayName: "旧名称",
    });
    expect(facts?.attributes.map((row) => row.attributeKey).sort()).toEqual([
      "departmentCode",
      "employeeNo",
    ]);
    expect(facts?.syncState).toMatchObject({
      freshUntil: observation.freshUntil,
      staleUntil: observation.staleUntil,
    });
  });

  it("相同观察不得用更晚期限滑动续期", async () => {
    const tenant = await ensureDefaultTenant();
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "employee-accept-2",
      email: "employee@example.test",
      displayName: "员工",
    });
    const observation: EnterpriseProfileObservation = {
      tenantId: tenant.id,
      externalSubject: identity.externalSubject,
      sourceSystem: source.sourceSystem,
      attributes: { employeeNo: "E-2" },
      verifiedAt: new Date("2026-09-07T00:00:00.000Z"),
      freshUntil: new Date("2026-09-07T00:30:00.000Z"),
      staleUntil: new Date("2026-09-07T01:30:00.000Z"),
    };
    await acceptEnterpriseProfileObservation({ observation, source, now: observation.verifiedAt });

    await expect(
      acceptEnterpriseProfileObservation({
        observation: {
          ...observation,
          freshUntil: new Date("2026-09-07T00:40:00.000Z"),
          staleUntil: new Date("2026-09-07T01:40:00.000Z"),
        },
        source,
        now: observation.verifiedAt,
      }),
    ).rejects.toBeInstanceOf(EnterpriseProfileAcceptanceError);

    const facts = await getEnterpriseUserProfileFacts(tenant.id, identity.id);
    expect(facts?.syncState?.freshUntil).toEqual(observation.freshUntil);
  });
});
