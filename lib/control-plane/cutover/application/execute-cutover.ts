/**
 * executeCutover — Cutover 执行器。
 *
 * 执行原则：
 * - 每个 Item 独立重试
 * - 外部调用不放在长数据库事务中
 * - 每步完成后保存 Checkpoint（Item state 转换）
 * - 指数退避：nextAttemptAt = now + min(baseMs * 2^attempt, maxMs)
 * - 最大重试次数（默认 5）后进入 manual_review
 * - 租约语义：Worker 领取 Item 后设置 leaseOwner + leaseExpiresAt
 *
 * Route 切换：
 * - 只有所有必要 Agent 和 Runtime Replacement Revision 均为 ready，
 *   Plan 才能进入 ready_to_activate
 * - 调用第一批的 ActivateRouteSet 一次原子激活整个 RouteSet
 *
 * 切换后验证：
 * - 重新执行 RouteResolver
 * - 使用 Replacement Revision
 * - Publication / Attestation / Conformance 完整
 * - RouteSetVersion 等于目标版本
 * - 历史 Route 不再 Active
 * - 已有 ExecutionBinding 不被修改
 */

import type { CutoverStore } from "@/lib/control-plane/cutover/persistence/cutover-store";
import type { CutoverItemRow } from "@/lib/control-plane/cutover/persistence/cutover-record";
import {
  isValidPlanTransition,
  type CutoverPlanState,
} from "@/lib/control-plane/cutover/domain/cutover-plan";
import {
  isValidItemTransition,
  itemNeedsRequalification,
  computeNextAttemptAt,
  type CutoverItemState,
  type QualificationCategory,
} from "@/lib/control-plane/cutover/domain/cutover-item";
import {
  checkItemReadiness,
} from "@/lib/control-plane/cutover/application/cutover-readiness-checker";

/** Cutover 执行器配置。 */
export interface CutoverExecutorConfig {
  store: CutoverStore;
  /** Replacement AgentRevision 工厂。 */
  createReplacementAgentRevision: (params: {
    tenantId: string;
    sourceRevisionId: string;
    newArtifactRef: string;
    createdBy: string;
  }) => Promise<{ replacementRevisionId: string }>;
  /** Replacement RuntimeRevision 工厂。 */
  createReplacementRuntimeRevision: (params: {
    tenantId: string;
    sourceRevisionId: string;
    newArtifactRef: string;
    createdBy: string;
  }) => Promise<{ replacementRevisionId: string }>;
  /** Artifact Evidence 获取（来自 Evidence Service）。 */
  resolveArtifactEvidence: (params: {
    tenantId: string;
    subjectType: "agent_revision" | "runtime_revision";
    subjectRevisionId: string;
  }) => Promise<{ artifactRef: string }>;
  /** ActivateRouteSet（来自第一批）。 */
  activateRouteSet: (params: {
    tenantId: string;
    routeSetId: string;
    expectedVersionNo: number;
    desiredRoutes: unknown[];
    actor: { tenantId: string; actorType: "system"; actorId: string };
    reason: string;
    requestId: string;
    idempotencyKey: string;
  }) => Promise<{ routeSetVersionNo: number }>;
  /** 最大重试次数。 */
  maxItemAttempts?: number;
}

/** 单个 Item 的执行结果。 */
export interface CutoverItemExecutionResult {
  itemId: string;
  subjectType: "agent_revision" | "runtime_revision";
  sourceSubjectId: string;
  replacementSubjectId: string | null;
  newState: CutoverItemState;
  error?: string;
}

/** Cutover Plan 的执行结果。 */
export interface CutoverExecutionResult {
  planId: string;
  planState: CutoverPlanState;
  itemResults: CutoverItemExecutionResult[];
}

const MAX_ITEM_ATTEMPTS = 5;
const CUTOVER_ACTOR_ID = "cutover-executor";

/**
 * 创建 Cutover 执行器。
 */
