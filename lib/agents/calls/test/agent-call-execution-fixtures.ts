/**
 * AgentCall 执行域测试共用夹具（startAgentCall 应用服务集成测试的种子支撑）。
 *
 * 只播种 startAgentCall 真正读取的事实源：
 * - 真实 Tenant / parent Invocation（running，含 refs，满足 AgentCall FK 与"父运行中"不变量）。
 * - 真实 Agent + published AgentRevision + 结构化 AgentContractSnapshot
 *   （execution_subject=required，匹配仓内 A2A Provider 的 Invocation Context Contract；
 *    供"required context 缺失/被拒"反例断言）。
 * - 真实 CredentialRef（provider=env，唯一 TEST env token + fingerprint）。
 * - 正式 Agent Route → Activation → Projection → Resolver。
 * - 经 finalizeAgentCall 事务冻结的 AgentCall + AgentCallBinding。
 *
 * startAgentCall 从 binding 读取 endpoint/protocol/credential/contract，绝不重新解析
 * Route；但创建夹具仍必须经真实 Agent Route Authority 完成冻结。
 *
 * 提供 createNewLatestEvidence 用于"冻结后新建最新 AgentRevision/Credential"反例：
 * 新建一个内容可观察不同的 published 修订（NEW_LATEST_CONTRACT：agent version/name 不同、
 * invocation context 的 current_datetime 换成 timezone）+ 新 CredentialRef，证明 start
 * 仍用 binding 冻结的旧证据（outbound 元数据与 binding hash 均保持冻结值）。
 */
import { createHash, randomUUID } from "node:crypto";
import { createCreateAgentCall } from "@/lib/agents/calls/application/create-agent-call";
import { resolveRequiredAgentBinding } from "@/lib/agents/calls/application/resolve-agent-call-binding";
import {
  type AgentCallBindingConfigInput,
  computeAgentCallBindingHash,
} from "@/lib/agents/calls/domain/agent-call-binding";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import {
  type A2ATestProvider,
  startA2ATestProvider,
} from "@/lib/agents/calls/test/a2a-test-provider";
import { seedInvocation, seedTenant } from "@/lib/agents/calls/test/agent-call-test-fixtures";
import {
  createAgent,
  getAgentById,
  updateAgentLifecycle,
} from "@/lib/agents/persistence/agent-queries";
import { createDraftRevision } from "@/lib/agents/persistence/agent-revision-queries";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { db } from "@/lib/db/client";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallTable,
} from "@/lib/persistence/schema/agent-calls";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { credentialRefTable } from "@/lib/persistence/schema/tool";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import type { RouteResolution } from "@/lib/routes/domain/route-resolution-policy";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { buildActor } from "@/lib/test-support/create-verified-attestation";
import { publishTrustedAgentRevisionForTest } from "@/lib/test-support/publish-trusted-agent-revision";
import { and, eq } from "drizzle-orm";

