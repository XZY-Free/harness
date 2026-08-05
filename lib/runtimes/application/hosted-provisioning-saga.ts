/**
 * HostedProvisioningSaga — Hosted 供应的异步步骤编排。
 *
 * §6.3: 修正工作流状态机 — 细化步骤名称。
 * §6.2: 持久化每一步输出 — Saga 后续步骤只使用已保存输出，不重新执行前置步骤。
 *
 * 步骤序列（§6.3）：
 *   start → publishing_agent → publishing_runtime → activating_route → verifying_route → ready
 *
 * 每步必须幂等：重复执行结果一致。
 * 外部调用不放在长数据库事务中。
 */

import type { HostedRuntimeControlPlane } from "@/lib/runtimes/application/provision-hosted-runtime";
import {
  classifyProvisioningError,
  computeProvisioningBackoff,
} from "@/lib/runtimes/domain/hosted-provisioning-request";
import type { HostedGateways } from "@/lib/runtimes/infrastructure/hosted-gateways";
import type { HostedProvisioningRequestRow } from "@/lib/runtimes/persistence/hosted-provisioning-request-record";
import type {
  HostedProvisioningRequestStore,
  StepCheckpoint,
} from "@/lib/runtimes/persistence/hosted-provisioning-request-store";

/** Saga 步骤结果。 */
export interface SagaStepResult {
  /** 步骤标识。 */
  step: string;
  /** 是否完成（可以进入下一步）。 */
  completed: boolean;
  /** 请求的新状态。 */
  newState:
    | "running"
    | "waiting_external_evidence"
    | "waiting_conformance"
    | "ready"
    | "retryable_failed"
    | "permanent_failed";
  /** §6.2: 步骤产出 Checkpoint。 */
  checkpoint?: StepCheckpoint;
}

/** Saga 配置。 */
export interface SagaConfig {
  /** §6.5: Gateway 接口 — 优先使用，替代 controlPlane 单体。 */
  gateways?: HostedGateways;
  /** 旧单体接口 — 过渡期保留，gateways 优先。 */
  controlPlane?: HostedRuntimeControlPlane;
  store: HostedProvisioningRequestStore;
  /** 最大重试次数。 */
  maxAttempts: number;
}

/**
 * 创建 Hosted 供应 Saga 执行器。
 *
 * §6.2: 每步完成后持久化产出到 Checkpoint 字段。
 * §6.3: 使用细化步骤名称。
 */
