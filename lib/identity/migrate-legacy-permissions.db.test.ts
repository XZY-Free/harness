import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { seedDefaultIdentity } from "@/lib/db/seed";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  permissionRole,
  permissionRoleAssignment,
  roleActionBinding,
} from "@/lib/persistence/schema/authorization";
import { beforeEach, expect, it } from "vitest";
import { checkActionScope } from "./authorization";
import { migrateLegacyPermissions } from "./migrate-legacy-permissions";
beforeEach(async () => resetDatabase(db));
it("旧授权转换为可管理角色，保留范围和有效期，重复迁移不扩权", async () => {
  const identity = await seedDefaultIdentity();
  const now = Date.now();
  await db.insert(roleActionBinding).values([
    {
      id: randomUUID(),
      tenantId: identity.tenantId,
      principalBindingId: identity.principalBindingId,
      actionCode: "user.manage",
      resourceScopeJson: JSON.stringify({ type: "tenant", ids: [identity.tenantId] }),
      validFrom: new Date(now - 10000),
    },
    {
      id: randomUUID(),
      tenantId: identity.tenantId,
      principalBindingId: identity.principalBindingId,
      actionCode: "agent.invoke",
      resourceScopeJson: JSON.stringify({ type: "agent", ids: ["private-hr"] }),
      validFrom: new Date(now - 10000),
      validUntil: new Date(now - 5000),
    },
    {
      id: randomUUID(),
      tenantId: identity.tenantId,
      principalBindingId: identity.principalBindingId,
      actionCode: "audit.read",
      resourceScopeJson: JSON.stringify({ type: "tenant", wildcard: true }),
      validFrom: new Date(now + 60000),
    },
  ]);
  expect(await migrateLegacyPermissions()).toEqual({ converted: 3 });
  expect(await db.select().from(permissionRole)).toHaveLength(1);
  expect(await db.select().from(permissionRoleAssignment)).toHaveLength(1);
  expect(await db.select().from(roleActionBinding)).toHaveLength(0);
  expect(
    (
      await checkActionScope(identity.tenantId, identity.userIdentityId, {
        actionCode: "user.manage",
        resource: { type: "tenant", id: identity.tenantId },
      })
    ).allowed,
  ).toBe(true);
  expect(
    (
      await checkActionScope(identity.tenantId, identity.userIdentityId, {
        actionCode: "audit.read",
        resource: { type: "tenant", id: identity.tenantId },
      })
    ).allowed,
  ).toBe(false);
  expect(
    (
      await checkActionScope(identity.tenantId, identity.userIdentityId, {
        actionCode: "agent.invoke",
        resource: { type: "agent", id: "private-hr" },
      })
    ).allowed,
  ).toBe(false);
  expect(await migrateLegacyPermissions()).toEqual({ converted: 0 });
  expect(await db.select().from(permissionRole)).toHaveLength(1);
});
it("非法旧授权使整个转换回滚，不产生部分角色", async () => {
  const identity = await seedDefaultIdentity();
  await db.insert(roleActionBinding).values({
    tenantId: identity.tenantId,
    principalBindingId: identity.principalBindingId,
    actionCode: "user.manage",
    resourceScopeJson: "invalid-json",
  });
  await expect(migrateLegacyPermissions()).rejects.toThrow();
  expect(await db.select().from(roleActionBinding)).toHaveLength(1);
  expect(await db.select().from(permissionRole)).toHaveLength(0);
});
