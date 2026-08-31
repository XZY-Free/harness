import { computeAgentCallBindingHash } from "@/lib/agents/calls/domain/agent-call-binding";
import type { StoreAgentCallInput } from "@/lib/agents/calls/persistence/agent-call-store";
import type { DbOrTx } from "@/lib/db/client";
import { GOVERNANCE_CONFIG_SET_KEY } from "@/lib/governance/config";
import {
  computeGovernanceConfigDigest,
  computePolicyRulesHash,
} from "@/lib/identity/tenant-bootstrap";
import { toRulesDigestInput } from "@/lib/permission/policy-queries";
import {
  agentContractSnapshotTable,
  agentRevisionTable,
  agentTable,
} from "@/lib/persistence/schema/agents";
import { turnTable } from "@/lib/persistence/schema/conversation";
import {
  deploymentRouteSetTable,
  deploymentRouteTable,
} from "@/lib/persistence/schema/deployment-route";
import { invocationTable } from "@/lib/persistence/schema/executions";
import {
  governanceConfigRevisionTable,
  governanceConfigSetTable,
} from "@/lib/persistence/schema/governance-config";
import {
  policyRevisionTable,
  policySetTable,
  policyTable,
} from "@/lib/persistence/schema/permission";
import { computePublicationEvidenceSetDigest } from "@/lib/publications/domain/publication-record";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import { computeResolutionInputDigest } from "@/lib/routes/domain/resolution-input-digest";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { and, desc, eq } from "drizzle-orm";

export class AgentCallBindingStaleError extends Error {
  readonly code = "AGENT_CALL_BINDING_STALE";

  constructor(detail: string) {
    super(`AgentCallBinding candidate 已失效：${detail}`);
    this.name = "AgentCallBindingStaleError";
  }
}

function stale(detail: string): never {
  throw new AgentCallBindingStaleError(detail);
}

/**
 * 在 AgentCall 最终写事务内按固定顺序锁定并重新证明全部 Authority。
 * 本 helper 绝不自行开启 transaction，也绝不重新选择 target。
 */
