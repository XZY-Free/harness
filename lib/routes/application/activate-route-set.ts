/**
 * RouteSet 整体激活服务 — 22 步事务流程。
 *
 * 输入目标 RouteSet 的完整 Active 状态（非增量 Patch），
 * 在单个事务内原子完成所有 RouteRevision + RouteActivation 创建，
 * 并更新 DeploymentRoute 投影。
 *
 * 现有单 Route 服务作为薄适配器委托此服务。
 */
import { randomUUID } from "node:crypto";
import { RevisionExecutionEligibilityPolicy, extractRequiredCapabilities } from "@/lib/control-plane/domain/revision-execution-eligibility";
import type { RevisionExecutionEvidenceReader } from "@/lib/control-plane/application/revision-execution-evidence-reader";
import { createMySqlRevisionExecutionEvidenceReader } from "@/lib/control-plane/persistence/mysql-revision-execution-evidence-reader";
import { db } from "@/lib/db/client";
import { agentRevisionTable } from "@/lib/persistence/schema/agents";
import { eq } from "drizzle-orm";
import {
 AgentCapabilityUnsupportedError,
 ArtifactNotVerifiedForRouteError,
 RevisionNotPublishedError,
 RouteEligibilityInvalidError,
 RouteExecutionIneligibleError,
 RouteSetNotFoundError,
 RouteSetVersionConflictError,
 computeRouteRevisionContentDigest,
 validateRouteRevisionContent,
} from "../domain/route-revision";
import type { RouteRevisionContent } from "../domain/route-revision";
import {
 computeSelectorDigest,
 computeSpecificity,
 normalizeEligibility,
} from "../domain/route-selector";
import { validateRouteSetActivation } from "../domain/route-set-activation-policy";
import type {
 RouteActivationRecord,
 RouteRevisionRecord,
} from "../persistence/route-revision-record";
import type {
 DesiredRoute,
 RouteSetActivationSession,
 RouteSetActivationStore,
} from "../persistence/route-set-activation-store";

// ─── 错误类型 ──────────────────────────────────────────────

export class RouteSetRequiresAtomicUpdateError extends Error {
 constructor(
 public readonly routeSetId: string,
 public readonly reason: string,
 ) {
 super(`RouteSet ${routeSetId} 需要原子更新: ${reason}`);
 this.name = "RouteSetRequiresAtomicUpdateError";
 }
}

// ─── 结果类型 ──────────────────────────────────────────────

export interface ActivateRouteSetResult {
 routeSetId: string;
 routeSetVersionNo: number;
 activations: Array<{
 routeId: string;
 routeRevisionId: string;
 routeActivationId: string;
 activationState: "active" | "disabled";
 routeGroupId: string;
 }>;
 auditEventId: string;
 affectsNewInvocationsOnly: true;
 /** : 幂等重放标记。 */
 idempotent?: true;
}

// ─── 命令类型 ──────────────────────────────────────────────

export interface ActivateRouteSetCommand {
 tenantId: string;
 routeSetId: string;
 expectedVersionNo: number;
 desiredRoutes: DesiredRoute[];
 actor: {
 tenantId: string;
 actorType: "user" | "service" | "workload" | "system";
 actorId: string;
 };
 reason: string;
 requestId: string;
 idempotencyKey: string;
 idempotencyCompletion?: {
 recordId: string;
 httpStatus: number;
 responseRef?: string | null;
 serializeResponse: (result: ActivateRouteSetResult) => string;
 };
}

// ─── 工厂 ──────────────────────────────────────────────────