/** sha256 指纹 helper（与 resolveOutboundRuntimeAuth 重算逻辑一致）。 */
export function fingerprintOf(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/**
 * 匹配仓内 A2A Provider 的合同：execution_subject=required，其余合法事实。
 * 与 provider 的 A2A_TEST_PROVIDER_CONTEXT_CONTRACT（required=[execution_subject]）对应。
 */
export const EXECUTION_FIXTURE_CONTRACT = {
  contract_version: "1.0.0",
  agent: {
    id: "exec-agent",
    name: { "zh-CN": "执行测试Agent", en: "Execution Test Agent" },
    version: "1.0.0",
  },
  capabilities: [
    {
      key: "general_assistance",
      name: { "zh-CN": "通用协助", en: "General Assistance" },
      description: { "zh-CN": "通用任务", en: "General task" },
    },
  ],
  invocation_context: [
    {
      key: "execution_subject",
      name: { "zh-CN": "执行主体" },
      necessity: "required",
    },
    {
      key: "current_datetime",
      name: { "zh-CN": "当前时间" },
      necessity: "preferred",
    },
  ],
  interaction: {
    streaming_transport: true,
    incremental_content: false,
    input_required: false,
    resume: false,
    cancel: false,
    durable_task_recovery: false,
    supported_locales: ["zh-CN", "en"],
  },
  result_contract: {
    fields: ["status"],
    error_codes: ["ERR"],
    notes: { "zh-CN": "无" },
  },
};

/**
 * 冻结后"新建最新修订"所用的内容可观察差异合同。
 *
 * 与 EXECUTION_FIXTURE_CONTRACT 的可观察差异：
 * - agent version 2.0.0 / name 不同（合同内容差异，非仅新 ID）；
 * - invocation_context 把 current_datetime 换成 timezone —— 若 start 错误使用该最新
 *   修订的合同，outbound metadata 会出现 timezone 而非 current_datetime，从而可断言
 *   outbound 元数据仍来自冻结合同事实。
 */
export const NEW_LATEST_CONTRACT = {
  contract_version: "1.0.0",
  agent: {
    id: "exec-agent",
    name: { "zh-CN": "新执行测试Agent", en: "New Execution Test Agent" },
    version: "2.0.0",
  },
  capabilities: [
    {
      key: "general_assistance",
      name: { "zh-CN": "通用协助", en: "General Assistance" },
      description: { "zh-CN": "通用任务", en: "General task" },
    },
  ],
  invocation_context: [
    {
      key: "execution_subject",
      name: { "zh-CN": "执行主体" },
      necessity: "required",
    },
    {
      key: "timezone",
      name: { "zh-CN": "时区" },
      necessity: "preferred",
    },
  ],
  interaction: {
    streaming_transport: true,
    incremental_content: false,
    input_required: false,
    resume: false,
    cancel: false,
    durable_task_recovery: false,
    supported_locales: ["zh-CN", "en"],
  },
  result_contract: {
    fields: ["status"],
    error_codes: ["ERR"],
    notes: { "zh-CN": "无" },
  },
};

export interface ExecutionScenario {
  tenantId: string;
  parentInvocationId: string;
  callId: string;
  agentId: string;
  agentRevisionId: string;
  agentContractSnapshotId: string;
  agentContractDigest: string;
  agentCapabilityDigest: string;
  agentContextDigest: string;
  agentPublicationRecordId: string;
  /** 冻结进 binding 的 endpoint（= provider 监听地址）。 */
  endpoint: string;
  binding: AgentCallBindingConfigInput;
  bindingHash: string;
  /** 冻结进 binding 的 CredentialRef。 */
  credentialRefId: string;
  credentialEnvVar: string;
  credentialToken: string;
  provider: A2ATestProvider;
  threadId: string;
  turnId: string;
  logicalCallKey: string;
  resolution: Extract<RouteResolution, { target: { kind: "agent" } }>;
  /** 在给定租户播种一个"新的最新 published 修订 + 新 CredentialRef"，返回其证据 id/env/token。 */
  createNewLatestEvidence(): Promise<{
    newAgentRevisionId: string;
    newContractSnapshotId: string;
    /** 新快照 contextDigest —— 与冻结的 agentContextDigest 相比须可观察不同。 */
    newContextDigest: string;
    newCredentialRefId: string;
    /** 新 CredentialRef 的 TEST env 变量名（调用方 afterEach 需删除）。 */
    newCredentialEnvVar: string;
    /** 新 CredentialRef 的 TEST token（断言绝不进入任何 Authorization）。 */
    newCredentialToken: string;
  }>;
}

/**
 * 播种完整 startAgentCall 场景并创建冻结的 AgentCall。
 * 调用方负责 afterEach 删除 process.env[credentialEnvVar] 并关闭 provider。
 */
export async function seedAgentCallExecutionScenario(options?: {
  /**
   * 正式冻结完成后，仅为 startAgentCall fail-closed 测试篡改已持久化 binding。
   * 不得用于绕过 finalizeAgentCall Authority 校验。
   */
  mutateBinding?: (b: AgentCallBindingConfigInput) => AgentCallBindingConfigInput;
  /** 覆盖冻结 credential（如 revoked/expired/错误 fingerprint）。 */
  mutateCredential?: (params: {
    tenantId: string;
    id: string;
    envVar: string;
    token: string;
  }) => Promise<void> | void;
  providerScenario?: Parameters<typeof startA2ATestProvider>[0];
  /** 覆盖合同（默认 execution_subject=required；可传含 required 数据型 context 的反例合同）。 */
  contract?: unknown;
  logicalCallKey?: string;
  sourceRef?: string;
  now?: Date;
}): Promise<ExecutionScenario> {
  const now = options?.now ?? new Date("2026-08-29T00:00:00.000Z");
  const tenantId = await seedTenant();
  const parentInvocationId = await seedInvocation(tenantId);
  const threadId = randomUUID();
  const turnId = randomUUID();

  await db.insert(threadTable).values({
    id: threadId,
    tenantId,
    ownerUserId: randomUUID(),
    lifecycleState: "active",
    lastActivityAt: now,
    lastTurnSequence: 1,
    lastItemSequence: 0,
    lastEventSequence: 0,
    pendingQueueVersionNo: 1,
    versionNo: 1,
  });

  // 父 Invocation 置为 running（含 refs）——startAgentCall 期间父必须保持 running 不变。
  await db
    .update(invocationTable)
    .set({
      executionState: "running",
      threadId,
      turnId,
      runtimeExecutionRef: `rt:${parentInvocationId}`,
      startedAt: now,
    })
    .where(eq(invocationTable.id, parentInvocationId));

  // ─── 真实 Agent + published Revision + ContractSnapshot ───
  const agent = await createAgent({
    tenantId,
    agentKey: `exec-agent-${randomUUID()}`,
    displayName: "Execution Test Agent",
    ownerUserId: randomUUID(),
  });
  await updateAgentLifecycle(tenantId, agent.id, "enabled", agent.versionNo);
  const enabledAgent = await getAgentById(tenantId, agent.id);
  if (!enabledAgent) throw new Error("Agent 启用后无法回读");

  const snapshot = await seedAgentContractSnapshot({
    tenantId,
    agentId: agent.id,
    createdBy: "exec-fixture",
    contract: options?.contract ?? EXECUTION_FIXTURE_CONTRACT,
    protocol: { type: "a2a", contractRevision: "0.3.0" },
  });
  const revision = await createDraftRevision({
    tenantId,
    agentId: agent.id,
    agentContractSnapshotId: snapshot.id,
    modelPolicyJson: { default: "exec-model" },
    permissionRequirementsJson: {},
    delegationPolicyJson: {},
    agentInterfaceRequirementsJson: { required: ["event_stream"] },
    createdBy: "exec-fixture",
  });
  const publication = await publishTrustedAgentRevisionForTest({
    tenantId,
    revisionId: revision.id,
    agentExpectedVersionNo: enabledAgent.versionNo,
    actorId: "exec-fixture",
  });

  // ─── 真实 CredentialRef（provider=env，唯一 TEST token）───
  const credentialRefId = randomUUID();
  const credentialEnvVar = `SNOWHARNESS_TEST_AGENT_CRED_${randomUUID().replace(/-/g, "")}`;
  const credentialToken = `test-external-token-${randomUUID()}`;
  await db.insert(credentialRefTable).values({
    id: credentialRefId,
    tenantId,
    provider: "env",
    vaultRef: credentialEnvVar,
    fingerprint: fingerprintOf(credentialToken),
    lifecycleState: "active",
    expiresAt: null,
  });
  await options?.mutateCredential?.({
    tenantId,
    id: credentialRefId,
    envVar: credentialEnvVar,
    token: credentialToken,
  });
  process.env[credentialEnvVar] = credentialToken;

  // ─── 真实 A2A Provider ───
  const provider = await startA2ATestProvider(options?.providerScenario ?? "completed");

  await db.insert(turnTable).values({
    id: turnId,
    threadId,
    turnSequence: 1,
    triggerType: "user_message",
    turnState: "running",
    activeInvocationId: parentInvocationId,
    latestInvocationId: parentInvocationId,
    preferredAgentId: agent.id,
    agentUseMode: "preferred",
    acceptedAt: now,
    startedAt: now,
    versionNo: 1,
  });

  // ─── 正式 Agent Route → Activation → Projection → Resolver ───
  const routeSet = await createRouteSet({
    tenantId,
    target: { kind: "agent", agentId: agent.id },
    routeScopeKey: "default",
    routeScopeJson: { networkZone: "private" },
  });
  await activateSingleRouteForTest({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    target: {
      kind: "agent",
      agentRevisionId: revision.id,
      agentEndpointRef: provider.endpoint,
      agentIdentityMode: "bearer",
      agentCredentialRefId: credentialRefId,
      agentNetworkZone: "private",
    },
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    actor: buildActor(tenantId, "agent-call-exec-fixture"),
  });
  const resolveRoute = createResolveRoute({ store: mysqlRouteEligibilityResolutionStore });
  const resolved = await resolveRequiredAgentBinding({
    tenantId,
    agentId: agent.id,
    resolveRoute,
    routeScopeKey: "default",
    businessKey: { threadId },
  });
  if (resolved.resolution.target.kind !== "agent") {
    throw new Error("执行夹具要求判别 agent target");
  }
  const resolution = resolved.resolution as Extract<RouteResolution, { target: { kind: "agent" } }>;
  const finalizedBinding = resolved.bindingCandidate;
  const finalizedBindingHash = computeAgentCallBindingHash(finalizedBinding);
  const logicalCallKey = options?.logicalCallKey ?? `required-agent:${randomUUID()}:${agent.id}`;

  const createAgentCall = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => now });
  const { call } = await createAgentCall({
    tenantId,
    parentInvocationId,
    agentId: agent.id,
    agentRevisionId: revision.id,
    sourceType: "user_selected",
    sourceRef: options?.sourceRef ?? turnId,
    logicalCallKey,
    bindingCandidate: finalizedBinding,
    now,
  });

  const binding = options?.mutateBinding?.(finalizedBinding) ?? finalizedBinding;
  const bindingHash = computeAgentCallBindingHash(binding);
  if (binding !== finalizedBinding) {
    // 测试专用：模拟冻结后存储损坏，验证 startAgentCall 在网络前 fail closed。
    await db
      .update(agentCallBindingTable)
      .set({
        agentId: binding.agentId,
        agentRevisionId: binding.agentRevisionId,
        agentContractSnapshotId: binding.agentContractSnapshotId,
        agentContractDigest: binding.agentContractDigest,
        agentCapabilityDigest: binding.agentCapabilityDigest,
        agentContextDigest: binding.agentContextDigest,
        agentPublicationRecordId: binding.agentPublicationRecordId,
        deploymentRouteId: binding.deploymentRouteId,
        routeRevisionId: binding.routeRevisionId,
        routeActivationId: binding.routeActivationId,
        routeContentDigest: binding.routeContentDigest,
        resolutionInputDigest: binding.resolutionInputDigest,
        projectionVersionNo: binding.projectionVersionNo,
        endpointRef: binding.endpointRef,
        identityMode: binding.identityMode,
        credentialRefId: binding.credentialRefId,
        networkZone: binding.networkZone,
        protocolType: binding.protocolType,
        protocolContractRevision: binding.protocolContractRevision,
        policyRevisionId: binding.policyRevisionId,
        policyRulesDigest: binding.policyRulesDigest,
        governanceConfigRevisionId: binding.governanceConfigRevisionId,
        governanceConfigDigest: binding.governanceConfigDigest,
        bindingHash,
      })
      .where(
        and(
          eq(agentCallBindingTable.callId, call.id),
          eq(agentCallBindingTable.tenantId, tenantId),
        ),
      );
  } else if (bindingHash !== finalizedBindingHash) {
    throw new Error("正式 AgentCallBinding hash 在夹具内发生漂移");
  }

  return {
    tenantId,
    parentInvocationId,
    callId: call.id,
    agentId: agent.id,
    agentRevisionId: revision.id,
    agentContractSnapshotId: snapshot.id,
    agentContractDigest: snapshot.contractDigest,
    agentCapabilityDigest: snapshot.capabilityDigest,
    agentContextDigest: snapshot.contextDigest,
    agentPublicationRecordId: publication.publicationRecordId,
    endpoint: provider.endpoint,
    binding,
    bindingHash,
    credentialRefId,
    credentialEnvVar,
    credentialToken,
    provider,
    threadId,
    turnId,
    logicalCallKey,
    resolution,
    async createNewLatestEvidence() {
      // 新修订：真实 published + 内容可观察不同的 ContractSnapshot（NEW_LATEST_CONTRACT）。
      const newSnapshot = await seedAgentContractSnapshot({
        tenantId,
        agentId: agent.id,
        createdBy: "exec-fixture",
        contract: NEW_LATEST_CONTRACT,
        protocol: { type: "a2a", contractRevision: "0.3.0" },
      });
      const newRevision = await createDraftRevision({
        tenantId,
        agentId: agent.id,
        agentContractSnapshotId: newSnapshot.id,
        modelPolicyJson: { default: "exec-model-new" },
        permissionRequirementsJson: {},
        delegationPolicyJson: {},
        agentInterfaceRequirementsJson: { required: ["event_stream"] },
        createdBy: "exec-fixture",
      });
      const current = await getAgentById(tenantId, agent.id);
      if (!current) throw new Error("Agent 回读失败");
      await publishTrustedAgentRevisionForTest({
        tenantId,
        revisionId: newRevision.id,
        agentExpectedVersionNo: current.versionNo,
        actorId: "exec-fixture",
      });
      // 新 CredentialRef（不同 token + env）。
      const newCredentialRefId = randomUUID();
      const newCredentialEnvVar = `SNOWHARNESS_TEST_AGENT_CRED_${randomUUID().replace(/-/g, "")}`;
      const newCredentialToken = `new-external-token-${randomUUID()}`;
      await db.insert(credentialRefTable).values({
        id: newCredentialRefId,
        tenantId,
        provider: "env",
        vaultRef: newCredentialEnvVar,
        fingerprint: fingerprintOf(newCredentialToken),
        lifecycleState: "active",
        expiresAt: null,
      });
      process.env[newCredentialEnvVar] = newCredentialToken;
      return {
        newAgentRevisionId: newRevision.id,
        newContractSnapshotId: newSnapshot.id,
        newContextDigest: newSnapshot.contextDigest,
        newCredentialRefId,
        newCredentialEnvVar,
        newCredentialToken,
      };
    },
  };
}

