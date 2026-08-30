/**
 * HostedProvisioningSaga — Hosted 供应的异步步骤编排。
 *
 * Runtime-only Authority：
 * HostedProvisioningSaga 只供应 tenant 内 builtin Harness Runtime 及其
 * targetKind=runtime Route。无 Agent 发布、Agent revision、Agent route，
 * 或 builtin-runtime binding 检查。
 *
 * 正式步骤序列：
 * validate_request → prepare_runtime_revision → verify_runtime_artifact
 * → record_runtime_conformance → publish_runtime_revision
 * → activate_route → await_projection → verify_route → ready
 *
 * - Runtime 拆为 4 步 Gateway + runtimeRouteActivation / runtimeRouteReader。
 * - Worker 每次只执行一个步骤，完成后保存 Checkpoint + 清除 Lease。
 * - validate_request 对空白 tenantId/requesterId/routeScopeKey fail-closed。
 * - verify_route 验证精确 ID（runtimeRevisionId/routeRevisionId/routeActivationId），非仅非空。
 */

import {
  classifyProvisioningError,
  computeProvisioningBackoff,
} from "@/lib/runtime/domain/hosted-provisioning-request";
import type { HostedGateways } from "@/lib/runtime/infrastructure/hosted-gateways";
import type { HostedProvisioningRequestRow } from "@/lib/runtime/persistence/hosted-provisioning-request-record";
import type {
  HostedProvisioningRequestStore,
  StepCheckpoint,
} from "@/lib/runtime/persistence/hosted-provisioning-request-store";
import type { HostedRuntimeRoute } from "@/lib/runtime/provisioning/provision-hosted-runtime";

/** 正式步骤名称（runtime-only）。 */
export const PROVISIONING_STEPS = [
  "validate_request",
  "prepare_runtime_revision",
  "verify_runtime_artifact",
  "record_runtime_conformance",
  "publish_runtime_revision",
  "activate_route",
  "await_projection",
  "verify_route",
] as const;
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];

/** 下一步映射。 */
const NEXT_STEP: Record<string, string | null> = {
  validate_request: "prepare_runtime_revision",
  prepare_runtime_revision: "verify_runtime_artifact",
  verify_runtime_artifact: "record_runtime_conformance",
  record_runtime_conformance: "publish_runtime_revision",
  publish_runtime_revision: "activate_route",
  activate_route: "await_projection",
  await_projection: "verify_route",
  verify_route: null, // 终态 → ready
};

/** Saga 步骤结果。 */
export interface SagaStepResult {
  /** 步骤标识。 */
  step: string;
  /** 是否完成（可以进入下一步）。 */
  completed: boolean;
  /** 请求的新状态。 */
  newState: "pending" | "ready" | "retryable_failed" | "permanent_failed";
  /** 步骤产出 Checkpoint。 */
  checkpoint?: StepCheckpoint;
}

/** Saga 配置。 */
export interface SagaConfig {
  /** Gateway 接口 — 唯一的供应控制面。 */
  gateways: HostedGateways;
  store: HostedProvisioningRequestStore;
  /** 最大重试次数。 */
  maxAttempts: number;
  /** 当前 Worker ID，用于 lease owner 校验。 */
  workerId: string;
}

/**
 * 创建 Hosted 供应 Saga 执行器。
 *
 * 每步完成后持久化产出到 Checkpoint 字段。
 * Worker 每次只执行一个步骤。
 */
