/**
 * requestHostedProvisioning — 幂等创建/确认 HostedProvisioningRequest。
 *
 * 用户 Turn 发现无 Ready Route 时调用此入口。
 * 只写入 Request 记录，不执行外部网络调用。
 * Worker 异步执行供应 Saga。
 *
 * §6.1: 创建前必须验证 AgentRevision 存在、属于 Tenant/Agent、是当前期望 Revision。
 * 禁止 agentRevisionId = "unknown"。
 */

import { randomUUID } from "node:crypto";
import type { HostedProvisioningRequestRow } from "@/lib/runtimes/persistence/hosted-provisioning-request-record";
import type { HostedProvisioningRequestStore } from "@/lib/runtimes/persistence/hosted-provisioning-request-store";
import type { RevisionValidationDeps } from "./validate-hosted-provisioning-revision";

export interface RequestHostedProvisioningResult {
  /** 供应请求 ID。 */
  requestId: string;
  /** 当前状态。 */
  state: string;
  /** 建议重试等待时间（毫秒）。 */
  retryAfterMs: number;
}

/** §6.1: Revision 验证失败结果。 */
export interface RequestHostedProvisioningRevisionInvalid {
  valid: false;
  /** 错误码。 */
  code: string;
  /** 人类可读原因。 */
  reason: string;
}

/**
 * 创建幂等供应请求工厂。
 *
 * §6.1: 新增 revisionValidator 依赖，在创建前验证 AgentRevision。
 */
export function createRequestHostedProvisioning(deps: {
  store: HostedProvisioningRequestStore;
  /** §6.1: AgentRevision 验证器。 */
  revisionValidator: RevisionValidationDeps;
}) {
  return async function requestHostedProvisioning(params: {
    tenantId: string;
    agentId: string;
    agentRevisionId: string;
    routeScopeKey: string;
    desiredRuntimeKey?: string;
  }): Promise<RequestHostedProvisioningResult | RequestHostedProvisioningRevisionInvalid> {
    const desiredRuntimeKey = params.desiredRuntimeKey ?? "builtin-hosted";

    // §6.1: 验证 AgentRevision 精确绑定
    const validation = await deps.revisionValidator.validateRevision({
      tenantId: params.tenantId,
      agentId: params.agentId,
      agentRevisionId: params.agentRevisionId,
    });

    if (!validation.valid) {
      return {
        valid: false,
        code: validation.code,
        reason: validation.reason,
      };
    }

    // 幂等：查找已有请求
    const existing = await deps.store.findActiveRequest({
      tenantId: params.tenantId,
      agentRevisionId: params.agentRevisionId,
      routeScopeKey: params.routeScopeKey,
      desiredRuntimeKey,
    });

    if (existing) {
      return {
        requestId: existing.id,
        state: existing.state,
        retryAfterMs: computeRetryAfter(existing),
      };
    }

    // 创建新请求
    const now = new Date();
    const id = randomUUID();
    const created = await deps.store.insert({
      id,
      tenantId: params.tenantId,
      agentId: params.agentId,
      agentRevisionId: params.agentRevisionId,
      routeScopeKey: params.routeScopeKey,
      desiredRuntimeKey,
      createdAt: now,
      updatedAt: now,
    });

    return {
      requestId: created.id,
      state: created.state,
      retryAfterMs: 5000, // 新请求默认 5s 后可开始处理
    };
  };
}

/** 根据请求状态计算建议重试时间。 */
function computeRetryAfter(request: HostedProvisioningRequestRow): number {
  if (request.state === "ready") return 0;
  if (request.state === "permanent_failed") return -1; // 不应重试
  if (request.state === "cancelled") return -1;

  if (request.nextAttemptAt) {
    const ms = request.nextAttemptAt.getTime() - Date.now();
    return Math.max(ms, 1000);
  }

  // 有活跃租约，等待租约过期
  if (request.leaseExpiresAt) {
    const ms = request.leaseExpiresAt.getTime() - Date.now();
    return Math.max(ms, 1000);
  }

  return 5000; // 默认 5s
}
