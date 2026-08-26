import { randomUUID } from "node:crypto";
/**
 * POST /admin/api/v1/agents/{agent_id}/revisions — AgentContractSnapshot 绑定先行冻结（预期 RED）。
 *
 * 冻结不变量（AgentContractSnapshot 权威切片）：
 * - 新 Revision 流只接受 wire key agent_contract_snapshot_id；agent_descriptor_snapshot_id
 *   不再作为别名被接受；缺省/null/空值非法。
 * - 跨 Agent / 跨租户 / 不存在的合同快照一律拒绝，且不得产生 Revision 行。
 * - 响应只回显 snapshot id（及既有 revision 事实），不回显原始合同 JSON/URL/secret。
 * - 幂等语义与现状完全一致（重放相同响应）。
 *
 * Revision 创建已切换为 AgentContractSnapshot 权威；本文件是该不变量的回归保护。
 * DB 级覆盖使用真实 AgentContractSnapshot 行（seedAgentContractSnapshot），
 * 不 mock 预计算结论。
 */
import { POST as createRevisionPOST } from "@/app/admin/api/v1/agents/[agent_id]/revisions/route";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { agentRevisionTable } from "@/lib/persistence/schema/agents";
import { tenant } from "@/lib/persistence/schema/identity";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 admin-routes.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

/** seed 管理员并授予 agent.revision.create。 */
async function seedRevisionCreator() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "agent.revision.create",
    resourceScope: { type: "agent", wildcard: true },
  });
  return { tenantId: tenant.id, userIdentityId: identity.id };
}

/** 合法 revision 请求体基线（除快照绑定 key 外全部字段齐备）。 */
function baseRevisionBody() {
  return {
    source: { source_type: "agent_yaml" as const, source_revision: "git:contract-v1" },
    artifact_ref: "oci://registry/agent@sha256:contract-artifact",
    instruction_hash: "sha256:contract-instruction",
    model_policy: { model: "doubao-pro" },
    permission_requirements: {},
    delegation_policy: { max_depth: 0 },
    agent_interface_requirements: { required: [], optional: [] },
  };
}

function buildPost(agentId: string, body: unknown, idempotencyKey: string) {
  return createRevisionPOST(
    buildApiRequest({
      audience: "admin",
      method: "POST",
      path: `/agents/${agentId}/revisions`,
      idempotencyKey,
      body,
    }),
    { params: Promise.resolve({ agent_id: agentId }) },
  );
}

async function countRevisions(agentId: string): Promise<number> {
  const rows = await db
    .select({ id: agentRevisionTable.id })
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.agentId, agentId));
  return rows.length;
}

