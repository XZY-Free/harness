import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type A2ATestProvider,
  startA2ATestProvider,
} from "@/lib/agents/calls/test/a2a-test-provider";
/**
 * POST /admin/api/v1/agents/{agent_id}/runtime-registrations — capability-driven
 * 黑盒注册验收（02 专项）。
 *
 * 冻结不变量（Runtime Registration 权威切片）：
 * - 请求体严格 schema：contract_snapshot_id + runtime_endpoint + authentication{mode,
 *   credential_ref_id} + conformance{basic 恒必填；input_required/resume/cancel 可选}，
 *   probe presence 与快照 interaction 声明严格匹配，多余/缺失/多余字段一律 400。
 * - 协议/交互事实只能来自已导入的结构化 AgentContractSnapshot（同租户、同 Agent）；
 *   调用方不得上传 protocol/capabilities/report/passed/agent_card_url。
 * - SnowHarness 必须主动对黑盒 Runtime 发起真实 HTTP/SSE 一致性调用（02 §3-§7）：
 *   AgentCard → basic（按 streamingTransport 分 message/send / message/stream）→
 *   按声明 input_required / resume / cancel probe；incremental_content=true 必须真实
 *   观测内容增量；cancel=false 绝不调用 tasks/cancel。
 * - durableTaskRecovery：measured=not_measured、effective=false（02 §8）。
 * - 成功响应/持久化只含结构化 id/status/measured digest（declared/measured/effective
 *   三态分离），不含原始合同、conformance transcript、secret、AgentCard 事实覆盖。
 * - 一切失败 fail closed：不可达/路径错误/无 input-required/correlation 变化/协议冲突/
 *   无增量 → 非 2xx，永不 verified/published/enabled，零 Runtime/Revision 行。
 * - 幂等：同 key 同 body 重放不产生第二次网络序列或重复行；同 key 不同 body 409。
 * - 专用授权动作 agent.runtime.register（按具体 Agent scope）；租户隔离。
 *
 * 真实 MySQL 8（Testcontainers）+ 真实 node:http Provider + 全局 fetch，无 mock。
 */
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { hrAgentContract } from "@/lib/agents/test-support/hr-agent-contract";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ACTION_CODES } from "@/lib/identity/action-codes";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { roleActionBinding } from "@/lib/persistence/schema/authorization";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import { tenant } from "@/lib/persistence/schema/identity";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { credentialRefTable } from "@/lib/persistence/schema/tool";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { generateEd25519SignerKeyPair } from "@/lib/runtime/test-support/ed25519-signer-keypair";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 admin-routes.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;
const ORIGINAL_SIGNER_ENV = process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON;
const ORIGINAL_RUNNERS_ENV = process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON;

/** 动态加载被测路由。 */
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

/** 平台 active-external signer 测试身份（01 专项：Registration 主动 Conformance）。 */
const SIGNER_KEY_ID = "test-active-external-signer-key-1";
const SIGNER_RUNNER_IDENTITY = "snowharness/active-external-conformance@test";
const signerKeyPair = generateEd25519SignerKeyPair();

/** 写入正式 signer/注册表 env（生产 getter 每次读取，无冻结）。 */
function configureActiveSignerEnv(): void {
  process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = JSON.stringify({
    keyId: SIGNER_KEY_ID,
    runnerIdentity: SIGNER_RUNNER_IDENTITY,
    privateKeyPkcs8Base64: signerKeyPair.privateKeyPkcs8Base64,
  });
  process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = JSON.stringify([
    {
      keyId: SIGNER_KEY_ID,
      publicKey: signerKeyPair.publicKeyBase64,
      runnerIdentity: SIGNER_RUNNER_IDENTITY,
      tenantScope: null,
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: null,
      revokedAt: null,
    },
  ]);
}

beforeAll(async () => {
  configureActiveSignerEnv();
  provider = await startA2ATestProvider("input_required");
});

afterAll(async () => {
  await provider.close();
  process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = ORIGINAL_SIGNER_ENV;
  process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = ORIGINAL_RUNNERS_ENV;
});

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
  // Provider 状态隔离：清空 wire 记录、复位 correlation 篡改/Bearer 校验/card 覆盖，
  // 场景回 input_required。
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

/** interaction 覆盖（02 §12 Provider profile 的声明侧事实）。 */
function contractWithInteraction(overrides: Record<string, boolean>): unknown {
  const contract = structuredClone(hrAgentContract) as Record<string, unknown>;
  contract.interaction = {
    ...(contract.interaction as Record<string, unknown>),
    ...overrides,
  };
  return contract;
}

