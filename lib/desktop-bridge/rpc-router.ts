import { isLeaseValid } from "../desktop/lease";
/**
 * RPC 路由逻辑。
 *
 * 将 RPC 请求路由到正确的 Desktop 设备。路由基于 lease：
 * 只有持有 threadId lease 且在线、已认证的设备才能接收该 thread 的 RPC。
 *
 * 路由流程：
 * 1. 查找 threadId 的 lease holder
 * 2. 如果没有 lease，返回 desktop_unavailable（没有设备持有执行权）
 * 3. 如果有 lease，检查 lease 是否有效（未过期）
 * 4. 检查 lease 的 userId 是否匹配
 * 5. 检查 lease 的 deviceRecordId（Device.id）对应的设备是否在线且已认证
 * 6. 返回目标设备的内部 deviceRecordId 与外部 deviceKey、WebSocket
 *
 * 内部路由一律用 deviceRecordId（Device.id）；返回中同时给出外部 deviceKey，
 * 供 wire 协议 / RPC envelope 使用（信封 deviceId 字段仍是 deviceKey）。
 */
import type { DeviceRegistry } from "./device-registry";
import type { LeaseService } from "./lease-service";

/**
 * RPC 路由结果。
 *
 * 鉴别联合：ok=true 时持有内部 deviceRecordId / 外部 deviceKey / ws，
 * ok=false 时持有 code/message。清楚区分内部路由 id 与外部 wire 标识。
 */
export type RpcRouteResult =
  | { ok: true; deviceRecordId: string; deviceKey: string; ws: unknown }
  | { ok: false; code: string; message?: string };

/**
 * 路由 RPC 请求到正确的 Desktop 设备。
 *
 * @param params.registry 设备注册表
 * @param params.leaseService lease 服务
 * @param params.userId 请求用户 ID
 * @param params.threadId thread ID
 * @param params.now 当前时间（epoch ms）
 * @returns 路由结果
 */
export function routeRpc(params: {
  registry: DeviceRegistry;
  leaseService: LeaseService;
  userId: string;
  threadId: string;
  now: number;
}): RpcRouteResult {
  const { registry, leaseService, userId, threadId, now } = params;
  // 1. 查找 lease holder
  const lease = leaseService.getLeaseHolder(threadId);
  if (!lease) {
    return {
      ok: false,
      code: "desktop_unavailable",
      message: "无 lease 持有该 thread",
    };
  }
  // 2. 检查 lease 是否有效（未过期）
  if (!isLeaseValid(lease, now)) {
    return {
      ok: false,
      code: "desktop_unavailable",
      message: "lease 已过期",
    };
  }
  // 3. 检查 lease 的 userId 是否匹配
  if (lease.userId !== userId) {
    return {
      ok: false,
      code: "desktop_unauthorized",
      message: `userId 不匹配：lease=${lease.userId}，request=${userId}`,
    };
  }
  // 4. 检查 lease 的 deviceRecordId 对应的设备是否在线（内部路由用 Device.id）
  const dev = registry.getByDeviceRecordId(lease.deviceRecordId);
  if (!dev) {
    return {
      ok: false,
      code: "desktop_disconnected",
      message: `设备 ${lease.deviceRecordId} 已离线`,
    };
  }
  // 5. 检查设备是否已认证
  if (!dev.authenticated) {
    return {
      ok: false,
      code: "desktop_unauthorized",
      message: `设备 ${lease.deviceRecordId} 未认证`,
    };
  }
  // 6. 返回目标设备的内部 deviceRecordId 与外部 deviceKey、WebSocket
  return {
    ok: true,
    deviceRecordId: dev.deviceRecordId,
    deviceKey: dev.deviceKey,
    ws: dev.ws,
  };
}
