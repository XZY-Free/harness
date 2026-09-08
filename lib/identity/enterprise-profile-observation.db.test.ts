import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  EnterpriseProfileAcceptanceError,
  acceptEnterpriseProfileObservation,
} from "@/lib/identity/accept-enterprise-profile-observation";
import type {
  EnterpriseProfileObservation,
  EnterpriseProfileSource,
} from "@/lib/identity/enterprise-profile-source";
import { getEnterpriseUserProfileFacts } from "@/lib/identity/enterprise-user-profile-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { getUserIdentityById, upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import mysql from "mysql2/promise";
import { beforeEach, describe, expect, it } from "vitest";

const LOCK_WAIT_POLL_INTERVAL_MS = 50;
const LOCK_WAIT_POLL_BOUND_MS = 5_000;

/** 测试专用：用普通测试库凭据（DATABASE_URL）开一个独立连接，充当行锁持有者 C。 */
async function openAppConnection(): Promise<mysql.Connection> {
  return mysql.createConnection(process.env.DATABASE_URL!);
}

/**
 * 测试专用：用 testcontainers 根账号（harness 设 root 密码为 test）派生一个只读观测连接，
 * 用于读取 performance_schema 锁等待。绝不打印 URL/口令。
 */
async function openRootObserverConnection(): Promise<mysql.Connection> {
  const url = new URL(process.env.DATABASE_URL!);
  url.username = "root"; // 隐式继承现有口令（testcontainers root/test 口令一致）。
  return mysql.createConnection(url.toString());
}

/** 当前连接的 MySQL processlist id（CONNECTION_ID），任何账号都可读取。 */
async function processlistId(conn: mysql.Connection): Promise<number> {
  const [rows] = (await conn.query("SELECT CONNECTION_ID() AS connection_id")) as [
    Array<{ connection_id: number }>,
    unknown,
  ];
  return rows[0]!.connection_id;
}

/** 在根观测连接上把 processlist id 映射为 performance_schema THREAD_ID。 */
async function currentThreadId(observer: mysql.Connection, processlist: number): Promise<number> {
  const [rows] = (await observer.query(
    "SELECT THREAD_ID AS thread_id FROM performance_schema.threads WHERE PROCESSLIST_ID = ?",
    [processlist],
  )) as [Array<{ thread_id: number }>, unknown];
  return rows[0]!.thread_id;
}

/**
 * 轮询 performance_schema.data_lock_waits，直到出现满足 whereSql 的活动锁等待。
 * 返回命中的等待行；在 bound 内未命中则返回空数组（fixture 守卫，非产品超时）。
 */
async function pollActiveLockWaits(
  conn: mysql.Connection,
  whereSql: string,
  params: unknown[],
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + LOCK_WAIT_POLL_BOUND_MS;
  while (Date.now() < deadline) {
    const [rows] = (await conn.query(
      `SELECT REQUESTING_THREAD_ID AS requesting_thread_id,
              BLOCKING_THREAD_ID AS blocking_thread_id
         FROM performance_schema.data_lock_waits
        WHERE ENGINE = 'InnoDB' AND ${whereSql}`,
      params,
    )) as [Array<Record<string, unknown>>, unknown];
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_POLL_INTERVAL_MS));
  }
  return [];
}

beforeEach(async () => {
  await resetDatabase(db);
});

const source: EnterpriseProfileSource = {
  sourceSystem: "directory",
  trusted: true,
  maxFreshAgeMs: 60 * 60_000,
  maxStaleAgeMs: 2 * 60 * 60_000,
};

