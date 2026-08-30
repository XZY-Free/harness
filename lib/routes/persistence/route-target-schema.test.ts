/**
 * Route target 持久化 schema 约束集成测试（真实 MySQL 8）。
 *
 * 专题01 冻结架构（tests 阶段）：
 * - DeploymentRouteSet：targetIdentity NOT NULL，UNIQUE(tenantId,targetKind,targetIdentity,
 *   routeScopeKey)，CHECK 保证 targetKind/agentId/targetIdentity 一致。runtime NULL 不得绕过唯一性。
 * - DeploymentRoute：CHECK 要求 runtimeRevisionId/agentRevisionId 恰好一个非空。
 * - RouteRevision：runtime 组（runtimeRevisionId 非空，Agent 事实全 null）与 agent 组
 *   （agent 事实非空、runtimeRevisionId null）互斥；bearer 必须带 credentialRefId。
 * 当前生产 schema 尚未迁移，以下用例用真实 DB 行为演示缺失约束导致的 RED。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { tenant } from "@/lib/persistence/schema/identity";
import {
  type NewDeploymentRouteSetRow,
  deploymentRouteSetTable,
  deploymentRouteTable,
} from "@/lib/persistence/schema/routes";
import { routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-29T00:00:00.000Z");

const MYSQL_ERRNO = {
  UNKNOWN_COLUMN: 1054,
  NOT_NULL: 1048,
  CHECK: 3819,
  DUPLICATE: 1062,
  ENUM_VALUE: 1265,
  FK: 1452,
} as const;

/** 约束拒绝可接受的 errno 类：NOT NULL(1048) / CHECK(3819) / DUPLICATE(1062)。 */
const EXPECTED_CONSTRAINT_ERRNOS = new Set<number>([
  MYSQL_ERRNO.NOT_NULL,
  MYSQL_ERRNO.CHECK,
  MYSQL_ERRNO.DUPLICATE,
  MYSQL_ERRNO.ENUM_VALUE,
]);

/**
 * 插入一个非默认租户（直接写 Tenant 表），返回其 id。
 * 用于跨租户共存用例：FK 必须指向真实租户，杜绝 FK(1452) 假阳性。
 */
async function seedSecondTenant(): Promise<string> {
  const id = randomUUID();
  await db.insert(tenant).values({
    id,
    key: `tenant-${id.slice(0, 8)}`,
    name: "Second Tenant",
    status: "active",
  });
  return id;
}

/**
 * 冻结后 RouteSet 必须携带非空 targetIdentity（当前 Drizzle schema 尚无该列）。
 * 通过 test-local cast 让 seed 携带最终 targetIdentity：schema 迁移后该字段成为真实
 * 必填列 seed 依然合法；迁移前 drizzle 丢弃未知键，行为不变。
 */
type RouteSetSeedRow = NewDeploymentRouteSetRow & { targetIdentity: string };

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

