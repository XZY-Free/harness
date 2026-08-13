/**
 * Environment 状态聚合查询（S10-W06 / S10-W07）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 * S10-W06：「Desktop 复用共同时间线，在右侧增加文件、页面和内部系统任务操作面板」
 * 「本地 Shell、Git、测试、构建、浏览器和应用操作显示实际执行设备、目录、权限和结果」
 * S10-W07：「页面显示当前 Environment owner、在线状态、租约和接管条件」
 *
 * 职责：
 * - 聚合 Thread 的当前 Environment 状态：EnvironmentDefinition + active Lease + ExecutionOwnership。
 * - 推导员工端可见的 availability（no_environment/cloud/online_desktop/pending_device/offline_desktop）。
 * - S10-W07：deviceOnline 推导加入 device.lastActiveAt 心跳阈值校验
 * （仅 deviceState=active 且 lastActiveAt 在 DEVICE_HEARTBEAT_TIMEOUT_MS 内才算在线）。
 * - 不修改任何状态，只读取。
 *
 * 推导规则（availability）：
 * - no_environment：Thread.defaultEnvironmentDefinitionId 为空。
 * - cloud：Environment 类型为 cloud/remote/sandbox。
 * - online_desktop：Desktop Lease active + 设备在线
 * （deviceState=active + lastActiveAt 在心跳阈值内）。
 * - pending_device：Desktop Lease allocated/releasing，或 Lease active 但设备离线。
 * - offline_desktop：Desktop Lease 终态（released/expired/lost），或无 Lease 但 Environment 为 desktop。
 *
 * 不变量：
 * - 跨租户隔离：Thread 必须属于当前 principal.tenantId。
 * - 非 owner 员工调用：调用方负责鉴权（route 层 404 隐藏式）。
 * - 不暴露内部堆栈或跨租户数据。
 */
import { getDeviceById } from "@/lib/identity/device-queries";
import {
 ENVIRONMENT_LEASE_TERMINAL_STATES,
 type EnvironmentDefinition,
 type EnvironmentLease,
} from "@/lib/persistence/schema/environment";
import type { ClientEnvironmentAvailability } from "@/lib/client/types";
import {
 getActiveExecutionOwnership,
 getEnvironmentDefinitionById,
 listEnvironmentLeasesByInvocation,
} from "@/lib/environment/environment-queries";
import {
 DEVICE_HEARTBEAT_TIMEOUT_MS,
 isDeviceHeartbeatStale,
} from "./environment-takeover-queries";

export { DEVICE_HEARTBEAT_TIMEOUT_MS };

/** 查询入参。 */
export interface GetEnvironmentStatusInput {
 readonly tenantId: string;
 readonly threadId: string;
 /** Thread.defaultEnvironmentDefinitionId（调用方从 Thread 取得）。 */
 readonly environmentDefinitionId: string | null;
 /** 当前 active Invocation id（来自 latest Turn.activeInvocationId；null 表示无活跃 Invocation）。 */
 readonly activeInvocationId: string | null;
}

/** 查询结果（聚合视图）。 */
export interface EnvironmentStatusAggregate {
 readonly environmentDefinition: EnvironmentDefinition | null;
 readonly activeLease: EnvironmentLease | null;
 readonly activeOwnership: Awaited<ReturnType<typeof getActiveExecutionOwnership>>;
 readonly availability: ClientEnvironmentAvailability;
 /** 设备在线状态（仅 Desktop 类型有意义）；基于 deviceState + lastActiveAt 心跳推导。 */
 readonly deviceOnline: boolean | null;
}

/**
 * 推导 availability 状态。
 *
 * 规则：
 * 1. environmentDefinitionId 为空 → no_environment
 * 2. Environment 类型非 desktop → cloud
 * 3. Desktop 类型：
 * - Lease 终态或无 Lease → offline_desktop
 * - Lease allocated/releasing → pending_device
 * - Lease active + device 在线 → online_desktop
 * - Lease active + device 离线 → pending_device
 */
export function deriveAvailability(params: {
 readonly environmentDefinition: EnvironmentDefinition | null;
 readonly activeLease: EnvironmentLease | null;
 readonly deviceOnline: boolean | null;
}): ClientEnvironmentAvailability {
 const { environmentDefinition, activeLease, deviceOnline } = params;

 if (!environmentDefinition) return "no_environment";
 if (environmentDefinition.environmentType !== "desktop") return "cloud";

 // Desktop 类型
 if (!activeLease) return "offline_desktop";
 if (ENVIRONMENT_LEASE_TERMINAL_STATES.includes(activeLease.leaseState)) {
 return "offline_desktop";
 }
 if (activeLease.leaseState !== "active") {
 // allocated / releasing
 return "pending_device";
 }
 // Lease active
 if (deviceOnline === true) return "online_desktop";
 return "pending_device";
}

/**
 * 聚合查询 Thread 的 Environment 状态。
 *
 * 步骤：
 * 1. 按 environmentDefinitionId 取 EnvironmentDefinition（跨租户隔离）。
 * 2. 按 activeInvocationId 取 Leases（取最新一条）+ ExecutionOwnership。
 * 3. Desktop 类型时按 lease.deviceId 查 Device.deviceState 推导在线状态。
 * 4. 推导 availability。
 */
export async function getEnvironmentStatus(
 input: GetEnvironmentStatusInput,
): Promise<EnvironmentStatusAggregate> {
 const { environmentDefinitionId, activeInvocationId } = input;

 // 1. EnvironmentDefinition
 const environmentDefinition = environmentDefinitionId
 ? await getEnvironmentDefinitionById(input.tenantId, environmentDefinitionId)
 : null;

 // 2. Lease + Ownership（按 activeInvocationId）
 let activeLease: EnvironmentLease | null = null;
 let activeOwnership: EnvironmentStatusAggregate["activeOwnership"] = null;
 if (activeInvocationId) {
 const leases = await listEnvironmentLeasesByInvocation(input.tenantId, activeInvocationId);
 // 取最新一条（按 createdAt desc 排序，第一条最新）
 activeLease = leases.length > 0 ? (leases[0] ?? null) : null;
 activeOwnership = await getActiveExecutionOwnership(activeInvocationId);
 }

 // 3. 设备在线状态（仅 Desktop 类型 + Lease 有 deviceId 时查询）
 // S10-W07：基于 deviceState=active + lastActiveAt 心跳未陈旧推导。
 let deviceOnline: boolean | null = null;
 if (environmentDefinition?.environmentType === "desktop" && activeLease?.deviceId) {
 const device = await getDeviceById(activeLease.deviceId);
 if (!device || device.deviceState !== "active") {
 deviceOnline = false;
 } else {
 // deviceState=active 但 lastActiveAt 超过阈值视为离线
 deviceOnline = !isDeviceHeartbeatStale(device);
 }
 }

 // 4. 推导 availability
 const availability = deriveAvailability({ environmentDefinition, activeLease, deviceOnline });

 return {
 environmentDefinition,
 activeLease,
 activeOwnership,
 availability,
 deviceOnline,
 };
}
