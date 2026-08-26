import { createHash, randomBytes, randomUUID } from "node:crypto";
/**
 * POST /admin/api/v1/agents/{agent_id}/runtime-registrations — 主动黑盒注册验收（预期 RED）。
 *
 * 冻结不变量（Runtime Registration 权威切片）：
 * - 请求体严格 schema：contract_snapshot_id + runtime_endpoint + authentication{mode,
 *   credential_ref_id} + conformance{start_input, resume_input}，多余字段一律 400。
 * - 协议/交互事实只能来自已导入的结构化 AgentContractSnapshot（同租户、同 Agent）；
 *   调用方不得上传 protocol/capabilities/report/passed/agent_card_url。
 * - SnowHarness 必须主动对黑盒 Runtime 发起真实 HTTP/SSE 一致性调用：
 *   GET /.well-known/agent-card.json → message/stream(start_input) 观测 input-required
 *   （同 taskId/contextId）→ message/send(resume_input) 观测 completed。cancel=false
 *   的快照不得调用 tasks/cancel；incremental_content=false 不得要求增量分片；
 *   streaming_transport=true 必须真实观测到 SSE 事件流。
 * - 成功响应/持久化只含结构化 id/status/measured digest，不含原始合同、conformance
 *   transcript、secret、AgentCard 事实覆盖。
 * - 一切失败 fail closed：不可达/路径错误/无 input-required/correlation 变化 → 非 2xx，
 *   永不 verified/published/enabled。
 * - 幂等：同 key 同 body 重放不产生第二次网络序列或重复行；同 key 不同 body 409。
 * - 专用授权动作 agent.runtime.register（按具体 Agent scope）；租户隔离。
 *
 * 真实 MySQL 8（Testcontainers）+ 真实 node:http Provider + 全局 fetch，无 mock。
 */
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ACTION_CODES } from "@/lib/identity/action-codes";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { roleActionBinding } from "@/lib/persistence/schema/authorization";
import { tenant } from "@/lib/persistence/schema/identity";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { credentialRefTable } from "@/lib/persistence/schema/tool";
import {
  type A2ATestProvider,
  startA2ATestProvider,
} from "@/lib/runtime/test-support/a2a-test-provider";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 admin-routes.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

/** 动态加载被测路由（RED 阶段：模块缺失 → 每个路由用例以缺路由失败）。 */
type RoutePOST = (
  request: Request,
  context: { params: Promise<{ agent_id: string }> },
) => Promise<Response>;

async function loadRoutePOST(): Promise<RoutePOST> {
  const mod = (await import(
    "@/app/admin/api/v1/agents/[agent_id]/runtime-registrations/route"
  )) as { POST: RoutePOST };
  if (typeof mod.POST !== "function") {
    throw new Error("runtime-registrations route 缺少 POST handler");
  }
  return mod.POST;
}

let provider: A2ATestProvider;

/** 本文件注入的临时 env 变量名（bearer 用例），afterEach 统一删除恢复。 */
const injectedEnvKeys: string[] = [];

beforeAll(async () => {
  provider = await startA2ATestProvider("input_required");
});

afterAll(async () => {
  await provider.close();
});

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
  // Provider 状态隔离：清空 wire 记录、复位 correlation 篡改/Bearer 校验，场景回 input_required。
  provider.reset();
  // 官方非流式 message/send 返回完整 Task（id/contextId），不是 status-update 的 taskId。
  provider.setResumeResponseShape("task");
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
  for (const key of injectedEnvKeys.splice(0)) {
    delete process.env[key];
  }
});

// ─── 种子与请求辅助 ────────────────────────────────────────

/** 种子管理员 principal（不授权任何 action；action 由各用例显式授予）。 */
async function seedAdmin() {
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
  return { tenantId: tenant.id, userIdentityId: identity.id, principalBindingId: binding.id };
}

/**
 * 直接写 RoleActionBinding 行授予 agent.runtime.register（按具体 Agent scope）。
 * 绕过 grantActionBinding 的目录校验——action 目录补齐是生产实现责任，不在测试期改目录。
 */
