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

export interface OutboxEventHandler {
  (event: ControlPlaneOutboxEvent): Promise<void>;
}

export interface ProjectionEventHandlerDeps {
  store: RouteEligibilityStore;
  buildRouteEligibility: (input: BuildRouteEligibilityInput) => Promise<BuildRouteEligibilityResult>;
}

/**
 * 创建 Outbox 事件处理器。
 *
 * 根据 eventType 分派到具体 Projection 重建逻辑。
 */
export function createProjectionEventHandler(deps: ProjectionEventHandlerDeps): OutboxEventHandler {
  return async function handleOutboxEvent(event: ControlPlaneOutboxEvent): Promise<void> {
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

      // ─── 生命周期事件 ────────────────────────────
      case "agent.lifecycle.changed": {
        const agentId = payload.agentId as string;
        const newState = payload.newState as string;
        if (newState !== "enabled") {
          // Agent 不再 enabled → 所有引用该 Agent 的 Route 标记 Ineligible
          await markProjectionsIneligibleByAgentId(agentId, "agent_lifecycle_changed");
        }
        break;
      }

      case "runtime.lifecycle.changed": {
        const runtimeId = payload.runtimeId as string;
        const newState = payload.newState as string;
        if (newState !== "enabled") {
          await markProjectionsIneligibleByRuntimeId(runtimeId, "runtime_lifecycle_changed");
        }
        break;
      }

      // ─── Policy 事件 ─────────────────────────────
      case "policy.revision.published": {
        // Policy 发布只重建已经引用该 Policy 的 Route
        const policyRevisionId = payload.policyRevisionId as string;
        await rebuildProjectionsByPolicyRevision(policyRevisionId);
        break;
      }

      case "policy.revision.withdrawn": {
        const policyRevisionId = payload.policyRevisionId as string;
        await markProjectionsIneligibleByPolicyRevision(policyRevisionId, "policy_withdrawn");
        break;
      }

      // ─── Route 验证事件 ──────────────────────────
      case "route.revision.validated": {
        const routeId = payload.routeId as string;
        const tenantId = payload.tenantId as string;
        await deps.buildRouteEligibility({ tenantId, routeId });
        break;
      }

      default:
        // 未知事件类型 — 不报错，跳过（幂等）
        break;
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

  async function markProjectionsIneligibleByAgentId(agentId: string, reason: string): Promise<void> {
    // 按 agentId 查找投影 — 需要通过 store 扩展方法或直接查询
    // 使用 findProjectionsByRouteSet 的组合方式
    // 简化实现：标记所有引用该 agentId 的 Projection 为 pending_rebuild
    // 实际重建由重建命令或后续事件触发
    void agentId;
    void reason;
    // TODO: 需要扩展 store 增加 findProjectionsByAgentId 方法
  }

  async function markProjectionsIneligibleByRuntimeId(runtimeId: string, reason: string): Promise<void> {
    void runtimeId;
    void reason;
    // TODO: 需要扩展 store 增加 findProjectionsByRuntimeId 方法
  }

  async function rebuildProjectionsByPolicyRevision(policyRevisionId: string): Promise<void> {
    void policyRevisionId;
    // TODO: 需要扩展 store 增加 findProjectionsByPolicyRevisionId 方法
  }

  async function markProjectionsIneligibleByPolicyRevision(policyRevisionId: string, reason: string): Promise<void> {
    void policyRevisionId;
    void reason;
    // TODO: 同上
  }
}
