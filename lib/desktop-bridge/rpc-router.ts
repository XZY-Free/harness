import { isLeaseValid } from "../desktop/lease";
/**
 * ：RPC 路由逻辑。
 *
 * 将 RPC 请求路由到正确的 Desktop 设备。路由基于 lease：
 * 只有持有 threadId lease 且在线、已认证的设备才能接收该 thread 的 RPC。
 *
 * 路由流程：
 * 1. 查找 threadId 的 lease holder
 * 2. 如果没有 lease，返回 desktop_unavailable（没有设备持有执行权）
 * 3. 如果有 lease，检查 lease 是否有效（未过期）
 * 4. 检查 lease 的 userId 是否匹配
 * 5. 检查 lease 的 deviceId 对应的设备是否在线且已认证
 * 6. 返回目标设备的 WebSocket
 */
import type { DeviceRegistry } from "./device-registry";
import type { LeaseService } from "./lease-service";

/**
 * RPC 路由结果。
 *
 * 鉴别联合：ok=true 时持有 deviceId/ws，ok=false 时持有 code/message。
 */
export type RpcRouteResult =
 | { ok: true; deviceId: string; ws: unknown }
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
 // 4. 检查 lease 的 deviceId 对应的设备是否在线
 const dev = registry.getByDeviceId(lease.deviceId);
 if (!dev) {
 return {
 ok: false,
 code: "desktop_disconnected",
 message: `设备 ${lease.deviceId} 已离线`,
 };
 }
 // 5. 检查设备是否已认证
 if (!dev.authenticated) {
 return {
 ok: false,
 code: "desktop_unauthorized",
 message: `设备 ${lease.deviceId} 未认证`,
 };
 }
 // 6. 返回目标设备的 WebSocket
 return {
 ok: true,
 deviceId: dev.deviceId,
 ws: dev.ws,
 };
}
