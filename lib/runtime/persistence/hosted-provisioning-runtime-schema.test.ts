/**
 * HostedProvisioningRequest runtime-target schema 约束集成测试（真实 MySQL 8）。
 *
 * 专题01 冻结架构（tests 阶段）：
 * - HostedProvisioningRequest 只表示 tenant 内 builtin Harness Runtime 在某 route scope
 *   的供应请求，身份中不得包含 Agent/AgentRevision。
 * - 干净 schema 列必须排除 agentId / agentRevisionId / desiredRuntimeKey /
 *   stepAgentRevisionId / stepAgentPublicationRecordId。
 * - 必须包含非空 requesterId（供首次创建 Runtime 记录 owner）。
 * - 唯一自然键为 (tenantId, routeScopeKey)，拒绝重复。
 *
 * 当前生产 schema 尚未迁移（仍含 agentId/agentRevisionId/desiredRuntimeKey NOT NULL、
 * 无 requesterId、唯一键为 tenant+agentRevision+scope+runtimeKey），以下用例用真实
 * DB 行为演示缺失冻结约束导致的 RED。必须使用真实 MySQL，不可用 in-memory/mock。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { tenant } from "@/lib/persistence/schema/identity";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-29T00:00:00.000Z");

const MYSQL_ERRNO = {
  NOT_NULL: 1048,
  CHECK: 3819,
  DUPLICATE: 1062,
} as const;

/** 约束拒绝可接受的 errno 类：NOT NULL(1048) / CHECK(3819) / DUPLICATE(1062)。 */
const EXPECTED_CONSTRAINT_ERRNOS = new Set<number>([
  MYSQL_ERRNO.NOT_NULL,
  MYSQL_ERRNO.CHECK,
  MYSQL_ERRNO.DUPLICATE,
]);

beforeEach(async () => {
  await resetDatabase(db);
});

/** 沿 cause 链取首个 mysql2 errno；取不到返回 null。 */
function extractMysqlErrno(error: unknown): number | null {
  const seen = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (seen.has(current)) break;
    seen.add(current);
    const e = current as { errno?: unknown; cause?: unknown };
    if (typeof e.errno === "number") return e.errno;
    current = e.cause;
  }
  return null;
}

/** 期待给定 insert 被 DB 接受；若 DB 拒绝则测试失败（保留具体 errno 与 cause）。 */
async function expectAccepted(operation: Promise<unknown>, why: string): Promise<void> {
  try {
    await operation;
    return;
  } catch (error) {
    const errno = extractMysqlErrno(error);
    throw new Error(`[RED] 预期被 DB 接受但实际被拒绝（errno=${errno}）：${why}`, {
      cause: error,
    } as ErrorOptions);
  }
}

/** 期待给定 insert 因 CHECK/唯一/NOT NULL 约束被 DB 拒绝（保留 errno 与 cause）。 */
async function expectConstraintRejection(operation: Promise<unknown>, why: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const errno = extractMysqlErrno(error);
    if (errno === null || !EXPECTED_CONSTRAINT_ERRNOS.has(errno)) {
      throw new Error(
        `[RED] 约束拒绝 errno=${errno} 不属于预期类（NOT NULL 1048/CHECK 3819/DUPLICATE 1062）：${why}`,
        { cause: error } as ErrorOptions,
      );
    }
    return;
  }
  throw new Error(`[RED] 预期被约束拒绝但实际插入成功：${why}`);
}

/** 读取 HostedProvisioningRequest 当前存在的列名集合。 */
async function tableColumns(): Promise<Set<string>> {
  const [rows] = await db.execute(
    sql`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'HostedProvisioningRequest'`,
  );
  return new Set((rows as unknown as { COLUMN_NAME: string }[]).map((r) => r.COLUMN_NAME));
}

/** 读取唯一索引 (active_uq) 的列序列（按 SEQ_IN_INDEX 排序）。 */
async function activeUqColumns(): Promise<string[]> {
  const [rows] = await db.execute(
    sql`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'HostedProvisioningRequest'
          AND INDEX_NAME = 'HostedProvisioningRequest_active_uq'
        ORDER BY SEQ_IN_INDEX`,
  );
  return (rows as unknown as { COLUMN_NAME: string }[]).map((r) => r.COLUMN_NAME);
}