/** Profile A：basic-only（streaming=false，无任何可选 probe）。 */
const PROFILE_A_CONTRACT = contractWithInteraction({
  streaming_transport: false,
  incremental_content: false,
  input_required: false,
  resume: false,
  cancel: false,
});
/** Profile B：streaming + input-required + resume。 */
const PROFILE_B_CONTRACT = contractWithInteraction({
  streaming_transport: true,
  incremental_content: false,
  input_required: true,
  resume: true,
  cancel: false,
});
/** Profile C：streaming + cancel。 */
const PROFILE_C_CONTRACT = contractWithInteraction({
  streaming_transport: true,
  incremental_content: false,
  input_required: false,
  resume: false,
  cancel: true,
});
/** incremental 声明（依赖流式，02 §4）。 */
const INCREMENTAL_CONTRACT = contractWithInteraction({
  streaming_transport: true,
  incremental_content: true,
  input_required: false,
  resume: false,
  cancel: false,
});

/** 持久化 capabilities JSON 的断言形态（declared/measured/effective）。 */
type PersistedCapabilities = {
  declared: Record<string, unknown>;
  measured: Record<string, unknown> & { features: Record<string, unknown> };
  effective: Record<string, unknown>;
};

/** 完整种子：管理员 + Agent + 指定 interaction 的合同快照 +（可选）授权。 */
async function seedRegistrationTarget(options: { grantAction?: boolean; contract?: unknown } = {}) {
  const seeded = await seedAdmin();
  const agent = await createAgent({
    tenantId: seeded.tenantId,
    agentKey: `agent-${randomUUID().slice(0, 8)}`,
    displayName: "Capability Agent",
    ownerUserId: seeded.userIdentityId,
  });
  const snapshot = await seedAgentContractSnapshot({
    tenantId: seeded.tenantId,
    agentId: agent.id,
    createdBy: seeded.userIdentityId,
    ...(options.contract !== undefined ? { contract: options.contract } : {}),
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

/** capability-driven 合法请求体基线（mode=none 免密路径，不伪造 secret）。 */
function registrationBody(
  snapshotId: string,
  endpoint: string,
  conformance: Record<string, unknown>,
): Record<string, unknown> {
  return {
    contract_snapshot_id: snapshotId,
    runtime_endpoint: endpoint,
    authentication: { mode: "none", credential_ref_id: null },
    conformance,
  };
}

/** Profile B（streaming+input_required+resume）的 conformance 基线。 */
const B_CONFORMANCE = {
  basic: { input: "常规问题" },
  input_required: { input: "请补充请假信息" },
  resume: { start_input: "我想请年假", resume_input: "明天一天" },
};
/** Profile A（basic-only）的 conformance 基线。 */
const A_CONFORMANCE = { basic: { input: "常规问题" } };
/** Profile C（streaming+cancel）的 conformance 基线。 */
const C_CONFORMANCE = { basic: { input: "开始长任务" }, cancel: { input: "开始长任务" } };

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

// ─── Conformance DB 断言辅助（01 专项）─────────────────────

async function loadConformanceRuns(tenantId: string) {
  return db
    .select()
    .from(runtimeConformanceRun)
    .where(eq(runtimeConformanceRun.tenantId, tenantId));
}

async function loadCaseResults(runId: string) {
  return db
    .select()
    .from(runtimeConformanceCaseResult)
    .where(eq(runtimeConformanceCaseResult.runId, runId));
}

/** 断言事务回滚：Revision/Run/Cases/Audit/Outbox 全部零残留。 */
async function expectNoConformanceResidue(tenantId: string): Promise<void> {
  await expect(loadConformanceRuns(tenantId)).resolves.toHaveLength(0);
  const revisions = await loadRuntimeRevisions(tenantId);
  expect(revisions).toHaveLength(0);
  const audits = await db
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(eq(auditEvent.tenantId, tenantId));
  expect(audits.filter((a) => a.id !== undefined).length).toBe(0);
  const outbox = await db
    .select({ id: controlPlaneOutboxEvent.id })
    .from(controlPlaneOutboxEvent)
    .where(eq(controlPlaneOutboxEvent.tenantId, tenantId));
  expect(outbox).toHaveLength(0);
}

/** 断言 fail closed：无 verified/enabled/published 持久化状态。 */
async function expectFailClosed(tenantId: string) {
  await expect(countEnabledRuntimes(tenantId)).resolves.toBe(0);
  await expect(countPublishedRuntimeRevisions(tenantId)).resolves.toBe(0);
}

// ─── 用例 ─────────────────────────────────────────────────

describe("POST /admin/api/v1/agents/{agent_id}/runtime-registrations（capability-driven 注册验收）", () => {
  it("action 目录冻结：必须存在专用稳定动作 agent.runtime.register", () => {
    expect(ACTION_CODES).toContain("agent.runtime.register");
  });

  it("01/02：basic-only Agent（Profile A，streaming=false）注册成功且绝不调用 message/stream 与 tasks/cancel", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_A_CONTRACT });
    provider.setCardStreaming(false);
    provider.setScenario("completed");
    const requestsBefore = provider.requests.length;
    const rpcBefore = provider.rpcMethods.length;
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, A_CONFORMANCE),
      "idem-rt-reg-basic-a-001",
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.agent_contract_snapshot_id).toBe(seeded.snapshotId);
    expect(body.runtime_endpoint).toBe(provider.endpoint);
    expect(String(body.verification_state ?? body.status ?? "")).toContain("verified");
    // 结构化 measured 矩阵（02 §9）。
    expect(body.measured).toEqual({
      agent_card: { protocol_version: "pass", transport: "pass", streaming_consistency: "pass" },
      basic_invocation: { status: "pass" },
      features: {
        streaming_transport: "not_applicable",
        incremental_content: "not_applicable",
        input_required: "not_applicable",
        resume: "not_applicable",
        cancel: "not_applicable",
        durable_task_recovery: "not_measured",
      },
    });

    // wire：basic probe 走 message/send（streaming=false 不调用 message/stream）；
    // 快照未声明任何可选能力 → 无 input-required/resume 流，cancel=false 零 tasks/cancel。
    const newRpcMethods = provider.rpcMethods.slice(rpcBefore);
    expect(newRpcMethods).toContain("message/send");
    expect(newRpcMethods).not.toContain("message/stream");
    expect(newRpcMethods).not.toContain("tasks/cancel");

    // 持久化：declared 全 false → measured features 全 not_applicable、effective 全 false。
    const persisted = await loadRuntimeRevisions(seeded.tenantId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.revision).toMatchObject({
      credentialRefId: null,
      endpointRef: provider.endpoint,
      protocolType: "a2a",
      protocolContractRevision: "0.3.0",
      revisionState: "draft",
    });
    expect(persisted[0]?.revision.runtimeCapabilitiesJson).toEqual({
      declared: {
        streaming_transport: false,
        incremental_content: false,
        input_required: false,
        resume: false,
        cancel: false,
        durable_task_recovery: false,
      },
      measured: {
        agent_card: {
          protocol_version: "pass",
          transport: "pass",
          streaming_consistency: "pass",
        },
        basic_invocation: { status: "pass" },
        features: {
          streaming_transport: "not_applicable",
          incremental_content: "not_applicable",
          input_required: "not_applicable",
          resume: "not_applicable",
          cancel: "not_applicable",
          durable_task_recovery: "not_measured",
        },
      },
      effective: {
        streaming_transport: false,
        incremental_content: false,
        input_required: false,
        resume: false,
        cancel: false,
        durable_task_recovery: false,
      },
    });
    await expectFailClosed(seeded.tenantId);
  });

  it("03/08/11：streaming=true（Profile B）真实观测 SSE，cancel=false 零 tasks/cancel，durable=not_measured", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const requestsBefore = provider.requests.length;
    const capturedBefore = provider.captured.length;
    const rpcBefore = provider.rpcMethods.length;
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
      "idem-rt-reg-streaming-b-001",
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.measured).toEqual({
      agent_card: { protocol_version: "pass", transport: "pass", streaming_consistency: "pass" },
      basic_invocation: { status: "pass" },
      features: {
        streaming_transport: "pass",
        incremental_content: "not_applicable",
        input_required: "pass",
        resume: "pass",
        cancel: "not_applicable",
        durable_task_recovery: "not_measured",
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Test Enterprise Agent");
    expect(serialized).not.toContain("capability_manifest");
    expect(serialized).not.toContain("请提供申请日期");
    expect(serialized).not.toContain("已收到补充信息");
    expect(serialized).not.toContain("vaultRef");
    expect(serialized).not.toContain("raw_contract");

    // 真实网络序列：card → basic(stream) → input-required(stream) → resume start(stream)
    // + resume(message/send 同 correlation completed)。
    const newRequests = provider.requests.slice(requestsBefore);
    const newCaptured = provider.captured.slice(capturedBefore);
    const newRpcMethods = provider.rpcMethods.slice(rpcBefore);
    expect(
      newRequests.filter((r) => r.method === "GET" && r.path === "/.well-known/agent-card.json"),
    ).toHaveLength(1);
    expect(newRpcMethods.filter((m) => m === "message/stream").length).toBeGreaterThanOrEqual(3);
    expect(newRpcMethods).toContain("message/send");
    // cancel=false：tasks/cancel 网络次数 = 0（02 §7）。
    expect(newRpcMethods.filter((m) => m === "tasks/cancel")).toHaveLength(0);
    // basic 与 input_required probe 使用各自声明的输入。
    expect(newCaptured.filter((c) => c.text === "常规问题").length).toBeGreaterThanOrEqual(1);
    const inputRequiredCall = newCaptured.find((c) => c.text === "我想请年假");
    expect(inputRequiredCall).toBeDefined();
    // resume：message/send 携带 resume_input 且同 taskId/contextId。
    const resumeCall = newCaptured.find((c) => c.resume && c.text === "明天一天");
    const startCall = newCaptured.find((c) => c.text === "我想请年假");
    expect(resumeCall?.taskId).toBe(startCall?.responseTaskId);
    expect(resumeCall?.contextId).toBe(startCall?.responseContextId);

    // durable_task_recovery：not_measured 且 effective=false（02 §8/§11）。
    const persisted = await loadRuntimeRevisions(seeded.tenantId);
    expect(persisted).toHaveLength(1);
    const capabilities = persisted[0]?.revision.runtimeCapabilitiesJson as PersistedCapabilities;
    expect(capabilities.declared.durable_task_recovery).toBe(false);
    expect(capabilities.measured.features.durable_task_recovery).toBe("not_measured");
    expect(capabilities.effective.durable_task_recovery).toBe(false);
    expect(capabilities.effective).toEqual({
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
    });
    const persistedJson = JSON.stringify(persisted);
    expect(persistedJson).not.toContain("我想请年假");
    expect(persistedJson).not.toContain("明天一天");
    await expectFailClosed(seeded.tenantId);
  });

  it("04/06：inputRequired=false、resume=false 不跑对应 probe（completed 场景即可注册成功）", async () => {
    const seeded = await seedRegistrationTarget({
      contract: contractWithInteraction({
        streaming_transport: true,
        incremental_content: false,
        input_required: false,
        resume: false,
        cancel: false,
      }),
    });
    provider.setScenario("completed");
    const rpcBefore = provider.rpcMethods.length;
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, A_CONFORMANCE),
      "idem-rt-reg-no-optional-001",
    );
    expect(response.status).toBe(201);
    // 只有 basic probe（一次 message/stream）；没有 resume 的 message/send（无 taskId 调用）。
    const newRpcMethods = provider.rpcMethods.slice(rpcBefore);
    expect(newRpcMethods.filter((m) => m === "message/stream")).toHaveLength(1);
    expect(newRpcMethods).not.toContain("message/send");
    expect(newRpcMethods).not.toContain("tasks/cancel");
    const captured = provider.captured;
    expect(captured.every((c) => !c.resume)).toBe(true);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(1);
  });

  it("05/13：声明 input_required=true 但未观测到 → 422 fail closed，零 Runtime/Revision 行", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    provider.setScenario("completed");
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
      "idem-rt-reg-no-input-required-001",
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    await expectFailClosed(seeded.tenantId);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
  });

  it("07/13：resume correlation 被篡改 → 422 fail closed，零行", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    provider.corruptResumeCorrelation();
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
      "idem-rt-reg-correlation-001",
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    await expectFailClosed(seeded.tenantId);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
  });

  it("09：cancel=true 真测取消（Profile C：start long-running → tasks/cancel → canceled）", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_C_CONTRACT });
    provider.setScenario("long_running");
    const requestsBefore = provider.requests.length;
    const rpcBefore = provider.rpcMethods.length;
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, C_CONFORMANCE),
      "idem-rt-reg-cancel-c-001",
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect((body.measured as Record<string, unknown>).features).toMatchObject({
      cancel: "pass",
      input_required: "not_applicable",
      resume: "not_applicable",
    });
    // wire：真实调用了 tasks/cancel（且只有一次，同 correlation）。
    const newRpcMethods = provider.rpcMethods.slice(rpcBefore);
    expect(newRpcMethods.filter((m) => m === "tasks/cancel")).toHaveLength(1);
    const persisted = await loadRuntimeRevisions(seeded.tenantId);
    expect(persisted).toHaveLength(1);
    const capabilities = persisted[0]?.revision.runtimeCapabilitiesJson as PersistedCapabilities;
    expect(capabilities.effective.cancel).toBe(true);
  });

  it("10：incremental_content=true 无内容增量（仅状态 update）→ 422 fail closed", async () => {
    const seeded = await seedRegistrationTarget({ contract: INCREMENTAL_CONTRACT });
    provider.setScenario("chunks");
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, A_CONFORMANCE),
      "idem-rt-reg-incremental-none-001",
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    await expectFailClosed(seeded.tenantId);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
  });

  it("10：incremental_content=true 真实观测 artifact 增量 → 201，measured/effective=pass/true", async () => {
    const seeded = await seedRegistrationTarget({ contract: INCREMENTAL_CONTRACT });
    provider.setScenario("incremental");
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, A_CONFORMANCE),
      "idem-rt-reg-incremental-ok-001",
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect((body.measured as Record<string, unknown>).features).toMatchObject({
      incremental_content: "pass",
    });
    const persisted = await loadRuntimeRevisions(seeded.tenantId);
    const capabilities = persisted[0]?.revision.runtimeCapabilitiesJson as PersistedCapabilities;
    expect(capabilities.measured.features.incremental_content).toBe("pass");
    expect(capabilities.effective.incremental_content).toBe(true);
  });

  it("12/13：AgentCard 协议版本/streaming 与快照冲突 → 422 fail closed，零行（不进入任何 message probe）", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    // 协议版本冲突。
    provider.setCardProtocolVersion("0.2.5");
    const mismatch = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
      "idem-rt-reg-card-mismatch-001",
    );
    expect(mismatch.status).toBeGreaterThanOrEqual(400);
    expect(mismatch.status).toBeLessThan(500);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
    // streaming 一致性冲突（快照 streaming=true，card 声明 false）。
    provider.setCardStreaming(false);
    const streamingMismatch = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
      "idem-rt-reg-card-streaming-001",
    );
    expect(streamingMismatch.status).toBeGreaterThanOrEqual(400);
    expect(streamingMismatch.status).toBeLessThan(500);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
    // 两次失败都停在 AgentCard：不发起任何 message 调用。
    expect(provider.captured.length).toBe(0);
    await expectFailClosed(seeded.tenantId);
  });

  it("13：malformed SSE（声明 streaming=true）→ 422 fail closed，零行", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    provider.setScenario("malformed");
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
      "idem-rt-reg-malformed-001",
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    await expectFailClosed(seeded.tenantId);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
  });

  it("13：不可达 endpoint → 422 fail closed，零行", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const dead = await startA2ATestProvider("input_required");
    const deadEndpoint = dead.endpoint;
    await dead.close();
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, deadEndpoint, B_CONFORMANCE),
      "idem-rt-reg-unreachable-001",
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    await expectFailClosed(seeded.tenantId);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
  });

  it("旧 card 路径（仅 /.well-known/agent.json）不能通过注册验收：非 2xx 且 fail closed", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const legacyOnly = await startA2ATestProvider("input_required", { legacyCardOnly: true });
    try {
      const response = await callPOST(
        seeded.agentId,
        registrationBody(seeded.snapshotId, legacyOnly.endpoint, B_CONFORMANCE),
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

  it("presence 规则：probe 与快照声明不匹配（缺失/多余）→ 400，零网络零写（02 §2）", async () => {
    // B 快照：声明 input_required/resume → 缺 input_required 或缺 resume 均 400。
    const seededB = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const casesB: Array<{ label: string; conformance: Record<string, unknown> }> = [
      {
        label: "缺 input_required",
        conformance: { basic: B_CONFORMANCE.basic, resume: B_CONFORMANCE.resume },
      },
      {
        label: "缺 resume",
        conformance: { basic: B_CONFORMANCE.basic, input_required: B_CONFORMANCE.input_required },
      },
      {
        label: "多余 cancel",
        conformance: { ...B_CONFORMANCE, cancel: { input: "x" } },
      },
    ];
    for (const c of casesB) {
      const before = provider.requests.length;
      const response = await callPOST(
        seededB.agentId,
        registrationBody(seededB.snapshotId, provider.endpoint, c.conformance),
        `idem-rt-reg-presence-b-${randomUUID().slice(0, 8)}`,
      );
      expect(response.status, c.label).toBe(400);
      expectZeroNewNetwork(before);
      await expect(countRuntimeRows(seededB.tenantId)).resolves.toBe(0);
    }

    // A 快照（未声明可选能力）：多余 input_required/resume/cancel 均 400。
    const seededA = await seedRegistrationTarget({ contract: PROFILE_A_CONTRACT });
    const casesA: Array<{ label: string; conformance: Record<string, unknown> }> = [
      {
        label: "多余 input_required",
        conformance: { basic: A_CONFORMANCE.basic, input_required: { input: "x" } },
      },
      {
        label: "多余 resume",
        conformance: {
          basic: A_CONFORMANCE.basic,
          resume: { start_input: "x", resume_input: "y" },
        },
      },
      { label: "多余 cancel", conformance: { basic: A_CONFORMANCE.basic, cancel: { input: "x" } } },
    ];
    for (const c of casesA) {
      const before = provider.requests.length;
      const response = await callPOST(
        seededA.agentId,
        registrationBody(seededA.snapshotId, provider.endpoint, c.conformance),
        `idem-rt-reg-presence-a-${randomUUID().slice(0, 8)}`,
      );
      expect(response.status, c.label).toBe(400);
      expectZeroNewNetwork(before);
      await expect(countRuntimeRows(seededA.tenantId)).resolves.toBe(0);
    }
  });

  it("严格 schema：多余字段/上传报告/passed/protocol/agent_card_url → 400，零网络零写", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const base = registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE);
    const cases: Array<{ label: string; body: Record<string, unknown> }> = [
      {
        label: "顶层多余字段 report",
        body: { ...base, report: { passed: true } },
      },
      {
        label: "顶层多余字段 passed=true",
        body: { ...base, passed: true },
      },
      {
        label: "顶层多余字段 agent_card_url",
        body: {
          ...base,
          agent_card_url: `${provider.endpoint}/.well-known/agent-card.json`,
        },
      },
      {
        label: "上传 protocol 事实",
        body: {
          ...base,
          protocol: { type: "a2a", version: "0.3.0" },
        },
      },
      {
        label: "上传 capabilities 事实",
        body: {
          ...base,
          capabilities: { streaming: true },
        },
      },
      {
        label: "authentication 多余 raw token 字段",
        body: {
          ...base,
          authentication: { mode: "none", credential_ref_id: null, token: "raw-secret" },
        },
      },
      {
        label: "conformance 多余 probe",
        body: {
          ...base,
          conformance: { ...B_CONFORMANCE, durable_recovery: { input: "x" } },
        },
      },
      {
        label: "conformance.basic 多余字段",
        body: {
          ...base,
          conformance: { ...B_CONFORMANCE, basic: { input: "x", extra: true } },
        },
      },
      {
        label: "conformance.resume 多余字段",
        body: {
          ...base,
          conformance: {
            ...B_CONFORMANCE,
            resume: { start_input: "x", resume_input: "y", final_confirm: true },
          },
        },
      },
      {
        label: "缺失 conformance.basic",
        body: {
          ...base,
          conformance: {
            input_required: B_CONFORMANCE.input_required,
            resume: B_CONFORMANCE.resume,
          },
        },
      },
      {
        label: "空白 basic.input",
        body: { ...base, conformance: { ...B_CONFORMANCE, basic: { input: "   " } } },
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

  it("缺省/null/空白矩阵：必填字段缺省或非法 → 400，零网络零写", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const base = registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE);
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
        label: "conformance 非对象",
        body: { ...base, conformance: "start" },
      },
      {
        label: "input_required 非对象",
        body: { ...base, conformance: { ...B_CONFORMANCE, input_required: "x" } },
      },
      {
        label: "input_required.input 空白",
        body: {
          ...base,
          conformance: { ...B_CONFORMANCE, input_required: { input: "" } },
        },
      },
      {
        label: "resume.start_input 空白",
        body: {
          ...base,
          conformance: { ...B_CONFORMANCE, resume: { start_input: "  ", resume_input: "y" } },
        },
      },
      {
        label: "resume.resume_input 空白",
        body: {
          ...base,
          conformance: { ...B_CONFORMANCE, resume: { start_input: "x", resume_input: "" } },
        },
      },
      {
        label: "cancel.input 空白",
        body: { ...base, conformance: { ...B_CONFORMANCE, cancel: { input: "" } } },
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
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
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
        ...registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
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
        ...registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
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
        ...registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
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
        ...registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
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
    const seeded = await seedRegistrationTarget({
      grantAction: false,
      contract: PROFILE_B_CONTRACT,
    });
    const before = provider.requests.length;
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
      "idem-rt-reg-forbidden-001",
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
    expectZeroNewNetwork(before);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
  });

  it("快照一致性：不存在/跨 Agent/跨租户快照 → 非 2xx，零网络零写（协议事实只来自本 Agent 快照）", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
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
        registrationBody(c.snapshotId, provider.endpoint, B_CONFORMANCE),
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

  it("14：幂等：同 key 同 body 重放不发起第二次网络序列、不产生重复行；同 key 不同 body 409", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const body = registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE);
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
      {
        ...body,
        conformance: {
          ...B_CONFORMANCE,
          resume: { start_input: "我想请病假", resume_input: "明天一天" },
        },
      },
      "idem-rt-reg-replay-001",
    );
    expect(conflict.status).toBe(409);
    await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(rowsAfterFirst);
  });

  it("并发：同 key 同 body 并发重放不产生重复当前注册（接受 201+201 或 201+409，冻结唯一性）", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const body = registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE);
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

  // ─── 01 专项：Registration 主动 Conformance 正式接线 ──────

  it("01/§15-1：Profile B 注册成功原子落库 1 RuntimeRevision + 1 ConformanceRun + 6 Cases（overall passed，精确绑定）", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
      "idem-rt-reg-conformance-b-001",
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;

    // API 返回真实 conformance 证据（仅 id/结果/数量，无 envelope/签名材料）。
    expect(typeof body.conformance_run_id).toBe("string");
    expect(body.conformance_overall_result).toBe("passed");
    expect(body.conformance_case_count).toBe(6);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("payloadType");
    expect(serialized).not.toContain("signatures");
    expect(serialized).not.toContain("privateKey");

    // 持久化：恰一个 Run，绑定同租户 + 响应中的 revision。
    const runs = await loadConformanceRuns(seeded.tenantId);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    if (!run) throw new Error("ConformanceRun 未落库");
    expect(run.id).toBe(body.conformance_run_id);
    expect(run.overallResult).toBe("passed");
    expect(run.runtimeRevisionId).toBe(body.runtime_revision_id);
    expect(run.runnerIdentity).toBe(SIGNER_RUNNER_IDENTITY);
    expect(run.idempotencyKey).toBe(
      "runtime-registration-conformance:idem-rt-reg-conformance-b-001",
    );
    // run 与 revision 的 digest/协议绑定完全一致（禁止第二份 digest 计算）。
    const revisions = await loadRuntimeRevisions(seeded.tenantId);
    expect(revisions).toHaveLength(1);
    const revision = revisions[0]?.revision;
    if (!revision) throw new Error("RuntimeRevision 未落库");
    expect(run.runtimeTargetDigest).toBe(revision.runtimeTargetDigest);
    expect(run.runtimeConfigDigest).toBe(revision.configHash);
    expect(run.protocolContractRevision).toBe(revision.protocolContractRevision);
    // probe 时间事实：startedAt/completedAt 是唯一持久化验收时间，合法有序。
    expect(run.startedAt.getTime()).toBeLessThanOrEqual(run.completedAt.getTime());

    // 6 个 Case 全部 passed；cancel=false 以诚实不适用语义通过。
    const cases = await loadCaseResults(run.id);
    expect(cases).toHaveLength(6);
    expect(cases.every((c) => c.passed)).toBe(true);
    const cancelCase = cases.find((c) => c.caseId === "cancel-acknowledgement");
    expect(cancelCase).toBeDefined();
    // replay 语义：conformance 幂等键已绑定本 Run。
    expect(run.requestId).toBeTruthy();
  });

  it("§15-3：signer 未配置 → 非 2xx，Provider 零请求，DB 零 Runtime/Revision/Run", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const before = provider.requests.length;
    const originalSigner = process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON;
    process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = undefined;
    try {
      const response = await callPOST(
        seeded.agentId,
        registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
        "idem-rt-reg-no-signer-001",
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expectZeroNewNetwork(before);
      await expectNoConformanceResidue(seeded.tenantId);
      await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
    } finally {
      process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = originalSigner;
    }
  });

  it("§15-4：signer 私钥与注册公钥不匹配 → 非 2xx，Provider 零请求，零行", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const before = provider.requests.length;
    const originalSigner = process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON;
    // 注册表仍是 keyPair A 的公钥，signer 换成另一对私钥 → 公钥不匹配 fail closed。
    const other = generateEd25519SignerKeyPair();
    process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = JSON.stringify({
      keyId: SIGNER_KEY_ID,
      runnerIdentity: SIGNER_RUNNER_IDENTITY,
      privateKeyPkcs8Base64: other.privateKeyPkcs8Base64,
    });
    try {
      const response = await callPOST(
        seeded.agentId,
        registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
        "idem-rt-reg-signer-mismatch-001",
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expectZeroNewNetwork(before);
      await expectNoConformanceResidue(seeded.tenantId);
      await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
    } finally {
      process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = originalSigner;
    }
  });

  it("§15-5：append 之后事务失败 → Revision/Run/Cases/Audit/Outbox 全部回滚", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const { __setRuntimeRegistrationPostAppendHookForTests } = await import(
      "@/lib/runtime/application/register-agent-runtime"
    );
    __setRuntimeRegistrationPostAppendHookForTests(() => {
      throw new Error("injected post-append failure");
    });
    try {
      // 路由对非 AgentRuntimeRegistrationError 直接上抛（fail loudly），无 5xx 响应体。
      await expect(
        callPOST(
          seeded.agentId,
          registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE),
          "idem-rt-reg-rollback-001",
        ),
      ).rejects.toThrow("injected post-append failure");
      await expectNoConformanceResidue(seeded.tenantId);
      await expect(countRuntimeRows(seeded.tenantId)).resolves.toBe(0);
    } finally {
      __setRuntimeRegistrationPostAppendHookForTests(null);
    }
  });

  it("§15-6：同 key 同 body replay 不新建第二 ConformanceRun", async () => {
    const seeded = await seedRegistrationTarget({ contract: PROFILE_B_CONTRACT });
    const body = registrationBody(seeded.snapshotId, provider.endpoint, B_CONFORMANCE);
    const first = await callPOST(seeded.agentId, body, "idem-rt-reg-conformance-replay-001");
    expect(first.status).toBe(201);
    await expect(loadConformanceRuns(seeded.tenantId)).resolves.toHaveLength(1);

    const replay = await callPOST(seeded.agentId, body, "idem-rt-reg-conformance-replay-001");
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
    await expect(loadConformanceRuns(seeded.tenantId)).resolves.toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 03 专项：Contract-driven Conformance Context
// ═══════════════════════════════════════════════════════════

/** 覆盖合同 invocation_context + interaction（其余 HR 合同事实保留）。 */
function contractWithProbeContextProfile(
  contexts: Array<Record<string, unknown>>,
  interaction: Record<string, unknown>,
): unknown {
  const contract = structuredClone(hrAgentContract) as Record<string, unknown>;
  contract.invocation_context = contexts;
  contract.interaction = {
    durable_task_recovery: false,
    supported_locales: ["zh-CN", "en-US"],
    ...interaction,
  };
  return contract;
}

describe("03 专项 Contract-driven Conformance Context（注册验收）", () => {
  it("Strict-Minimal：合同只声明 locale preferred → 只发送 locale（严格 Provider 拒绝任何额外 key 仍注册成功）", async () => {
    const contract = contractWithProbeContextProfile(
      [{ key: "locale", name: { "zh-CN": "语言环境" }, necessity: "preferred" }],
      {
        streaming_transport: false,
        incremental_content: false,
        input_required: false,
        resume: false,
        cancel: false,
      },
    );
    const seeded = await seedRegistrationTarget({ contract });
    provider.setCardStreaming(false);
    provider.setScenario("completed");
    provider.setStrictMetadataAllowlist(["locale"]);
    const before = provider.requests.length;

    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, A_CONFORMANCE),
      "idem-rt-ctx-strict-minimal-001",
    );
    expect(response.status).toBe(201);
    expect(provider.requests.length - before).toBeGreaterThan(0);

    // 每条 message.metadata 只有 locale（绝无 execution_subject/current_datetime/timezone）
    expect(provider.captured.length).toBeGreaterThan(0);
    for (const c of provider.captured) {
      expect(Object.keys(c.messageMetadata ?? {})).toEqual(["locale"]);
    }
  });

  it("Required-Subject：execution_subject required → 全部 probe message（含 cancel start）都带 platform_service subject", async () => {
    const contract = contractWithProbeContextProfile(
      [
        { key: "execution_subject", name: { "zh-CN": "执行主体" }, necessity: "required" },
        { key: "current_datetime", name: { "zh-CN": "当前时间" }, necessity: "preferred" },
      ],
      {
        streaming_transport: true,
        incremental_content: false,
        input_required: false,
        resume: false,
        cancel: true,
      },
    );
    const seeded = await seedRegistrationTarget({ contract });
    provider.setScenario("long_running");
    provider.setCardStreaming(true);

    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, C_CONFORMANCE),
      "idem-rt-ctx-required-subject-001",
    );
    expect(response.status).toBe(201);

    expect(provider.captured.length).toBeGreaterThan(0);
    for (const c of provider.captured) {
      const subject = c.messageMetadata?.execution_subject as { subject_kind?: string } | undefined;
      expect(subject?.subject_kind).toBe("platform_service");
    }
    // 报告审计摘要：probe_context_kinds 只含 kind
    const runs = await loadConformanceRuns(seeded.tenantId);
    expect(runs).toHaveLength(1);
    // DSSE envelope payload 解码出正式报告（03 §九：审计摘要只记录 kind）
    const envelope = JSON.parse(runs[0]?.envelopeJson ?? "{}") as {
      payload?: string;
    };
    const report = JSON.parse(Buffer.from(envelope.payload ?? "", "base64").toString("utf8")) as {
      predicate?: {
        probe_context_kinds?: {
          supplied?: string[];
          unavailable_required?: string[];
        };
      };
    };
    expect(report.predicate?.probe_context_kinds?.supplied).toContain("execution_subject");
    expect(report.predicate?.probe_context_kinds?.supplied).toContain("current_datetime");
    expect(report.predicate?.probe_context_kinds?.unavailable_required).toEqual([]);
  });

  it("Required unavailable：workspace_context required → 422 + 网络零请求 + 零 Runtime/Revision/Run", async () => {
    const contract = contractWithProbeContextProfile(
      [{ key: "workspace_context", name: { "zh-CN": "工作区上下文" }, necessity: "required" }],
      {
        streaming_transport: false,
        incremental_content: false,
        input_required: false,
        resume: false,
        cancel: false,
      },
    );
    const seeded = await seedRegistrationTarget({ contract });
    provider.setCardStreaming(false);
    provider.setScenario("completed");
    const before = provider.requests.length;

    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, A_CONFORMANCE),
      "idem-rt-ctx-unavailable-001",
    );
    expect(response.status).toBe(422);
    // 网络请求次数 = 0（fail closed 在任何 Provider 请求之前）
    expect(provider.requests.length - before).toBe(0);
    await expectNoConformanceResidue(seeded.tenantId);
  });
});

