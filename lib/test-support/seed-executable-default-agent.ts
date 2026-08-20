/**
 * 为 seed 出的默认 Agent 建出完整可执行证据链（e2e 正式链引导）。
 *
 * 背景：`lib/db/seed.ts` 按 §19.5 只惰性引导 draft 身份，不造 revision / route。
 * 但 `POST /api/v1/threads/{id}/turns` 在 `dispatchEmployeeTurn` 返回
 * `dispatched=false` 时直接抛错——因此 Web / Desktop 客户端要真正跑通
 *
 *   Route Resolver → ExecutionBinding → Runtime
 *
 * 必须先有一条 eligible Route。本模块即为 e2e 提供这条正式链。
 *
 * §11.2 合规性：
 * - 允许使用测试密钥与本地 Artifact Store。
 * - 全程运行正式组件：production DSSE verifier、production Artifact verifier、
 *   production Runtime Conformance verifier、production Publication service、
 *   production RouteSet activation、production Projection builder。
 * - 不使用 TrustedTestVerifier、不直插 Publication、不直插 Projection、不 mock ready。
 *
 * 幂等：默认 Agent 已具备 currentRevision 时直接返回，重复调用不产生第二套事实。
 */
import { getAgentByKey, updateAgentLifecycle } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
} from "@/lib/agents/persistence/agent-revision-queries";
import { aiConfig } from "@/lib/config";
import { DEFAULT_AGENT_KEY, seedDefaultAgent, seedDefaultIdentity } from "@/lib/db/seed";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import {
  buildActor,
  createVerifiedAttestation,
} from "@/lib/test-support/create-verified-attestation";
import { publishTrustedAgentRevisionForTest } from "@/lib/test-support/publish-trusted-agent-revision";
import { seedPublishedRuntimeRevision } from "@/lib/test-support/seed-published-runtime-revision";

/** Route scope key，与 `dispatchEmployeeTurn` 的解析入参一致。 */
const ROUTE_SCOPE_KEY = "default";

/** Agent 声明的接口要求，必须被 Runtime 能力集覆盖。 */
const REQUIRED_CAPABILITIES = ["event_stream"];

export interface ExecutableDefaultAgentContext {
  tenantId: string;
  ownerId: string;
  agentId: string;
  agentRevisionId: string;
  runtimeRevisionId: string;
  routeId: string;
  routeSetId: string;
  /** true 表示本次新建；false 表示已存在（幂等跳过）。 */
  created: boolean;
}

/**
 * 幂等建出可执行的默认 Agent 正式链。
 *
 * 链路：enabled Agent → published AgentRevision（artifact + DSSE attestation）
 *      → hosted Runtime → published RuntimeRevision（DSSE conformance）
 *      → RouteSet → RouteActivation → RouteEligibilityProjection
 */
export async function seedExecutableDefaultAgent(): Promise<ExecutableDefaultAgentContext> {
  const { tenantId, userIdentityId: ownerId } = await seedDefaultIdentity();
  await seedDefaultAgent();

  const agent = await getAgentByKey(tenantId, DEFAULT_AGENT_KEY);
  if (!agent) throw new Error(`e2e 引导失败：默认 Agent "${DEFAULT_AGENT_KEY}" 不存在`);

  // 幂等：已发布过 revision 则不再建第二套事实。
  if (agent.currentRevisionId) {
    const existing = await getRevisionById(agent.currentRevisionId);
    if (existing) {
      return {
        tenantId,
        ownerId,
        agentId: agent.id,
        agentRevisionId: existing.id,
        runtimeRevisionId: "",
        routeId: "",
        routeSetId: "",
        created: false,
      };
    }
  }

  const suffix = "e2e";

  // 1. Agent 置为 enabled（seed 只建 draft；建 Thread 要求 enabled）。
  let currentAgent = agent;
  if (currentAgent.lifecycleState !== "enabled") {
    const enabled = await updateAgentLifecycle(
      tenantId,
      currentAgent.id,
      "enabled",
      currentAgent.versionNo,
    );
    if (!enabled) throw new Error("e2e 引导失败：默认 Agent 启用时乐观锁冲突");
    currentAgent = enabled;
  }

  // 2. AgentRevision + 权威 Artifact Attestation + 正式发布。
  const revision = await createDraftRevision({
    tenantId,
    agentId: currentAgent.id,
    sourceType: "agent_yaml",
    sourceRevision: `git:${suffix}`,
    instructionHash: `sha256:instruction_${suffix}`,
    agentArtifactRef: `oci://registry/agent@sha256:${suffix}`,
    modelPolicyJson: { default: aiConfig.chatModel, provider: "openai-compatible" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: REQUIRED_CAPABILITIES, optional: [] },
    createdBy: ownerId,
  });

  const agentAttestation = await createVerifiedAttestation(
    tenantId,
    "agent_revision",
    revision.id,
    `agent-content-${suffix}`,
  );
  await publishTrustedAgentRevisionForTest({
    tenantId,
    revisionId: revision.id,
    agentExpectedVersionNo: currentAgent.versionNo,
    attestationId: agentAttestation.id,
    actorId: ownerId,
  });

  const publishedRevision = await getRevisionById(revision.id);
  if (!publishedRevision) throw new Error("e2e 引导失败：AgentRevision 发布后无法回读");

  // 3. hosted Runtime + published RuntimeRevision（含正式 DSSE Conformance）。
  const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
    tenantId,
    ownerId,
    `hosted-${suffix}`,
    REQUIRED_CAPABILITIES,
    suffix,
  );

  // 4. RouteSet → 正式激活 → 构建 RouteEligibilityProjection。
  const routeSet = await createRouteSet({
    tenantId,
    agentId: currentAgent.id,
    routeScopeKey: ROUTE_SCOPE_KEY,
    routeScopeJson: { networkZone: "internal" },
  });

  const routeResult = await activateSingleRouteForTest({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    agentRevisionId: publishedRevision.id,
    runtimeRevisionId: runtimeRevision.id,
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenantId, "e2e-bootstrap"),
  });

  return {
    tenantId,
    ownerId,
    agentId: currentAgent.id,
    agentRevisionId: publishedRevision.id,
    runtimeRevisionId: runtimeRevision.id,
    routeId: routeResult.route.id,
    routeSetId: routeSet.id,
    created: true,
  };
}