/** 用干净（冻结）形状向 HostedProvisioningRequest 插入一行。 */
function insertFrozenRow(
  tenantId: string,
  requesterId: string,
  routeScopeKey: string,
): Promise<unknown> {
  return db.execute(
    sql`INSERT INTO \`HostedProvisioningRequest\`
        (id, tenantId, requesterId, routeScopeKey, state, createdAt, updatedAt)
        VALUES (${randomUUID()}, ${tenantId}, ${requesterId}, ${routeScopeKey}, 'pending', ${NOW}, ${NOW})`,
  );
}

describe("HostedProvisioningRequest frozen runtime schema", () => {
  it("[RED] requesterId 列必须存在且 NOT NULL", async () => {
    const [rows] = await db.execute(
      sql`SELECT IS_NULLABLE, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'HostedProvisioningRequest'
            AND COLUMN_NAME = 'requesterId'`,
    );
    const row = (rows as unknown as { IS_NULLABLE: string; COLUMN_NAME: string }[])[0];
    if (!row) {
      throw new Error("[RED] requesterId 列不存在——schema 尚未迁移，无法验证非空 owner 字段");
    }
    expect(row.IS_NULLABLE).toBe("NO");
  });

  it.each(["agentId", "agentRevisionId", "desiredRuntimeKey"])(
    "[RED] 身份列 %s 不得存在于干净 schema",
    async (col) => {
      const cols = await tableColumns();
      expect(cols.has(col)).toBe(false);
    },
  );

  it.each(["stepAgentRevisionId", "stepAgentPublicationRecordId"])(
    "[RED] Agent publication checkpoint 列 %s 不得存在于干净 schema",
    async (col) => {
      const cols = await tableColumns();
      expect(cols.has(col)).toBe(false);
    },
  );

  it("[RED] 唯一自然键必须是 (tenantId, routeScopeKey)", async () => {
    const cols = await activeUqColumns();
    expect(cols).toEqual(["tenantId", "routeScopeKey"]);
  });

  it("[RED] 合法冻结行（仅 tenantId+requesterId+routeScopeKey）必须被接受", async () => {
    const { id: tenantId } = await ensureDefaultTenant();
    await expectAccepted(
      insertFrozenRow(tenantId, "requester-1", "prod"),
      "仅 tenantId+requesterId+routeScopeKey 的合法冻结行应被接受",
    );
  });

  it("[RED] 同 (tenantId, routeScopeKey) 第二行必须被唯一约束拒绝", async () => {
    const { id: tenantId } = await ensureDefaultTenant();
    await expectAccepted(
      insertFrozenRow(tenantId, "requester-1", "prod"),
      "第一行（合法冻结形状）应先被接受",
    );
    await expectConstraintRejection(
      insertFrozenRow(tenantId, "requester-2", "prod"),
      "同 (tenantId, routeScopeKey) 第二行应被唯一约束拒绝",
    );
  });

  it("[RED] 不同 tenant 相同 routeScopeKey 可共存（租户隔离唯一性）", async () => {
    // FK 必须指向真实租户：默认租户 + 真实第二个租户，杜绝 FK(1452) 假阳性。
    const defaultTenant = await ensureDefaultTenant();
    const secondTenantId = randomUUID();
    await db.insert(tenant).values({
      id: secondTenantId,
      key: `tenant-${secondTenantId.slice(0, 8)}`,
      name: "Second Tenant",
      status: "active",
    });
    await expectAccepted(
      insertFrozenRow(defaultTenant.id, "requester-1", "prod"),
      "默认租户 frozen 行应先被接受",
    );
    await expectAccepted(
      insertFrozenRow(secondTenantId, "requester-2", "prod"),
      "第二个租户同 scope 应被接受（租户隔离）",
    );
    const [rows] = await db.execute(
      sql`SELECT tenantId, COUNT(*) AS n FROM \`HostedProvisioningRequest\`
          GROUP BY tenantId ORDER BY tenantId`,
    );
    const counts = (rows as unknown as { tenantId: string; n: number }[]).map((r) => Number(r.n));
    expect(counts).toEqual([1, 1]);
  });
});
