/**
 * Hosted Provisioning Gateway 接口 — 纯适配器层。
 *
 * Runtime-only Authority：
 * - 只供应 tenant 内 builtin Harness Runtime 及其 targetKind=runtime Route。
 * - 无 Agent 发布、Agent revision、Agent route，或 builtin-runtime binding 检查。
 * - runtimeRouteActivation / runtimeRouteReader 替代旧 Agent 导向 routeActivation / routeReader。
 * - prepareRuntimeRevision 命令只含 {tenantId, requesterId}。
 */

import type { HostedRuntimeRoute } from "@/lib/runtime/provisioning/provision-hosted-runtime";

// ─── 1. Runtime Route 读取 ────────────────────────────────

/** Hosted Runtime Route 读取 Gateway。 */
export interface HostedRuntimeRouteReader {
  /** 只返回已经通过正式 Resolver 的 targetKind=runtime 路由。无 Agent ID 命令或输出。 */
  resolveEligibleRuntimeRoute(command: {
    tenantId: string;
    routeScopeKey: string;
  }): Promise<HostedRuntimeRoute | null>;
}

// ─── 2. Runtime 步骤 Gateway ───────────────────────────────

/** 准备 Runtime Revision — 创建/查找 tenant 内 builtin Harness Runtime 的 Draft RuntimeRevision。 */
export interface HostedRuntimePrepareGateway {
  /** 命令只含 {tenantId, requesterId}；requesterId 仅供首次创建 Runtime 记录 owner。 */
  prepareRuntimeRevision(command: {
    tenantId: string;
    requesterId: string;
  }): Promise<{
    runtimeId: string;
    runtimeRevisionId: string;
  }>;
}

/** 验证 Runtime Artifact — Attestation。 */
export interface HostedRuntimeArtifactVerifyGateway {
  verifyRuntimeArtifact(command: {
    tenantId: string;
    runtimeRevisionId: string;
  }): Promise<{
    runtimeArtifactId: string;
    runtimeAttestationIds: string[];
  }>;
}

/** 记录 Runtime Conformance。 */
export interface HostedRuntimeConformanceGateway {
  recordRuntimeConformance(command: {
    tenantId: string;
    runtimeRevisionId: string;
  }): Promise<{
    conformanceRunId: string;
    overallResult: "passed" | "failed";
  }>;
}

/** 发布 Runtime Revision。 */
export interface HostedRuntimePublishGateway {
  /** 发布 Runtime Revision — 必须传入精确的 conformanceRunId 和 runtimeAttestationIds。 */
  publishRuntimeRevision(command: {
    tenantId: string;
    runtimeRevisionId: string;
    conformanceRunId: string;
    runtimeAttestationIds: string[];
  }): Promise<{
    runtimePublicationRecordId: string;
  }>;
}

// ─── 3. Runtime Route 激活 ─────────────────────────────────

/**
 * Runtime Route 激活 Gateway — 必须返回路由详情（非 void）。
 * 只操作 targetKind=runtime RouteSet/Route，不接受任何 Agent endpoint/identity/network 字段。
 */
export interface HostedRuntimeRouteActivationGateway {
  /** 激活 targetKind=runtime Route 并返回路由绑定详情。 */
  activateRuntimeRoute(command: {
    tenantId: string;
    routeScopeKey: string;
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

// ─── Gateway 聚合 ─────────────────────────────────────────

/**
 * HostedGateways — 6 个 Gateway 的聚合。
 * Saga 通过此聚合调用各个 Gateway。
 */
export interface HostedGateways {
  /** 仅 runtime：无 agentPublication、旧 routeActivation、旧 routeReader。 */
  runtimeRouteReader: HostedRuntimeRouteReader;
  runtimePrepare: HostedRuntimePrepareGateway;
  runtimeArtifactVerify: HostedRuntimeArtifactVerifyGateway;
  runtimeConformance: HostedRuntimeConformanceGateway;
  runtimePublish: HostedRuntimePublishGateway;
  runtimeRouteActivation: HostedRuntimeRouteActivationGateway;
}