describe("POST /admin/api/v1/agents/{agent_id}/revisions（AgentContractSnapshot 绑定）", () => {
  let tenantId: string;
  let userIdentityId: string;
  let agentId: string;
  let snapshotId: string;
  let contractDigest: string;

  beforeEach(async () => {
    const seeded = await seedRevisionCreator();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
    const agent = await createAgent({
      tenantId,
      agentKey: "hr-agent",
      displayName: "HR Agent",
      ownerUserId: userIdentityId,
    });
    agentId = agent.id;
    const snapshot = await seedAgentContractSnapshot({
      tenantId,
      agentId,
      createdBy: userIdentityId,
    });
    snapshotId = snapshot.id;
    contractDigest = snapshot.contractDigest;
  });

  it("happy path：agent_contract_snapshot_id → 201，响应回显合同快照 id 与 digest，不回显原始合同", async () => {
    const response = await buildPost(
      agentId,
      { ...baseRevisionBody(), agent_contract_snapshot_id: snapshotId },
      "idem-contract-rev-happy-001",
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.revision_state).toBe("draft");
    expect(body.revision_no).toBe(1);
    expect(body.agent_contract_snapshot_id).toBe(snapshotId);
    // 脱敏：响应只含 id/digest 级事实，不回显原始合同 JSON、URL 或 secret。
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("canonicalProviderDescriptor");
    expect(serialized).not.toContain("agent_descriptor_snapshot_id");
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toContain("employee_id");
    expect(serialized).not.toContain("corp_id");
    expect(contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await countRevisions(agentId)).toBe(1);
  });

  it("legacy key agent_descriptor_snapshot_id 不再被接受，且与新 key 同传也拒绝 → 400，无 Revision", async () => {
    const response = await buildPost(
      agentId,
      { ...baseRevisionBody(), agent_descriptor_snapshot_id: randomUUID() },
      "idem-contract-rev-legacy-key-001",
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
    expect(await countRevisions(agentId)).toBe(0);

    const mixed = await buildPost(
      agentId,
      {
        ...baseRevisionBody(),
        agent_contract_snapshot_id: snapshotId,
        agent_descriptor_snapshot_id: randomUUID(),
      },
      "idem-contract-rev-mixed-keys-001",
    );
    expect(mixed.status).toBe(400);
    expect(await countRevisions(agentId)).toBe(0);
  });

  it.each([
    ["缺失", undefined],
    ["null", null],
    ["空字符串", ""],
    ["空白字符串", "   "],
  ])("agent_contract_snapshot_id %s → 400，无 Revision", async (_label, value) => {
    const response = await buildPost(
      agentId,
      { ...baseRevisionBody(), agent_contract_snapshot_id: value },
      `idem-contract-rev-missing-${randomUUID().slice(0, 8)}`,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
    expect(await countRevisions(agentId)).toBe(0);
  });

  it("跨 Agent 合同快照（同租户）→ 400，无 Revision", async () => {
    const otherAgent = await createAgent({
      tenantId,
      agentKey: "other-agent",
      displayName: "Other Agent",
      ownerUserId: userIdentityId,
    });
    const otherSnapshot = await seedAgentContractSnapshot({
      tenantId,
      agentId: otherAgent.id,
      createdBy: userIdentityId,
    });
    const response = await buildPost(
      agentId,
      { ...baseRevisionBody(), agent_contract_snapshot_id: otherSnapshot.id },
      "idem-contract-rev-cross-agent-001",
    );
    expect(response.status).toBe(400);
    expect(await countRevisions(agentId)).toBe(0);
  });

  it("跨租户合同快照 → 400，无 Revision", async () => {
    // 第二租户 + 该租户 Agent 的真实合同快照（存在但不属于当前租户）。
    const otherTenantId = "11111111-1111-4111-8111-111111111111";
    await db.insert(tenant).values({
      id: otherTenantId,
      key: "other-tenant",
      name: "Other Tenant",
    });
    const otherAgent = await createAgent({
      tenantId: otherTenantId,
      agentKey: "other-tenant-agent",
      displayName: "Other Tenant Agent",
      ownerUserId: userIdentityId,
    });
    const otherSnapshot = await seedAgentContractSnapshot({
      tenantId: otherTenantId,
      agentId: otherAgent.id,
      createdBy: userIdentityId,
    });
    const response = await buildPost(
      agentId,
      { ...baseRevisionBody(), agent_contract_snapshot_id: otherSnapshot.id },
      "idem-contract-rev-cross-tenant-001",
    );
    expect(response.status).toBe(400);
    expect(await countRevisions(agentId)).toBe(0);
  });

  it("不存在的合同快照 → 400，无 Revision", async () => {
    const response = await buildPost(
      agentId,
      { ...baseRevisionBody(), agent_contract_snapshot_id: randomUUID() },
      "idem-contract-rev-missing-ref-001",
    );
    expect(response.status).toBe(400);
    expect(await countRevisions(agentId)).toBe(0);
  });

  it("幂等：同 key 同 body 重放相同响应；同 key 不同 body 409（语义与现状一致）", async () => {
    const body = { ...baseRevisionBody(), agent_contract_snapshot_id: snapshotId };
    const first = await buildPost(agentId, body, "idem-contract-rev-replay-001");
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const replay = await buildPost(agentId, body, "idem-contract-rev-replay-001");
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstBody);
    expect(await countRevisions(agentId)).toBe(1);

    const conflict = await buildPost(
      agentId,
      { ...body, instruction_hash: "sha256:conflicting-instruction" },
      "idem-contract-rev-replay-001",
    );
    expect(conflict.status).toBe(409);
    expect(await countRevisions(agentId)).toBe(1);
  });
});
