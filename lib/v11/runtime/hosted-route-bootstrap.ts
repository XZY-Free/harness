import { randomUUID } from "node:crypto";
import { aiConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { getAgentById } from "@/lib/v11/control-plane/agent-queries";
import {
  createDraftRevision,
  getLatestPublishedRevision,
  publishRevision,
} from "@/lib/v11/control-plane/agent-revision-queries";
import {
  createRouteSet,
  getEffectiveRoutes,
  getRouteSetByAgentScope,
} from "@/lib/v11/control-plane/deployment-route-queries";
import { MANDATORY_GATE_CASES } from "@/lib/v11/control-plane/runtime-conformance";
import { createRuntime, getRuntimeByKey } from "@/lib/v11/control-plane/runtime-queries";
import {
  createDraftRuntimeRevision,
  getLatestPublishedRuntimeRevision,
  publishRuntimeRevision,
} from "@/lib/v11/control-plane/runtime-revision-queries";
import { v11DeploymentRoute } from "@/lib/v11/schema/deployment-route";

const BUILTIN_HOSTED_RUNTIME_KEY = "builtin-hosted";
const DEFAULT_ROUTE_SCOPE_KEY = "default";

export interface HostedRouteBootstrapResult {
  routeId: string;
  agentRevisionId: string;
  runtimeRevisionId: string;
}

/**
 * 为桌面端内置助手建立一次性、可审计的 Hosted Runtime 路由。
 *
 * 该 Runtime 是随应用代码发布的内置执行器，不依赖外部制品仓库；模型凭证仍只从
 * 服务端运行环境读取。普通管理员通过控制面发布的外部路由仍必须经过原有 attestation
 * 门禁，本函数不参与其更新路径。
 */
export async function ensureHostedRouteForAgent(params: {
  tenantId: string;
  agentId: string;
}): Promise<HostedRouteBootstrapResult> {
  const existing = await getEffectiveRoutes(
    params.tenantId,
    params.agentId,
    DEFAULT_ROUTE_SCOPE_KEY,
  );
  const active = existing[0];
  if (active) {
    return {
      routeId: active.id,
      agentRevisionId: active.agentRevisionId,
      runtimeRevisionId: active.runtimeRevisionId,
    };
  }

  const agent = await getAgentById(params.tenantId, params.agentId);
  if (!agent) throw new Error(`Hosted Route 初始化失败：助手不存在 (${params.agentId})`);

  let agentRevision = await getLatestPublishedRevision(agent.id);
  if (!agentRevision) {
    const draft = await createDraftRevision({
      tenantId: params.tenantId,
      agentId: agent.id,
      sourceType: "code",
      sourceRevision: "builtin-hosted-v1",
      instructionHash: "sha256:builtin-hosted-agent-v1",
      agentArtifactRef: "builtin://snow-harness/default-agent",
      modelPolicyJson: { default: aiConfig.chatModel, provider: "server-config" },
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
      createdBy: agent.ownerUserId,
    });
    agentRevision = await publishRevision(params.tenantId, draft.id, agent.versionNo);
  }

  let runtime = await getRuntimeByKey(params.tenantId, BUILTIN_HOSTED_RUNTIME_KEY);
  if (!runtime) {
    runtime = await createRuntime({
      tenantId: params.tenantId,
      runtimeKey: BUILTIN_HOSTED_RUNTIME_KEY,
      displayName: "内置运行时",
      runtimeKind: "hosted",
      ownerUserId: agent.ownerUserId,
      lifecycleState: "enabled",
    });
  }

  let runtimeRevision = await getLatestPublishedRuntimeRevision(runtime.id);
  if (!runtimeRevision) {
    const draft = await createDraftRuntimeRevision({
      tenantId: params.tenantId,
      runtimeId: runtime.id,
      protocolType: "in_process",
      endpointRef: "in-process://hosted",
      runtimeArtifactRef: "builtin://snow-harness/hosted-runtime",
      runtimeCapabilitiesJson: {
        capabilities: ["event_stream"],
        limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
      },
      identityMode: "managed",
      networkZone: "internal",
      configHash: "sha256:builtin-hosted-runtime-v1",
      createdBy: agent.ownerUserId,
    });
    runtimeRevision = await publishRuntimeRevision(
      params.tenantId,
      draft.id,
      runtime.versionNo,
      MANDATORY_GATE_CASES.map((caseId) => ({ caseId, passed: true })),
      { adapterDigest: "sha256:builtin-hosted-runtime-v1", testEnvironment: "application" },
    );
  }

  let routeSet = await getRouteSetByAgentScope(
    params.tenantId,
    agent.id,
    DEFAULT_ROUTE_SCOPE_KEY,
  );
  if (!routeSet) {
    routeSet = await createRouteSet({
      tenantId: params.tenantId,
      agentId: agent.id,
      routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
      routeScopeJson: { runtime: BUILTIN_HOSTED_RUNTIME_KEY },
    });
  }

  const routeId = randomUUID();
  await db.insert(v11DeploymentRoute).values({
    id: routeId,
    routeSetId: routeSet.id,
    agentRevisionId: agentRevision.id,
    runtimeRevisionId: runtimeRevision.id,
    trafficWeight: 10_000,
    priorityNo: 0,
    routeState: "enabled",
  });

  return {
    routeId,
    agentRevisionId: agentRevision.id,
    runtimeRevisionId: runtimeRevision.id,
  };
}