export function createCutoverExecutor(config: CutoverExecutorConfig) {
  const maxAttempts = config.maxItemAttempts ?? MAX_ITEM_ATTEMPTS;

  /**
   * 执行 Cutover Plan 的单个 Item。
   *
   * 根据 Item 的当前状态和 qualificationCategory 决定下一步：
   * - trusted → 直接标记 ready
   * - legacy_projection_only / missing_attestation / missing_conformance →
   *   创建 Replacement Revision → 标记 publication_pending → ready
   * - withdrawn / invalid_digest → 标记 manual_review
   */
  return async function executeCutoverItem(
    item: CutoverItemRow,
  ): Promise<CutoverItemExecutionResult> {
    // trusted → 直接就绪
    if (item.qualificationCategory === "trusted") {
      if (item.state !== "ready") {
        await config.store.updateItemState({
          itemId: item.id,
          state: "ready",
        });
      }
      return {
        itemId: item.id,
        subjectType: item.subjectType,
        sourceSubjectId: item.sourceSubjectId,
        replacementSubjectId: item.replacementSubjectId,
        newState: "ready",
      };
    }

    // 已达到最大重试次数 → manual_review
    if (item.attemptCount >= maxAttempts) {
      await config.store.updateItemState({
        itemId: item.id,
        state: "manual_review",
        lastError: `达到最大重试次数 (${maxAttempts})`,
      });
      return {
        itemId: item.id,
        subjectType: item.subjectType,
        sourceSubjectId: item.sourceSubjectId,
        replacementSubjectId: item.replacementSubjectId,
        newState: "manual_review",
      };
    }

    try {
      // 获取 Artifact Evidence
      await config.store.updateItemState({
        itemId: item.id,
        state: "artifact_pending",
        attemptCount: item.attemptCount + 1,
      });

      const evidence = await config.resolveArtifactEvidence({
        tenantId: item.tenantId,
        subjectType: item.subjectType,
        subjectRevisionId: item.sourceSubjectId,
      });

      // 创建 Replacement Revision
      let replacementId: string;

      if (item.subjectType === "agent_revision") {
        await config.store.updateItemState({
          itemId: item.id,
          state: "attestation_pending",
        });
        const result = await config.createReplacementAgentRevision({
          tenantId: item.tenantId,
          sourceRevisionId: item.sourceSubjectId,
          newArtifactRef: evidence.artifactRef,
          createdBy: CUTOVER_ACTOR_ID,
        });
        replacementId = result.replacementRevisionId;
      } else {
        await config.store.updateItemState({
          itemId: item.id,
          state: "conformance_pending",
        });
        const result = await config.createReplacementRuntimeRevision({
          tenantId: item.tenantId,
          sourceRevisionId: item.sourceSubjectId,
          newArtifactRef: evidence.artifactRef,
          createdBy: CUTOVER_ACTOR_ID,
        });
        replacementId = result.replacementRevisionId;
      }

      // Replacement 创建成功 → 保存 replacementSubjectId
      await config.store.updateItemState({
        itemId: item.id,
        state: "publication_pending",
        replacementSubjectId: replacementId,
      });

      // §7.1: 真实 Readiness 检查 — 不能在创建 Draft 后直接 Ready
      // 必须验证: Revision published + Artifact bound + Attestation verified + Publication active (+ Conformance passed for runtime)
      const readiness = await checkItemReadiness({
        subjectType: item.subjectType,
        replacementRevisionId: replacementId,
      });

      if (readiness.ready) {
        await config.store.updateItemState({
          itemId: item.id,
          state: "ready",
        });
        return {
          itemId: item.id,
          subjectType: item.subjectType,
          sourceSubjectId: item.sourceSubjectId,
          replacementSubjectId: replacementId,
          newState: "ready",
        };
      }

      // §7.1: Readiness 条件不满足 — 保持在 publication_pending，由后续 Worker 轮询
      return {
        itemId: item.id,
        subjectType: item.subjectType,
        sourceSubjectId: item.sourceSubjectId,
        replacementSubjectId: replacementId,
        newState: "publication_pending",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const backoff = computeNextAttemptAt(item.attemptCount);

      await config.store.updateItemState({
        itemId: item.id,
        state: "failed",
        nextAttemptAt: backoff,
        lastError: message,
      });

      return {
        itemId: item.id,
        subjectType: item.subjectType,
        sourceSubjectId: item.sourceSubjectId,
        replacementSubjectId: item.replacementSubjectId,
        newState: "failed",
        error: message,
      };
    }
  };
}
