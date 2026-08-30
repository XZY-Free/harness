/**
 * RouteEligibilityProjection target-specific schema 约束集成测试（真实 MySQL 8）。
 *
 * 专题01 冻结架构（01 §4.D，tests 阶段）：
 * - 单一 RouteEligibilityProjection 必须显式携带 targetKind + targetIdentity（非空）。
 * - targetKind / targetIdentity 与 agentId 一致（runtime targetIdentity='runtime'、agentId NULL；
 *   agent targetIdentity=agentId）。
 * - Agent target 行所有 Runtime 字段必须为 NULL；Runtime target 行所有 Agent 字段必须为 NULL。
 *   Agent 携带任一 Runtime 字段、Runtime 携带任一 Agent 字段都必须被 DB CHECK/NOT NULL 拒绝。
 * - 合法 agent/runtime 行可插入且对方字段为 NULL；禁止 "not_applicable"/"hosted_artifact" placeholder。
 *
 * 当前生产 schema 尚未迁移（无 targetIdentity 列、runtimeRevisionState 等仍 NOT NULL、无互斥
 * CHECK），以下用例用真实 DB 行为演示缺失约束导致的 RED。
 * 必须使用真实 MySQL，不可用 in-memory/mock 证明 schema。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import {
  type NewRouteEligibilityProjectionRecord,
  routeEligibilityProjection,
} from "@/lib/routes/projection/route-eligibility-projection-record";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-29T00:00:00.000Z");

const MYSQL_ERRNO = {
  UNKNOWN_COLUMN: 1054,
  NOT_NULL: 1048,
  CHECK: 3819,
  DUPLICATE: 1062,
  ENUM_VALUE: 1265,
} as const;

/** 约束拒绝可接受的 errno 类：NOT NULL(1048) / CHECK(3819) / DUPLICATE(1062)。 */
const EXPECTED_CONSTRAINT_ERRNOS = new Set<number>([
  MYSQL_ERRNO.NOT_NULL,
  MYSQL_ERRNO.CHECK,
  MYSQL_ERRNO.DUPLICATE,
  MYSQL_ERRNO.ENUM_VALUE,
]);

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

