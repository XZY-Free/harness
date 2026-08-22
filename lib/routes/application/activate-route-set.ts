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
import type { RevisionExecutionEvidenceReader } from "@/lib/control-plane/application/revision-execution-evidence-reader";
import {
  RevisionExecutionEligibilityPolicy,
  extractRequiredCapabilities,
} from "@/lib/control-plane/domain/revision-execution-eligibility";
import { createMySqlRevisionExecutionEvidenceReader } from "@/lib/control-plane/persistence/mysql-revision-execution-evidence-reader";
import { agentRevisionTable } from "@/lib/persistence/schema/agents";
import { eq } from "drizzle-orm";
import {
  AgentCapabilityUnsupportedError,
  ArtifactNotVerifiedForRouteError,
  RevisionNotPublishedError,
  RouteEligibilityInvalidError,
  RouteExecutionIneligibleError,
  RouteIdempotencyCompletionError,
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
    previousRouteRevisionId: string | null;
    previousRouteActivationId: string | null;
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
  /**
   * §04: 可选证据 Reader 注入（仅用于测试 mock）。
   * 生产路径始终从事务内创建 MySQL Evidence Reader。
   */
  evidenceReaderForTest?: RevisionExecutionEvidenceReader;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  return async function activateRouteSet(
    command: ActivateRouteSetCommand,
  ): Promise<ActivateRouteSetResult> {
    // 1. 校验 actor tenant
    if (command.actor.tenantId !== command.tenantId) {
      throw new Error("RouteSetActivation actor tenant 与命令 tenant 不一致");
    }

    return dependencies.store.transaction(async (session) => {
      // §04: 事务级 Evidence Reader — 生产路径从事务内创建，测试可注入 mock
      const evidenceReader: RevisionExecutionEvidenceReader =
        dependencies.evidenceReaderForTest ??
        createMySqlRevisionExecutionEvidenceReader({ db: session.getDbOrTx() });
      // 2. FOR UPDATE 锁定 RouteSet
      const routeSet = await session.lockRouteSet({
        tenantId: command.tenantId,
        routeSetId: command.routeSetId,
      });
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

        // 6. 校验 AgentRevision 基本存在性（无 Agent 约束 → 基础 Harness Route，跳过 Agent 校验）
        const hasAgentConstraint = desired.agentRevisionId !== null;
        if (hasAgentConstraint) {
          const agentRevision = await session.findAgentRevision(desired.agentRevisionId as string);
          if (!agentRevision) {
            throw new RevisionNotPublishedError(desired.agentRevisionId as string, "agent", "not_found");
          }
          if (agentRevision.agentId !== routeSet.agentId) {
            throw new RevisionNotPublishedError(desired.agentRevisionId as string, "agent", "wrong_agent");
          }
        }

        // 6. 校验 RuntimeRevision 基本存在性
        const runtimeRevision = await session.findRuntimeRevision(desired.runtimeRevisionId);
        if (!runtimeRevision) {
          throw new RevisionNotPublishedError(desired.runtimeRevisionId, "runtime", "not_found");
        }

        if (activationState === "active") {
          // §03: 使用统一 Reader + Policy 进行完整执行资格检查（删除 hasVerifiedAttestation 旁路）
          // 无 Agent 约束 → Reader/Policy 内部跳过 Agent 维度（not_applicable，§18）。
          const evidence = await evidenceReader.loadCurrentEvidence({
            tenantId: command.tenantId,
            agentRevisionId: desired.agentRevisionId,
            runtimeRevisionId: desired.runtimeRevisionId,
            policyRevisionId: desired.policyRevisionId ?? null,
          });
          // §03: 使用统一 RevisionExecutionEligibilityPolicy（fail-closed，无降级路径）
          // §04: 从同一事务读取 agentInterfaceRequirementsJson（无 Agent 约束时为 null）
          let requiredCapabilities: string[] = [];
          if (hasAgentConstraint) {
            const [fullAgentRevision] = await session
              .getDbOrTx()
              .select({
                agentInterfaceRequirementsJson: agentRevisionTable.agentInterfaceRequirementsJson,
              })
              .from(agentRevisionTable)
              .where(eq(agentRevisionTable.id, desired.agentRevisionId as string))
              .limit(1);
            requiredCapabilities = extractRequiredCapabilities(
              fullAgentRevision?.agentInterfaceRequirementsJson,
            );
          }
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
        if (
          currentActivation &&
          (currentActivation.tenantId !== command.tenantId ||
            currentActivation.routeId !== routeId ||
            currentActivation.routeSetId !== command.routeSetId)
        ) {
          throw new Error(`历史 Activation 与当前 Route authority 不一致: ${currentActivation.id}`);
        }
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
          previousRouteRevisionId: activation.previousRouteRevisionId,
          previousRouteActivationId: activation.previousRouteActivationId,
        });
      }

      // 15. 未出现在目标 Active 集合中的旧 Route 写 disabled Activation
      const desiredRouteIds = new Set(desiredContents.map((d) => d.routeId));
      for (const currentRoute of currentRoutes) {
        if (!desiredRouteIds.has(currentRoute.id) && currentRoute.routeState === "enabled") {
          // : 使用 findLatestActivation 获取最新 Activation + Revision
          const lastActivation = await session.findLatestActivation(currentRoute.id);
          if (!lastActivation) {
            throw new Error(`隐式禁用 Route ${currentRoute.id} 时找不到历史 Activation`);
          }
          if (
            lastActivation.tenantId !== command.tenantId ||
            lastActivation.routeId !== currentRoute.id ||
            lastActivation.routeSetId !== command.routeSetId
          ) {
            throw new Error(`历史 Activation 与当前 Route authority 不一致: ${lastActivation.id}`);
          }
          // : 从 activation 的 routeRevisionId 查询完整 Revision
          const lastRevision = await session.findRevisionById(lastActivation.routeRevisionId);
          if (!lastRevision) {
            throw new Error(
              `隐式禁用 Route ${currentRoute.id} 时找不到历史 Revision ${lastActivation.routeRevisionId}`,
            );
          }
          if (
            lastRevision.tenantId !== command.tenantId ||
            lastRevision.routeId !== currentRoute.id ||
            lastRevision.routeSetId !== command.routeSetId
          ) {
            throw new Error(`历史 Revision 与当前 Route authority 不一致: ${lastRevision.id}`);
          }
          const activation = await session.appendActivation({
            id: newId(),
            tenantId: command.tenantId,
            routeId: currentRoute.id,
            routeRevisionId: lastActivation.routeRevisionId,
            routeSetId: command.routeSetId,
            activationSequence: await session.nextActivationSequence(currentRoute.id),
            activationState: "disabled" as const,
            previousRouteRevisionId: lastActivation.routeRevisionId,
            previousRouteActivationId: lastActivation.id,
            routeSetVersionNo: nextVersionNo,
            actorType: command.actor.actorType,
            actorId: command.actor.actorId,
            reason: `${command.reason}（不在目标集合中）`,
            requestId: command.requestId,
            idempotencyKey: `${command.idempotencyKey}:disable:${currentRoute.id}`,
            now: occurredAt,
          });
          await session.updateRouteProjection({
            routeId: currentRoute.id,
            revision: lastRevision,
            routeState: "disabled",
            now: occurredAt,
          });
          activations.push({
            routeId: currentRoute.id,
            routeRevisionId: lastRevision.id,
            routeActivationId: activation.id,
            activationState: "disabled",
            routeGroupId: lastRevision.routeGroupId,
            previousRouteRevisionId: activation.previousRouteRevisionId,
            previousRouteActivationId: activation.previousRouteActivationId,
          });
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
          route_ids: activations.map((activation) => activation.routeId),
          activation_ids: activations.map((activation) => activation.routeActivationId),
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
          tenant_id: command.tenantId,
          route_ids: activations.map((a) => a.routeId),
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
          tenantId: command.tenantId,
          commandScope: `route_set.activate:${command.routeSetId}`,
          httpStatus: command.idempotencyCompletion.httpStatus,
          responseRef: command.idempotencyCompletion?.responseRef ?? command.routeSetId,
          responseRedactedJson: command.idempotencyCompletion.serializeResponse(result),
          completedAt: occurredAt,
        });
        if (!completed) {
          throw new RouteIdempotencyCompletionError(command.idempotencyCompletion.recordId);
        }
      }

      // 21. 提交事务（return = commit）
      return result;
    });
  };
}