/** 读取冻结 binding 行（断言不可变）。 */
export async function loadFrozenBinding(callId: string, tenantId: string) {
  const [row] = await db
    .select()
    .from(agentCallBindingTable)
    .where(
      and(eq(agentCallBindingTable.callId, callId), eq(agentCallBindingTable.tenantId, tenantId)),
    )
    .limit(1);
  return row;
}

/** 读取 AgentCallAttempt 行（断言 outbound 次数 / 终态）。 */
export async function loadAttempt(callId: string, tenantId: string, attemptNo = 1) {
  const [row] = await db
    .select()
    .from(agentCallAttemptTable)
    .where(
      and(
        eq(agentCallAttemptTable.callId, callId),
        eq(agentCallAttemptTable.tenantId, tenantId),
        eq(agentCallAttemptTable.attemptNo, attemptNo),
      ),
    )
    .limit(1);
  return row;
}

/** 等待 AgentCall 进入终态（detached stream 由 ingress 写库，调用方轮询）。 */
export async function waitForCallTerminal(
  callId: string,
  tenantId: string,
  timeoutMs = 15_000,
): Promise<{ state: string; externalTaskRef: string | null; externalContextRef: string | null }> {
  const start = Date.now();
  for (;;) {
    const [row] = await db
      .select()
      .from(agentCallTable)
      .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
      .limit(1);
    if (row) {
      const state = String(row.state);
      if (["completed", "failed", "cancelled", "lost"].includes(state)) {
        return {
          state,
          externalTaskRef: row.externalTaskRef,
          externalContextRef: row.externalContextRef,
        };
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`AgentCall ${callId} 未在 ${timeoutMs}ms 内进入终态`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
