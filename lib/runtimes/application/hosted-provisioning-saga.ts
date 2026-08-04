/**
 * HostedProvisioningSaga — Hosted 供应的异步步骤编排。
 *
 * 拆分自 mysql-hosted-runtime-control-plane.ts，将同步编排改为
 * 每步幂等的 Saga 步骤，由 Worker 异步驱动。
 *
 * 每步必须幂等：重复执行结果一致。
 * 外部调用不放在长数据库事务中。
 */

import type { HostedRuntimeControlPlane } from "@/lib/runtimes/application/provision-hosted-runtime";
import type { HostedProvisioningRequestStore } from "@/lib/runtimes/persistence/hosted-provisioning-request-store";
import type { HostedProvisioningRequestRow } from "@/lib/runtimes/persistence/hosted-provisioning-request-record";
import {
  classifyProvisioningError,
  computeProvisioningBackoff,
} from "@/lib/runtimes/domain/hosted-provisioning-request";

/** Saga 步骤结果。 */
export interface SagaStepResult {
  /** 步骤标识。 */
  step: string;
  /** 是否完成（可以进入下一步）。 */
  completed: boolean;
  /** 请求的新状态。 */
  newState: "running" | "waiting_external_evidence" | "waiting_conformance" | "ready" | "retryable_failed" | "permanent_failed";
  /** 步骤产出数据（JSON 可序列化）。 */
  output?: Record<string, string>;
}

/** Saga 配置。 */
export interface SagaConfig {
  controlPlane: HostedRuntimeControlPlane;
  store: HostedProvisioningRequestStore;
  /** 最大重试次数。 */
  maxAttempts: number;
}

/**
 * 创建 Hosted 供应 Saga 执行器。
 */
export function createHostedProvisioningSaga(config: SagaConfig) {
  return async function executeProvisioningSaga(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    const step = request.currentStep ?? "start";

    try {
      switch (step) {
        case "start":
          return await stepStart(request);
        case "ensure_agent_published":
          return await stepEnsureAgentPublished(request);
        case "ensure_runtime_published":
          return await stepEnsureRuntimePublished(request);
        case "activate_route":
          return await stepActivateRoute(request);
        case "verify_route":
          return await stepVerifyRoute(request);
        default:
          throw new Error(`未知供应步骤: ${step}`);
      }
    } catch (error) {
      return await handleSagaError(request, error);
    }
  };

  // ─── 步骤实现 ────────────────────────────────────────────

  async function stepStart(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    await config.store.updateState({
      requestId: request.id,
      state: "running",
      currentStep: "ensure_agent_published",
      lastAttemptAt: new Date(),
    });
    return { step: "start", completed: true, newState: "running" };
  }

  async function stepEnsureAgentPublished(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    // 外部调用：Evidence Service + Attestation + Publish
    const agentRevision = await config.controlPlane.ensurePublishedAgentRevision({
      tenantId: request.tenantId,
      agentId: request.agentId,
    });

    await config.store.updateState({
      requestId: request.id,
      state: "running",
      currentStep: "ensure_runtime_published",
      lastAttemptAt: new Date(),
    });

    return {
      step: "ensure_agent_published",
      completed: true,
      newState: "running",
      output: {
        agentRevisionId: agentRevision.revisionId,
        agentPublicationRecordId: agentRevision.publicationRecordId,
        agentAttestationId: agentRevision.attestationId,
      },
    };
  }

  async function stepEnsureRuntimePublished(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    // 外部调用：Evidence Service + Attestation + Conformance + Publish
    const runtimeRevision = await config.controlPlane.ensurePublishedRuntimeRevision({
      tenantId: request.tenantId,
      agentId: request.agentId,
    });

    await config.store.updateState({
      requestId: request.id,
      state: "running",
      currentStep: "activate_route",
      lastAttemptAt: new Date(),
    });

    return {
      step: "ensure_runtime_published",
      completed: true,
      newState: "running",
      output: {
        runtimeRevisionId: runtimeRevision.revisionId,
        runtimePublicationRecordId: runtimeRevision.publicationRecordId,
        runtimeAttestationId: runtimeRevision.attestationId,
        conformanceRunId: runtimeRevision.conformanceRunId,
      },
    };
  }

  async function stepActivateRoute(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    // 先获取 published revisions
    const agentRevision = await config.controlPlane.ensurePublishedAgentRevision({
      tenantId: request.tenantId,
      agentId: request.agentId,
    });
    const runtimeRevision = await config.controlPlane.ensurePublishedRuntimeRevision({
      tenantId: request.tenantId,
      agentId: request.agentId,
    });

    // 激活 Route
    await config.controlPlane.activateRoute({
      tenantId: request.tenantId,
      agentId: request.agentId,
      routeScopeKey: request.routeScopeKey,
      agentRevision,
      runtimeRevision,
    });

    await config.store.updateState({
      requestId: request.id,
      state: "running",
      currentStep: "verify_route",
      lastAttemptAt: new Date(),
    });

    return { step: "activate_route", completed: true, newState: "running" };
  }

  async function stepVerifyRoute(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    // 最终验证：RouteResolver 通过
    const route = await config.controlPlane.resolveEligibleRoute({
      tenantId: request.tenantId,
      agentId: request.agentId,
      routeScopeKey: request.routeScopeKey,
    });

    if (!route) {
      // Route 激活后未通过 Resolver — 可能是短暂延迟，标记为 retryable
      const backoff = computeProvisioningBackoff(request.attemptCount);
      await config.store.updateState({
        requestId: request.id,
        state: "retryable_failed",
        currentStep: "verify_route",
        nextAttemptAt: backoff,
        lastError: "Route 激活后未通过正式 RouteResolver 门禁",
        lastAttemptAt: new Date(),
      });
      return { step: "verify_route", completed: false, newState: "retryable_failed" };
    }

    // 全部完成
    await config.store.updateState({
      requestId: request.id,
      state: "ready",
      currentStep: "done",
      lastAttemptAt: new Date(),
    });

    return { step: "verify_route", completed: true, newState: "ready" };
  }

  // ─── 错误处理 ────────────────────────────────────────────

  async function handleSagaError(
    request: HostedProvisioningRequestRow,
    error: unknown,
  ): Promise<SagaStepResult> {
    const classification = classifyProvisioningError(error);
    const step = request.currentStep ?? "unknown";

    if (classification.category === "permanent" || request.attemptCount >= config.maxAttempts) {
      // 永久失败或达到最大重试
      await config.store.updateState({
        requestId: request.id,
        state: "permanent_failed",
        lastError: classification.message,
        lastAttemptAt: new Date(),
      });
      return { step, completed: false, newState: "permanent_failed" };
    }

    // 可重试失败
    const backoff = computeProvisioningBackoff(request.attemptCount);
    await config.store.updateState({
      requestId: request.id,
      state: "retryable_failed",
      nextAttemptAt: backoff,
      lastError: classification.message,
      lastAttemptAt: new Date(),
    });
    return { step, completed: false, newState: "retryable_failed" };
  }
}