export function createHostedProvisioningSaga(config: SagaConfig) {
  const gateways = config.gateways;

  return async function executeProvisioningSaga(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    const step = request.currentStep ?? "validate_request";

    try {
      switch (step) {
        case "validate_request":
          return await stepValidateRequest(request);
        case "prepare_runtime_revision":
          return await stepPrepareRuntimeRevision(request);
        case "verify_runtime_artifact":
          return await stepVerifyRuntimeArtifact(request);
        case "record_runtime_conformance":
          return await stepRecordRuntimeConformance(request);
        case "publish_runtime_revision":
          return await stepPublishRuntimeRevision(request);
        case "activate_route":
          return await stepActivateRoute(request);
        case "await_projection":
          return await stepAwaitProjection(request);
        case "verify_route":
          return await stepVerifyRoute(request);
        default:
          throw new Error(`未知供应步骤: ${step}`);
      }
    } catch (error) {
      return await handleSagaError(request, error);
    }
  };

  // ─── 辅助：推进到下一步 ──────────────────────────────────

  async function advanceStep(
    request: HostedProvisioningRequestRow,
    completedStep: string,
    checkpoint?: StepCheckpoint,
  ): Promise<SagaStepResult> {
    const nextStep = NEXT_STEP[completedStep];
    if (nextStep === null) {
      // 终态 → ready
      await config.store.updateState({
        requestId: request.id,
        workerId: config.workerId,
        state: "ready",
        currentStep: "done",
        lastAttemptAt: new Date(),
        lastCompletedStep: completedStep,
        checkpoint,
        // 清除 Lease
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      return { step: completedStep, completed: true, newState: "ready", checkpoint };
    }

    // 成功非终态 → 保存 Checkpoint → currentStep=下一步 → state=pending → 清除 Lease
    await config.store.updateState({
      requestId: request.id,
      workerId: config.workerId,
      state: "pending",
      currentStep: nextStep,
      lastAttemptAt: new Date(),
      lastCompletedStep: completedStep,
      checkpoint,
      // 清除 Lease
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: new Date(), // 立即可被领取
    });
    return { step: completedStep, completed: true, newState: "pending", checkpoint };
  }

  // ─── 步骤实现 ────────────────────────────────────────────

  /** validate_request — 校验请求冻结值完整性，fail-closed。 */
  async function stepValidateRequest(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    if (isBlank(request.tenantId)) {
      throw permanentError("HOSTED_REQUEST_INVALID", "tenantId 缺失");
    }
    if (isBlank(request.requesterId)) {
      throw permanentError("HOSTED_REQUEST_INVALID", "requesterId 缺失");
    }
    if (isBlank(request.routeScopeKey)) {
      throw permanentError("HOSTED_REQUEST_INVALID", "routeScopeKey 缺失");
    }
    return advanceStep(request, "validate_request");
  }

  /**
   * prepare_runtime_revision — 准备 Runtime Revision。
   * 命令只含 {tenantId, requesterId}。
   */
  async function stepPrepareRuntimeRevision(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    if (request.stepRuntimeRevisionId && request.stepRuntimeId) {
      return advanceStep(request, "prepare_runtime_revision");
    }

    const result = await gateways.runtimePrepare.prepareRuntimeRevision({
      tenantId: request.tenantId,
      requesterId: request.requesterId,
    });

    const checkpoint: StepCheckpoint = {
      runtimeId: result.runtimeId,
      runtimeRevisionId: result.runtimeRevisionId,
    };

    return advanceStep(request, "prepare_runtime_revision", checkpoint);
  }

  /**
   * verify_runtime_artifact — Runtime Artifact Attestation。
   */
  async function stepVerifyRuntimeArtifact(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    const runtimeRevisionId = request.stepRuntimeRevisionId;
    if (!runtimeRevisionId) {
      throw permanentError("CHECKPOINT_BROKEN", "stepRuntimeRevisionId 缺失，无法验证 Artifact");
    }

    if (request.stepRuntimeArtifactId && request.stepRuntimeAttestationIds) {
      return advanceStep(request, "verify_runtime_artifact");
    }

    const result = await gateways.runtimeArtifactVerify.verifyRuntimeArtifact({
      tenantId: request.tenantId,
      runtimeRevisionId,
    });

    const checkpoint: StepCheckpoint = {
      runtimeArtifactId: result.runtimeArtifactId,
      runtimeAttestationIds: result.runtimeAttestationIds,
    };

    return advanceStep(request, "verify_runtime_artifact", checkpoint);
  }

  /**
   * record_runtime_conformance — 记录 Runtime Conformance。
   */
  async function stepRecordRuntimeConformance(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    const runtimeRevisionId = request.stepRuntimeRevisionId;
    if (!runtimeRevisionId) {
      throw permanentError("CHECKPOINT_BROKEN", "stepRuntimeRevisionId 缺失，无法记录 Conformance");
    }

    if (request.stepConformanceRunId) {
      return advanceStep(request, "record_runtime_conformance");
    }

    const result = await gateways.runtimeConformance.recordRuntimeConformance({
      tenantId: request.tenantId,
      runtimeRevisionId,
    });

    if (result.overallResult !== "passed") {
      // Conformance 未通过 → 可重试（可能有新的 Conformance）
      const backoff = computeProvisioningBackoff(request.attemptCount);
      await config.store.updateState({
        requestId: request.id,
        workerId: config.workerId,
        state: "retryable_failed",
        currentStep: "record_runtime_conformance",
        nextAttemptAt: backoff,
        lastError: "Runtime Conformance 未通过",
        lastAttemptAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      return { step: "record_runtime_conformance", completed: false, newState: "retryable_failed" };
    }

    const checkpoint: StepCheckpoint = {
      conformanceRunId: result.conformanceRunId,
    };

    return advanceStep(request, "record_runtime_conformance", checkpoint);
  }

  /**
   * publish_runtime_revision — 发布 Runtime Revision。
   */
  async function stepPublishRuntimeRevision(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    const runtimeRevisionId = request.stepRuntimeRevisionId;
    if (!runtimeRevisionId) {
      throw permanentError("CHECKPOINT_BROKEN", "stepRuntimeRevisionId 缺失，无法发布 Runtime");
    }

    if (request.stepRuntimePublicationRecordId) {
      return advanceStep(request, "publish_runtime_revision");
    }

    const conformanceRunId = request.stepConformanceRunId;
    const runtimeAttestationIds = request.stepRuntimeAttestationIds;
    if (!conformanceRunId || !runtimeAttestationIds?.[0]) {
      throw permanentError(
        "CHECKPOINT_BROKEN",
        "Conformance 或 Attestation Checkpoint 缺失，无法发布 Runtime",
      );
    }

    const result = await gateways.runtimePublish.publishRuntimeRevision({
      tenantId: request.tenantId,
      runtimeRevisionId,
      conformanceRunId,
      runtimeAttestationIds,
    });

    const checkpoint: StepCheckpoint = {
      runtimePublicationRecordId: result.runtimePublicationRecordId,
    };

    return advanceStep(request, "publish_runtime_revision", checkpoint);
  }

  /**
   * activate_route — Route 激活，返回路由详情。
   * 只要求 runtimeRevisionId / runtimePublicationRecordId / conformanceRunId /
   * 非空 runtimeAttestationId，不引用任何 Agent checkpoint。
   */
  async function stepActivateRoute(request: HostedProvisioningRequestRow): Promise<SagaStepResult> {
    const runtimeRevisionId = request.stepRuntimeRevisionId;
    const runtimePublicationRecordId = request.stepRuntimePublicationRecordId;
    const conformanceRunId = request.stepConformanceRunId;

    const runtimeAttestationId = request.stepRuntimeAttestationIds?.[0];
    if (
      !runtimeRevisionId ||
      !runtimePublicationRecordId ||
      !conformanceRunId ||
      !runtimeAttestationId
    ) {
      throw permanentError("CHECKPOINT_BROKEN", "Checkpoint 不完整，无法激活 Route");
    }

    // Checkpoint 跳过（已激活）
    if (request.stepRouteSetId && request.stepRouteRevisionId && request.stepRouteActivationId) {
      return advanceStep(request, "activate_route");
    }

    const runtimeRevision = {
      revisionId: runtimeRevisionId,
      publicationRecordId: runtimePublicationRecordId,
      attestationId: runtimeAttestationId,
      conformanceRunId,
    };

    // Route Activation 返回路由详情（无 Agent 字段）
    const routeResult = await gateways.runtimeRouteActivation.activateRuntimeRoute({
      tenantId: request.tenantId,
      routeScopeKey: request.routeScopeKey,
      runtimeRevision,
    });

    const checkpoint: StepCheckpoint = {
      routeSetId: routeResult.routeSetId,
      routeSetVersionNo: routeResult.routeSetVersionNo,
      routeId: routeResult.routeId,
      routeRevisionId: routeResult.routeRevisionId,
      routeActivationId: routeResult.routeActivationId,
    };

    return advanceStep(request, "activate_route", checkpoint);
  }

  /**
   * await_projection — 等待 Projection 构建。
   *
   * Route 激活后需要等待 Projection 事件处理器完成构建。
   * 通过 runtimeRouteReader 检查 targetKind=runtime Projection 是否已可见且 eligible。
   */
  async function stepAwaitProjection(
    request: HostedProvisioningRequestRow,
  ): Promise<SagaStepResult> {
    // 通过 Resolver 检查 Projection 是否已可见
    const route = await gateways.runtimeRouteReader.resolveEligibleRuntimeRoute({
      tenantId: request.tenantId,
      routeScopeKey: request.routeScopeKey,
    });

    if (!route) {
      // Projection 尚未构建 — 可重试
      const backoff = computeProvisioningBackoff(request.attemptCount);
      await config.store.updateState({
        requestId: request.id,
        workerId: config.workerId,
        state: "retryable_failed",
        currentStep: "await_projection",
        nextAttemptAt: backoff,
        lastError: "Projection 尚未构建，等待重试",
        lastAttemptAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      return { step: "await_projection", completed: false, newState: "retryable_failed" };
    }

    assertResolvedRouteMatchesRequest(request, route);

    // 保存 Projection 信息到 Checkpoint
    const checkpoint: StepCheckpoint = {
      routeRevisionId: route.routeRevisionId,
      routeActivationId: route.routeActivationId,
      projectionVersionNo: route.projectionVersionNo,
    };

    return advanceStep(request, "await_projection", checkpoint);
  }

  /**
   * verify_route — 验证精确 ID（runtimeRevisionId/routeRevisionId/routeActivationId），非仅非空。
   */
  async function stepVerifyRoute(request: HostedProvisioningRequestRow): Promise<SagaStepResult> {
    const route = await gateways.runtimeRouteReader.resolveEligibleRuntimeRoute({
      tenantId: request.tenantId,
      routeScopeKey: request.routeScopeKey,
    });

    if (!route) {
      const backoff = computeProvisioningBackoff(request.attemptCount);
      await config.store.updateState({
        requestId: request.id,
        workerId: config.workerId,
        state: "retryable_failed",
        currentStep: "verify_route",
        nextAttemptAt: backoff,
        lastError: "Route 验证失败：Resolver 未返回路由",
        lastAttemptAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      return { step: "verify_route", completed: false, newState: "retryable_failed" };
    }

    assertResolvedRouteMatchesRequest(request, route);

    // 精确 ID 验证 — 全部完成
    const checkpoint: StepCheckpoint = {
      routeRevisionId: route.routeRevisionId,
      routeActivationId: route.routeActivationId,
    };

    return advanceStep(request, "verify_route", checkpoint);
  }

  function assertResolvedRouteMatchesRequest(
    request: HostedProvisioningRequestRow,
    route: HostedRuntimeRoute,
  ): void {
    const mismatches: string[] = [];
    if (
      request.stepRuntimeRevisionId &&
      route.runtimeRevisionId !== request.stepRuntimeRevisionId
    ) {
      mismatches.push(
        `runtimeRevisionId: route=${route.runtimeRevisionId} != checkpoint=${request.stepRuntimeRevisionId}`,
      );
    }
    if (request.stepRouteRevisionId && route.routeRevisionId !== request.stepRouteRevisionId) {
      mismatches.push(
        `routeRevisionId: route=${route.routeRevisionId} != checkpoint=${request.stepRouteRevisionId}`,
      );
    }
    if (
      request.stepRouteActivationId &&
      route.routeActivationId !== request.stepRouteActivationId
    ) {
      mismatches.push(
        `routeActivationId: route=${route.routeActivationId} != checkpoint=${request.stepRouteActivationId}`,
      );
    }

    if (mismatches.length > 0) {
      throw permanentError(
        "HOSTED_ROUTE_ID_MISMATCH",
        `Route ID 验证失败: ${mismatches.join("; ")}`,
      );
    }
  }

  // ─── 错误处理 ────────────────────────────────────────────

  async function handleSagaError(
    request: HostedProvisioningRequestRow,
    error: unknown,
  ): Promise<SagaStepResult> {
    const classification = classifyProvisioningError(error);
    const step = request.currentStep ?? "unknown";

    if (classification.category === "permanent" || request.attemptCount >= config.maxAttempts) {
      // 永久失败 → 清除 Lease
      await config.store.updateState({
        requestId: request.id,
        workerId: config.workerId,
        state: "permanent_failed",
        lastError: classification.message,
        lastAttemptAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      return { step, completed: false, newState: "permanent_failed" };
    }

    // 可重试失败 → backoff + 清除 Lease
    const backoff = computeProvisioningBackoff(request.attemptCount);
    await config.store.updateState({
      requestId: request.id,
      workerId: config.workerId,
      state: "retryable_failed",
      nextAttemptAt: backoff,
      lastError: classification.message,
      lastAttemptAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    return { step, completed: false, newState: "retryable_failed" };
  }
}

/** 空白校验：空串或全空白视为非法。 */
function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/** 创建永久错误 — 不可重试。 */
function permanentError(code: string, message: string): Error {
  const err = new Error(`[${code}] ${message}`);
  err.name = "HostedProvisioningPermanentError";
  return err;
}
