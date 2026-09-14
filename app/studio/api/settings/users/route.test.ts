import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { checkActionScope } from "@/lib/identity/authorization";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { permissionRoleAssignment } from "@/lib/persistence/schema/authorization";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ requireStudioAction: vi.fn() }));
vi.mock("@/lib/identity/studio-access", () => auth);
import { PUT } from "./[id]/roles/route";
import { GET } from "./route";

async function setup() {
  const tenant = await ensureDefaultTenant();
  const admin = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "admin",
    email: "admin@example.test",
    displayName: "管理员",
  });
  const employee = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "employee",
    email: "employee@example.test",
    displayName: "员工",
  });
  const principal = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "admin",
    userIdentityId: admin.id,
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "employee",
    userIdentityId: employee.id,
  });
  await db
    .insert(permissionRoleAssignment)
    .values({ tenantId: tenant.id, principalId: principal.id, roleKey: "admin" });
  auth.requireStudioAction.mockResolvedValue({
    ok: true,
    principal: { tenantId: tenant.id, userIdentityId: admin.id },
  });
  return { tenant, admin, employee };
}
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase(db);
});
describe("成员角色 API 正式分配", () => {
  it("未通过认证直接返回门禁响应", async () => {
    auth.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    expect((await GET(new NextRequest("http://localhost/studio/api/settings/users"))).status).toBe(
      401,
    );
  });
  it("GET 从角色分配读取，PUT 保存后实际鉴权生效", async () => {
    const { tenant, employee } = await setup();
    const response = await PUT(
      new NextRequest("http://localhost/studio/api/settings/users/u/roles", {
        method: "PUT",
        body: JSON.stringify({ roleIds: ["auditor"], expectedRoleIds: [] }),
      }),
      { params: Promise.resolve({ id: employee.id }) },
    );
    expect(response.status).toBe(200);
    const list = await (
      await GET(new NextRequest("http://localhost/studio/api/settings/users"))
    ).json();
    expect(list.data.users.find((u: { id: string }) => u.id === employee.id).templateKeys).toEqual([
      "auditor",
    ]);
    expect(
      (
        await checkActionScope(tenant.id, employee.id, {
          actionCode: "audit.read",
          resource: { type: "tenant", id: tenant.id },
        })
      ).allowed,
    ).toBe(true);
  });
  it("缺少旧版本拒绝覆盖；不存在成员返回404", async () => {
    const { employee } = await setup();
    const make = () =>
      new NextRequest("http://localhost/studio/api/settings/users/u/roles", {
        method: "PUT",
        body: JSON.stringify({ roleIds: ["admin"] }),
      });
    expect((await PUT(make(), { params: Promise.resolve({ id: employee.id }) })).status).toBe(400);
    expect((await PUT(make(), { params: Promise.resolve({ id: "not-a-user" }) })).status).toBe(404);
  });
});