export function createHostedProvisioningSaga(config: SagaConfig) {
  // §6.5: 解析控制面 — 优先使用 Gateway，回退到旧单体
  const cp: HostedRuntimeControlPlane = config.gateways
    ? {
        resolveEligibleRoute: (cmd) => config.gateways!.routeReader.resolveEligibleRoute(cmd),
        ensurePublishedAgentRevision: (cmd) =>
          config.gateways!.agentPublication.ensurePublishedAgentRevision(cmd),
        ensurePublishedRuntimeRevision: (cmd) =>
          config.gateways!.runtimePublication.ensurePublishedRuntimeRevision(cmd),
        activateRoute: (cmd) => config.gateways!.routeActivation.activateRoute(cmd),
      }
    : config.controlPlane!;

  return async function executeProvisioningSaga(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    const step = request.currentStep ?? "start";

    try {
      switch (step) {
        case "start":
          return await stepStart(request);
        case "publishing_agent":
          return await stepPublishingAgent(request);
        case "publishing_runtime":
          return await stepPublishingRuntime(request);
        case "activating_route":
          return await stepActivateRoute(request);
        case "verifying_route":
          return await stepVerifyRoute(request);
        // §6.3 兼容旧步骤名 — 自动迁移到新步骤
        case "ensure_agent_published":
          return await stepPublishingAgent(request);
        case "ensure_runtime_published":
          return await stepPublishingRuntime(request);
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

  async function stepStart(request: HostedProvisioningRequestRow): Promise<SagaStepResult> {
    await config.store.updateState({
      requestId: request.id,
      state: "running",
      currentStep: "publishing_agent",
      lastAttemptAt: new Date(),
    });
    return { step: "start", completed: true, newState: "running" };
  }

  /**
   * §6.3: publishing_agent — Agent 证据解析 + Attestation + Publish。
   * §6.2: 完成后保存 agentRevisionId, agentPublicationRecordId, agentAttestationId 到 Checkpoint。
   */
  async function stepPublishingAgent(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    // §6.2: 如果 Checkpoint 已有 agent 产出，跳过重复执行
    if (
      request.stepAgentRevisionId &&
      request.stepAgentPublicationRecordId &&
      request.stepAgentAttestationId
    ) {
      await config.store.updateState({
        requestId: request.id,
        state: "running",
        currentStep: "publishing_runtime",
        lastAttemptAt: new Date(),
      });
      return { step: "publishing_agent", completed: true, newState: "running" };
    }

    const agentRevision = await cp.ensurePublishedAgentRevision({
      tenantId: request.tenantId,
      agentId: request.agentId,
    });

    const checkpoint: StepCheckpoint = {
      agentRevisionId: agentRevision.revisionId,
      agentPublicationRecordId: agentRevision.publicationRecordId,
      agentAttestationId: agentRevision.attestationId,
    };

    await config.store.updateState({
      requestId: request.id,
      state: "running",
      currentStep: "publishing_runtime",
      lastAttemptAt: new Date(),
      lastCompletedStep: "publishing_agent",
      checkpoint,
    });

    return {
      step: "publishing_agent",
      completed: true,
      newState: "running",
      checkpoint,
    };
  }

  /**
   * §6.3: publishing_runtime — Runtime 证据 + Conformance + Attestation + Publish。
   * §6.2: 完成后保存 runtimeRevisionId, runtimePublicationRecordId, runtimeAttestationId, conformanceRunId。
   */
  async function stepPublishingRuntime(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    // §6.2: 如果 Checkpoint 已有 runtime 产出，跳过重复执行
    if (
      request.stepRuntimeRevisionId &&
      request.stepRuntimePublicationRecordId &&
      request.stepRuntimeAttestationId &&
      request.stepConformanceRunId
    ) {
      await config.store.updateState({
        requestId: request.id,
        state: "running",
        currentStep: "activating_route",
        lastAttemptAt: new Date(),
      });
      return { step: "publishing_runtime", completed: true, newState: "running" };
    }

    const runtimeRevision = await cp.ensurePublishedRuntimeRevision({
      tenantId: request.tenantId,
      agentId: request.agentId,
    });

    const checkpoint: StepCheckpoint = {
      runtimeRevisionId: runtimeRevision.revisionId,
      runtimePublicationRecordId: runtimeRevision.publicationRecordId,
      runtimeAttestationId: runtimeRevision.attestationId,
      conformanceRunId: runtimeRevision.conformanceRunId,
    };

    await config.store.updateState({
      requestId: request.id,
      state: "running",
      currentStep: "activating_route",
      lastAttemptAt: new Date(),
      lastCompletedStep: "publishing_runtime",
      checkpoint,
    });

    return {
      step: "publishing_runtime",
      completed: true,
      newState: "running",
      checkpoint,
    };
  }

  /**
   * §6.3: activating_route — 使用 Checkpoint 中已保存的 Revision 激活 Route。
   * §6.2: 不再重新调用 ensurePublished*，直接从 Checkpoint 读取。
   */
  async function stepActivateRoute(request: HostedProvisioningRequestRow): Promise<SagaStepResult> {
    // §6.2: 从 Checkpoint 读取已保存的 Revision 产出
    const agentRevision = {
      revisionId: request.stepAgentRevisionId!,
      publicationRecordId: request.stepAgentPublicationRecordId!,
      attestationId: request.stepAgentAttestationId!,
    };
    const runtimeRevision = {
      revisionId: request.stepRuntimeRevisionId!,
      publicationRecordId: request.stepRuntimePublicationRecordId!,
      attestationId: request.stepRuntimeAttestationId!,
      conformanceRunId: request.stepConformanceRunId!,
    };

    // 激活 Route
    await config.controlPlane!.activateRoute({
      tenantId: request.tenantId,
      agentId: request.agentId,
      routeScopeKey: request.routeScopeKey,
      agentRevision,
      runtimeRevision,
    });

    await config.store.updateState({
      requestId: request.id,
      state: "running",
      currentStep: "verifying_route",
      lastAttemptAt: new Date(),
      lastCompletedStep: "activating_route",
    });

    return { step: "activating_route", completed: true, newState: "running" };
  }

  async function stepVerifyRoute(request: HostedProvisioningRequestRow): Promise<SagaStepResult> {
    // 最终验证：RouteResolver 通过
    const route = await config.controlPlane!.resolveEligibleRoute({
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
        currentStep: "verifying_route",
        nextAttemptAt: backoff,
        lastError: "Route 激活后未通过正式 RouteResolver 门禁",
        lastAttemptAt: new Date(),
      });
      return { step: "verifying_route", completed: false, newState: "retryable_failed" };
    }

    // §6.2: 保存 Route 验证产出到 Checkpoint
    const checkpoint: StepCheckpoint = {
      routeRevisionId: route.routeRevisionId,
      routeActivationId: route.routeActivationId,
    };

    // 全部完成
    await config.store.updateState({
      requestId: request.id,
      state: "ready",
      currentStep: "done",
      lastAttemptAt: new Date(),
      lastCompletedStep: "verifying_route",
      checkpoint,
    });

    return { step: "verifying_route", completed: true, newState: "ready", checkpoint };
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
