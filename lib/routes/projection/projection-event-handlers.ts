/**
 * Projection 事件处理器 — 处理 Outbox 事件触发 Projection 重建。
 *
 * §05.3: 所有事件使用 RouteEligibilitySourceReader 从权威事实发现受影响 Route，
 * 不再通过 Projection 表的 findProjectionsByXxx() 来发现 Route。
 * Projection 不存在时也能发现 Route — 首次构建的前提。
 *
 * 每个 Handler 幂等。
 */

import type { ControlPlaneEventType } from "@/lib/control-plane/events/control-plane-event";
import type { ControlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { validateEventPayload } from "@/lib/control-plane/events/event-contracts";
import type {
  BuildRouteEligibilityInput,
  BuildRouteEligibilityResult,
} from "./build-route-eligibility";
import type { RouteEligibilitySourceReader } from "./route-eligibility-source-reader";
import type { RouteEligibilityStore } from "./route-eligibility-store";

export type OutboxEventHandler = (event: ControlPlaneOutboxEvent) => Promise<void>;

export interface ProjectionEventHandlerDeps {
  store: RouteEligibilityStore;
  /** §05.3: 权威事实 SourceReader — 替代 findProjectionsByXxx。 */
  sourceReader: RouteEligibilitySourceReader;
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
 * §05.3: 所有事件通过 SourceReader 从权威事实发现 Route。
 * Projection 不存在时也能发现 Route。
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

    // §4.2/§05.7: 来源事件信息
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

      // ─── Revision 事件 — §05.3: 通过 SourceReader 从权威事实发现 Route ───
      case "agent.revision.published": {
        const revisionId = payload.revision_id as string;
        await rebuildFromAuthority(
          () => deps.sourceReader.listRouteIdsByAgentRevision(revisionId),
          sourceEventId,
          sourceAggregateVersion,
        );
        break;
      }

      case "agent.revision.withdrawn": {
        const revisionId = payload.revision_id as string;
        await markIneligibleFromAuthority(
          () => deps.sourceReader.listRouteIdsByAgentRevision(revisionId),
          "agent_revision_withdrawn",
        );
        break;
      }

      case "runtime.revision.published": {
        const revisionId = payload.revision_id as string;
        await rebuildFromAuthority(
          () => deps.sourceReader.listRouteIdsByRuntimeRevision(revisionId),
          sourceEventId,
          sourceAggregateVersion,
        );
        break;
      }

      case "runtime.revision.withdrawn": {
        const revisionId = payload.revision_id as string;
        await markIneligibleFromAuthority(
          () => deps.sourceReader.listRouteIdsByRuntimeRevision(revisionId),
          "runtime_revision_withdrawn",
        );
        break;
      }

      // ─── Attestation 事件 — §05.3: 通过 PublicationRecord → RouteRevision 发现 ───
      case "artifact.attestation.revoked": {
        const attestationId = payload.attestation_id as string;
        await rebuildFromAuthority(
          () => deps.sourceReader.listRouteIdsByAttestation(attestationId),
          sourceEventId,
          sourceAggregateVersion,
        );
        break;
      }

      // ─── Conformance 事件 — §05.3: 通过 RuntimeRevision 发现 ───
      case "runtime.conformance.recorded": {
        const runtimeRevisionId = payload.runtime_revision_id as string;
        await rebuildFromAuthority(
          () => deps.sourceReader.listRouteIdsByRuntimeRevision(runtimeRevisionId),
          sourceEventId,
          sourceAggregateVersion,
        );
        break;
      }

      // ─── §05.3: 生命周期事件 — 通过 SourceReader 从权威事实发现 ───
      case "agent.lifecycle.changed": {
        const agentId = payload.agent_id as string;
        const lifecycleState = payload.new_state as string;
        if (lifecycleState !== "enabled") {
          // Agent 非 enabled → 标记所有相关投影 Ineligible
          await markIneligibleFromAuthority(
            () => deps.sourceReader.listRouteIdsByAgent(agentId),
            `agent_lifecycle_${lifecycleState}`,
          );
        } else {
          // Agent 重新 enabled → 重建所有相关投影
          await rebuildFromAuthority(
            () => deps.sourceReader.listRouteIdsByAgent(agentId),
            sourceEventId,
            sourceAggregateVersion,
          );
        }
        break;
      }

      case "runtime.lifecycle.changed": {
        const runtimeId = payload.runtime_id as string;
        const lifecycleState = payload.new_state as string;
        if (lifecycleState !== "enabled") {
          // Runtime 非 enabled → 标记相关投影 Ineligible
          await markIneligibleFromAuthority(
            () => deps.sourceReader.listRouteIdsByRuntime(runtimeId),
            `runtime_lifecycle_${lifecycleState}`,
          );
        } else {
          // Runtime 重新 enabled → 重建相关投影
          await rebuildFromAuthority(
            () => deps.sourceReader.listRouteIdsByRuntime(runtimeId),
            sourceEventId,
            sourceAggregateVersion,
          );
        }
        break;
      }

      // ─── §05.3: Policy 事件 — 通过 SourceReader 从权威事实发现 ───
      case "policy.revision.published": {
        const policyRevisionId = payload.policy_revision_id as string;
        await rebuildFromAuthority(
          () => deps.sourceReader.listRouteIdsByPolicyRevision(policyRevisionId),
          sourceEventId,
          sourceAggregateVersion,
        );
        break;
      }

      case "policy.revision.withdrawn": {
        const policyRevisionId = payload.policy_revision_id as string;
        await markIneligibleFromAuthority(
          () => deps.sourceReader.listRouteIdsByPolicyRevision(policyRevisionId),
          "policy_revision_withdrawn",
        );
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

      // ─── §05.3: RouteSet 激活事件 — 通过 SourceReader 从权威事实发现 ───
      case "route_set.activated": {
        const routeSetId = payload.route_set_id as string;
        // §05.3: payload 中可能包含 route_ids，优先使用；否则按 RouteSet 查权威 Route
        const routeIds = payload.route_ids as string[] | undefined;
        if (routeIds && routeIds.length > 0) {
          const tenantId = payload.tenant_id as string;
          for (const routeId of routeIds) {
            await deps.buildRouteEligibility({
              tenantId,
              routeId,
              sourceEventId,
              sourceAggregateVersion,
            });
          }
        } else {
          await rebuildFromAuthority(
            () => deps.sourceReader.listRouteIdsByRouteSet(routeSetId),
            sourceEventId,
            sourceAggregateVersion,
          );
        }
        break;
      }

      default:
        // §3.6: 未知事件类型 — Fail-loud，不标记成功
        throw new ControlPlaneEventUnsupportedError(event.eventType, "switch 未覆盖的事件类型");
    }
  };

  /**
   * §05.3: 从权威事实发现受影响 Route 并重建 Projection。
   * Projection 不存在时也能发现 Route — buildRouteEligibility 会创建新 Projection。
   */
  async function rebuildFromAuthority(
    findRoutes: () => Promise<Array<{ routeId: string; tenantId: string }>>,
    sourceEventId?: string | null,
    sourceAggregateVersion?: number | null,
  ): Promise<void> {
    const routes = await findRoutes();
    for (const { routeId, tenantId } of routes) {
      await deps.buildRouteEligibility({
        tenantId,
        routeId,
        sourceEventId,
        sourceAggregateVersion,
      });
    }
  }

  /**
   * §05.3: 从权威事实发现受影响 Route 并标记 Ineligible。
   */
  async function markIneligibleFromAuthority(
    findRoutes: () => Promise<Array<{ routeId: string; tenantId: string }>>,
    reason: string,
  ): Promise<void> {
    const routes = await findRoutes();
    for (const { routeId } of routes) {
      await deps.store.markIneligible(routeId, reason);
    }
  }
}
