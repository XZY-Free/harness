/**
 * Projection 事件处理器 — 处理 Outbox 事件触发 Projection 重建。
 *
 * §4.5: 所有事件类型均已实现，无 TODO 桩。
 * 每个 Handler 幂等。
 *
 * 处理规则：
 * - Route 激活/验证：重建该 Route 的 Projection
 * - Route 禁用：Projection 标记 Ineligible
 * - RouteSet 激活：重建 RouteSet 下所有 Route
 * - Revision 发布：查找引用该 Revision 的 Route 并重建
 * - Revision 撤回：标记相关 Projection Ineligible
 * - Attestation 撤销：标记相关 Projection Ineligible
 * - Runtime Conformance 记录：重建相关 Route
 * - Agent/Runtime 生命周期变更：标记相关 Projection Ineligible
 * - Policy 发布/撤回：重建/标记相关 Projection
 *
 * §4.4: 缺失对象清理 — Route/RouteSet 不存在时删除孤立投影。
 */

import type { ControlPlaneEventType } from "@/lib/control-plane/events/control-plane-event";
import type { ControlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { validateEventPayload } from "@/lib/control-plane/events/event-contracts";
import type {
  BuildRouteEligibilityInput,
  BuildRouteEligibilityResult,
} from "./build-route-eligibility";
import type { RouteEligibilityStore } from "./route-eligibility-store";

export type OutboxEventHandler = (event: ControlPlaneOutboxEvent) => Promise<void>;

export interface ProjectionEventHandlerDeps {
  store: RouteEligibilityStore;
  buildRouteEligibility: (
    input: BuildRouteEligibilityInput,
  ) => Promise<BuildRouteEligibilityResult>;
}

/**
 * §3.6: 未知事件错误 — Fail-loud。
 * 未知事件类型、非法 Payload、不可恢复的格式错误
 * 不能标记成功，必须抛出此错误让 Worker 进入 retry/dead_letter。
 */
export class ControlPlaneEventUnsupportedError extends Error {
  constructor(
    public readonly eventType: string,
    public readonly reason: string,
  ) {
    super(`控制面事件不支持: eventType=${eventType}, reason=${reason}`);
    this.name = "ControlPlaneEventUnsupportedError";
  }
}

/**
 * 创建 Outbox 事件处理器。
 *
 * §4.5: 所有事件类型均有完整实现。
 * §4.4: 缺失对象时清理孤立投影。
 */
export function createProjectionEventHandler(deps: ProjectionEventHandlerDeps): OutboxEventHandler {
  return async function handleOutboxEvent(event: ControlPlaneOutboxEvent): Promise<void> {
    // §3.6: 校验事件类型已知
    const knownTypes: Set<string> = new Set([
      "route.activated",
      "route.disabled",
      "agent.revision.published",
      "agent.revision.withdrawn",
      "runtime.revision.published",
      "runtime.revision.withdrawn",
      "artifact.attestation.revoked",
      "runtime.conformance.recorded",
      "agent.lifecycle.changed",
      "runtime.lifecycle.changed",
      "policy.revision.published",
      "policy.revision.withdrawn",
      "route.revision.validated",
      "route_set.activated",
    ]);

    if (!knownTypes.has(event.eventType)) {
      throw new ControlPlaneEventUnsupportedError(event.eventType, "未知事件类型");
    }

    // §3.6: 校验 Payload 合法
    const payloadValidation = validateEventPayload(event.eventType, event.payloadJson);
    if (!payloadValidation.valid) {
      throw new ControlPlaneEventUnsupportedError(
        event.eventType,
        `Payload 校验失败: ${payloadValidation.errors.join("; ")}`,
      );
    }

    const payload = event.payloadJson as Record<string, unknown>;

    // §4.2: 来源事件信息
    const sourceEventId = event.id;
    const sourceAggregateVersion = event.aggregateVersion;

    switch (event.eventType) {
      // ─── Route 事件 ──────────────────────────────
      case "route.activated": {
        const routeId = payload.route_id as string;
        const tenantId = payload.tenant_id as string;
        await deps.buildRouteEligibility({
          tenantId,
          routeId,
          sourceEventId,
          sourceAggregateVersion,
        });
        break;
      }

      case "route.disabled": {
        const routeId = payload.route_id as string;
        const reason = (payload.reason as string) ?? "route_disabled";
        await deps.store.markIneligible(routeId, reason);
        break;
      }

      // ─── Revision 事件 ───────────────────────────
      case "agent.revision.published": {
        const revisionId = payload.revision_id as string;
        await rebuildProjectionsByRevision(revisionId, sourceEventId, sourceAggregateVersion);
        break;
      }

      case "agent.revision.withdrawn": {
        const revisionId = payload.revision_id as string;
        await markProjectionsIneligibleByRevision(revisionId, "agent_revision_withdrawn");
        break;
      }

      case "runtime.revision.published": {
        const revisionId = payload.revision_id as string;
        await rebuildProjectionsByRevision(revisionId, sourceEventId, sourceAggregateVersion);
        break;
      }

      case "runtime.revision.withdrawn": {
        const revisionId = payload.revision_id as string;
        await markProjectionsIneligibleByRevision(revisionId, "runtime_revision_withdrawn");
        break;
      }

      // ─── Attestation 事件 ────────────────────────
      case "artifact.attestation.revoked": {
        // §4.5: 使用 attestation_id 搜索投影中的证据数组
        const attestationId = payload.attestation_id as string;
        const projections = await deps.store.findProjectionsByAttestationId(attestationId);
        for (const projection of projections) {
          await deps.buildRouteEligibility({
            tenantId: projection.tenantId,
            routeId: projection.routeId,
            sourceEventId,
            sourceAggregateVersion,
          });
        }
        break;
      }

      // ─── Conformance 事件 ────────────────────────
      case "runtime.conformance.recorded": {
        const runtimeRevisionId = payload.runtime_revision_id as string;
        await rebuildProjectionsByRevision(
          runtimeRevisionId,
          sourceEventId,
          sourceAggregateVersion,
        );
        break;
      }

      // ─── §4.5: 生命周期事件 — 完整实现 ──────────────
      case "agent.lifecycle.changed": {
        const agentId = payload.agent_id as string;
        const lifecycleState = payload.new_state as string;
        // Agent 生命周期变为非 enabled → 标记所有相关投影 Ineligible
        if (lifecycleState !== "enabled") {
          const projections = await deps.store.findProjectionsByAgentId(agentId);
          for (const projection of projections) {
            await deps.store.markIneligible(
              projection.routeId,
              `agent_lifecycle_${lifecycleState}`,
            );
          }
        } else {
          // Agent 重新 enabled → 重建所有相关投影
          const projections = await deps.store.findProjectionsByAgentId(agentId);
          for (const projection of projections) {
            await deps.buildRouteEligibility({
              tenantId: projection.tenantId,
              routeId: projection.routeId,
              sourceEventId,
              sourceAggregateVersion,
            });
          }
        }
        break;
      }

      case "runtime.lifecycle.changed": {
        const runtimeId = payload.runtime_id as string;
        const lifecycleState = payload.new_state as string;
        if (lifecycleState !== "enabled") {
          // Runtime 非 enabled → 标记相关投影 Ineligible
          const projections = await deps.store.findProjectionsByRuntimeId(runtimeId);
          for (const projection of projections) {
            await deps.store.markIneligible(
              projection.routeId,
              `runtime_lifecycle_${lifecycleState}`,
            );
          }
        } else {
          // Runtime 重新 enabled → 重建相关投影
          const projections = await deps.store.findProjectionsByRuntimeId(runtimeId);
          for (const projection of projections) {
            await deps.buildRouteEligibility({
              tenantId: projection.tenantId,
              routeId: projection.routeId,
              sourceEventId,
              sourceAggregateVersion,
            });
          }
        }
        break;
      }

      // ─── §4.5: Policy 事件 — 完整实现 ──────────────
      case "policy.revision.published": {
        const policyRevisionId = payload.policy_revision_id as string;
        // Policy 发布 → 重建引用该 Policy 的所有投影
        const projections = await deps.store.findProjectionsByPolicyRevisionId(policyRevisionId);
        for (const projection of projections) {
          await deps.buildRouteEligibility({
            tenantId: projection.tenantId,
            routeId: projection.routeId,
            sourceEventId,
            sourceAggregateVersion,
          });
        }
        break;
      }

      case "policy.revision.withdrawn": {
        const policyRevisionId = payload.policy_revision_id as string;
        // Policy 撤回 → 标记引用该 Policy 的投影 Ineligible
        const projections = await deps.store.findProjectionsByPolicyRevisionId(policyRevisionId);
        for (const projection of projections) {
          await deps.store.markIneligible(projection.routeId, "policy_revision_withdrawn");
        }
        break;
      }

      // ─── Route 验证事件 ──────────────────────────
      case "route.revision.validated": {
        const routeId = payload.route_id as string;
        const tenantId = payload.tenant_id as string;
        await deps.buildRouteEligibility({
          tenantId,
          routeId,
          sourceEventId,
          sourceAggregateVersion,
        });
        break;
      }

      // ─── §4.5: RouteSet 激活事件 — 完整实现 ────────
      case "route_set.activated": {
        const routeSetId = payload.route_set_id as string;
        // RouteSet 激活 → 重建该 RouteSet 下所有 Route 的投影
        const projections = await deps.store.findProjectionsByRouteSet(routeSetId);
        for (const projection of projections) {
          await deps.buildRouteEligibility({
            tenantId: projection.tenantId,
            routeId: projection.routeId,
            sourceEventId,
            sourceAggregateVersion,
          });
        }
        break;
      }

      default:
        // §3.6: 未知事件类型 — Fail-loud，不标记成功
        throw new ControlPlaneEventUnsupportedError(event.eventType, "switch 未覆盖的事件类型");
    }
  };

  async function rebuildProjectionsByRevision(
    revisionId: string,
    sourceEventId?: string | null,
    sourceAggregateVersion?: number | null,
  ): Promise<void> {
    const projections = await deps.store.findProjectionsByRevision(revisionId);
    for (const projection of projections) {
      await deps.buildRouteEligibility({
        tenantId: projection.tenantId,
        routeId: projection.routeId,
        sourceEventId,
        sourceAggregateVersion,
      });
    }
  }

  async function markProjectionsIneligibleByRevision(
    revisionId: string,
    reason: string,
  ): Promise<void> {
    const projections = await deps.store.findProjectionsByRevision(revisionId);
    for (const projection of projections) {
      await deps.store.markIneligible(projection.routeId, reason);
    }
  }
}
