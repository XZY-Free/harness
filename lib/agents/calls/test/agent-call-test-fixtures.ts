/**
 * AgentCall 测试共用夹具。
 *
 * 提供：
 * - 真实 Tenant / Invocation 播种（parent Invocation FK 满足）。
 * - 合法 AgentCallBindingConfigInput 与合法 RouteResolution（Batch4 targetKind=agent）。
 * - 计算 payloadHash（递归排序 key 后 sha256，与 schema 注释一致）。
 */
import { createHash, randomUUID } from "node:crypto";
import type { AgentCallBindingConfigInput } from "@/lib/agents/calls/domain/agent-call-binding";
import { db } from "@/lib/db/client";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { tenant } from "@/lib/persistence/schema/identity";
import type { RouteResolution } from "@/lib/routes/domain/route-resolution-policy";

export const D = (hex: string): string => `sha256:${hex.repeat(64)}`;

/** 播种真实 Tenant。 */
export async function seedTenant(overrides?: { id?: string; key?: string }): Promise<string> {
  const tenantId = overrides?.id ?? randomUUID();
  await db.insert(tenant).values({
    id: tenantId,
    key: overrides?.key ?? `tenant-${randomUUID()}`,
    name: "AgentCall Test Tenant",
    status: "active",
  });
  return tenantId;
}

/** 播种真实 parent Invocation（满足 AgentCall FK）。 */
export async function seedInvocation(
  tenantId: string,
  overrides?: { id?: string },
): Promise<string> {
  const id = overrides?.id ?? randomUUID();
  await db.insert(invocationTable).values({
    id,
    tenantId,
    invocationSequence: 1,
    invocationKind: "initial",
    executionState: "queued",
    versionNo: 1,
  });
  return id;
}

/** 合法 AgentCallBindingConfigInput（policy/governance digest 合法 64 hex）。 */
export function validBindingConfig(
  overrides?: Partial<AgentCallBindingConfigInput>,
): AgentCallBindingConfigInput {
  return {
    agentId: "agent-1",
    agentRevisionId: "agent-rev-1",
    agentContractSnapshotId: "contract-1",
    agentContractDigest: D("a"),
    agentCapabilityDigest: D("b"),
    agentContextDigest: D("c"),
    agentPublicationRecordId: "pub-1",
    deploymentRouteId: "route-1",
    routeRevisionId: "route-rev-1",
    routeActivationId: "route-act-1",
    routeContentDigest: D("1"),
    resolutionInputDigest: D("2"),
    projectionVersionNo: 3,
    endpointRef: "https://agent.example.com/a2a",
    identityMode: "bearer",
    credentialRefId: "cred-1",
    networkZone: "private",
    protocolType: "a2a",
    protocolContractRevision: "a2a-0.3.0",
    policyRevisionId: "policy-rev-1",
    policyRulesDigest: D("e"),
    governanceConfigRevisionId: "gov-rev-1",
    governanceConfigDigest: D("f"),
    ...overrides,
  };
}

/** 合法 Batch4 targetKind=agent RouteResolution。 */
export function validAgentRouteResolution(overrides?: Partial<RouteResolution>): RouteResolution {
  return {
    deploymentRouteId: "route-1",
    routeSetId: "route-set-1",
    routeSetVersionNo: 1,
    routeRevisionId: "route-rev-1",
    routeRevisionNo: 1,
    routeActivationId: "route-act-1",
    routeActivationSequence: 1,
    targetKind: "agent",
    agentRevisionId: "agent-rev-1",
    runtimeRevisionId: "runtime-rev-1",
    policyRevisionId: "policy-rev-1",
    routeContentDigest: D("1"),
    routeGroupId: "primary",
    specificity: 1,
    priorityNo: 0,
    trafficWeight: 100,
    trafficBucket: 0,
    resolutionKeyDigest: D("k"),
    resolutionInputDigest: D("2"),
    resolvedAt: new Date("2026-08-28T00:00:00.000Z"),
    controlPlaneEvidence: {
      agentRevisionId: "agent-rev-1",
      runtimeArtifactId: null,
      runtimeArtifactDigest: null,
      runtimeConfigDigest: D("rc"),
      runtimeEvidenceKind: "external_endpoint",
      runtimeTargetDigest: D("rt"),
      capabilityManifestDigest: D("cm"),
      agentContractSnapshotId: "contract-1",
      agentContractDigest: D("a"),
      agentContextDigest: D("c"),
      runtimeAttestationIds: [],
      agentPublicationRecordId: "pub-1",
      runtimePublicationRecordId: "pub-runtime-1",
      conformanceRunId: "conf-1",
    },
    projectionVersionNo: 3,
    ...overrides,
  };
}

/** 计算候选负载 hash（递归排序 key 后 sha256，与 AgentCallEventIngress.payloadHash 语义一致）。 */
export function computePayloadHash(payload: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortKeys(payload)))
    .digest("hex")}`;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return result;
}
