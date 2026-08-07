/**
 * HostedProvisioningSaga — Hosted 供应的异步步骤编排。
 *
 * : 正式步骤序列：
 * validate_request → ensure_agent_publication → prepare_runtime_revision
 * → verify_runtime_artifact → record_runtime_conformance → publish_runtime_revision
 * → activate_route → await_projection → verify_route → ready
 *
 * : Agent Gateway 接受 agentRevisionId 并验证一致性。
 * : Runtime 拆为 4 步 Gateway。
 * : Worker 每次只执行一个步骤，完成后保存 Checkpoint + 清除 Lease。
 * : Route Activation 返回路由详情。
 * : verify_route 验证精确 ID，非仅非空。
 */

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

/** : 正式步骤名称。 */
export const PROVISIONING_STEPS = [
 "validate_request",
 "ensure_agent_publication",
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
 validate_request: "ensure_agent_publication",
 ensure_agent_publication: "prepare_runtime_revision",
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
 newState:
 | "running"
 | "ready"
 | "retryable_failed"
 | "permanent_failed";
 /** : 步骤产出 Checkpoint。 */
 checkpoint?: StepCheckpoint;
}

/** Saga 配置。 */
export interface SagaConfig {
 /** Gateway 接口 — 唯一的供应控制面。 */
 gateways: HostedGateways;
 store: HostedProvisioningRequestStore;
 /** 最大重试次数。 */
 maxAttempts: number;
 /** : 当前 Worker ID，用于 lease owner 校验。 */
 workerId: string;
}