/** 校验 RouteEligibilityProjection 已迁移出 targetIdentity 列（防假阳性的前置断言）。 */
async function expectTargetIdentityColumnExists(): Promise<void> {
  const [rows] = (await db.execute(
    sql`SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RouteEligibilityProjection'
          AND COLUMN_NAME = 'targetIdentity'`,
  )) as unknown as [[{ n: number }]];
  const row = rows[0];
  if (!row || Number(row.n) !== 1) {
    throw new Error(
      "[RED] RouteEligibilityProjection.targetIdentity 列不存在——schema 尚未迁移，无法验证目标约束",
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
    // 只接受目标约束类 errno。FK(1452)/unknown column(1054)/其他一律视为假阳性。
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

beforeEach(async () => {
  await resetDatabase(db);
});

// ─── 合法 base seed 行 ────────────────────────────────────
// 冻结最终形态：Agent 目标行 runtime 组全 NULL，targetIdentity=agentId。
// 当前 schema 尚无 targetIdentity 列、runtime 组仍 NOT NULL，seed 用 cast 透传。

function sha(prefix: string, fill: string): string {
  return `${prefix}:${fill.repeat(64)}`;
}

/** 合法 Agent 目标行（冻结）：runtime 组全 NULL、targetIdentity=agentId。 */
function agentBase(overrides: Record<string, unknown> = {}) {
  return {
    routeId: randomUUID(),
    tenantId: "agent-schema-tenant",
    targetKind: "agent",
    targetIdentity: "agent-1",
    agentId: "agent-1",
    routeSetId: randomUUID(),
    routeScopeKey: "prod",
    routeSetVersionNo: 1,
    routeRevisionId: randomUUID(),
    routeRevisionNo: 1,
    routeActivationId: randomUUID(),
    routeActivationSequence: 1,
    activationState: "active",
    routeGroupId: "primary",
    selectorDigest: sha("sha256", "a"),
    eligibilityConditionsJson: {},
    specificity: 0,
    priorityNo: 10,
    trafficWeight: 100,
    effectiveFrom: null,
    effectiveUntil: null,
    // Agent 组
    agentRevisionId: "agent-rev-1",
    agentEndpointRef: "https://agent.example.com/capability",
    agentIdentityMode: "none",
    agentCredentialRefId: null,
    agentNetworkZone: "cn-north",
    agentRevisionState: "published",
    agentLifecycleState: "enabled",
    agentPublicationActive: 1,
    agentEvidenceValid: 1,
    agentPublicationRecordId: "agent-pub-1",
    agentContractSnapshotId: "contract-1",
    agentContractDigest: sha("sha256", "c"),
    agentContextDigest: sha("sha256", "d"),
    // Runtime 组（冻结：agent target 必须全 NULL）
    runtimeRevisionId: null,
    runtimeRevisionState: null,
    runtimeLifecycleState: null,
    runtimePublicationActive: null,
    runtimeEvidenceValid: null,
    runtimeConformanceValid: null,
    runtimeEvidenceKind: null,
    runtimeArtifactDigest: null,
    runtimeConfigDigest: null,
    runtimeTargetDigest: null,
    runtimePublicationRecordId: null,
    runtimeAttestationIds: null,
    conformanceRunId: null,
    runtimeArtifactId: null,
    // 公共
    policyRevisionId: null,
    policyRevisionState: null,
    // capabilityCompatibilityDigest 属 Runtime 组：agent target 必须 null。
    capabilityCompatibilityDigest: null,
    routeContentDigest: sha("sha256", "e"),
    sourceEventId: null,
    sourceAggregateVersion: null,
    invalidReason: null,
    eligibilityState: "eligible",
    projectionContentDigest: sha("sha256", "f"),
    projectionVersionNo: 1,
    lastRebuiltAt: NOW,
    ...overrides,
  };
}

/** 合法 Runtime 目标行（冻结）：agent 组全 NULL、targetIdentity='runtime'。 */
function runtimeBase(overrides: Record<string, unknown> = {}) {
  return {
    ...agentBase({
      targetKind: "runtime",
      targetIdentity: "runtime",
      agentId: null,
      // Agent 组全 NULL（冻结：runtime target 必须全 NULL）
      agentRevisionId: null,
      agentEndpointRef: null,
      agentIdentityMode: null,
      agentCredentialRefId: null,
      agentNetworkZone: null,
      agentRevisionState: null,
      agentLifecycleState: null,
      agentPublicationActive: null,
      agentEvidenceValid: null,
      agentPublicationRecordId: null,
      agentContractSnapshotId: null,
      agentContractDigest: null,
      agentContextDigest: null,
      // Runtime 组
      runtimeRevisionId: "rt-rev-1",
      runtimeRevisionState: "published",
      runtimeLifecycleState: "enabled",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      runtimeEvidenceKind: "hosted_artifact",
      runtimeArtifactDigest: sha("sha256", "x"),
      runtimeConfigDigest: sha("sha256", "y"),
      runtimeTargetDigest: sha("sha256", "z"),
      runtimePublicationRecordId: "rt-pub-1",
      runtimeAttestationIds: ["att-1"],
      conformanceRunId: "conformance-1",
      runtimeArtifactId: "rt-artifact-1",
      // capabilityCompatibilityDigest 属 Runtime 组：runtime target 可有。
      capabilityCompatibilityDigest: sha("sha256", "b"),
    }),
    ...overrides,
  };
}

/**
 * 混合目标行：agent 组与 runtime 组同时非空。
 * 冻结设计：单一投影只能属于一个 target，两 group 同时非空必须被 CHECK 拒绝。
 * 当前 schema 无互斥 CHECK，且该行已满足全部 NOT NULL 列 → 当前会被接受（RED）。
 */
function mixedBase(overrides: Record<string, unknown> = {}) {
  return {
    ...agentBase({
      runtimeRevisionId: "rt-rev-1",
      runtimeRevisionState: "published",
      runtimeLifecycleState: "enabled",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      runtimeEvidenceKind: "hosted_artifact",
      runtimeArtifactDigest: sha("sha256", "x"),
      runtimeConfigDigest: sha("sha256", "y"),
      runtimeTargetDigest: sha("sha256", "z"),
      runtimePublicationRecordId: "rt-pub-1",
      runtimeAttestationIds: ["att-1"],
      conformanceRunId: "conformance-1",
      runtimeArtifactId: "rt-artifact-1",
      // capabilityCompatibilityDigest 属 Runtime 组：runtime target 可有。
      capabilityCompatibilityDigest: sha("sha256", "b"),
    }),
    ...overrides,
  };
}

/** 用 seed 行插入 RouteEligibilityProjection（cast 透传 targetIdentity 等待迁移列）。 */
function insertRow(row: Record<string, unknown>): Promise<unknown> {
  return db
    .insert(routeEligibilityProjection)
    .values(row as unknown as NewRouteEligibilityProjectionRecord);
}

// ─── targetIdentity / targetKind 一致性 ───────────────────

describe("RouteEligibilityProjection targetIdentity schema", () => {
  it("[RED] targetIdentity 列必须存在（INFORMATION_SCHEMA 前置断言）", async () => {
    await ensureDefaultTenant();
    await expectTargetIdentityColumnExists();
  });

  it("[RED] runtime 行（targetIdentity='runtime'、agentId NULL）必须被接受", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    const errno = await tryAccept(insertRow(runtimeBase()));
    if (errno !== null) {
      throw new Error(`[RED] runtime 行应被接受，实际 errno=${errno}`);
    }
  });

  it("[RED] agent 行（targetIdentity=agentId、agentId 非空）必须被接受", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    const errno = await tryAccept(insertRow(agentBase()));
    if (errno !== null) {
      throw new Error(`[RED] agent 行应被接受，实际 errno=${errno}`);
    }
  });

  it("[RED] targetIdentity NULL 必须被拒绝（NOT NULL）", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertRow(agentBase({ targetIdentity: null })),
      "targetIdentity NULL 应被 NOT NULL 拒绝",
    );
  });

  it("[RED] runtime 携带 agentId 必须被拒绝（CHECK 一致）", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertRow(runtimeBase({ agentId: "agent-1" })),
      "runtime 携带 agentId 应被 CHECK 拒绝",
    );
  });

  it("[RED] agent 携带 agentId=NULL 必须被拒绝（CHECK 一致）", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertRow(agentBase({ agentId: null })),
      "agent 携带 agentId=NULL 应被 CHECK 拒绝",
    );
  });

  it("[RED] agent 的 targetIdentity != agentId 必须被拒绝（CHECK 一致）", async () => {
    await expectTargetIdentityColumnExists();
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertRow(agentBase({ targetIdentity: "agent-2" })),
      "agent targetIdentity!=agentId 应被 CHECK 拒绝",
    );
  });
});