/** 校验 DeploymentRouteSet 已迁移出 targetIdentity 列（防假阳性的前置断言）。 */
async function expectTargetIdentityColumnExists(): Promise<void> {
  const [rows] = (await db.execute(
    sql`SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeploymentRouteSet'
          AND COLUMN_NAME = 'targetIdentity'`,
  )) as unknown as [[{ n: number }]];
  const row = rows[0];
  if (!row || Number(row.n) !== 1) {
    throw new Error(
      "[RED] DeploymentRouteSet.targetIdentity 列不存在——schema 尚未迁移，无法验证目标约束",
    );
  }
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
    // 只接受目标约束类 errno。FK(1452)/unknown column(1054)/其他一律视为假阳性：
    // 列未迁移或外键不满足都不能证明"约束拒绝"这一行为。
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

/** 期待给定 insert 被 DB 接受；被拒时返回具体 errno（供调用方自行判读）。 */
async function tryAccept(operation: Promise<unknown>): Promise<number | null> {
  try {
    await operation;
    return null;
  } catch (error) {
    return extractMysqlErrno(error);
  }
}

describe("DeploymentRouteSet target schema", () => {
  async function seedRuntimeRouteSet(tenantId: string, scopeKey: string) {
    const id = randomUUID();
    await db.insert(deploymentRouteSetTable).values({
      id,
      tenantId,
      targetKind: "runtime",
      agentId: null,
      routeScopeKey: scopeKey,
      routeScopeJson: {},
      versionNo: 1,
      createdAt: NOW,
      updatedAt: NOW,
      // 冻结最终形态：runtime targetIdentity='runtime'（当前 schema 尚无该列，cast 透传）。
      targetIdentity: "runtime",
    } as RouteSetSeedRow);
    return id;
  }

  it("[RED] runtime NULL 不得绕过 UNIQUE：同 tenant/scope 第二个 runtime 必须被拒绝", async () => {
    // 冻结设计 targetIdentity NOT NULL + UNIQUE(tenantId,targetKind,targetIdentity,scope)
    // 应拒绝第二个 runtime。当前唯一索引 (tenantId,agentId,scope) 中 agentId=NULL 不参与
    // 比较 → 两个 runtime 可同时插入，唯一性被 NULL 绕过。
    const { id: tenantId } = await ensureDefaultTenant();
    await seedRuntimeRouteSet(tenantId, "prod");
    await expectConstraintRejection(
      seedRuntimeRouteSet(tenantId, "prod"),
      "同 tenant/scope 的 runtime RouteSet 应被唯一约束拒绝",
    );
  });

  it("runtime 与 agent A 相同 tenant/scope 可共存（targetIdentity 判别）", async () => {
    const { id: tenantId } = await ensureDefaultTenant();
    await seedRuntimeRouteSet(tenantId, "prod");
    await db.insert(deploymentRouteSetTable).values({
      id: randomUUID(),
      tenantId,
      targetKind: "agent",
      agentId: "agent-A",
      routeScopeKey: "prod",
      routeScopeJson: {},
      versionNo: 1,
      createdAt: NOW,
      updatedAt: NOW,
      // 冻结最终形态：agent targetIdentity=agentId（当前 schema 尚无该列，cast 透传）。
      targetIdentity: "agent-A",
    } as RouteSetSeedRow);
    const rows = await db
      .select()
      .from(deploymentRouteSetTable)
      .where(eq(deploymentRouteSetTable.tenantId, tenantId));
    expect(rows.map((r) => r.targetKind).sort()).toEqual(["agent", "runtime"]);
  });

  it("同 tenant/scope 第二个 agent A 必须被唯一约束拒绝", async () => {
    const { id: tenantId } = await ensureDefaultTenant();
    const values = {
      id: randomUUID(),
      tenantId,
      targetKind: "agent" as const,
      agentId: "agent-A",
      routeScopeKey: "prod",
      routeScopeJson: {},
      versionNo: 1,
      createdAt: NOW,
      updatedAt: NOW,
      // 冻结最终形态：agent targetIdentity=agentId（当前 schema 尚无该列，cast 透传）。
      targetIdentity: "agent-A",
    } as RouteSetSeedRow;
    await db.insert(deploymentRouteSetTable).values(values);
    await expectConstraintRejection(
      db.insert(deploymentRouteSetTable).values({ ...values, id: randomUUID() }),
      "同 tenant/scope 的 agent A RouteSet 应被唯一约束拒绝",
    );
  });

  // ─── targetIdentity 最终列（最终 Drizzle schema 形状）─────────────────

  function targetRow(overrides: Record<string, unknown>) {
    return {
      id: randomUUID(),
      tenantId: DEFAULT_TENANT_ID,
      targetKind: "runtime",
      targetIdentity: "runtime",
      agentId: null,
      routeScopeKey: "prod",
      routeScopeJson: {},
      versionNo: 1,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function insertTargetRow(row: Record<string, unknown>): Promise<unknown> {
    return db.insert(deploymentRouteSetTable).values(row as unknown as NewDeploymentRouteSetRow);
  }

  it("[RED] targetIdentity 列必须存在（INFORMATION_SCHEMA 前置断言）", async () => {
    await expectTargetIdentityColumnExists();
  });

  it("[RED] runtime 行 targetIdentity='runtime'、agentId NULL 必须被接受", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    const errno = await tryAccept(
      insertTargetRow(
        targetRow({ targetKind: "runtime", targetIdentity: "runtime", agentId: null }),
      ),
    );
    if (errno !== null) {
      throw new Error(`[RED] runtime 行应被接受，实际 errno=${errno}`, {
        cause: undefined,
      } as ErrorOptions);
    }
  });

  it("[RED] agent 行 targetIdentity=agentId 且 agentId 非空必须被接受", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    const errno = await tryAccept(
      insertTargetRow(
        targetRow({ targetKind: "agent", targetIdentity: "agent-A", agentId: "agent-A" }),
      ),
    );
    if (errno !== null) {
      throw new Error(`[RED] agent 行应被接受，实际 errno=${errno}`, {
        cause: undefined,
      } as ErrorOptions);
    }
  });

  it("[RED] targetIdentity NULL 必须被拒绝（NOT NULL）", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertTargetRow(targetRow({ targetIdentity: null })),
      "targetIdentity NULL 应被 NOT NULL 拒绝",
    );
  });

  it.each(["", "   "])("targetIdentity %j 必须被拒绝（CHECK 禁止空白）", async (value) => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertTargetRow(targetRow({ targetIdentity: value })),
      "targetIdentity 空白应被 CHECK 拒绝",
    );
  });

  it("[RED] runtime 携带 agentId 必须被拒绝（CHECK 一致）", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertTargetRow(
        targetRow({ targetKind: "runtime", targetIdentity: "runtime", agentId: "agent-A" }),
      ),
      "runtime 携带 agentId 应被 CHECK 拒绝",
    );
  });

  it("[RED] runtime 的 targetIdentity != 'runtime' 必须被拒绝（CHECK 一致）", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertTargetRow(
        targetRow({ targetKind: "runtime", targetIdentity: "agent-A", agentId: null }),
      ),
      "runtime targetIdentity!=runtime 应被 CHECK 拒绝",
    );
  });

  it("[RED] agent 携带 agentId=NULL 必须被拒绝（CHECK 一致）", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertTargetRow(targetRow({ targetKind: "agent", targetIdentity: "agent-A", agentId: null })),
      "agent 携带 agentId=NULL 应被 CHECK 拒绝",
    );
  });

  it("[RED] agent 的 targetIdentity != agentId 必须被拒绝（CHECK 一致）", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertTargetRow(
        targetRow({ targetKind: "agent", targetIdentity: "agent-B", agentId: "agent-A" }),
      ),
      "agent targetIdentity!=agentId 应被 CHECK 拒绝",
    );
  });

  it("[RED] targetIdentity 唯一：同 tenant/scope 重复 runtime 必须被拒绝", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await insertTargetRow(
      targetRow({
        targetKind: "runtime",
        targetIdentity: "runtime",
        agentId: null,
        routeScopeKey: "prod",
      }),
    );
    await expectConstraintRejection(
      insertTargetRow(
        targetRow({
          targetKind: "runtime",
          targetIdentity: "runtime",
          agentId: null,
          routeScopeKey: "prod",
        }),
      ),
      "重复 runtime targetIdentity 应被唯一约束拒绝",
    );
  });

  it("[RED] targetIdentity 唯一：同 tenant/scope 重复 agent A 必须被拒绝", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await insertTargetRow(
      targetRow({
        targetKind: "agent",
        targetIdentity: "agent-A",
        agentId: "agent-A",
        routeScopeKey: "prod",
      }),
    );
    await expectConstraintRejection(
      insertTargetRow(
        targetRow({
          targetKind: "agent",
          targetIdentity: "agent-A",
          agentId: "agent-A",
          routeScopeKey: "prod",
        }),
      ),
      "重复 agent targetIdentity 应被唯一约束拒绝",
    );
  });

  it("[RED] targetIdentity 唯一：runtime 与 agent A 同 scope 可共存", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await insertTargetRow(
      targetRow({
        targetKind: "runtime",
        targetIdentity: "runtime",
        agentId: null,
        routeScopeKey: "prod",
      }),
    );
    await insertTargetRow(
      targetRow({
        targetKind: "agent",
        targetIdentity: "agent-A",
        agentId: "agent-A",
        routeScopeKey: "prod",
      }),
    );
    const [rows] = await db.execute(
      sql`SELECT targetKind, targetIdentity FROM \`DeploymentRouteSet\`
          WHERE routeScopeKey = 'prod' ORDER BY targetIdentity`,
    );
    const kinds = (rows as unknown as { targetKind: string }[]).map((r) => r.targetKind).sort();
    expect(kinds).toEqual(["agent", "runtime"]);
  });

  it("[RED] 不同 tenant 相同 target/scope 可共存（租户隔离唯一性）", async () => {
    // FK 必须指向真实租户：默认租户 + 真实第二个租户，杜绝 FK(1452) 假阳性。
    await expectTargetIdentityColumnExists();
    const defaultTenant = await ensureDefaultTenant();
    const secondTenantId = await seedSecondTenant();
    await insertTargetRow(
      targetRow({
        tenantId: defaultTenant.id,
        targetKind: "runtime",
        targetIdentity: "runtime",
        agentId: null,
        routeScopeKey: "prod",
      }),
    );
    await insertTargetRow(
      targetRow({
        tenantId: secondTenantId,
        targetKind: "runtime",
        targetIdentity: "runtime",
        agentId: null,
        routeScopeKey: "prod",
      }),
    );
    const [rows] = await db.execute(
      sql`SELECT tenantId, COUNT(*) AS n FROM \`DeploymentRouteSet\`
          GROUP BY tenantId ORDER BY tenantId`,
    );
    const counts = (rows as unknown as { tenantId: string; n: number }[]).map((r) => Number(r.n));
    expect(counts).toEqual([1, 1]);
  });
});