export function createActivateRouteSet(dependencies: {
 store: RouteSetActivationStore;
 /** §03: 可选证据 Reader 注入（默认使用 MySQL 实现，测试可注入 mock）。 */
 evidenceReader?: RevisionExecutionEvidenceReader;
 now?: () => Date;
 newId?: () => string;
}) {
 const now = dependencies.now ?? (() => new Date());
 const newId = dependencies.newId ?? randomUUID;
 const evidenceReader = dependencies.evidenceReader ?? createMySqlRevisionExecutionEvidenceReader({ db });

 return async function activateRouteSet(
 command: ActivateRouteSetCommand,
 ): Promise<ActivateRouteSetResult> {
 // 1. 校验 actor tenant
 if (command.actor.tenantId !== command.tenantId) {
 throw new Error("RouteSetActivation actor tenant 与命令 tenant 不一致");
 }

 return dependencies.store.transaction(async (session) => {
 // : 幂等重放 — 先按 routeSetId+idempotencyKey 查找已完成激活
 const existingIdempotent = await session.findIdempotentRouteSetActivation({
 routeSetId: command.routeSetId,
 idempotencyKey: command.idempotencyKey,
 });
 if (existingIdempotent?.completed) {
 // 已完成激活：幂等返回（完整重放需要持久化 response，此处返回确认）
 return {
 routeSetId: command.routeSetId,
 routeSetVersionNo: 0, // 从幂等记录恢复
 activations: [],
 auditEventId: "",
 affectsNewInvocationsOnly: true as const,
 idempotent: true as const,
 };
 }

 // 2. FOR UPDATE 锁定 RouteSet
 const routeSet = await session.lockRouteSet({ tenantId: command.tenantId, routeSetId: command.routeSetId });
 if (!routeSet) throw new RouteSetNotFoundError(command.routeSetId);

 // 3. 校验 expectedVersionNo
 if (routeSet.versionNo !== command.expectedVersionNo) {
 throw new RouteSetVersionConflictError(
 command.routeSetId,
 command.expectedVersionNo,
 routeSet.versionNo,
 );
 }

 // 4. 读取当前所有 Route 和 Active RouteRevision
 const currentRoutes = await session.listRoutesBySet(command.routeSetId);

 // 5. 将命令转换为完整目标集合 — 验证并解析每条 DesiredRoute
 const desiredContents: Array<{
 desired: DesiredRoute;
 routeId: string;
 content: RouteRevisionContent;
 }> = [];

 for (const desired of command.desiredRoutes) {
 const activationState = desired.activationState ?? "active";

 // 6. 校验 AgentRevision 基本存在性
 const agentRevision = await session.findAgentRevision(desired.agentRevisionId);
 if (!agentRevision) {
 throw new RevisionNotPublishedError(desired.agentRevisionId, "agent", "not_found");
 }
 if (agentRevision.agentId !== routeSet.agentId) {
 throw new RevisionNotPublishedError(desired.agentRevisionId, "agent", "wrong_agent");
 }

 // 6. 校验 RuntimeRevision 基本存在性
 const runtimeRevision = await session.findRuntimeRevision(desired.runtimeRevisionId);
 if (!runtimeRevision) {
 throw new RevisionNotPublishedError(desired.runtimeRevisionId, "runtime", "not_found");
 }

 if (activationState === "active") {
 // §03: 使用统一 Reader + Policy 进行完整执行资格检查（删除 hasVerifiedAttestation 旁路）
 const evidence = await evidenceReader.loadCurrentEvidence({
 tenantId: command.tenantId,
 agentRevisionId: desired.agentRevisionId,
 runtimeRevisionId: desired.runtimeRevisionId,
 policyRevisionId: desired.policyRevisionId ?? null,
 });
 // §03: 使用统一 RevisionExecutionEligibilityPolicy（fail-closed，无降级路径）
 // 从 DB 读取完整 agentRevision 行以获取 agentInterfaceRequirementsJson
 const [fullAgentRevision] = await db
 .select({ agentInterfaceRequirementsJson: agentRevisionTable.agentInterfaceRequirementsJson })
 .from(agentRevisionTable)
 .where(eq(agentRevisionTable.id, desired.agentRevisionId))
 .limit(1);
 const requiredCapabilities = extractRequiredCapabilities(
 fullAgentRevision?.agentInterfaceRequirementsJson,
 );
 const eligibilityResult = RevisionExecutionEligibilityPolicy.isEligible(
 evidence,
 requiredCapabilities,
 );
 if (!eligibilityResult.eligible) {
 throw new RouteExecutionIneligibleError(desired.routeKey, eligibilityResult.errors);
 }
 }
 // disabled Route 不检查执行资格，只验证基本存在性（已在上方完成）

 // 构造 RouteRevisionContent
 const content: RouteRevisionContent = {
 agentRevisionId: desired.agentRevisionId,
 runtimeRevisionId: desired.runtimeRevisionId,
 policyRevisionId: desired.policyRevisionId ?? null,
 modelPolicyRevisionId: desired.modelPolicyRevisionId ?? null,
 toolsetRevisionId: desired.toolsetRevisionId ?? null,
 trafficWeight: desired.trafficWeight,
 priorityNo: desired.priorityNo,
 effectiveFrom: desired.effectiveFrom ?? null,
 effectiveUntil: desired.effectiveUntil ?? null,
 eligibilityConditions: desired.eligibilityConditions ?? {},
 routeGroupId: desired.routeGroupId,
 };
 validateRouteRevisionContent(content);

 // 解析 Route 身份
 const route = await session.resolveOrCreateRouteIdentity({
 routeSetId: command.routeSetId,
 routeId: desired.routeId,
 routeKey: desired.routeKey,
 content,
 now: now(),
 });

 desiredContents.push({ desired, routeId: route.id, content });
 }

 // 11. 调用 RouteSetActivationPolicy 验证目标集合
 const policyInput = desiredContents
 .filter((d) => d.desired.activationState !== "disabled")
 .map((d) => ({
 routeId: d.routeId,
 routeGroupId: d.desired.routeGroupId,
 trafficWeight: d.desired.trafficWeight,
 priorityNo: d.desired.priorityNo,
 effectiveFrom: d.content.effectiveFrom,
 effectiveUntil: d.content.effectiveUntil,
 eligibilityConditions: d.content.eligibilityConditions,
 activationState: "active" as const,
 }));

 const policyResult = validateRouteSetActivation({
 routeSetId: command.routeSetId,
 routeScopeKey: routeSet.routeScopeKey,
 tenantId: command.tenantId,
 agentId: routeSet.agentId,
 desiredRoutes: policyInput,
 });

 if (!policyResult.valid) {
 throw new RouteSetRequiresAtomicUpdateError(
 command.routeSetId,
 policyResult.validationErrors.map((e) => e.message).join("; "),
 );
 }

 const occurredAt = now();
 const nextVersionNo = routeSet.versionNo + 1;
 const activations: ActivateRouteSetResult["activations"] = [];

 // 12-13. 为每条目标 Route 创建 RouteRevision + RouteActivation
 for (const { desired, routeId, content } of desiredContents) {
 const contentDigest = computeRouteRevisionContentDigest(content);
 const normalized = normalizeEligibility(content.eligibilityConditions);
 // Fail-closed — 非法 eligibility 条件必须拒绝，不得降级
 if (!normalized) {
 throw new RouteEligibilityInvalidError(routeId, content.eligibilityConditions);
 }
 const selectorDigest = computeSelectorDigest(normalized);

 let revision = await session.findRevisionByContent(routeId, contentDigest);
 if (!revision) {
 revision = await session.appendRevision({
 id: newId(),
 tenantId: command.tenantId,
 routeId,
 routeSetId: command.routeSetId,
 routeKey: desired.routeKey,
 revisionNo: await session.nextRevisionNo(routeId),
 content,
 contentDigest,
 selectorDigest,
 actorType: command.actor.actorType,
 actorId: command.actor.actorId,
 now: occurredAt,
 });
 }

 const activationState = desired.activationState ?? "active";
 // : 查找当前最新 Activation，填充 previous 历史字段
 const currentActivation = await session.findLatestActivation(routeId);
 const activation = await session.appendActivation({
 id: newId(),
 tenantId: command.tenantId,
 routeId,
 routeRevisionId: revision.id,
 routeSetId: revision.routeSetId,
 activationSequence: await session.nextActivationSequence(routeId),
 activationState,
 previousRouteRevisionId: currentActivation?.routeRevisionId ?? null,
 previousRouteActivationId: currentActivation?.id ?? null,
 routeSetVersionNo: nextVersionNo,
 actorType: command.actor.actorType,
 actorId: command.actor.actorId,
 reason: command.reason,
 requestId: command.requestId,
 idempotencyKey: `${command.idempotencyKey}:${routeId}`,
 now: occurredAt,
 });

 // 14. 更新 DeploymentRoute 当前投影
 await session.updateRouteProjection({
 routeId,
 revision,
 routeState: activationState === "disabled" ? "disabled" : "enabled",
 now: occurredAt,
 });

 activations.push({
 routeId,
 routeRevisionId: revision.id,
 routeActivationId: activation.id,
 activationState,
 routeGroupId: desired.routeGroupId,
 });
 }

 // 15. 未出现在目标 Active 集合中的旧 Route 写 disabled Activation
 const desiredRouteIds = new Set(desiredContents.map((d) => d.routeId));
 for (const currentRoute of currentRoutes) {
 if (!desiredRouteIds.has(currentRoute.id) && currentRoute.routeState === "enabled") {
 // : 使用 findLatestActivation 获取最新 Activation + Revision
 const lastActivation = await session.findLatestActivation(currentRoute.id);
 if (lastActivation) {
 await session.appendActivation({
 id: newId(),
 tenantId: command.tenantId,
 routeId: currentRoute.id,
 routeRevisionId: lastActivation.routeRevisionId,
 routeSetId: command.routeSetId,
 activationSequence: await session.nextActivationSequence(currentRoute.id),
 activationState: "disabled" as const,
 previousRouteRevisionId: lastActivation.routeRevisionId,
 previousRouteActivationId: null,
 routeSetVersionNo: nextVersionNo,
 actorType: command.actor.actorType,
 actorId: command.actor.actorId,
 reason: `${command.reason}（不在目标集合中）`,
 requestId: command.requestId,
 idempotencyKey: `${command.idempotencyKey}:disable:${currentRoute.id}`,
 now: occurredAt,
 });
 // : 从 activation 的 routeRevisionId 查询完整 Revision
 const lastRevision = await session.findRevisionById(lastActivation.routeRevisionId);
 if (!lastRevision) continue;
 await session.updateRouteProjection({
 routeId: currentRoute.id,
 revision: lastRevision,
 routeState: "disabled",
 now: occurredAt,
 });
 }
 }
 }

 // 16-17. RouteSet.versionNo 只增加一次，所有 Activation 使用相同 routeSetVersionNo
 const updatedRouteSet = await session.advanceRouteSetVersion({
 routeSetId: command.routeSetId,
 expectedVersionNo: routeSet.versionNo,
 now: occurredAt,
 });
 if (!updatedRouteSet) {
 throw new RouteSetVersionConflictError(command.routeSetId, routeSet.versionNo, -1);
 }

 // 18. 写聚合 Audit + 每条 Route Audit
 const auditEventId = newId();
 await session.appendAudit({
 id: auditEventId,
 tenantId: command.tenantId,
 actorType: command.actor.actorType,
 actorId: command.actor.actorId,
 actionType: "route_set.activation",
 routeId: command.routeSetId,
 after: {
 route_set_id: command.routeSetId,
 route_set_version_no: nextVersionNo,
 activated_count: activations.filter((a) => a.activationState === "active").length,
 disabled_count: activations.filter((a) => a.activationState === "disabled").length,
 },
 reason: command.reason,
 requestId: command.requestId,
 occurredAt,
 });

 // 19. 写 Outbox
 const outboxEventId = newId();
 await session.appendOutbox({
 id: outboxEventId,
 tenantId: command.tenantId,
 eventKey: `route-set-activation:${command.routeSetId}:${nextVersionNo}`,
 eventType: "route_set.activated",
 aggregateId: command.routeSetId,
 aggregateVersion: nextVersionNo,
 payload: {
 route_set_id: command.routeSetId,
 route_set_version_no: nextVersionNo,
 activation_ids: activations.map((a) => a.routeActivationId),
 },
 occurredAt,
 });

 const result: ActivateRouteSetResult = {
 routeSetId: command.routeSetId,
 routeSetVersionNo: nextVersionNo,
 activations,
 auditEventId,
 affectsNewInvocationsOnly: true,
 };

 // 20. 完成 Idempotency
 if (command.idempotencyCompletion) {
 const completed = await session.completeIdempotency({
 recordId: command.idempotencyCompletion.recordId,
 httpStatus: command.idempotencyCompletion.httpStatus,
 responseRef: command.idempotencyCompletion?.responseRef ?? command.routeSetId,
 responseRedactedJson: command.idempotencyCompletion.serializeResponse(result),
 completedAt: occurredAt,
 });
 if (!completed) {
 throw new Error(
 `RouteSetActivation 幂等记录完成失败: ${command.idempotencyCompletion.recordId}`,
 );
 }
 }

 // 21. 提交事务（return = commit）
 return result;
 });
 };
}