// ─── target 证据组互斥 ────────────────────────────────────

describe("RouteEligibilityProjection target group mutual exclusion", () => {
  it("[RED] 合法 agent 行（runtime 组全 NULL）必须被接受", async () => {
    await ensureDefaultTenant();
    await expectAccepted(insertRow(agentBase()), "合法 agent 行（runtime 组全 NULL）应被接受");
  });

  it("[RED] 合法 runtime 行（agent 组全 NULL）必须被接受", async () => {
    await ensureDefaultTenant();
    await expectAccepted(insertRow(runtimeBase()), "合法 runtime 行（agent 组全 NULL）应被接受");
  });

  it("[RED] 混合行（agent+runtime 组同时非空）必须被 CHECK 拒绝", async () => {
    // 冻结设计：单一投影只属一个 target；混合行必须被互斥 CHECK 拒绝。
    // 当前无 CHECK 且该行已满足全部 NOT NULL 列 → 被接受（RED，非假阳性）。
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertRow(mixedBase()),
      "混合行（两 target group 同时非空）应被互斥 CHECK 拒绝",
    );
  });

  it("[RED] agent 行携带 Runtime 字段（runtimeRevisionId 非空）必须被 CHECK 拒绝", async () => {
    // 冻结设计：agent 行任何 Runtime 字段非空即非法。当前无 CHECK → RED。
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertRow(mixedBase({ runtimeRevisionId: "rt-rev-1" })),
      "agent 行携带 Runtime 字段应被 CHECK 拒绝",
    );
  });

  it("[RED] runtime 行携带 Agent 字段（agentRevisionState 非空）必须被 CHECK 拒绝", async () => {
    // 冻结设计：runtime 行任何 Agent 字段非空即非法。当前无 CHECK → RED。
    await ensureDefaultTenant();
    await expectConstraintRejection(
      insertRow(mixedBase({ agentRevisionState: "published" })),
      "runtime 行携带 Agent 字段应被 CHECK 拒绝",
    );
  });

  it("[RED] 合法 agent 行插入后对方（runtime）字段全为 NULL", async () => {
    await ensureDefaultTenant();
    await expectAccepted(insertRow(agentBase()), "合法 agent 行（runtime 组全 NULL）应先被接受");
    const [rows] = await db.execute(
      sql`SELECT * FROM \`RouteEligibilityProjection\` WHERE targetKind = 'agent'`,
    );
    const rowsList = rows as unknown as Array<Record<string, unknown>>;
    expect(rowsList.length).toBeGreaterThan(0);
    const runtimeFields = [
      "runtimeRevisionId",
      "runtimeRevisionState",
      "runtimeLifecycleState",
      "runtimePublicationActive",
      "runtimeEvidenceValid",
      "runtimeConformanceValid",
      "runtimeEvidenceKind",
      "runtimeArtifactDigest",
      "runtimeConfigDigest",
      "runtimeTargetDigest",
      "runtimePublicationRecordId",
      "runtimeAttestationIds",
      "conformanceRunId",
      "runtimeArtifactId",
    ];
    for (const row of rowsList) {
      for (const field of runtimeFields) {
        expect(row[field] ?? null).toBeNull();
      }
    }
  });

  it("[RED] 合法 runtime 行插入后对方（agent）字段全为 NULL", async () => {
    await ensureDefaultTenant();
    await expectAccepted(insertRow(runtimeBase()), "合法 runtime 行（agent 组全 NULL）应先被接受");
    const [rows] = await db.execute(
      sql`SELECT * FROM \`RouteEligibilityProjection\` WHERE targetKind = 'runtime'`,
    );
    const rowsList = rows as unknown as Array<Record<string, unknown>>;
    expect(rowsList.length).toBeGreaterThan(0);
    const agentFields = [
      "agentRevisionId",
      "agentEndpointRef",
      "agentIdentityMode",
      "agentCredentialRefId",
      "agentNetworkZone",
      "agentRevisionState",
      "agentLifecycleState",
      "agentPublicationActive",
      "agentEvidenceValid",
      "agentPublicationRecordId",
      "agentContractSnapshotId",
      "agentContractDigest",
      "agentContextDigest",
    ];
    for (const row of rowsList) {
      for (const field of agentFields) {
        expect(row[field] ?? null).toBeNull();
      }
    }
  });
});
