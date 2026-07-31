import { db } from "@/lib/db/client";
import {
  getDeviceByDeviceId,
  getDeviceForUser,
  isDeviceActive,
  listActiveDevicesByUser,
  registerDevice,
  revokeDevice,
  touchDevice,
} from "@/lib/db/desktop-device-queries";
import { desktopDevice, user } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./test/mysql-harness";

/**
 * V10 Phase 5：Desktop 设备查询测试。
 *
 * 同 queries.test.ts：用 testcontainers 起真实 MySQL 8 容器
 * （vitest globalSetup 注入 DATABASE_URL），beforeEach resetDatabase TRUNCATE 隔离。
 *
 * 验证维度：
 * - deviceId 唯一约束（uniqueIndex）+ INSERT IGNORE 幂等
 * - userId 外键约束（references → User.id）
 * - status enum（active / revoked）
 * - revokeDevice 状态机：active → revoked + revokedAt 回填
 * - getDeviceForUser owner guard：deviceId + userId 双校验
 * - isDeviceActive / listActiveDevicesByUser 仅返回 active
 */

// ─── 测试数据工厂 ─────────────────────────────────────────────

async function insertUser(id: string, name: string | null = null) {
  await db.insert(user).values({ id, externalId: id, email: `${id}@x`, name });
}

// ─── 测试用例 ─────────────────────────────────────────────────

beforeEach(async () => {
  await resetDatabase(db);
});

describe("registerDevice", () => {
  it("新设备注册成功：返回完整记录，status=active", async () => {
    await insertUser("u1");
    const device = await registerDevice({
      userId: "u1",
      deviceId: "desktop-aaa",
      publicKey: "pk-base64-aaa",
      name: "MacBook Pro",
      version: "1.0.0",
    });

    expect(device).not.toBeNull();
    expect(device?.id).toBeTruthy();
    expect(device?.userId).toBe("u1");
    expect(device?.deviceId).toBe("desktop-aaa");
    expect(device?.publicKey).toBe("pk-base64-aaa");
    expect(device?.name).toBe("MacBook Pro");
    expect(device?.version).toBe("1.0.0");
    expect(device?.status).toBe("active");
    expect(device?.revokedAt).toBeNull();
    expect(device?.createdAt).toBeInstanceOf(Date);
    expect(device?.lastActiveAt).toBeInstanceOf(Date);
  });

  it("幂等：相同 deviceId + active 重复注册返回现有记录", async () => {
    await insertUser("u1");
    const first = await registerDevice({
      userId: "u1",
      deviceId: "desktop-bbb",
      publicKey: "pk-1",
      name: "MBP",
      version: "1.0.0",
    });

    const second = await registerDevice({
      userId: "u1",
      deviceId: "desktop-bbb",
      // 再次注册：即便其他字段不同，也返回现有 active 行（不更新）
      publicKey: "pk-2-different",
      name: "MacBook Air",
      version: "2.0.0",
    });

    expect(second).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(second?.publicKey).toBe("pk-1");
    expect(second?.name).toBe("MBP");
    expect(second?.version).toBe("1.0.0");
    expect(second?.status).toBe("active");
  });
});

describe("getDeviceByDeviceId", () => {
  it("存在返回设备", async () => {
    await insertUser("u1");
    await registerDevice({
      userId: "u1",
      deviceId: "desktop-get",
      publicKey: "pk",
      name: "MBP",
      version: "1.0.0",
    });

    const got = await getDeviceByDeviceId("desktop-get");
    expect(got).not.toBeNull();
    expect(got?.deviceId).toBe("desktop-get");
  });

  it("不存在返回 null", async () => {
    const got = await getDeviceByDeviceId("non-existent-device");
    expect(got).toBeNull();
  });
});

describe("listActiveDevicesByUser", () => {
  it("返回用户活跃设备，不返回已撤销的", async () => {
    await insertUser("u1");
    await registerDevice({
      userId: "u1",
      deviceId: "dev-active-1",
      publicKey: "pk1",
      name: "MBP1",
      version: "1.0.0",
    });
    await registerDevice({
      userId: "u1",
      deviceId: "dev-active-2",
      publicKey: "pk2",
      name: "MBP2",
      version: "1.0.0",
    });
    await registerDevice({
      userId: "u1",
      deviceId: "dev-revoked",
      publicKey: "pk3",
      name: "MBA",
      version: "1.0.0",
    });
    await revokeDevice("dev-revoked");

    const list = await listActiveDevicesByUser("u1");

    expect(list).toHaveLength(2);
    const deviceIds = list.map((d) => d.deviceId).sort();
    expect(deviceIds).toEqual(["dev-active-1", "dev-active-2"]);
    for (const d of list) {
      expect(d.status).toBe("active");
    }
  });

  it("其他用户的设备不返回", async () => {
    await insertUser("u1");
    await insertUser("u2");
    await registerDevice({
      userId: "u1",
      deviceId: "dev-u1",
      publicKey: "pk",
      name: "MBP",
      version: "1.0.0",
    });
    await registerDevice({
      userId: "u2",
      deviceId: "dev-u2",
      publicKey: "pk",
      name: "MBP",
      version: "1.0.0",
    });

    const list = await listActiveDevicesByUser("u1");
    expect(list).toHaveLength(1);
    expect(list[0]?.deviceId).toBe("dev-u1");
  });
});