/**
 * : 创建 Hosted 供应 Saga 执行器。
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
 case "ensure_agent_publication":
 return await stepEnsureAgentPublication(request);
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
 // : 清除 Lease
 leaseOwner: null,
 leaseExpiresAt: null,
 });
 return { step: completedStep, completed: true, newState: "ready", checkpoint };
 }

 // : 成功非终态 → 保存 Checkpoint → currentStep=下一步 → state=pending → 清除 Lease
 await config.store.updateState({
 requestId: request.id,
 workerId: config.workerId,
 state: "pending",
 currentStep: nextStep,
 lastAttemptAt: new Date(),
 lastCompletedStep: completedStep,
 checkpoint,
 // : 清除 Lease
 leaseOwner: null,
 leaseExpiresAt: null,
 nextAttemptAt: new Date(), // 立即可被领取
 });
 return { step: completedStep, completed: true, newState: "running", checkpoint };
 }

 // ─── 步骤实现 ────────────────────────────────────────────

 /** : validate_request — 校验请求冻结值完整性。 */
 async function stepValidateRequest(request: HostedProvisioningRequestRow): Promise<SagaStepResult> {
 if (!request.agentRevisionId) {
 throw permanentError("HOSTED_REQUEST_INVALID", "agentRevisionId 缺失");
 }
 return advanceStep(request, "validate_request");
 }

 /**
 * : ensure_agent_publication — Agent 发布，验证 revision 一致性。
 */
 async function stepEnsureAgentPublication(
 request: HostedProvisioningRequestRow,
 ): Promise<SagaStepResult> {
 // Checkpoint 跳过
 if (request.stepAgentRevisionId && request.stepAgentPublicationRecordId) {
 return advanceStep(request, "ensure_agent_publication");
 }

 // : 传入 agentRevisionId
 const agentRevision = await gateways.agentPublication.ensurePublishedAgentRevision({
 tenantId: request.tenantId,
 agentId: request.agentId,
 agentRevisionId: request.agentRevisionId,
 });

 // : 验证 Revision 一致性
 if (agentRevision.revisionId !== request.agentRevisionId) {
 throw permanentError(
 "HOSTED_AGENT_REVISION_MISMATCH",
 `Agent 发布返回 revisionId=${agentRevision.revisionId}，请求要求=${request.agentRevisionId}`,
 );
 }

 const checkpoint: StepCheckpoint = {
 agentRevisionId: agentRevision.revisionId,
 agentPublicationRecordId: agentRevision.publicationRecordId,
 agentAttestationId: agentRevision.attestationId,
 };

 return advanceStep(request, "ensure_agent_publication", checkpoint);
 }

 /**
 * : prepare_runtime_revision — 准备 Runtime Revision。
 */
 async function stepPrepareRuntimeRevision(
 request: HostedProvisioningRequestRow,
 ): Promise<SagaStepResult> {
 if (request.stepRuntimeRevisionId && request.stepRuntimeId) {
 return advanceStep(request, "prepare_runtime_revision");
 }

 const result = await gateways.runtimePrepare.prepareRuntimeRevision({
 tenantId: request.tenantId,
 agentId: request.agentId,
 agentRevisionId: request.agentRevisionId,
 });

 const checkpoint: StepCheckpoint = {
 runtimeId: result.runtimeId,
 runtimeRevisionId: result.runtimeRevisionId,
 };

 return advanceStep(request, "prepare_runtime_revision", checkpoint);
 }

 /**
 * : verify_runtime_artifact — Runtime Artifact Attestation。
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
 * : record_runtime_conformance — 记录 Runtime Conformance。
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
 * : publish_runtime_revision — 发布 Runtime Revision。
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

 const result = await gateways.runtimePublish.publishRuntimeRevision({
 tenantId: request.tenantId,
 runtimeRevisionId,
 conformanceRunId: request.stepConformanceRunId ?? "",
 runtimeAttestationIds: request.stepRuntimeAttestationIds ?? [],
 });

 const checkpoint: StepCheckpoint = {
 runtimePublicationRecordId: result.runtimePublicationRecordId,
 };

 return advanceStep(request, "publish_runtime_revision", checkpoint);
 }

 /**
 * : activate_route — Route 激活，返回路由详情。
 */
 async function stepActivateRoute(request: HostedProvisioningRequestRow): Promise<SagaStepResult> {
 const agentRevisionId = request.stepAgentRevisionId;
 const agentPublicationRecordId = request.stepAgentPublicationRecordId;
 const agentAttestationId = request.stepAgentAttestationId;
 const runtimeRevisionId = request.stepRuntimeRevisionId;
 const runtimePublicationRecordId = request.stepRuntimePublicationRecordId;
 const conformanceRunId = request.stepConformanceRunId;

 if (!agentRevisionId || !agentPublicationRecordId || !agentAttestationId ||
 !runtimeRevisionId || !runtimePublicationRecordId || !conformanceRunId ||
 !request.stepRuntimeAttestationIds?.length) {
 throw permanentError("CHECKPOINT_BROKEN", "Checkpoint 不完整，无法激活 Route");
 }

 // Checkpoint 跳过（已激活）
 if (request.stepRouteSetId && request.stepRouteRevisionId && request.stepRouteActivationId) {
 return advanceStep(request, "activate_route");
 }

 const agentRevision = {
 revisionId: agentRevisionId,
 publicationRecordId: agentPublicationRecordId,
 attestationId: agentAttestationId,
 };
 const runtimeRevision = {
 revisionId: runtimeRevisionId,
 publicationRecordId: runtimePublicationRecordId,
 attestationId: request.stepRuntimeAttestationIds![0]!,
 conformanceRunId,
 };

 // : Route Activation 返回路由详情
 const routeResult = await gateways.routeActivation.activateRoute({
 tenantId: request.tenantId,
 agentId: request.agentId,
 routeScopeKey: request.routeScopeKey,
 agentRevision,
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
 * 检查 Projection 是否已存在且 eligible。
 */
 async function stepAwaitProjection(request: HostedProvisioningRequestRow): Promise<SagaStepResult> {
 // 通过 Resolver 检查 Projection 是否已可见
 const route = await gateways.routeReader.resolveEligibleRoute({
 tenantId: request.tenantId,
 agentId: request.agentId,
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

 // 保存 Projection 信息到 Checkpoint
 const checkpoint: StepCheckpoint = {
 routeRevisionId: route.routeRevisionId,
 routeActivationId: route.routeActivationId,
 projectionVersionNo: route.projectionVersionNo ?? null,
 };

 return advanceStep(request, "await_projection", checkpoint);
 }

 /**
 * : verify_route — 验证精确 ID，非仅非空。
 */
 async function stepVerifyRoute(request: HostedProvisioningRequestRow): Promise<SagaStepResult> {
 const route = await gateways.routeReader.resolveEligibleRoute({
 tenantId: request.tenantId,
 agentId: request.agentId,
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

 // : 精确 ID 验证
 const mismatches: string[] = [];
 if (route.agentRevisionId !== request.agentRevisionId) {
 mismatches.push(`agentRevisionId: route=${route.agentRevisionId} != request=${request.agentRevisionId}`);
 }
 if (request.stepRuntimeRevisionId && route.runtimeRevisionId !== request.stepRuntimeRevisionId) {
 mismatches.push(`runtimeRevisionId: route=${route.runtimeRevisionId} != checkpoint=${request.stepRuntimeRevisionId}`);
 }
 if (request.stepRouteRevisionId && route.routeRevisionId !== request.stepRouteRevisionId) {
 mismatches.push(`routeRevisionId: route=${route.routeRevisionId} != checkpoint=${request.stepRouteRevisionId}`);
 }
 if (request.stepRouteActivationId && route.routeActivationId !== request.stepRouteActivationId) {
 mismatches.push(`routeActivationId: route=${route.routeActivationId} != checkpoint=${request.stepRouteActivationId}`);
 }

 if (mismatches.length > 0) {
 throw permanentError(
 "HOSTED_ROUTE_ID_MISMATCH",
 `Route ID 验证失败: ${mismatches.join("; ")}`,
 );
 }

 // 全部完成
 const checkpoint: StepCheckpoint = {
 routeRevisionId: route.routeRevisionId,
 routeActivationId: route.routeActivationId,
 };

 return advanceStep(request, "verify_route", checkpoint);
 }

 // ─── 错误处理 ────────────────────────────────────────────

 async function handleSagaError(
 request: HostedProvisioningRequestRow,
 error: unknown,
 ): Promise<SagaStepResult> {
 const classification = classifyProvisioningError(error);
 const step = request.currentStep ?? "unknown";

 if (classification.category === "permanent" || request.attemptCount >= config.maxAttempts) {
 // : 永久失败 → 清除 Lease
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

 // : 可重试失败 → backoff + 清除 Lease
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

/** 创建永久错误 — 不可重试。 */
function permanentError(code: string, message: string): Error {
 const err = new Error(`[${code}] ${message}`);
 err.name = "HostedProvisioningPermanentError";
 return err;
}
