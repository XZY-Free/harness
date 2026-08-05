/**
 * Projection 事件处理器 — 处理 Outbox 事件触发 Projection 重建。
 *
 * 每个 Handler 幂等。
 * 处理规则：
 * - Route 激活：重建该 Route
 * - Route 禁用：Projection 标记 Ineligible
 * - Revision 撤回：查找引用该 Revision 的 Route 并重建
 * - Attestation 撤销：查找 Publication 和 Route 并重建
 * - Runtime Conformance 记录：重建相关 Route
 * - Agent/Runtime 生命周期变更：相关 Route 全部 Ineligible
 * - Policy 发布/撤回：相关 Route 重建/Ineligible
 */

import type { ControlPlaneOutboxEvent } from "@/lib/agents/persistence/control-plane-outbox";
import type { RouteEligibilityStore } from "./route-eligibility-store";
import type { BuildRouteEligibilityInput, BuildRouteEligibilityResult } from "./build-route-eligibility";
import { validateEventPayload } from "@/lib/control-plane/events/event-contracts";
import type { ControlPlaneEventType } from "@/lib/control-plane/events/control-plane-event";

export interface OutboxEventHandler {
  (event: ControlPlaneOutboxEvent): Promise<void>;
}

export interface ProjectionEventHandlerDeps {
  store: RouteEligibilityStore;
  buildRouteEligibility: (input: BuildRouteEligibilityInput) => Promise<BuildRouteEligibilityResult>;
}

/**
 * §3.6: 未知事件错误 — Fail-loud。
 * 未知事件类型、非法 Payload、TODO 未实现处理逻辑
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
 * §3.6: 根据 eventType 分派到具体 Projection 重建逻辑。
 * 未知事件类型 → 抛 ControlPlaneEventUnsupportedError（Fail-loud）。
 * Payload 不合法 → 抛 ControlPlaneEventUnsupportedError（Fail-loud）。
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

    switch (event.eventType) {
      // ─── Route 事件 ──────────────────────────────
      case "route.activated": {
        const routeId = payload.routeId as string;
        const tenantId = payload.tenantId as string;
        await deps.buildRouteEligibility({ tenantId, routeId });
        break;
      }

      case "route.disabled": {
        const routeId = payload.routeId as string;
        const reason = (payload.reason as string) ?? "route_disabled";
        await deps.store.markIneligible(routeId, reason);
        break;
      }

      // ─── Revision 事件 ───────────────────────────
      case "agent.revision.published": {
        const revisionId = payload.revisionId as string;
        await rebuildProjectionsByRevision(revisionId);
        break;
      }

      case "agent.revision.withdrawn": {
        const revisionId = payload.revisionId as string;
        await markProjectionsIneligibleByRevision(revisionId, "agent_revision_withdrawn");
        break;
      }

      case "runtime.revision.published": {
        const revisionId = payload.revisionId as string;
        await rebuildProjectionsByRevision(revisionId);
        break;
      }

      case "runtime.revision.withdrawn": {
        const revisionId = payload.revisionId as string;
        await markProjectionsIneligibleByRevision(revisionId, "runtime_revision_withdrawn");
        break;
      }

      // ─── Attestation 事件 ────────────────────────
      case "artifact.attestation.revoked": {
        const revisionId = payload.revisionId as string;
        await markProjectionsIneligibleByRevision(revisionId, "attestation_revoked");
        break;
      }

      // ─── Conformance 事件 ────────────────────────
      case "runtime.conformance.recorded": {
        const runtimeRevisionId = payload.runtimeRevisionId as string;
        await rebuildProjectionsByRevision(runtimeRevisionId);
        break;
      }

      // ─── 生命周期事件 — §3.6: TODO 未实现 → Fail-loud ────
      case "agent.lifecycle.changed": {
        // §3.6: 未实现处理逻辑，Fail-loud
        throw new ControlPlaneEventUnsupportedError(
          event.eventType,
          "agent.lifecycle.changed 处理逻辑未实现（需 store.findProjectionsByAgentId）",
        );
      }

      case "runtime.lifecycle.changed": {
        // §3.6: 未实现处理逻辑，Fail-loud
        throw new ControlPlaneEventUnsupportedError(
          event.eventType,
          "runtime.lifecycle.changed 处理逻辑未实现（需 store.findProjectionsByRuntimeId）",
        );
      }

      // ─── Policy 事件 — §3.6: TODO 未实现 → Fail-loud ────
      case "policy.revision.published": {
        // §3.6: 未实现处理逻辑，Fail-loud
        throw new ControlPlaneEventUnsupportedError(
          event.eventType,
          "policy.revision.published 处理逻辑未实现（需 store.findProjectionsByPolicyRevisionId）",
        );
      }

      case "policy.revision.withdrawn": {
        // §3.6: 未实现处理逻辑，Fail-loud
        throw new ControlPlaneEventUnsupportedError(
          event.eventType,
          "policy.revision.withdrawn 处理逻辑未实现（需 store.findProjectionsByPolicyRevisionId）",
        );
      }

      // ─── Route 验证事件 ──────────────────────────
      case "route.revision.validated": {
        const routeId = payload.routeId as string;
        const tenantId = payload.tenantId as string;
        await deps.buildRouteEligibility({ tenantId, routeId });
        break;
      }

      default:
        // §3.6: 未知事件类型 — Fail-loud，不标记成功
        throw new ControlPlaneEventUnsupportedError(event.eventType, "switch 未覆盖的事件类型");
    }
  };

  async function rebuildProjectionsByRevision(revisionId: string): Promise<void> {
    const projections = await deps.store.findProjectionsByRevision(revisionId);
    for (const projection of projections) {
      await deps.buildRouteEligibility({
        tenantId: projection.tenantId,
        routeId: projection.routeId,
      });
    }
  }

  async function markProjectionsIneligibleByRevision(revisionId: string, reason: string): Promise<void> {
    const projections = await deps.store.findProjectionsByRevision(revisionId);
    for (const projection of projections) {
      await deps.store.markIneligible(projection.routeId, reason);
    }
  }

  // §3.6: 以下 helper 待 TODO 实现后恢复使用。
  // 当前 lifecycle/policy 事件直接抛 ControlPlaneEventUnsupportedError。
}