describe("DeploymentRoute revision schema", () => {
  async function seedRouteSet(tenantId: string) {
    const routeSetId = randomUUID();
    await db.insert(deploymentRouteSetTable).values({
      id: routeSetId,
      tenantId,
      targetKind: "agent",
      agentId: "agent-A",
      routeScopeKey: "prod",
      routeScopeJson: {},
      versionNo: 1,
      createdAt: NOW,
      updatedAt: NOW,
      // 冻结最终形态：agent targetIdentity=agentId（当前 schema 尚无该列，cast 透传）。
      targetIdentity: "agent-A",
    } as RouteSetSeedRow);
    return routeSetId;
  }

  function baseRoute(routeSetId: string) {
    return {
      id: randomUUID(),
      routeSetId,
      routeKey: randomUUID(),
      trafficWeight: 5_000,
      priorityNo: 0,
      routeState: "enabled" as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  it("[RED] 两个 revision ID 同时非空必须被 CHECK 拒绝（恰好一个非空）", async () => {
    const { id: tenantId } = await ensureDefaultTenant();
    const routeSetId = await seedRouteSet(tenantId);
    await expectConstraintRejection(
      db.insert(deploymentRouteTable).values({
        ...baseRoute(routeSetId),
        runtimeRevisionId: "runtime-rev",
        agentRevisionId: "agent-rev",
      }),
      "runtime+agent 同时非空应被 CHECK 拒绝",
    );
  });

  it("两个 revision ID 同时为 NULL 必须被拒绝（恰好一个非空）", async () => {
    const { id: tenantId } = await ensureDefaultTenant();
    const routeSetId = await seedRouteSet(tenantId);
    await expectConstraintRejection(
      db.insert(deploymentRouteTable).values({
        ...baseRoute(routeSetId),
        runtimeRevisionId: null,
        agentRevisionId: null,
      }),
      "两个 revision ID 同时 NULL 应被拒绝",
    );
  });

  it("[RED] agent-only 行（runtimeRevisionId=null）必须被接受", async () => {
    // 冻结设计：agent 目标恰好一个非空（agentRevisionId 非空、runtimeRevisionId null）。
    // 当前 runtimeRevisionId NOT NULL → 该合法 agent-only 行被 DB 拒绝（RED）。
    const { id: tenantId } = await ensureDefaultTenant();
    const routeSetId = await seedRouteSet(tenantId);
    await expectAccepted(
      db.insert(deploymentRouteTable).values({
        ...baseRoute(routeSetId),
        runtimeRevisionId: null,
        agentRevisionId: "agent-rev",
      }),
      "agent-only 行（runtimeRevisionId=null）应被接受",
    );
  });

  it("runtime-only 行（agentRevisionId=null）被接受", async () => {
    const { id: tenantId } = await ensureDefaultTenant();
    const routeSetId = await seedRouteSet(tenantId);
    await db.insert(deploymentRouteTable).values({
      ...baseRoute(routeSetId),
      runtimeRevisionId: "runtime-rev",
      agentRevisionId: null,
    });
  });
});

describe("RouteRevision target schema", () => {
  async function seedParentIds() {
    const { id: tenantId } = await ensureDefaultTenant();
    const routeSetId = randomUUID();
    await db.insert(deploymentRouteSetTable).values({
      id: routeSetId,
      tenantId,
      targetKind: "runtime",
      agentId: null,
      routeScopeKey: "prod",
      routeScopeJson: {},
      versionNo: 1,
      createdAt: NOW,
      updatedAt: NOW,
      // 冻结最终形态：runtime targetIdentity='runtime'（当前 schema 尚无该列，cast 透传）。
      targetIdentity: "runtime",
    } as RouteSetSeedRow);
    return { tenantId, routeSetId };
  }

  function baseRevision(tenantId: string, routeSetId: string) {
    const routeId = randomUUID();
    return {
      id: randomUUID(),
      tenantId,
      routeId,
      routeSetId,
      routeKey: randomUUID(),
      revisionNo: 1,
      trafficAllocationJson: { percentage: 100 },
      routeGroupId: "primary",
      selectorDigest: `sha256:${"a".repeat(64)}`,
      trafficWeight: 5_000,
      priorityNo: 0,
      eligibilityConditionsJson: {},
      contentDigest: `sha256:${"b".repeat(64)}`,
      createdByType: "system" as const,
      createdBy: "route-target-schema-test",
      validatedAt: NOW,
      createdAt: NOW,
    };
  }

  /** 合法 agent/none 目标事实（runtimeRevisionId=null）。 */
  function agentNoneFacts() {
    return {
      runtimeRevisionId: null,
      agentRevisionId: "agent-rev",
      agentEndpointRef: "https://agent.example.com/capability",
      agentIdentityMode: "none" as const,
      agentCredentialRefId: null,
      agentNetworkZone: "cn-north",
    };
  }

  it("[RED] 混合目标（agent 事实 + runtimeRevisionId 非空）必须被 CHECK 拒绝", async () => {
    // 冻结设计：runtime 组不得携带 Agent 事实，agent 组不得携带 runtimeRevisionId。
    // 当前无 CHECK → 混合行可插入（RED）。
    const { tenantId, routeSetId } = await seedParentIds();
    await expectConstraintRejection(
      db.insert(routeRevision).values({
        ...baseRevision(tenantId, routeSetId),
        runtimeRevisionId: "runtime-rev",
        agentRevisionId: "agent-rev",
        agentEndpointRef: "https://agent.example.com/capability",
        agentIdentityMode: "none",
        agentCredentialRefId: null,
        agentNetworkZone: "cn-north",
      }),
      "混合目标行应被 CHECK 拒绝",
    );
  });

  it("[RED] 两个 revision ID 同时为 NULL 必须被拒绝（恰好一个非空）", async () => {
    const { tenantId, routeSetId } = await seedParentIds();
    await expectConstraintRejection(
      db.insert(routeRevision).values({
        ...baseRevision(tenantId, routeSetId),
        runtimeRevisionId: null,
        agentRevisionId: null,
        agentEndpointRef: null,
        agentIdentityMode: null,
        agentCredentialRefId: null,
        agentNetworkZone: null,
      }),
      "两个 revision ID 同时 NULL 应被拒绝",
    );
  });

  it("[RED] runtime 组携带任一 Agent 事实必须被 CHECK 拒绝（逐字段独立）", async () => {
    // 冻结设计：runtime 组 agentRevisionId=null 时，所有 Agent transport 事实必须为 null。
    // 逐字段独立表测：agentRevisionId/endpointRef/identityMode/credentialRefId/networkZone，
    // 任一携带即违反"runtime 组不得含 Agent 事实"（当前无 CHECK → RED）。
    const { tenantId, routeSetId } = await seedParentIds();
    const cases: Array<Record<string, unknown>> = [
      { agentRevisionId: "agent-rev" },
      { agentEndpointRef: "https://leak.example.com/capability" },
      { agentIdentityMode: "none" },
      { agentCredentialRefId: "cred-1" },
      { agentNetworkZone: "cn-north" },
    ];
    for (const [i, patch] of cases.entries()) {
      await expectConstraintRejection(
        db.insert(routeRevision).values({
          ...baseRevision(tenantId, routeSetId),
          runtimeRevisionId: "runtime-rev",
          agentRevisionId: null,
          agentEndpointRef: null,
          agentIdentityMode: null,
          agentCredentialRefId: null,
          agentNetworkZone: null,
          ...patch,
        }),
        `runtime 组携带 Agent 事实（case ${i}）应被 CHECK 拒绝`,
      );
    }
  });

  it("[RED] agent/none 组（runtimeRevisionId=null）必须被接受", async () => {
    // 冻结设计：agent 目标 runtimeRevisionId=null。当前 runtimeRevisionId NOT NULL →
    // 合法 agent/none 行被 DB 拒绝（RED）。
    const { tenantId, routeSetId } = await seedParentIds();
    await expectAccepted(
      db.insert(routeRevision).values({
        ...baseRevision(tenantId, routeSetId),
        ...agentNoneFacts(),
      }),
      "agent/none 行（runtimeRevisionId=null）应被接受",
    );
  });

  it("[RED] 合法 agent/bearer 组（runtimeRevisionId=null、含 credential）必须被接受", async () => {
    // 冻结设计：agent/bearer 合法（credentialRefId 非空）。当前 runtimeRevisionId NOT NULL
    // → 该合法 agent/bearer 行被 DB 拒绝（RED）。
    const { tenantId, routeSetId } = await seedParentIds();
    await expectAccepted(
      db.insert(routeRevision).values({
        ...baseRevision(tenantId, routeSetId),
        runtimeRevisionId: null,
        agentRevisionId: "agent-rev",
        agentEndpointRef: "https://agent.example.com/capability",
        agentIdentityMode: "bearer",
        agentCredentialRefId: "cred-1",
        agentNetworkZone: "cn-north",
      }),
      "agent/bearer 合法行应被接受",
    );
  });

  it("[RED] bearer 无 credentialRefId（合法 agent-only 形状）必须被 CHECK 拒绝", async () => {
    // 冻结设计：bearer 必须冻结非空 agentCredentialRefId。此处为合法 agent-only 形状
    // （runtimeRevisionId=null），唯一非法点是 bearer 无 credential → 迁移后由 CHECK 拒绝。
    const { tenantId, routeSetId } = await seedParentIds();
    await expectConstraintRejection(
      db.insert(routeRevision).values({
        ...baseRevision(tenantId, routeSetId),
        ...agentNoneFacts(),
        agentIdentityMode: "bearer",
        agentCredentialRefId: null,
      }),
      "bearer 无 credentialRefId 应被 CHECK 拒绝",
    );
  });

  it("[RED] agent 组缺少/空/空白必需字段必须被 CHECK 拒绝", async () => {
    // 冻结设计：agentRevisionId/endpointRef/identityMode/networkZone 必须非空，空/空白非法。
    const { tenantId, routeSetId } = await seedParentIds();
    const cases: Array<Record<string, unknown>> = [
      // 缺少 agentRevisionId
      { agentRevisionId: undefined },
      // agentRevisionId 空串 / 空白
      { agentRevisionId: "" },
      { agentRevisionId: "   " },
      // endpointRef 空串 / 空白
      { agentEndpointRef: "" },
      { agentEndpointRef: "   " },
      // identityMode 非法
      { agentIdentityMode: "invalid" },
      // networkZone 空串 / 空白
      { agentNetworkZone: "" },
      { agentNetworkZone: "   " },
    ];
    for (const [i, patch] of cases.entries()) {
      await expectConstraintRejection(
        db.insert(routeRevision).values({
          ...baseRevision(tenantId, routeSetId),
          ...agentNoneFacts(),
          ...patch,
        }),
        `agent 组必需字段非法（case ${i}）应被 CHECK 拒绝`,
      );
    }
  });

  it("runtime 组（Agent 事实全 null、runtimeRevisionId 非空）被接受", async () => {
    const { tenantId, routeSetId } = await seedParentIds();
    await db.insert(routeRevision).values({
      ...baseRevision(tenantId, routeSetId),
      runtimeRevisionId: "runtime-rev",
      agentRevisionId: null,
      agentEndpointRef: null,
      agentIdentityMode: null,
      agentCredentialRefId: null,
      agentNetworkZone: null,
    });
  });
});
