/**
 * requestHostedProvisioning — 幂等创建/确认 HostedProvisioningRequest。
 *
 * 专题01 冻结（runtime-only）：
 * - 请求权威 = (tenantId, routeScopeKey)；builtin Runtime key 固定在 Hosted Runtime
 *   Gateway，不由请求选择。
 * - 请求携带非空 requesterId（供首次创建 Runtime 记录 owner）。
 * - 空白 tenantId/requesterId/routeScopeKey 在 store 写入前 fail closed（返回 typed invalid，
 *   不抛错、不写入）。
 * - 重复 (tenantId, routeScopeKey) 返回同一 request，不覆盖 first requester。
 *
 * 用户 Turn 发现无 Ready Route 时调用此入口。
 * 只写入 Request 记录，不执行外部网络调用。Worker 异步执行供应 Saga。
 * 本工厂只依赖 store；AgentRevision 验证/黑盒 A2A 不在 Hosted 供应范围内。
 */

import { randomUUID } from "node:crypto";
import type { HostedProvisioningRequestRow } from "@/lib/runtime/persistence/hosted-provisioning-request-record";
import type { HostedProvisioningRequestStore } from "@/lib/runtime/persistence/hosted-provisioning-request-store";

export interface RequestHostedProvisioningResult {
  /** 供应请求 ID。 */
  requestId: string;
  /** 当前状态。 */
  state: string;
  /** 建议重试等待时间（毫秒）。 */
  retryAfterMs: number;
}

/** : 参数校验失败（空白 tenantId/requesterId/routeScopeKey）结果。 */
export interface RequestHostedProvisioningInvalid {
  valid: false;
  /** 错误码。 */
  code: string;
  /** 人类可读原因。 */
  reason: string;
}

/** 空白校验：空串或全空白视为非法。 */
function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * 创建幂等供应请求工厂。只依赖 store。
 *
 * : 参数合法才落库；任一空白 tenantId/requesterId/routeScopeKey 在 store 写入前 fail closed。
 */
export function createRequestHostedProvisioning(deps: {
  store: HostedProvisioningRequestStore;
}) {
  return async function requestHostedProvisioning(params: {
    tenantId: string;
    requesterId: string;
    routeScopeKey: string;
  }): Promise<RequestHostedProvisioningResult | RequestHostedProvisioningInvalid> {
    // : 空白校验——store 写入前 fail closed（不抛错、不写入）。
    if (isBlank(params.tenantId)) {
      return { valid: false, code: "BLANK_TENANT", reason: "tenantId 不能为空" };
    }
    if (isBlank(params.requesterId)) {
      return { valid: false, code: "BLANK_REQUESTER", reason: "requesterId 不能为空" };
    }
    if (isBlank(params.routeScopeKey)) {
      return { valid: false, code: "BLANK_ROUTE_SCOPE", reason: "routeScopeKey 不能为空" };
    }

    // 幂等：同 (tenantId, routeScopeKey) 已有请求则返回同一请求，不覆盖 first requester。
    const existing = await deps.store.findActiveRequest({
      tenantId: params.tenantId,
      routeScopeKey: params.routeScopeKey,
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
      requesterId: params.requesterId,
      routeScopeKey: params.routeScopeKey,
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
