/**
 * §08.2/§08.3/§08.10: Hosted Provisioning Gateway 接口 — 纯适配器层。
 *
 * §08.2: Agent Gateway 接受 agentRevisionId 并验证一致性。
 * §08.3: 拆开过粗 Runtime Gateway 为 4 个正式步骤 Gateway。
 * §08.10: Route Activation Gateway 返回路由详情（非 void）。
 *
 * 参见：SnowHarness专题01最终差距整改与正式链路收口实施方案 §08
 */

import type {
  HostedRuntimeRoute,
  PublishedHostedAgentRevision,
} from "@/lib/runtimes/application/provision-hosted-runtime";

// ─── 1. Route 读取 ───────────────────────────────────────

/** Hosted Route 读取 Gateway。 */
export interface HostedRouteReader {
  /** 只返回已经通过正式 Resolver 全部门禁的路由。 */
  resolveEligibleRoute(command: {
    tenantId: string;
    agentId: string;
    routeScopeKey: string;
  }): Promise<HostedRuntimeRoute | null>;
}

// ─── 2. Agent 发布 ──────────────────────────────────────

/**
 * Agent 发布 Gateway — §08.2: 接受 agentRevisionId 并验证一致性。
 *
 * 返回结果中的 revisionId 必须等于请求的 agentRevisionId，
 * 否则抛出 HOSTED_AGENT_REVISION_MISMATCH 永久失败。
 */
export interface HostedAgentPublicationGateway {
  /** §08.2: 确保指定 AgentRevision 已发布，验证 revision 一致性。 */
  ensurePublishedAgentRevision(command: {
    tenantId: string;
    agentId: string;
    /** §08.2: 请求冻结的 AgentRevisionId，贯穿全流程。 */
    agentRevisionId: string;
  }): Promise<PublishedHostedAgentRevision>;
}

// ─── 3. Runtime 步骤 Gateway（§08.3: 拆开过粗 Gateway） ──

/** §08.3: 准备 Runtime Revision — 创建/查找 Draft RuntimeRevision。 */
export interface HostedRuntimePrepareGateway {
  prepareRuntimeRevision(command: {
    tenantId: string;
    agentId: string;
    /** §08.1: 从请求冻结的 agentRevisionId 传递。 */
    agentRevisionId: string;
  }): Promise<{
    runtimeId: string;
    runtimeRevisionId: string;
  }>;
}

/** §08.3: 验证 Runtime Artifact — Attestation。 */
export interface HostedRuntimeArtifactVerifyGateway {
  verifyRuntimeArtifact(command: {
    tenantId: string;
    runtimeRevisionId: string;
  }): Promise<{
    runtimeArtifactId: string;
    runtimeAttestationIds: string[];
  }>;
}

/** §08.3: 记录 Runtime Conformance。 */
export interface HostedRuntimeConformanceGateway {
  recordRuntimeConformance(command: {
    tenantId: string;
    runtimeRevisionId: string;
  }): Promise<{
    conformanceRunId: string;
    overallResult: "passed" | "failed";
  }>;
}

/** §08.3: 发布 Runtime Revision。 */
export interface HostedRuntimePublishGateway {
  publishRuntimeRevision(command: {
    tenantId: string;
    runtimeRevisionId: string;
  }): Promise<{
    runtimePublicationRecordId: string;
  }>;
}

// ─── 4. Route 激活 ───────────────────────────────────────

/**
 * §08.10: Route 激活 Gateway — 必须返回路由详情（非 void）。
 */
export interface HostedRouteActivationGateway {
  /** §08.10: 激活 Route 并返回路由绑定详情。 */
  activateRoute(command: {
    tenantId: string;
    agentId: string;
    routeScopeKey: string;
    agentRevision: PublishedHostedAgentRevision;
    runtimeRevision: {
      revisionId: string;
      publicationRecordId: string;
      attestationId: string;
      conformanceRunId: string;
    };
  }): Promise<{
    routeSetId: string;
    routeSetVersionNo: number;
    routeId: string;
    routeRevisionId: string;
    routeActivationId: string;
  }>;
}

// ─── 5. Artifact Evidence 读取 ────────────────────────────

/** Artifact Evidence 读取 Gateway。 */
export interface HostedArtifactEvidenceProvider {
  /** 读取 Agent Revision 的 Artifact Evidence。 */
  loadAgentArtifactEvidence(command: {
    tenantId: string;
    agentRevisionId: string;
  }): Promise<{ artifactRef: string | null; artifactDigest: string | null }>;

  /** 读取 Runtime Revision 的 Artifact Evidence。 */
  loadRuntimeArtifactEvidence(command: {
    tenantId: string;
    runtimeRevisionId: string;
  }): Promise<{
    artifactRef: string | null;
    artifactDigest: string | null;
    configHash: string | null;
  }>;
}

// ─── 6. Conformance 运行 ─────────────────────────────────

/** Conformance 运行 Gateway。 */
export interface HostedConformanceRunner {
  /** 运行 Runtime Conformance 并返回 Run ID。 */
  runConformance(command: {
    tenantId: string;
    runtimeRevisionId: string;
  }): Promise<{ conformanceRunId: string; overallResult: "passed" | "failed" }>;
}

// ─── Gateway 聚合 ─────────────────────────────────────────

/**
 * §08.3: HostedGateways — 9 个 Gateway 的聚合。
 * Saga 通过此聚合调用各个 Gateway。
 */
export interface HostedGateways {
  routeReader: HostedRouteReader;
  agentPublication: HostedAgentPublicationGateway;
  /** §08.3: 拆开的 4 个 Runtime 步骤 Gateway。 */
  runtimePrepare: HostedRuntimePrepareGateway;
  runtimeArtifactVerify: HostedRuntimeArtifactVerifyGateway;
  runtimeConformance: HostedRuntimeConformanceGateway;
  runtimePublish: HostedRuntimePublishGateway;
  routeActivation: HostedRouteActivationGateway;
  artifactEvidence: HostedArtifactEvidenceProvider;
  conformanceRunner: HostedConformanceRunner;
}