export async function lockAndValidateAgentCallAuthority(
  tx: DbOrTx,
  input: StoreAgentCallInput,
): Promise<void> {
  const b = input.bindingCandidate;
  if (
    b.agentId !== input.agentId ||
    b.agentRevisionId !== input.agentRevisionId ||
    computeAgentCallBindingHash(b) !== input.bindingHash
  ) {
    stale("candidate Agent 身份或 bindingHash 与创建命令不一致");
  }

  // 1. Parent Invocation
  const [invocation] = await tx
    .select()
    .from(invocationTable)
    .where(
      and(
        eq(invocationTable.id, input.parentInvocationId),
        eq(invocationTable.tenantId, input.tenantId),
      ),
    )
    .limit(1)
    .for("update");
  if (!invocation) stale("Parent Invocation 不存在或跨租户");
  if (invocation.executionState !== "running") {
    stale(`Parent Invocation 必须为 running: ${invocation.executionState}`);
  }

  // 2-4. Agent → exact Revision → exact ContractSnapshot
  const [agent] = await tx
    .select()
    .from(agentTable)
    .where(and(eq(agentTable.id, input.agentId), eq(agentTable.tenantId, input.tenantId)))
    .limit(1)
    .for("update");
  if (!agent || agent.lifecycleState !== "enabled" || agent.deletedAt) stale("Agent 非 enabled");

  const [revision] = await tx
    .select()
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.id, input.agentRevisionId))
    .limit(1)
    .for("update");
  if (
    !revision ||
    revision.agentId !== input.agentId ||
    revision.revisionState !== "published" ||
    revision.agentContractSnapshotId !== b.agentContractSnapshotId
  ) {
    stale("AgentRevision/ContractSnapshot commitment 已漂移");
  }

  const [snapshot] = await tx
    .select()
    .from(agentContractSnapshotTable)
    .where(
      and(
        eq(agentContractSnapshotTable.id, b.agentContractSnapshotId),
        eq(agentContractSnapshotTable.tenantId, input.tenantId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !snapshot ||
    snapshot.agentId !== input.agentId ||
    snapshot.contractDigest !== b.agentContractDigest ||
    snapshot.capabilityDigest !== b.agentCapabilityDigest ||
    snapshot.contextDigest !== b.agentContextDigest ||
    snapshot.protocolType !== b.protocolType ||
    snapshot.protocolContractRevision !== b.protocolContractRevision
  ) {
    stale("AgentContractSnapshot 事实已漂移");
  }

  // 5-6. Agent Publication/Withdrawal；黑盒 Agent 的 Attestation 精确全集固定为空。
  const [publication] = await tx
    .select()
    .from(publicationRecord)
    .where(
      and(
        eq(publicationRecord.id, b.agentPublicationRecordId),
        eq(publicationRecord.tenantId, input.tenantId),
      ),
    )
    .limit(1)
    .for("update");
  const [withdrawal] = publication
    ? await tx
        .select({ id: withdrawalRecord.id })
        .from(withdrawalRecord)
        .where(eq(withdrawalRecord.publicationRecordId, publication.id))
        .limit(1)
        .for("update")
    : [];
  const expectedPublicationDigest = computePublicationEvidenceSetDigest({
    attestationIds: [],
    conformanceRunId: null,
    approvals: [],
    additionalEvidence: {
      agent_contract_snapshot: {
        id: snapshot.id,
        contract_digest: snapshot.contractDigest,
        capability_digest: snapshot.capabilityDigest,
        context_digest: snapshot.contextDigest,
      },
    },
  });
  if (
    !publication ||
    withdrawal ||
    publication.subjectType !== "agent_revision" ||
    publication.subjectRevisionId !== input.agentRevisionId ||
    publication.agentContractSnapshotId !== b.agentContractSnapshotId ||
    publication.agentContractDigest !== b.agentContractDigest ||
    publication.agentCapabilityDigest !== b.agentCapabilityDigest ||
    publication.agentContextDigest !== b.agentContextDigest ||
    publication.conformanceRunId !== null ||
    publication.attestationIds.length !== 0 ||
    publication.approvals.length !== 0 ||
    publication.evidenceSetDigest !== expectedPublicationDigest
  ) {
    stale("Agent Publication 已撤回或证据不精确");
  }

  // 7-10. RouteSet → Route → RouteRevision → latest Activation → Projection
  const [routeKey] = await tx
    .select({ routeSetId: deploymentRouteTable.routeSetId })
    .from(deploymentRouteTable)
    .where(eq(deploymentRouteTable.id, b.deploymentRouteId))
    .limit(1);
  if (!routeKey) stale("DeploymentRoute 不存在");
  const [routeSet] = await tx
    .select()
    .from(deploymentRouteSetTable)
    .where(eq(deploymentRouteSetTable.id, routeKey.routeSetId))
    .limit(1)
    .for("update");
  if (
    !routeSet ||
    routeSet.tenantId !== input.tenantId ||
    routeSet.targetKind !== "agent" ||
    routeSet.targetIdentity !== input.agentId ||
    routeSet.agentId !== input.agentId
  ) {
    stale("Agent RouteSet target 已漂移");
  }

  const [route] = await tx
    .select()
    .from(deploymentRouteTable)
    .where(eq(deploymentRouteTable.id, b.deploymentRouteId))
    .limit(1)
    .for("update");
  if (
    !route ||
    route.routeSetId !== routeSet.id ||
    route.agentRevisionId !== input.agentRevisionId ||
    route.runtimeRevisionId !== null ||
    route.routeState !== "enabled" ||
    route.activeRouteRevisionId !== b.routeRevisionId ||
    route.trafficWeight <= 0 ||
    (route.effectiveFrom && route.effectiveFrom > input.createdAt) ||
    (route.effectiveUntil && route.effectiveUntil <= input.createdAt)
  ) {
    stale("DeploymentRoute 已漂移或不在有效窗口");
  }

  const [routeRev] = await tx
    .select()
    .from(routeRevision)
    .where(eq(routeRevision.id, b.routeRevisionId))
    .limit(1)
    .for("update");
  if (
    !routeRev ||
    routeRev.tenantId !== input.tenantId ||
    routeRev.routeId !== route.id ||
    routeRev.routeSetId !== routeSet.id ||
    routeRev.agentRevisionId !== input.agentRevisionId ||
    routeRev.runtimeRevisionId !== null ||
    routeRev.agentEndpointRef !== b.endpointRef ||
    routeRev.agentIdentityMode !== b.identityMode ||
    routeRev.agentCredentialRefId !== b.credentialRefId ||
    routeRev.agentNetworkZone !== b.networkZone ||
    routeRev.contentDigest !== b.routeContentDigest
  ) {
    stale("RouteRevision 目标事实已漂移");
  }

  const [activation] = await tx
    .select()
    .from(routeActivation)
    .where(eq(routeActivation.routeId, route.id))
    .orderBy(desc(routeActivation.activationSequence))
    .limit(1)
    .for("update");
  if (
    !activation ||
    activation.id !== b.routeActivationId ||
    activation.routeRevisionId !== b.routeRevisionId ||
    activation.routeSetId !== routeSet.id ||
    activation.activationState !== "active" ||
    activation.routeSetVersionNo !== routeSet.versionNo
  ) {
    stale("latest RouteActivation 已切版");
  }

  const [projection] = await tx
    .select()
    .from(routeEligibilityProjection)
    .where(
      and(
        eq(routeEligibilityProjection.routeId, route.id),
        eq(routeEligibilityProjection.tenantId, input.tenantId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !projection ||
    projection.targetKind !== "agent" ||
    projection.targetIdentity !== input.agentId ||
    projection.agentId !== input.agentId ||
    projection.runtimeRevisionId !== null ||
    projection.eligibilityState !== "eligible" ||
    projection.activationState !== "active" ||
    projection.projectionVersionNo !== b.projectionVersionNo ||
    projection.routeSetId !== routeSet.id ||
    projection.routeSetVersionNo !== routeSet.versionNo ||
    projection.routeRevisionId !== b.routeRevisionId ||
    projection.routeActivationId !== b.routeActivationId ||
    projection.routeContentDigest !== b.routeContentDigest ||
    projection.agentRevisionId !== input.agentRevisionId ||
    projection.agentEndpointRef !== b.endpointRef ||
    projection.agentIdentityMode !== b.identityMode ||
    projection.agentCredentialRefId !== b.credentialRefId ||
    projection.agentNetworkZone !== b.networkZone ||
    projection.agentRevisionState !== "published" ||
    projection.agentLifecycleState !== "enabled" ||
    projection.agentPublicationActive !== 1 ||
    projection.agentEvidenceValid !== 1 ||
    projection.agentPublicationRecordId !== b.agentPublicationRecordId ||
    projection.agentContractSnapshotId !== b.agentContractSnapshotId ||
    projection.agentContractDigest !== b.agentContractDigest ||
    projection.agentContextDigest !== b.agentContextDigest ||
    projection.policyRevisionId !== routeRev.policyRevisionId
  ) {
    stale("RouteEligibilityProjection 已漂移");
  }

  // 11-12. exact effective Policy 与 tenant Governance current revision。
  const [policySet] = await tx
    .select()
    .from(policySetTable)
    .where(
      and(
        eq(policySetTable.tenantId, input.tenantId),
        eq(policySetTable.policySetKey, "tool-execution"),
      ),
    )
    .limit(1)
    .for("update");
  const effectivePolicyRevisionId = routeRev.policyRevisionId ?? policySet?.currentRevisionId;
  if (
    !policySet ||
    policySet.lifecycleState !== "enabled" ||
    effectivePolicyRevisionId !== b.policyRevisionId
  ) {
    stale("有效 PolicyRevision 已漂移");
  }
  const [policyRevision] = await tx
    .select()
    .from(policyRevisionTable)
    .where(eq(policyRevisionTable.id, b.policyRevisionId))
    .limit(1)
    .for("update");
  if (
    !policyRevision ||
    policyRevision.policySetId !== policySet.id ||
    policyRevision.revisionState !== "published"
  ) {
    stale("PolicyRevision 不存在、跨租户或非 published");
  }
  const rules = (
    await tx
      .select()
      .from(policyTable)
      .where(eq(policyTable.policyRevisionId, policyRevision.id))
      .for("update")
  ).sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    return left.ruleKey < right.ruleKey ? -1 : left.ruleKey > right.ruleKey ? 1 : 0;
  });
  if (rules.some((rule) => rule.tenantId !== input.tenantId || rule.policySetId !== policySet.id)) {
    stale("Policy rule 存在跨租户或跨 Set 引用");
  }
  const rulesDigest = computePolicyRulesHash(
    policyRevision.defaultDecision,
    toRulesDigestInput(rules),
  );
  if (rulesDigest !== policyRevision.rulesHash || rulesDigest !== b.policyRulesDigest) {
    stale("Policy rules digest 已漂移");
  }

  const [governanceSet] = await tx
    .select()
    .from(governanceConfigSetTable)
    .where(
      and(
        eq(governanceConfigSetTable.tenantId, input.tenantId),
        eq(governanceConfigSetTable.configSetKey, GOVERNANCE_CONFIG_SET_KEY),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !governanceSet ||
    governanceSet.lifecycleState !== "enabled" ||
    governanceSet.currentRevisionId !== b.governanceConfigRevisionId
  ) {
    stale("GovernanceConfigSet current revision 已漂移");
  }
  const [governanceRevision] = await tx
    .select()
    .from(governanceConfigRevisionTable)
    .where(eq(governanceConfigRevisionTable.id, b.governanceConfigRevisionId))
    .limit(1)
    .for("update");
  if (
    !governanceRevision ||
    governanceRevision.configSetId !== governanceSet.id ||
    governanceRevision.revisionState !== "published" ||
    governanceRevision.configDigest !== b.governanceConfigDigest ||
    computeGovernanceConfigDigest(governanceRevision.configJson) !== b.governanceConfigDigest
  ) {
    stale("GovernanceConfigRevision 已漂移");
  }

  // 13. Harness action provenance：actionId + preferred AgentUseDirective + parent Invocation。
  let resolutionBusinessKey: { threadId?: string; jobId?: string };
  if (input.sourceType === "harness_planned") {
    const actionId = input.sourceRef;
    if (!actionId || !invocation.turnId || !invocation.threadId) {
      stale("Harness action provenance 缺少 action/Turn/Thread 引用");
    }
    if (input.logicalCallKey !== `${input.parentInvocationId}:${actionId}:${input.agentId}`) {
      stale("AgentCall logicalCallKey 与 parent/action/agent 不一致");
    }
    const [turn] = await tx
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, invocation.turnId))
      .limit(1)
      .for("update");
    if (
      !turn ||
      turn.threadId !== invocation.threadId ||
      turn.preferredAgentId !== input.agentId ||
      turn.agentUseMode !== "preferred" ||
      turn.latestInvocationId !== invocation.id
    ) {
      stale("Harness action 的 preferred Agent 授权来源已漂移");
    }
    resolutionBusinessKey = { threadId: turn.threadId };
  } else {
    stale(`AgentCall sourceType 尚无正式 provenance: ${input.sourceType}`);
  }

  const resolutionInputDigest = computeResolutionInputDigest({
    tenantId: input.tenantId,
    target: { kind: "agent", agentId: input.agentId },
    routeScopeKey: projection.routeScopeKey,
    businessKey: resolutionBusinessKey,
    attributes: {},
    threadDefaultModelRef: null,
  });
  if (resolutionInputDigest !== b.resolutionInputDigest) {
    stale("Route resolution input digest 与调用 provenance 不一致");
  }
}
