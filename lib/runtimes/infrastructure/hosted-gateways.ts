/**
 * §6.5: Hosted Provisioning Gateway 接口 — 纯适配器层。
 *
 * §7.1: 移除旧 HostedRuntimeControlPlane 兼容 facade。
 * 6 个职责清晰的 Gateway 是唯一的供应接口。
 * Saga 负责步骤编排，每个 Gateway 只做 DB 访问 + 对应领域调用。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §6.5
 */

import type {
  HostedRuntimeRoute,
  PublishedHostedAgentRevision,
  PublishedHostedRuntimeRevision,
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

/** Agent 发布 Gateway — 确保 Agent Revision 已发布。 */
export interface HostedAgentPublicationGateway {
  /** 确保 Agent Revision 已通过门禁并发布。 */
  ensurePublishedAgentRevision(command: {
    tenantId: string;
    agentId: string;
  }): Promise<PublishedHostedAgentRevision>;
}

// ─── 3. Runtime 发布 ─────────────────────────────────────

/** Runtime 发布 Gateway — 确保 Runtime Revision 已发布（含 Conformance）。 */
export interface HostedRuntimePublicationGateway {
  /** 确保 Runtime Revision 已通过门禁、Conformance、并发布。 */
  ensurePublishedRuntimeRevision(command: {
    tenantId: string;
    agentId: string;
  }): Promise<PublishedHostedRuntimeRevision>;
}

// ─── 4. Route 激活 ───────────────────────────────────────

/** Route 激活 Gateway — 激活 Route 到 RouteSet。 */
export interface HostedRouteActivationGateway {
  /** 激活 Route，将 Agent/Runtime Revision 绑定到 Route。 */
  activateRoute(command: {
    tenantId: string;
    agentId: string;
    routeScopeKey: string;
    agentRevision: PublishedHostedAgentRevision;
    runtimeRevision: PublishedHostedRuntimeRevision;
  }): Promise<void>;
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
 * §6.5: HostedGateways — 6 个 Gateway 的聚合。
 * Saga 通过此聚合调用各个 Gateway，不再有 HostedRuntimeControlPlane 中间层。
 */
export interface HostedGateways {
  routeReader: HostedRouteReader;
  agentPublication: HostedAgentPublicationGateway;
  runtimePublication: HostedRuntimePublicationGateway;
  routeActivation: HostedRouteActivationGateway;
  artifactEvidence: HostedArtifactEvidenceProvider;
  conformanceRunner: HostedConformanceRunner;
}
