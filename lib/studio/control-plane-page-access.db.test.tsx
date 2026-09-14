import OperationsPage from "@/app/studio/operations/page";
import ResourcesPage from "@/app/studio/resources/page";
import RuntimePage from "@/app/studio/runtime/page";
import { AgentRegistrationWorkspace } from "@/components/studio/agent-registration-workspace";
import { RouteActivationPanel } from "@/components/studio/route-activation-panel";
import { RuntimeControlPanel } from "@/components/studio/runtime-control-panel";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { checkActionScope } from "@/lib/identity/authorization";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import type { Principal } from "@/lib/identity/resolver";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  revokeSeededActionPermission,
  seedActionPermission,
} from "@/lib/test-support/seed-action-permission";
import { Children, type ReactNode, isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 仅替代 Next 请求的已认证边界；页面的权限查询使用真实 MySQL 和生产授权实现。
const context = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("@/lib/studio/page-auth", () => ({
  requireStudioPagePermission: async () => ({ ok: true, principal: context.principal }),
}));

function propsFor(node: ReactNode, component: unknown): Record<string, unknown> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === component) return child.props;
    const found = propsFor(child.props.children, component);
    if (found) return found;
  }
}

async function seedUser(subject: string) {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: subject,
    email: `${subject}@example.test`,
    displayName: null,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: subject,
    userIdentityId: identity.id,
  });
  const principal: Principal = {
    tenantId: tenant.id,
    tenantKey: tenant.id,
    userIdentityId: identity.id,
    externalSubject: subject,
    email: identity.email,
    displayName: null,
    audience: "admin",
  };
  return { principal, binding };
}

beforeEach(async () => {
  await resetDatabase(db);
});

describe("Studio 控制面页面的资源范围权限", () => {
  it("具有 agent/runtime 范围权限的管理员可进入登记、版本、运行服务和路由操作", async () => {
    const { principal, binding } = await seedUser("admin");
    context.principal = principal;
    for (const [actionCode, type] of [
      ["agent.read", "tenant"],
      ["agent.contract.register", "agent"],
      ["agent.revision.create", "agent"],
      ["runtime.publish", "runtime"],
      ["route.update", "agent"],
    ] as const) {
      await seedActionPermission({
        tenantId: principal.tenantId,
        principalBindingId: binding.id,
        actionCode,
        resourceScope: { type, wildcard: true },
      });
    }
    expect(propsFor(await ResourcesPage(), AgentRegistrationWorkspace)).toMatchObject({
      canReadAgents: true,
      canRegisterContract: true,
      canManageRevisions: true,
      canManageRoutes: true,
    });
    expect(propsFor(await RuntimePage(), RuntimeControlPanel)).toMatchObject({ canPublish: true });
    expect(propsFor(await OperationsPage(), RouteActivationPanel)).toMatchObject({
      canManage: true,
    });
  });

  it("只有读取权限时不展示写操作，也不继承其他用户的授权", async () => {
    const reader = await seedUser("reader");
    const admin = await seedUser("other-admin");
    context.principal = reader.principal;
    await seedActionPermission({
      tenantId: reader.principal.tenantId,
      principalBindingId: reader.binding.id,
      actionCode: "agent.read",
      resourceScope: { type: "tenant", wildcard: true },
    });
    await seedActionPermission({
      tenantId: admin.principal.tenantId,
      principalBindingId: admin.binding.id,
      actionCode: "agent.contract.register",
      resourceScope: { type: "agent", wildcard: true },
    });
    expect(propsFor(await ResourcesPage(), AgentRegistrationWorkspace)).toMatchObject({
      canReadAgents: true,
      canRegisterContract: false,
      canManageRevisions: false,
      canManageRoutes: false,
    });
    expect(propsFor(await RuntimePage(), RuntimeControlPanel)).toMatchObject({ canPublish: false });
    expect(propsFor(await OperationsPage(), RouteActivationPanel)).toMatchObject({
      canManage: false,
    });
  });

  it("指定资源的授权允许进入操作区，但不允许写其他资源；撤销后入口关闭", async () => {
    const { principal, binding } = await seedUser("scoped-admin");
    context.principal = principal;
    const grant = await seedActionPermission({
      tenantId: principal.tenantId,
      principalBindingId: binding.id,
      actionCode: "route.update",
      resourceScope: { type: "agent", ids: ["allowed-agent"] },
    });
    expect(propsFor(await OperationsPage(), RouteActivationPanel)).toMatchObject({
      canManage: true,
    });
    expect(
      await checkActionScope(principal.tenantId, principal.userIdentityId, {
        actionCode: "route.update",
        resource: { type: "agent", id: "other-agent" },
      }),
    ).toMatchObject({ allowed: false });
    await revokeSeededActionPermission(principal.tenantId, grant.id);
    expect(propsFor(await OperationsPage(), RouteActivationPanel)).toMatchObject({
      canManage: false,
    });
  });
});
