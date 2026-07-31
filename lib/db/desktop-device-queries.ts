import { db } from "@/lib/db/client";
import { type DesktopDevice, desktopDevice } from "@/lib/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

/**
 * V10 Phase 5：Desktop 设备查询。
 *
 * 与 queries.ts 分离：Desktop 设备生命周期独立（绑定 / 心跳 / 撤销），
 * 不参与 thread / message CRUD，独立单测与后续 Phase 复用。
 *
 * 幂等写入：MySQL 无 onConflictDoNothing，用 INSERT IGNORE（drizzle `.ignore()`）。
 */

/**
 * 注册新设备。
 *
 * 幂等语义：若 deviceId 已存在且 status=active，直接返回现有记录（不更新 publicKey/name/version）。
 * Desktop 多次绑定同一 deviceId（如重装后重新绑定）不会创建重复行。
 */
export async function registerDevice(params: {
  userId: string;
  deviceId: string;
  publicKey: string;
  name: string;
  version: string;
}): Promise<DesktopDevice> {
  // 先查是否已有 active 设备——有则返回现有，不覆盖
  const [existing] = await db
    .select()
    .from(desktopDevice)
    .where(and(eq(desktopDevice.deviceId, params.deviceId), eq(desktopDevice.status, "active")))
    .limit(1);
  if (existing) {
    return existing;
  }

  // 无 active 记录 → INSERT IGNORE（deviceId 唯一索引兜底并发竞态：另一个 worker 可能已插入）
  // IGNORE 遇唯一键冲突静默跳过；之后重新查询拿真实落库行（race-winner 写入的）
  const now = new Date();
  await db.insert(desktopDevice).ignore().values({
    userId: params.userId,
    deviceId: params.deviceId,
    publicKey: params.publicKey,
    name: params.name,
    version: params.version,
    status: "active",
    lastActiveAt: now,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await db
    .select()
    .from(desktopDevice)
    .where(eq(desktopDevice.deviceId, params.deviceId))
    .limit(1);
  // 刚 insert 成功或被 IGNORE 兜底，必有一行；row 缺失表示并发删除（外键级联），属不变式违反
  if (!row) {
    throw new Error(`registerDevice: 行未找到（deviceId=${params.deviceId}）`);
  }
  return row;
}

/** 按 deviceId 获取设备（任意状态）。不存在返回 null。 */
export async function getDeviceByDeviceId(deviceId: string): Promise<DesktopDevice | null> {
  const [row] = await db
    .select()
    .from(desktopDevice)
    .where(eq(desktopDevice.deviceId, deviceId))
    .limit(1);
  return row ?? null;
}

/**
 * 获取用户的所有活跃设备（status=active），按 lastActiveAt desc 排序。
 * 不返回已撤销的设备。
 */
export async function listActiveDevicesByUser(userId: string): Promise<DesktopDevice[]> {
  return db
    .select()
    .from(desktopDevice)
    .where(and(eq(desktopDevice.userId, userId), eq(desktopDevice.status, "active")))
    .orderBy(desc(desktopDevice.lastActiveAt));
}

/**
 * 更新设备最后活动时间（Desktop launch 时调用）。
 * 用 NOW(3) 取 DB 当前时间，避免应用进程时钟漂移并保留毫秒精度。
 */
export async function touchDevice(deviceId: string): Promise<void> {
  await db
    .update(desktopDevice)
    .set({ lastActiveAt: sql`NOW(3)` })
    .where(eq(desktopDevice.deviceId, deviceId));
}

/**
 * 撤销设备（active → revoked + revokedAt 回填）。
 *
 * 严格条件：仅当 deviceId 存在且 status=active 时撤销。
 * 重复撤销（已 revoked）返回 null——避免覆盖 revokedAt 时间戳，保留首次撤销时间。
 * 不存在的 deviceId 返回 null。
 */
export async function revokeDevice(deviceId: string): Promise<DesktopDevice | null> {
  const result = await db
    .update(desktopDevice)
    .set({
      status: "revoked",
      revokedAt: sql`NOW()`,
      updatedAt: sql`NOW(3)`,
    })
    .where(and(eq(desktopDevice.deviceId, deviceId), eq(desktopDevice.status, "active")));
  // affectedRows = 0 表示无 active 设备被撤销（已 revoked 或不存在）
  if (result[0].affectedRows === 0) {
    return null;
  }
  const [row] = await db
    .select()
    .from(desktopDevice)
    .where(eq(desktopDevice.deviceId, deviceId))
    .limit(1);
  return row ?? null;
}

/**
 * 按 deviceId + userId 获取设备（owner guard 双重校验）。
 *
 * HTTP 入口在读写设备前必须用此 helper，避免裸 deviceId 越权（A 用户读取 B 用户的设备）。
 * 不属于该 userId 返回 null（HTTP 入口据此返回 404）。
 */
export async function getDeviceForUser(
  deviceId: string,
  userId: string,
): Promise<DesktopDevice | null> {
  const [row] = await db
    .select()
    .from(desktopDevice)
    .where(and(eq(desktopDevice.deviceId, deviceId), eq(desktopDevice.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * 检查设备是否活跃（status=active）。
 * 不存在的设备返回 false（保守默认：未知设备不视为活跃）。
 */
export async function isDeviceActive(deviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: desktopDevice.status })
    .from(desktopDevice)
    .where(eq(desktopDevice.deviceId, deviceId))
    .limit(1);
  return row?.status === "active";
}
