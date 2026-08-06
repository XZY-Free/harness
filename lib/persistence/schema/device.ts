/**
 * 设备 schema：从 DesktopDevice 迁移的多端可信设备身份。
 *
 * 阶段 2（）：建立 Desktop 请求的设备签名校验与租户/员工绑定。
 *
 * 与 DesktopDevice 的差异（10-core-data-model.md 、§10 迁移映射）：
 * - 新增 tenantId（缺失，必填）。
 * - deviceId → deviceKey，并改为 UNIQUE(tenantId, deviceKey)（V10 是全局 UNIQUE(deviceId)）。
 * - name → deviceName、version → appVersion。
 * - status → deviceState（公共字段规则禁止裸 status 列，10-core-data-model.md:28）。
 * - userId 引用 UserIdentity 而非旧 User 表（不再直接引用旧 User 表）。
 *
 * 私钥只在 Desktop Keychain，不写 DB（与 V10 一致）。
 * 事实源：../v11-agentkit-platform/10-core-data-model.md 。
 */
import { randomUUID } from "node:crypto";
import { tenant, userIdentity } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
 datetime,
 index,
 mysqlEnum,
 mysqlTable,
 text,
 uniqueIndex,
 varchar,
} from "drizzle-orm/mysql-core";

/** 设备状态：active（可签名）/ revoked（撤销后不可恢复）。 */
export const DEVICE_STATES = ["active", "revoked"] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];

export const device = mysqlTable(
 "Device",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 绑定员工（引用 UserIdentity 稳定 id）。 */
 userId: varchar("userId", { length: 36 })
 .notNull()
 .references(() => userIdentity.id),
 /** 租户内稳定唯一键（Desktop 本地生成的 uuid 或稳定硬件指纹）。 */
 deviceKey: varchar("deviceKey", { length: 128 }).notNull(),
 /** ed25519 公钥（base64）。Server 仅记录用于验签，私钥不入库。 */
 publicKey: text("publicKey").notNull(),
 deviceName: varchar("deviceName", { length: 256 }).notNull(),
 appVersion: varchar("appVersion", { length: 32 }).notNull(),
 deviceState: mysqlEnum("deviceState", DEVICE_STATES).notNull().default("active"),
 lastActiveAt: datetime("lastActiveAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 /** 撤销时间；null = 未撤销。撤销后不可恢复（10-core-data-model.md:46）。 */
 revokedAt: datetime("revokedAt", { mode: "date" }),
 createdAt: datetime("createdAt", { mode: "date" })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 tenantKeyUq: uniqueIndex("Device_tenant_key_uq").on(t.tenantId, t.deviceKey),
 tenantUserIdx: index("Device_tenant_user_idx").on(t.tenantId, t.userId),
 tenantStateIdx: index("Device_tenant_state_idx").on(t.tenantId, t.deviceState),
 }),
);

export type Device = InferSelectModel<typeof device>;
export type NewDevice = InferInsertModel<typeof device>;