describe("acceptEnterpriseProfileObservation", () => {
  it("只保存企业属性和期限，不改写标准身份字段", async () => {
    const tenant = await ensureDefaultTenant();
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "employee-accept-1",
      email: "old@example.test",
      displayName: "旧名称",
    });
    const observation: EnterpriseProfileObservation = {
      tenantId: tenant.id,
      externalSubject: identity.externalSubject,
      sourceSystem: source.sourceSystem,
      attributes: { employeeNo: "E-1", departmentCode: "D-1" },
      verifiedAt: new Date("2026-09-07T00:00:00.000Z"),
      freshUntil: new Date("2026-09-07T00:30:00.000Z"),
      staleUntil: new Date("2026-09-07T01:30:00.000Z"),
    };

    await acceptEnterpriseProfileObservation({
      observation,
      source,
      expectedSubject: {
        tenantId: tenant.id,
        userIdentityId: identity.id,
        externalSubject: identity.externalSubject,
      },
      now: observation.verifiedAt,
    });

    const facts = await getEnterpriseUserProfileFacts(tenant.id, identity.id);
    expect(await getUserIdentityById(identity.id)).toMatchObject({
      email: "old@example.test",
      displayName: "旧名称",
    });
    expect(facts?.attributes.map((row) => row.attributeKey).sort()).toEqual([
      "departmentCode",
      "employeeNo",
    ]);
    expect(facts?.syncState).toMatchObject({
      freshUntil: observation.freshUntil,
      staleUntil: observation.staleUntil,
    });
  });

  it("相同观察不得用更晚期限滑动续期", async () => {
    const tenant = await ensureDefaultTenant();
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "employee-accept-2",
      email: "employee@example.test",
      displayName: "员工",
    });
    const observation: EnterpriseProfileObservation = {
      tenantId: tenant.id,
      externalSubject: identity.externalSubject,
      sourceSystem: source.sourceSystem,
      attributes: { employeeNo: "E-2" },
      verifiedAt: new Date("2026-09-07T00:00:00.000Z"),
      freshUntil: new Date("2026-09-07T00:30:00.000Z"),
      staleUntil: new Date("2026-09-07T01:30:00.000Z"),
    };
    await acceptEnterpriseProfileObservation({
      observation,
      source,
      expectedSubject: {
        tenantId: tenant.id,
        userIdentityId: identity.id,
        externalSubject: identity.externalSubject,
      },
      now: observation.verifiedAt,
    });

    await expect(
      acceptEnterpriseProfileObservation({
        observation: {
          ...observation,
          freshUntil: new Date("2026-09-07T00:40:00.000Z"),
          staleUntil: new Date("2026-09-07T01:40:00.000Z"),
        },
        source,
        expectedSubject: {
          tenantId: tenant.id,
          userIdentityId: identity.id,
          externalSubject: identity.externalSubject,
        },
        now: observation.verifiedAt,
      }),
    ).rejects.toBeInstanceOf(EnterpriseProfileAcceptanceError);

    const facts = await getEnterpriseUserProfileFacts(tenant.id, identity.id);
    expect(facts?.syncState?.freshUntil).toEqual(observation.freshUntil);
  });
});

