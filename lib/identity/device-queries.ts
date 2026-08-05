/**
 * 设备仓储。
 *
 * 设备生命周期：register（绑定）→ touch（心跳）→ revoke（撤销，不可恢复）。
 * 撤销后拒绝新 Lease、Workspace handle 和迟到签名请求（S02-W02）。
 *
 * 与 V10 desktop-device-queries 的差异：
 * - 所有查询按 (tenantId, deviceKey) 而非全局 deviceKey。
 * - userId 引用 UserIdentity 而非旧 User 表。
 * - deviceState 替代 status（公共字段规则）。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §2.1、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §9。
 */
import { db } from "@/lib/db/client";
import { device } from "@/lib/v11/schema/device";
import type { Device } from "@/lib/v11/schema/device";
import { and, desc, eq, sql } from "drizzle-orm";

/**
 * 注册新设备（幂等）。
 *
 * 若 (tenantId, deviceKey) 已存在且 active，直接返回现有记录，不覆盖 publicKey/deviceName/appVersion。
 * Desktop 多次绑定同一 deviceKey（如重装后重新绑定）不会创建重复行。
 */
export async function registerDevice(params: {
  tenantId: string;
  userId: string;
  deviceKey: string;
  publicKey: string;
  deviceName: string;
  appVersion: string;
}): Promise<Device> {
  // 先查是否已有 active 设备——有则返回现有，不覆盖
  const [existing] = await db
    .select()
    .from(device)
    .where(
      and(
        eq(device.tenantId, params.tenantId),
        eq(device.deviceKey, params.deviceKey),
        eq(device.deviceState, "active"),
      ),
    )
    .limit(1);
  if (existing) {
    return existing;
  }

  // 无 active 记录 → INSERT IGNORE（唯一索引兜底并发竞态）
  const now = new Date();
  await db.insert(device).ignore().values({
    tenantId: params.tenantId,
    userId: params.userId,
    deviceKey: params.deviceKey,
    publicKey: params.publicKey,
    deviceName: params.deviceName,
    appVersion: params.appVersion,
    deviceState: "active",
    lastActiveAt: now,
    revokedAt: null,
    createdAt: now,
  });

  const [row] = await db
    .select()
    .from(device)
    .where(and(eq(device.tenantId, params.tenantId), eq(device.deviceKey, params.deviceKey)))
    .limit(1);
  if (!row) {
    throw new Error(
      `registerDevice: 行未找到（tenantId=${params.tenantId}, deviceKey=${params.deviceKey}）`,
    );
  }
  return row;
}

/** 按 (tenantId, deviceKey) 获取设备（任意状态）。不存在返回 null。 */
export async function getDeviceByKey(tenantId: string, deviceKey: string): Promise<Device | null> {
  const [row] = await db
    .select()
    .from(device)
    .where(and(eq(device.tenantId, tenantId), eq(device.deviceKey, deviceKey)))
    .limit(1);
  return row ?? null;
}

/** 按 id 获取设备。不存在返回 null。 */
export async function getDeviceById(id: string): Promise<Device | null> {
  const [row] = await db.select().from(device).where(eq(device.id, id)).limit(1);
  return row ?? null;
}

/**
 * 获取用户在租户内的所有活跃设备，按 lastActiveAt desc 排序。
 * 不返回已撤销的设备。
 */
export async function listActiveDevicesByUser(tenantId: string, userId: string): Promise<Device[]> {
  return db
    .select()
    .from(device)
    .where(
      and(
        eq(device.tenantId, tenantId),
        eq(device.userId, userId),
        eq(device.deviceState, "active"),
      ),
    )
    .orderBy(desc(device.lastActiveAt));
}

/**
 * 更新设备最后活动时间（Desktop launch 时调用）。
 * 用 NOW(3) 取 DB 当前时间，避免应用进程时钟漂移并保留毫秒精度。
 */
export async function touchDevice(tenantId: string, deviceKey: string): Promise<void> {
  await db
    .update(device)
    .set({ lastActiveAt: sql`NOW(3)` })
    .where(and(eq(device.tenantId, tenantId), eq(device.deviceKey, deviceKey)));
}

/**
 * 撤销设备（active → revoked + revokedAt 回填）。
 *
 * 严格条件：仅当 (tenantId, deviceKey) 存在且 deviceState=active 时撤销。
 * 重复撤销（已 revoked）返回 null——避免覆盖 revokedAt 时间戳，保留首次撤销时间。
 * 撤销后不可恢复（与 V10 一致，10-core-data-model.md:46）。
 *
 * 撤销后立即阻止后续注入：新 Lease、Workspace handle 和迟到签名请求全部拒绝。
 */
export async function revokeDevice(tenantId: string, deviceKey: string): Promise<Device | null> {
  const result = await db
    .update(device)
    .set({
      deviceState: "revoked",
      revokedAt: sql`NOW()`,
    })
    .where(
      and(
        eq(device.tenantId, tenantId),
        eq(device.deviceKey, deviceKey),
        eq(device.deviceState, "active"),
      ),
    );
  // affectedRows = 0 表示无 active 设备被撤销（已 revoked 或不存在）
  if (result[0].affectedRows === 0) {
    return null;
  }
  const [row] = await db
    .select()
    .from(device)
    .where(and(eq(device.tenantId, tenantId), eq(device.deviceKey, deviceKey)))
    .limit(1);
  return row ?? null;
}

/**
 * 按 (tenantId, deviceKey, userId) 获取设备（owner guard 双重校验）。
 *
 * HTTP 入口在读写设备前必须用此 helper，避免裸 deviceKey 越权（A 用户读取 B 用户的设备）。
 * 不属于该 userId 返回 null（HTTP 入口据此返回 404 隐藏存在性）。
 */
export async function getDeviceForUser(
  tenantId: string,
  deviceKey: string,
  userId: string,
): Promise<Device | null> {
  const [row] = await db
    .select()
    .from(device)
    .where(
      and(
        eq(device.tenantId, tenantId),
        eq(device.deviceKey, deviceKey),
        eq(device.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 检查设备是否活跃（deviceState=active）。
 * 不存在的设备返回 false（保守默认：未知设备不视为活跃）。
 */
export async function isDeviceActive(tenantId: string, deviceKey: string): Promise<boolean> {
  const [row] = await db
    .select({ deviceState: device.deviceState })
    .from(device)
    .where(and(eq(device.tenantId, tenantId), eq(device.deviceKey, deviceKey)))
    .limit(1);
  return row?.deviceState === "active";
}
