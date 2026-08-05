/**
 * §6.5: Hosted Provisioning Gateway 接口 — 纯适配器层。
 *
 * 6 个职责清晰的 Gateway 替代旧单体编排器。
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

// ─── 兼容 facade ─────────────────────────────────────────

/**
 * §6.5: 从 Gateway 组合出 HostedRuntimeControlPlane 兼容接口。
 * 过渡期使用，避免一次性修改所有调用方。
 */
export interface HostedGateways {
  routeReader: HostedRouteReader;
  agentPublication: HostedAgentPublicationGateway;
  runtimePublication: HostedRuntimePublicationGateway;
  routeActivation: HostedRouteActivationGateway;
  artifactEvidence: HostedArtifactEvidenceProvider;
  conformanceRunner: HostedConformanceRunner;
}

// ─── 兼容 Facade 工厂 ────────────────────────────────────

import type { HostedRuntimeControlPlane } from "@/lib/runtimes/application/provision-hosted-runtime";

/**
 * §6.5: 从 HostedGateways 构造 HostedRuntimeControlPlane 兼容对象。
 * 过渡期: 允许旧调用方继续使用 HostedRuntimeControlPlane 接口。
 */
export function createControlPlaneFromGateways(
  gateways: HostedGateways,
): HostedRuntimeControlPlane {
  return {
    resolveEligibleRoute: (command) => gateways.routeReader.resolveEligibleRoute(command),
    ensurePublishedAgentRevision: (command) =>
      gateways.agentPublication.ensurePublishedAgentRevision(command),
    ensurePublishedRuntimeRevision: (command) =>
      gateways.runtimePublication.ensurePublishedRuntimeRevision(command),
    activateRoute: (command) => gateways.routeActivation.activateRoute(command),
  };
}