describe("getEnterpriseUserProfileFacts 与写并发的一致性（F05-A）", () => {
  it("读取器 A 与写入器 B 竞争时返回完整 A 或完整 B，绝不返回混合快照", async () => {
    const tenant = await ensureDefaultTenant();
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "employee-race-f05",
      email: "race@example.test",
      displayName: "竞态员工",
    });
    const expectedSubject = {
      tenantId: tenant.id,
      userIdentityId: identity.id,
      externalSubject: identity.externalSubject,
    };

    const observationA: EnterpriseProfileObservation = {
      tenantId: tenant.id,
      externalSubject: identity.externalSubject,
      sourceSystem: source.sourceSystem,
      attributes: { employeeNo: "E-A", departmentCode: "D-A" },
      verifiedAt: new Date("2026-09-07T00:00:00.000Z"),
      freshUntil: new Date("2026-09-07T00:30:00.000Z"),
      staleUntil: new Date("2026-09-07T01:00:00.000Z"),
    };
    // 通过真实接纳链路写入完整资料 A。
    const acceptedA = await acceptEnterpriseProfileObservation({
      observation: observationA,
      source,
      expectedSubject,
      now: observationA.verifiedAt,
    });
    const seedFacts = await getEnterpriseUserProfileFacts(tenant.id, identity.id);
    const lockedAttributeId = seedFacts!.attributes[0]!.id;

    const observationB: EnterpriseProfileObservation = {
      tenantId: tenant.id,
      externalSubject: identity.externalSubject,
      sourceSystem: source.sourceSystem,
      attributes: { employeeNo: "E-B", departmentCode: "D-B" },
      verifiedAt: new Date("2026-09-07T02:00:00.000Z"),
      freshUntil: new Date("2026-09-07T02:30:00.000Z"),
      staleUntil: new Date("2026-09-07T03:00:00.000Z"),
    };

    const connC = await openAppConnection();
    const connO = await openRootObserverConnection();
    let readerPromise: ReturnType<typeof getEnterpriseUserProfileFacts> | null = null;
    let writerPromise: ReturnType<typeof acceptEnterpriseProfileObservation> | null = null;
    try {
      // 独立连接 C 锁定 A 的一条属性行，并保持事务打开。
      await connC.query("START TRANSACTION");
      await connC.query("SELECT id FROM UserExtensionAttribute WHERE id = ? FOR UPDATE", [
        lockedAttributeId,
      ]);
      const threadIdC = await currentThreadId(connO, await processlistId(connC));

      // 启动公共读取器 A。
      readerPromise = getEnterpriseUserProfileFacts(tenant.id, identity.id);

      // 读取器必须被 C 的行锁阻塞（当前读/事务行为）。当前实现是非锁定快照读，不会等待 → RED。
      const readerWait = await pollActiveLockWaits(connO, "BLOCKING_THREAD_ID = ?", [threadIdC]);
      expect(
        readerWait.length,
        "预期公共读取器读取企业属性时被连接 C 的行锁阻塞（缺少当前读/事务），但未观察到任何锁等待",
      ).toBeGreaterThan(0);

      // 读取器已被阻塞并持有 UserIdentity 共享锁；启动真实接纳写入器 B，验证其等待读取器的共享锁。
      const readerThreadId = Number(readerWait[0]!.requesting_thread_id);
      writerPromise = acceptEnterpriseProfileObservation({
        observation: observationB,
        source,
        expectedSubject,
        now: observationB.verifiedAt,
      });
      const writerWait = await pollActiveLockWaits(connO, "BLOCKING_THREAD_ID = ?", [
        readerThreadId,
      ]);
      expect(
        writerWait.length,
        "预期接纳写入器 B 被读取器持有的共享 UserIdentity 锁阻塞，但未观察到锁等待",
      ).toBeGreaterThan(0);
    } finally {
      // 释放 C 的行锁；无论断言是否失败都恢复连接。
      try {
        await connC.rollback();
      } catch {
        // 连接已关闭则忽略。
      }
      // 观察已启动的 promise（防未处理拒绝/挂起）；C 的锁已释放，读取器/写入器可正常收敛。
      if (readerPromise) await readerPromise.catch(() => {});
      if (writerPromise) await writerPromise.catch(() => {});
      await connC.end();
      await connO.end();
    }

    // 释放 C 后：读取器读到完整 A，写入器提交完整 B。
    const readerFacts = await readerPromise!;
    const writerResult = await writerPromise!;

    expect(
      readerFacts?.attributes.find((row) => row.attributeKey === "employeeNo")?.stringValue,
    ).toBe("E-A");
    expect(
      readerFacts?.attributes.find((row) => row.attributeKey === "departmentCode")?.stringValue,
    ).toBe("D-A");
    expect(readerFacts?.syncState).toMatchObject({
      profileFingerprint: acceptedA.profileFingerprint,
      freshUntil: acceptedA.freshUntil,
      staleUntil: acceptedA.staleUntil,
    });

    // 最终公共读必须是完整 B，且无任何 A 残留。
    const finalFacts = await getEnterpriseUserProfileFacts(tenant.id, identity.id);
    expect(
      finalFacts?.attributes.find((row) => row.attributeKey === "employeeNo")?.stringValue,
    ).toBe("E-B");
    expect(
      finalFacts?.attributes.find((row) => row.attributeKey === "departmentCode")?.stringValue,
    ).toBe("D-B");
    expect(finalFacts?.syncState).toMatchObject({
      profileFingerprint: writerResult.profileFingerprint,
      freshUntil: writerResult.freshUntil,
      staleUntil: writerResult.staleUntil,
    });
    expect(writerResult.profileFingerprint).not.toBe(acceptedA.profileFingerprint);
  });
});