// ─── 05 专项（P2-3）：durable=true 声明可注册（E2E-10） ────────

describe("05 专项：durable_task_recovery=true 声明（E2E-10）", () => {
  it("durable=true + not_measured + effective=false → Registration 成功（201），effective durable=false", async () => {
    const contract = contractWithProbeContextProfile(
      [{ key: "execution_subject", name: { "zh-CN": "执行主体" }, necessity: "required" }],
      {
        streaming_transport: true,
        incremental_content: false,
        input_required: false,
        resume: false,
        cancel: false,
        durable_task_recovery: true,
      },
    );
    const seeded = await seedRegistrationTarget({ contract });
    provider.setScenario("completed");
    provider.setCardStreaming(true);

    const response = await callPOST(
      seeded.agentId,
      registrationBody(seeded.snapshotId, provider.endpoint, { basic: { input: "常规问题" } }),
      "idem-rt-durable-declared-001",
    );
    expect(response.status).toBe(201);

    const revisions = await loadRuntimeRevisions(seeded.tenantId);
    expect(revisions).toHaveLength(1);
    const caps = revisions[0]?.revision.runtimeCapabilitiesJson as {
      declared: { durable_task_recovery: boolean };
      measured: { features: { durable_task_recovery: string } };
      effective: { durable_task_recovery: boolean };
    };
    expect(caps.declared.durable_task_recovery).toBe(true);
    expect(caps.measured.features.durable_task_recovery).toBe("not_measured");
    expect(caps.effective.durable_task_recovery).toBe(false);
  });
});