async function grantRuntimeRegisterAction(
  seeded: { tenantId: string; principalBindingId: string },
  agentId: string,
): Promise<void> {
  await db.insert(roleActionBinding).values({
    id: randomUUID(),
    tenantId: seeded.tenantId,
    principalBindingId: seeded.principalBindingId,
    actionCode: "agent.runtime.register",
    resourceScopeJson: JSON.stringify({ type: "agent", ids: [agentId] }),
    validFrom: new Date(),
    validUntil: null,
  });
}

/** 完整种子：管理员 + HR Agent + 结构化合同快照 +（可选）授权。 */
async function seedRegistrationTarget(options: { grantAction?: boolean } = {}) {
  const seeded = await seedAdmin();
  const agent = await createAgent({
    tenantId: seeded.tenantId,
    agentKey: "hr-agent",
    displayName: "HR Agent",
    ownerUserId: seeded.userIdentityId,
  });
  const snapshot = await seedAgentContractSnapshot({
    tenantId: seeded.tenantId,
    agentId: agent.id,
    createdBy: seeded.userIdentityId,
  });
  if (options.grantAction !== false) {
    await grantRuntimeRegisterAction(seeded, agent.id);
  }
  return { ...seeded, agentId: agent.id, snapshotId: snapshot.id };
}

/** 种子 CredentialRef（bearer 用例；缺省同租户 active env 引用）。 */
async function seedCredentialRef(
  tenantId: string,
  overrides: {
    provider?: string;
    vaultRef?: string;
    fingerprint?: string;
    lifecycleState?: "active" | "revoked" | "rotated";
  } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(credentialRefTable).values({
    id,
    tenantId,
    provider: overrides.provider ?? "env",
    vaultRef: overrides.vaultRef ?? "vault://test/agent-runtime-token",
    fingerprint: overrides.fingerprint ?? `sha256:${"a1b2c3d4".repeat(8)}`,
    lifecycleState: overrides.lifecycleState ?? "active",
  });
  return id;
}

/** 合法注册请求体基线（mode=none 免密路径，不伪造 secret）。 */
function baseBody(snapshotId: string, endpoint: string) {
  return {
    contract_snapshot_id: snapshotId,
    runtime_endpoint: endpoint,
    authentication: { mode: "none", credential_ref_id: null },
    conformance: { start_input: "我想请年假", resume_input: "明天一天" },
  };
}

async function callPOST(agentId: string, body: unknown, idempotencyKey: string): Promise<Response> {
  const POST = await loadRoutePOST();
  return POST(
    buildApiRequest({
      audience: "admin",
      method: "POST",
      path: `/agents/${agentId}/runtime-registrations`,
      idempotencyKey,
      body,
    }),
    { params: Promise.resolve({ agent_id: agentId }) },
  );
}

// ─── DB 断言辅助 ──────────────────────────────────────────

async function countRuntimeRows(tenantId: string): Promise<number> {
  const rows = await db
    .select({ id: runtimeTable.id })
    .from(runtimeTable)
    .where(eq(runtimeTable.tenantId, tenantId));
  return rows.length;
}

async function countEnabledRuntimes(tenantId: string): Promise<number> {
  const rows = await db
    .select({ id: runtimeTable.id })
    .from(runtimeTable)
    .where(and(eq(runtimeTable.tenantId, tenantId), eq(runtimeTable.lifecycleState, "enabled")));
  return rows.length;
}

async function countPublishedRuntimeRevisions(tenantId: string): Promise<number> {
  const rows = await db
    .select({ id: runtimeRevisionTable.id })
    .from(runtimeRevisionTable)
    .innerJoin(runtimeTable, eq(runtimeRevisionTable.runtimeId, runtimeTable.id))
    .where(
      and(eq(runtimeTable.tenantId, tenantId), eq(runtimeRevisionTable.revisionState, "published")),
    );
  return rows.length;
}

async function loadRuntimeRevisions(tenantId: string) {
  return db
    .select({ revision: runtimeRevisionTable })
    .from(runtimeRevisionTable)
    .innerJoin(runtimeTable, eq(runtimeRevisionTable.runtimeId, runtimeTable.id))
    .where(eq(runtimeTable.tenantId, tenantId));
}

/** 断言零网络：Provider 请求数不变。 */
function expectZeroNewNetwork(before: number) {
  expect(provider.requests.length, "校验失败必须发生在任何网络调用之前").toBe(before);
}

