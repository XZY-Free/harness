import * as route from "@/app/admin/api/v1/agents/[agent_id]/route";
import { POST as ensureRouteSet } from "@/app/admin/api/v1/deployment-route-sets/route";
import { deleteAgentRegistration } from "@/lib/agents/application/delete-agent-registration";
import { createAgent, getAgentById, listAgents } from "@/lib/agents/persistence/agent-queries";
import { createDraftRevision } from "@/lib/agents/persistence/agent-revision-queries";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import type { Principal } from "@/lib/identity/resolver";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { auditEvent } from "@/lib/persistence/schema/audit";
import { createRouteSet } from "@/lib/routes/application/deployment-route-service";
import { beforeEach, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("@/lib/admin/route-helpers", async (original) => ({
  ...(await original<typeof import("@/lib/admin/route-helpers")>()),
  resolveAdminPrincipalAsync: async () => context.principal,
}));
beforeEach(async () => {
  await resetDatabase(db);
});
async function seed(authorized = true) {
  const tenant = await ensureDefaultTenant();
  const user = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "delete-admin",
    email: "delete@example.test",
    displayName: null,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "delete-admin",
    userIdentityId: user.id,
  });
  context.principal = {
    tenantId: tenant.id,
    tenantKey: tenant.id,
    userIdentityId: user.id,
    externalSubject: "delete-admin",
    email: user.email,
    displayName: null,
    audience: "admin",
  };
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: "disposable",
    displayName: "删除测试",
    ownerUserId: user.id,
    lifecycleState: "enabled",
  });
  if (authorized)
    for (const actionCode of ["agent.retract", "agent.contract.register", "route.update"] as const)
      await grantActionBinding({
        tenantId: tenant.id,
        principalBindingId: binding.id,
        actionCode,
        resourceScope: { type: "agent", ids: [agent.id] },
      });
  return agent;
}
function remove(id: string, version = 1) {
  return (route as typeof route & { DELETE: typeof route.GET }).DELETE(
    new Request(`http://localhost/admin/api/v1/agents/${id}`, {
      method: "DELETE",
      headers: { "If-Match": `"agent-${version}"` },
    }),
    { params: Promise.resolve({ agent_id: id }) },
  );
}
it("删除未连接的已配置智能体，保留历史身份并原子记录审计；重试不重复审计", async () => {
  const agent = await seed();
  expect((await remove(agent.id)).status).toBe(200);
  expect(await listAgents(agent.tenantId)).toEqual([]);
  const saved = await getAgentById(agent.tenantId, agent.id);
  expect(saved?.deletedAt).not.toBeNull();
  expect(saved?.lifecycleState).toBe("disabled");
  expect((await remove(agent.id)).status).toBe(200);
  expect(
    (await db.select().from(auditEvent)).filter((event) => event.actionType === "agents.deleted"),
  ).toHaveLength(1);
});
it("读取身份没有删除授权时不得修改", async () => {
  const agent = await seed(false);
  expect((await remove(agent.id)).status).toBe(403);
  expect((await getAgentById(agent.tenantId, agent.id))?.deletedAt).toBeNull();
});
it("过期页面不能删除已发生变化的智能体", async () => {
  const agent = await seed();
  expect((await remove(agent.id, 99)).status).toBe(412);
  expect((await getAgentById(agent.tenantId, agent.id))?.deletedAt).toBeNull();
});

it("存在发布配置时删除被拒绝且状态、审计和事件均不变化", async () => {
  const agent = await seed();
  await createRouteSet({
    tenantId: agent.tenantId,
    target: { kind: "agent", agentId: agent.id },
    routeScopeKey: "default",
    routeScopeJson: {},
  });
  expect((await remove(agent.id)).status).toBe(422);
  expect((await getAgentById(agent.tenantId, agent.id))?.deletedAt).toBeNull();
  expect(await db.select().from(controlPlaneOutboxEvent)).toHaveLength(0);
});
it("资源范围不能用于删除另一个智能体", async () => {
  const agent = await seed();
  const other = await createAgent({
    tenantId: agent.tenantId,
    agentKey: "other",
    displayName: "其他智能体",
    ownerUserId: agent.ownerUserId,
  });
  expect((await remove(other.id)).status).toBe(403);
  expect((await getAgentById(agent.tenantId, other.id))?.deletedAt).toBeNull();
});
it("并发删除仅产生一条生命周期事件", async () => {
  const agent = await seed();
  const responses = await Promise.all([remove(agent.id), remove(agent.id)]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(await db.select().from(controlPlaneOutboxEvent)).toHaveLength(1);
});
it("审计写入失败时删除和事件都回滚", async () => {
  const agent = await seed();
  await expect(
    deleteAgentRegistration({
      tenantId: agent.tenantId,
      agentId: agent.id,
      expectedVersion: 1,
      actor: { tenantId: agent.tenantId, actorType: "user", actorId: agent.ownerUserId },
      requestId: "x".repeat(1000),
    }),
  ).rejects.toThrow();
  expect((await getAgentById(agent.tenantId, agent.id))?.deletedAt).toBeNull();
  expect(await db.select().from(controlPlaneOutboxEvent)).toHaveLength(0);
});

function connect(agentId: string) {
  return ensureRouteSet(
    new Request("http://localhost/admin/api/v1/deployment-route-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        target: { kind: "agent", agent_id: agentId },
        route_scope_key: "default",
        route_scope: {},
      }),
    }),
  );
}
it("删除后不能重新建立服务连接", async () => {
  const agent = await seed();
  expect((await remove(agent.id)).status).toBe(200);
  expect((await connect(agent.id)).status).toBe(404);
});
it("并发建立相同连接仍能复用唯一发布配置", async () => {
  const agent = await seed();
  const responses = await Promise.all([connect(agent.id), connect(agent.id)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
  expect((await remove(agent.id)).status).toBe(422);
});

it("删除后不能通过旧页面继续创建版本", async () => {
  const agent = await seed();
  const snapshot = await seedAgentContractSnapshot({
    tenantId: agent.tenantId,
    agentId: agent.id,
    createdBy: agent.ownerUserId,
  });
  expect((await remove(agent.id)).status).toBe(200);
  await expect(
    createDraftRevision({
      tenantId: agent.tenantId,
      agentId: agent.id,
      agentContractSnapshotId: snapshot.id,
      createdBy: agent.ownerUserId,
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: {},
    }),
  ).rejects.toThrow();
});