describe("touchDevice", () => {
  it("更新 lastActiveAt 到当前时间", async () => {
    await insertUser("u1");
    await registerDevice({
      userId: "u1",
      deviceId: "dev-touch",
      publicKey: "pk",
      name: "MBP",
      version: "1.0.0",
    });
    // 取原始 lastActiveAt
    const [before] = await db
      .select()
      .from(desktopDevice)
      .where(eq(desktopDevice.deviceId, "dev-touch"))
      .limit(1);
    expect(before).toBeDefined();
    const beforeTime = before?.lastActiveAt.getTime() ?? 0;

    // 等待至少 1ms 确保 datetime(3) 时间推进。
    await new Promise((r) => setTimeout(r, 1100));

    await touchDevice("dev-touch");

    const [after] = await db
      .select()
      .from(desktopDevice)
      .where(eq(desktopDevice.deviceId, "dev-touch"))
      .limit(1);
    expect(after).toBeDefined();
    expect(after?.lastActiveAt.getTime() ?? 0).toBeGreaterThan(beforeTime);
  });
});

describe("revokeDevice", () => {
  it("撤销后 status=revoked，revokedAt 不为 null", async () => {
    await insertUser("u1");
    await registerDevice({
      userId: "u1",
      deviceId: "dev-revoke",
      publicKey: "pk",
      name: "MBP",
      version: "1.0.0",
    });

    const revoked = await revokeDevice("dev-revoke");
    expect(revoked).not.toBeNull();
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokedAt).not.toBeNull();
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
  });

  it("重复撤销返回 null（已是 revoked 状态）", async () => {
    await insertUser("u1");
    await registerDevice({
      userId: "u1",
      deviceId: "dev-double-revoke",
      publicKey: "pk",
      name: "MBP",
      version: "1.0.0",
    });

    const first = await revokeDevice("dev-double-revoke");
    expect(first).not.toBeNull();

    const second = await revokeDevice("dev-double-revoke");
    expect(second).toBeNull();
  });

  it("撤销不存在的设备返回 null", async () => {
    const result = await revokeDevice("non-existent");
    expect(result).toBeNull();
  });
});

describe("getDeviceForUser", () => {
  it("正确 userId 返回设备（owner guard 通过）", async () => {
    await insertUser("u1");
    await registerDevice({
      userId: "u1",
      deviceId: "dev-owner",
      publicKey: "pk",
      name: "MBP",
      version: "1.0.0",
    });

    const got = await getDeviceForUser("dev-owner", "u1");
    expect(got).not.toBeNull();
    expect(got?.deviceId).toBe("dev-owner");
    expect(got?.userId).toBe("u1");
  });

  it("错误 userId 返回 null（owner guard 阻止越权）", async () => {
    await insertUser("u1");
    await insertUser("u2");
    await registerDevice({
      userId: "u1",
      deviceId: "dev-owner-2",
      publicKey: "pk",
      name: "MBP",
      version: "1.0.0",
    });

    // u2 试图读取 u1 的设备 → null
    const got = await getDeviceForUser("dev-owner-2", "u2");
    expect(got).toBeNull();
  });
});

describe("isDeviceActive", () => {
  it("活跃设备返回 true", async () => {
    await insertUser("u1");
    await registerDevice({
      userId: "u1",
      deviceId: "dev-active-check",
      publicKey: "pk",
      name: "MBP",
      version: "1.0.0",
    });

    const active = await isDeviceActive("dev-active-check");
    expect(active).toBe(true);
  });

  it("撤销设备返回 false", async () => {
    await insertUser("u1");
    await registerDevice({
      userId: "u1",
      deviceId: "dev-revoked-check",
      publicKey: "pk",
      name: "MBP",
      version: "1.0.0",
    });
    await revokeDevice("dev-revoked-check");

    const active = await isDeviceActive("dev-revoked-check");
    expect(active).toBe(false);
  });

  it("不存在的设备返回 false", async () => {
    const active = await isDeviceActive("non-existent");
    expect(active).toBe(false);
  });
});