/** 断言 fail closed：无 verified/enabled/published 持久化状态。 */
async function expectFailClosed(tenantId: string) {
  await expect(countEnabledRuntimes(tenantId)).resolves.toBe(0);
  await expect(countPublishedRuntimeRevisions(tenantId)).resolves.toBe(0);
}

// ─── 用例 ─────────────────────────────────────────────────

describe("POST /admin/api/v1/agents/{agent_id}/runtime-registrations（主动黑盒注册验收）", () => {
  it("action 目录冻结：必须存在专用稳定动作 agent.runtime.register", () => {
    expect(ACTION_CODES).toContain("agent.runtime.register");
  });

  it("happy path：真实 HTTP/SSE 序列（标准 card 路径 → input-required → 同 task/context resume → completed），响应结构化且 fail-closed 状态干净", async () => {
    const seeded = await seedRegistrationTarget();
    // 本用例的 wire 切片（reset 已隔离，这里显式取切片以明确意图）。
    const requestsBefore = provider.requests.length;
    const capturedBefore = provider.captured.length;
    const rpcBefore = provider.rpcMethods.length;
    const response = await callPOST(
      seeded.agentId,
      baseBody(seeded.snapshotId, provider.endpoint),
      "idem-rt-reg-happy-001",
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;

    // 结构化响应：回显 snapshot id 与 endpoint，status 为 verified；不含原始合同/transcript/secret/AgentCard 事实。
    expect(body.agent_contract_snapshot_id).toBe(seeded.snapshotId);
    expect(body.runtime_endpoint).toBe(provider.endpoint);
    expect(String(body.verification_state ?? body.status ?? "")).toContain("verified");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Test Enterprise Agent");
    expect(serialized).not.toContain("capability_manifest");
    expect(serialized).not.toContain("请提供申请日期");
    expect(serialized).not.toContain("已收到补充信息");
    expect(serialized).not.toContain("vaultRef");
    expect(serialized).not.toContain("raw_contract");

    // 真实网络序列（黑盒 wire 证据，全部限定在本用例切片内）：
    const newRequests = provider.requests.slice(requestsBefore);
    const newCaptured = provider.captured.slice(capturedBefore);
    const newRpcMethods = provider.rpcMethods.slice(rpcBefore);
    // 1) 标准 A2A 0.3.0 AgentCard 路径（旧 agent.json 路径不算通过），恰好一次。
    expect(
      newRequests.filter((r) => r.method === "GET" && r.path === "/.well-known/agent-card.json"),
    ).toHaveLength(1);
    expect(newRequests.some((r) => r.method === "POST")).toBe(true);
    // 2) message/stream 携带 start_input（SSE 流，streaming_transport=true）。
    const streamCall = newCaptured.find((c) => c.method === "message/stream");
    expect(streamCall?.text).toContain("我想请年假");
    // 3) message/send 携带 resume_input 且同 taskId/contextId。
    const resumeCall = newCaptured.find((c) => c.method === "message/send");
    expect(resumeCall?.text).toContain("明天一天");
    expect(resumeCall?.taskId).toBe(streamCall?.responseTaskId);
    expect(resumeCall?.contextId).toBe(streamCall?.responseContextId);
    // 4) RPC method wire 观测：stream + send 各至少一次；snapshot cancel=false，绝不调用 tasks/cancel。
    expect(newRpcMethods).toContain("message/stream");
    expect(newRpcMethods).toContain("message/send");
    expect(newRpcMethods).not.toContain("tasks/cancel");

    // 成功注册 ≠ 发布/启用：无 enabled Runtime、无 published Revision。
    await expectFailClosed(seeded.tenantId);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(1);
    const persisted = await loadRuntimeRevisions(seeded.tenantId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.revision).toMatchObject({
      agentContractSnapshotId: seeded.snapshotId,
      credentialRefId: null,
      endpointRef: provider.endpoint,
      protocolType: "a2a",
      protocolContractRevision: "0.3.0",
      verificationState: "verified",
      revisionState: "draft",
    });
    expect(persisted[0]?.revision.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(persisted[0]?.revision.verifiedAt).toBeInstanceOf(Date);
    expect(persisted[0]?.revision.runtimeCapabilitiesJson).toEqual({
      conformance: {
        agent_card_protocol_version_match: true,
        event_stream_observed: true,
        input_required_observed: true,
        resume_completed: true,
      },
      interaction: {
        streaming_transport: true,
        incremental_content: false,
        input_required: true,
        resume: true,
        cancel: false,
        durable_task_recovery: false,
      },
    });
    const persistedJson = JSON.stringify(persisted);
    expect(persistedJson).not.toContain("我想请年假");
    expect(persistedJson).not.toContain("明天一天");
    expect(persistedJson).not.toContain("Test Enterprise Agent");
    expect(persistedJson).not.toContain("capability_manifest");
  });

  it("旧 card 路径（仅 /.well-known/agent.json）不能通过注册验收：非 2xx 且 fail closed", async () => {
    const seeded = await seedRegistrationTarget();
    // 独立 Provider 实例：只暴露已废弃的旧 card 路径（其余 A2A wire 行为正常）。
    const legacyOnly = await startA2ATestProvider("input_required", { legacyCardOnly: true });
    try {
      const response = await callPOST(
        seeded.agentId,
        baseBody(seeded.snapshotId, legacyOnly.endpoint),
        "idem-rt-reg-legacy-card-001",
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      await expectFailClosed(seeded.tenantId);
      await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
    } finally {
      await legacyOnly.close();
    }
  });

  it("严格 schema：多余字段/上传报告/passed/protocol/agent_card_url → 400，零网络零写", async () => {
    const seeded = await seedRegistrationTarget();
    const cases: Array<{ label: string; body: Record<string, unknown> }> = [
      {
        label: "顶层多余字段 report",
        body: { ...baseBody(seeded.snapshotId, provider.endpoint), report: { passed: true } },
      },
      {
        label: "顶层多余字段 passed=true",
        body: { ...baseBody(seeded.snapshotId, provider.endpoint), passed: true },
      },
      {
        label: "顶层多余字段 agent_card_url",
        body: {
          ...baseBody(seeded.snapshotId, provider.endpoint),
          agent_card_url: `${provider.endpoint}/.well-known/agent-card.json`,
        },
      },
      {
        label: "上传 protocol 事实",
        body: {
          ...baseBody(seeded.snapshotId, provider.endpoint),
          protocol: { type: "a2a", version: "0.3.0" },
        },
      },
      {
        label: "上传 capabilities 事实",
        body: {
          ...baseBody(seeded.snapshotId, provider.endpoint),
          capabilities: { streaming: true },
        },
      },
      {
        label: "authentication 多余 raw token 字段",
        body: {
          ...baseBody(seeded.snapshotId, provider.endpoint),
          authentication: { mode: "none", credential_ref_id: null, token: "raw-secret" },
        },
      },
    ];
    for (const c of cases) {
      const before = provider.requests.length;
      const response = await callPOST(
        seeded.agentId,
        c.body,
        `idem-rt-reg-schema-${randomUUID().slice(0, 8)}`,
      );
      expect(response.status, c.label).toBe(400);
      expectZeroNewNetwork(before);
      await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
    }
  });

  it("缺省/null/空白矩阵：四个必填字段缺省或非法 → 400，零网络零写", async () => {
    const seeded = await seedRegistrationTarget();
    const base = baseBody(seeded.snapshotId, provider.endpoint);
    const promptCases: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: "缺失 contract_snapshot_id", body: { ...base, contract_snapshot_id: undefined } },
      { label: "null contract_snapshot_id", body: { ...base, contract_snapshot_id: null } },
      { label: "空字符串 snapshot id", body: { ...base, contract_snapshot_id: "" } },
      { label: "缺失 runtime_endpoint", body: { ...base, runtime_endpoint: undefined } },
      { label: "null runtime_endpoint", body: { ...base, runtime_endpoint: null } },
      { label: "空白 endpoint", body: { ...base, runtime_endpoint: "   " } },
      { label: "相对 endpoint", body: { ...base, runtime_endpoint: "127.0.0.1:9000" } },
      {
        label: "endpoint 带 userinfo",
        body: { ...base, runtime_endpoint: "http://user:pass@127.0.0.1:9000" },
      },
      {
        label: "endpoint 带 query",
        body: { ...base, runtime_endpoint: `${provider.endpoint}?token=x` },
      },
      {
        label: "endpoint 带 fragment",
        body: { ...base, runtime_endpoint: `${provider.endpoint}#frag` },
      },
      { label: "缺失 authentication", body: { ...base, authentication: undefined } },
      { label: "null authentication", body: { ...base, authentication: null } },
      {
        label: "none 模式 credential_ref_id 非 null",
        body: { ...base, authentication: { mode: "none", credential_ref_id: "x" } },
      },
      {
        label: "none 模式缺失 credential_ref_id",
        body: { ...base, authentication: { mode: "none" } },
      },
      {
        label: "bearer 模式 credential_ref_id 为 null",
        body: { ...base, authentication: { mode: "bearer", credential_ref_id: null } },
      },
      {
        label: "bearer 模式缺失 credential_ref_id",
        body: { ...base, authentication: { mode: "bearer" } },
      },
      {
        label: "bearer 模式 credential_ref_id 空白",
        body: { ...base, authentication: { mode: "bearer", credential_ref_id: "  " } },
      },
      { label: "缺失 conformance", body: { ...base, conformance: undefined } },
      { label: "null conformance", body: { ...base, conformance: null } },
      {
        label: "空白 start_input",
        body: { ...base, conformance: { start_input: "   ", resume_input: "明天一天" } },
      },
      {
        label: "空白 resume_input",
        body: { ...base, conformance: { start_input: "我想请年假", resume_input: "" } },
      },
      {
        label: "conformance 多余字段",
        body: {
          ...base,
          conformance: { start_input: "我想请年假", resume_input: "明天一天", final_confirm: true },
        },
      },
    ];
    for (const c of promptCases) {
      const before = provider.requests.length;
      const response = await callPOST(
        seeded.agentId,
        c.body,
        `idem-rt-reg-null-${randomUUID().slice(0, 8)}`,
      );
      expect(response.status, c.label).toBe(400);
      expectZeroNewNetwork(before);
      await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
    }
  });

  it("bearer：真实凭证解析（env 引用 + Provider 401 校验）；缺失/跨租户/inactive 引用在网络前 400", async () => {
    const seeded = await seedRegistrationTarget();
    // 临时凭证：只存在于测试进程 env（不落 DB、不回显）；Provider 只接受恰好匹配的头。
    const token = randomBytes(24).toString("base64url");
    const envName = `SNOW_TEST_RUNTIME_BEARER_${randomUUID().slice(0, 8)}`;
    process.env[envName] = token;
    injectedEnvKeys.push(envName);
    provider.setExpectedBearerToken(token);
    const fingerprint = `sha256:${createHash("sha256").update(token).digest("hex")}`;

    // 1) 缺失引用 → 400，零网络。
    const before = provider.requests.length;
    const missing = await callPOST(
      seeded.agentId,
      {
        ...baseBody(seeded.snapshotId, provider.endpoint),
        authentication: { mode: "bearer", credential_ref_id: randomUUID() },
      },
      "idem-rt-reg-bearer-missing-001",
    );
    expect(missing.status).toBe(400);
    expectZeroNewNetwork(before);

    // 2) 跨租户引用（存在但不属于当前租户）→ 非 2xx，零网络，攻击方租户零写入。
    const otherTenantId = "22222222-2222-4222-8222-222222222222";
    await db.insert(tenant).values({
      id: otherTenantId,
      key: "bearer-other-tenant",
      name: "Bearer Other Tenant",
    });
    const crossTenantRefId = await seedCredentialRef(otherTenantId, {
      vaultRef: envName,
      fingerprint,
    });
    const crossTenant = await callPOST(
      seeded.agentId,
      {
        ...baseBody(seeded.snapshotId, provider.endpoint),
        authentication: { mode: "bearer", credential_ref_id: crossTenantRefId },
      },
      "idem-rt-reg-bearer-cross-tenant-001",
    );
    expect(crossTenant.status).toBeGreaterThanOrEqual(400);
    expect(crossTenant.status).toBeLessThan(500);
    expectZeroNewNetwork(before);
    await expect(countRuntimeRows(otherTenantId)).resolves.toBe(0);

    // 3) 非 active 引用（同租户存在但已 revoked）→ 非 2xx，零网络。
    const inactiveRefId = await seedCredentialRef(seeded.tenantId, {
      vaultRef: envName,
      fingerprint,
      lifecycleState: "revoked",
    });
    const inactive = await callPOST(
      seeded.agentId,
      {
        ...baseBody(seeded.snapshotId, provider.endpoint),
        authentication: { mode: "bearer", credential_ref_id: inactiveRefId },
      },
      "idem-rt-reg-bearer-inactive-001",
    );
    expect(inactive.status).toBeGreaterThanOrEqual(400);
    expect(inactive.status).toBeLessThan(500);
    expectZeroNewNetwork(before);

    // 4) 合法 active 引用：生产必须解析该 CredentialRef（env 引用）并携带恰好匹配的
    //    Authorization 头发起真实网络调用（Provider 对任何不匹配头返回真实 401）。
    const credentialRefId = await seedCredentialRef(seeded.tenantId, {
      vaultRef: envName,
      fingerprint,
    });
    const requestsBefore = provider.requests.length;
    const ok = await callPOST(
      seeded.agentId,
      {
        ...baseBody(seeded.snapshotId, provider.endpoint),
        authentication: { mode: "bearer", credential_ref_id: credentialRefId },
      },
      "idem-rt-reg-bearer-ok-001",
    );
    expect(ok.status).toBe(201);
    const newRequests = provider.requests.slice(requestsBefore);
    expect(newRequests.length).toBeGreaterThan(0);
    const expectedHeader = `Bearer ${token}`;
    expect(
      newRequests.every((r) => r.authorization === expectedHeader),
      "全部真实网络调用必须携带被解析凭证对应的 Authorization 头",
    ).toBe(true);
    const serialized = JSON.stringify(await ok.json());
    // 脱敏：不回显 token、vault 引用与 fingerprint 原值。
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(envName);
    expect(serialized).not.toContain("fingerprint");
    const persisted = await loadRuntimeRevisions(seeded.tenantId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.revision.credentialRefId).toBe(credentialRefId);
    expect(JSON.stringify(persisted)).not.toContain(token);
    expect(JSON.stringify(persisted)).not.toContain(envName);
  });

  it("授权：缺少 agent.runtime.register action scope → 403 ACTION_SCOPE_DENIED，零网络零写", async () => {
    const seeded = await seedRegistrationTarget({ grantAction: false });
    const before = provider.requests.length;
    const response = await callPOST(
      seeded.agentId,
      baseBody(seeded.snapshotId, provider.endpoint),
      "idem-rt-reg-forbidden-001",
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
    expectZeroNewNetwork(before);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
  });

  it("快照一致性：不存在/跨 Agent/跨租户快照 → 非 2xx，零网络零写（协议事实只来自本 Agent 快照）", async () => {
    const seeded = await seedRegistrationTarget();
    const otherAgent = await createAgent({
      tenantId: seeded.tenantId,
      agentKey: "other-agent",
      displayName: "Other Agent",
      ownerUserId: seeded.userIdentityId,
    });
    const otherSnapshot = await seedAgentContractSnapshot({
      tenantId: seeded.tenantId,
      agentId: otherAgent.id,
      createdBy: seeded.userIdentityId,
    });

    const otherTenantId = "11111111-1111-4111-8111-111111111111";
    await db
      .insert(tenant)
      .values({ id: otherTenantId, key: "other-tenant", name: "Other Tenant" });
    const otherTenantAgent = await createAgent({
      tenantId: otherTenantId,
      agentKey: "other-tenant-agent",
      displayName: "Other Tenant Agent",
      ownerUserId: seeded.userIdentityId,
    });
    const otherTenantSnapshot = await seedAgentContractSnapshot({
      tenantId: otherTenantId,
      agentId: otherTenantAgent.id,
      createdBy: seeded.userIdentityId,
    });

    const cases: Array<{ label: string; snapshotId: string }> = [
      { label: "不存在快照", snapshotId: randomUUID() },
      { label: "跨 Agent 快照", snapshotId: otherSnapshot.id },
      { label: "跨租户快照", snapshotId: otherTenantSnapshot.id },
    ];
    for (const c of cases) {
      const before = provider.requests.length;
      const response = await callPOST(
        seeded.agentId,
        baseBody(c.snapshotId, provider.endpoint),
        `idem-rt-reg-snapshot-${randomUUID().slice(0, 8)}`,
      );
      expect(response.status, c.label).toBeGreaterThanOrEqual(400);
      expect(response.status, c.label).toBeLessThan(500);
      expectZeroNewNetwork(before);
      await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
      // 攻击方租户无任何写入。
      await expect(countRuntimeRows(otherTenantId)).resolves.toBe(0);
    }
  });

  it("fail closed：不可达 endpoint / 无 input-required / resume correlation 被篡改 → 非 2xx 且永不 verified/published/enabled", async () => {
    const seeded = await seedRegistrationTarget();

    // 1) 不可达：起真实 Provider 后立即关闭，得到已释放端口。
    const dead = await startA2ATestProvider("input_required");
    const deadEndpoint = dead.endpoint;
    await dead.close();
    const unreachable = await callPOST(
      seeded.agentId,
      baseBody(seeded.snapshotId, deadEndpoint),
      "idem-rt-reg-unreachable-001",
    );
    expect(unreachable.status).toBeGreaterThanOrEqual(400);
    expect(unreachable.status).toBeLessThan(500);
    await expectFailClosed(seeded.tenantId);

    // 2) 无 input-required：stream 直接 completed（HR 快照声明 input_required=true）。
    provider.setScenario("completed");
    const noInputRequired = await callPOST(
      seeded.agentId,
      baseBody(seeded.snapshotId, provider.endpoint),
      "idem-rt-reg-no-input-required-001",
    );
    expect(noInputRequired.status).toBeGreaterThanOrEqual(400);
    expect(noInputRequired.status).toBeLessThan(500);
    await expectFailClosed(seeded.tenantId);
    provider.setScenario("input_required");

    // 3) resume correlation 被篡改（taskId/contextId 变化）。
    provider.corruptResumeCorrelation();
    const corrupted = await callPOST(
      seeded.agentId,
      baseBody(seeded.snapshotId, provider.endpoint),
      "idem-rt-reg-correlation-001",
    );
    expect(corrupted.status).toBeGreaterThanOrEqual(400);
    expect(corrupted.status).toBeLessThan(500);
    await expectFailClosed(seeded.tenantId);
  });

  it("幂等：同 key 同 body 重放不发起第二次网络序列、不产生重复行；同 key 不同 body 409", async () => {
    const seeded = await seedRegistrationTarget();
    const body = baseBody(seeded.snapshotId, provider.endpoint);
    const first = await callPOST(seeded.agentId, body, "idem-rt-reg-replay-001");
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const networkAfterFirst = provider.requests.length;
    const rowsAfterFirst = await countRuntimeRows(seeded.tenantId);

    const replay = await callPOST(seeded.agentId, body, "idem-rt-reg-replay-001");
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstBody);
    expect(provider.requests.length, "重放不得发起第二次网络序列").toBe(networkAfterFirst);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(rowsAfterFirst);

    const conflict = await callPOST(
      seeded.agentId,
      { ...body, conformance: { start_input: "我想请病假", resume_input: "明天一天" } },
      "idem-rt-reg-replay-001",
    );
    expect(conflict.status).toBe(409);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(rowsAfterFirst);
  });

  it("并发：同 key 同 body 并发重放不产生重复当前注册（接受 201+201 或 201+409，冻结唯一性）", async () => {
    const seeded = await seedRegistrationTarget();
    const body = baseBody(seeded.snapshotId, provider.endpoint);
    const requestsBefore = provider.requests.length;
    const [a, b] = await Promise.all([
      callPOST(seeded.agentId, body, "idem-rt-reg-concurrent-001"),
      callPOST(seeded.agentId, body, "idem-rt-reg-concurrent-001"),
    ]);
    const statuses = [a.status, b.status].sort();
    // 冻结的合法组合：恰好一个 201；另一个要么 201（幂等重放同响应）要么 409（in-flight/冲突）。
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);
    if (statuses[1] === 201) {
      // 双 201 时两个 body 必须一致（同一注册的幂等重放）。
      expect(await b.json()).toEqual(await a.json());
    }
    // 至多一次成功网络验收序列（标准 card 路径 GET ≤ 1），且只有一行 Runtime。
    const newRequests = provider.requests.slice(requestsBefore);
    expect(
      newRequests.filter((r) => r.method === "GET" && r.path === "/.well-known/agent-card.json")
        .length,
      "并发重放至多发起一次成功网络验收序列",
    ).toBeLessThanOrEqual(1);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(1);
    await expectFailClosed(seeded.tenantId);
  });
});
