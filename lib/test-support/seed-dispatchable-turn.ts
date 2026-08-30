/**
 * 正式 Turn 调度的可复用测试夹具（真实 MySQL 8）。
 *
 * 从一个 resetDatabase 后的空库，幂等建出可被 `dispatchEmployeeTurn` 真正调度的
 * 完整上下文：Tenant → UserIdentity → principalBinding → enabled Agent →
 * published AgentRevision（artifact+attestation）→ hosted Runtime →
 * published RuntimeRevision（conformance）→ RouteSet → RouteActivation →
 * RouteEligibilityProjection → Thread → accepted Turn。
 *
 * §27"测试必须证明生产链"：turn 调度测试必须走真实 Route Resolver →
 * ExecutionBinding → Runtime，而不是 mock 成功。本夹具即为此而建。
 *
 * owner 默认用 DEFAULT_USER_ID 身份，使 SNOW_AUTH_MODE=dev 下路由解析出的
 * principal 与 thread 属主一致（conversation 路由按属主鉴权）。
 */
import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
} from "@/lib/agents/persistence/agent-revision-queries";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import type { AgentRevision } from "@/lib/persistence/schema/agents";
import type { RuntimeRevision } from "@/lib/persistence/schema/runtimes";
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

export const DEFAULT_ROUTE_SCOPE_KEY = "default";

// ─── seed 租户 + 默认用户 ────────────────────────────────────

async function seedTenantAndOwner() {
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
  return { tenantId: tenant.id, ownerId: identity.id, principalBindingId: binding.id };
}

// ─── seed Agent + published AgentRevision ────────────────────

async function seedPublishedAgentRevision(
  tenantId: string,
  ownerId: string,
  agentKey: string,
  requiredCaps: string[],
  contentSuffix: string,
  modelPolicy?: Record<string, unknown>,
) {
  const agent = await createAgent({
    tenantId,
    agentKey,
    displayName: `Agent ${agentKey}`,
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const revision = await createDraftRevision({
    tenantId,
    agentId: agent.id,
    agentContractSnapshotId: `snap_${contentSuffix}`,
    modelPolicyJson: modelPolicy ?? { default: "doubao-pro", provider: "doubao" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: requiredCaps, optional: [] },
    createdBy: ownerId,
  });

  // Agent 是源码不可见黑盒：发布权威 = AgentContractSnapshot，无 Attestation。
  await publishTrustedAgentRevisionForTest({
    tenantId,
    revisionId: revision.id,
    agentExpectedVersionNo: 1,
    actorId: ownerId,
  });

  const publishedRevision = await getRevisionById(revision.id);
  if (!publishedRevision) throw new Error("测试 AgentRevision 发布后无法回读");
  return { agent, revision: publishedRevision };
}

// ─── seed 完整调度上下文 ─────────────────────────────────────

export interface DispatchableTurnContext {
  tenantId: string;
  ownerId: string;
  agentId: string;
  agentRevision: AgentRevision;
  runtimeRevision: RuntimeRevision;
  routeId: string;
  routeSetId: string;
  threadId: string;
  turnId: string;
  triggerItemId: string | null;
  agentInvokeBindingId: string | null;
}

/**
 * 从空库建出可真正调度的 turn。调用方 beforeEach 需先 resetDatabase。
 *
 * @param overrides 可选的 agentKey / runtimeKey / contentSuffix，便于并发测试隔离。
 */
export async function seedDispatchableTurn(
  overrides: {
    agentKey?: string;
    runtimeKey?: string;
    contentSuffix?: string;
    grantAgentInvoke?: boolean;
  } = {},
): Promise<DispatchableTurnContext> {
  const suffix = overrides.contentSuffix ?? randomUUID().slice(0, 8);
  const agentKey = overrides.agentKey ?? `finance-${suffix}`;
  const runtimeKey = overrides.runtimeKey ?? `hosted-${suffix}`;

  const { tenantId, ownerId, principalBindingId } = await seedTenantAndOwner();

  const { agent, revision: agentRevision } = await seedPublishedAgentRevision(
    tenantId,
    ownerId,
    agentKey,
    ["event_stream"],
    suffix,
  );
  const invokeBinding =
    overrides.grantAgentInvoke === false
      ? null
      : await grantActionBinding({
          tenantId,
          principalBindingId,
          actionCode: "agent.invoke",
          resourceScope: { type: "agent", ids: [agent.id] },
        });
  const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
    tenantId,
    ownerId,
    runtimeKey,
    ["event_stream"],
    suffix,
  );

  // Employee Turn 热路径解析基础 Harness Route（显式 runtime target，专题01 冻结架构），
  // 故 seed 一个 base RouteSet（target={kind:"runtime"}）+ RouteRevision（target runtime，不携带 Agent 字段）。
  // Agent 作为本轮可选择的黑盒能力创建；路由本身仍是 base runtime。
  const routeSet = await createRouteSet({
    tenantId,
    target: { kind: "runtime" },
    routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
    routeScopeJson: { networkZone: "internal" },
  });

  const routeResult = await activateSingleRouteForTest({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    target: { kind: "runtime", runtimeRevisionId: runtimeRevision.id },
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenantId, "deploy-bot-001"),
  });

  const { thread } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    actorId: ownerId,
  });

  const { turn } = await acceptUserMessageTurn({
    tenantId,
    threadId: thread.id,
    ownerUserId: ownerId,
    content: { text: "请帮我分析数据" },
    actorId: ownerId,
  });

  return {
    tenantId,
    ownerId,
    agentId: agent.id,
    agentRevision,
    runtimeRevision,
    routeId: routeResult.route.id,
    routeSetId: routeSet.id,
    threadId: thread.id,
    turnId: turn.id,
    triggerItemId: turn.triggerItemId ?? null,
    agentInvokeBindingId: invokeBinding?.id ?? null,
  };
}
