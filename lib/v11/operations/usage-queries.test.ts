/**
 * S11-W07：V11 Usage / Capacity / SLI 仓储集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - createUsageRecord：默认值 + 全字段透传 + bigint 序列化
 * - getUsageRecordById：命中 + 不存在 + 跨租户隔离
 * - listUsageRecordsByTenant：observedAt 降序 + dimension/scopeType/observedFrom/observedTo 过滤 + cursor 分页 + 跨租户隔离
 * - createOrUpdateCostAggregate：upsert 行为（同 UNIQUE key 覆盖）+ 不同 key 共存
 * - listCostAggregatesByTenant：dimension/scopeType/granularity/windowFrom/windowTo 过滤
 * - createCapacitySnapshot + listCapacitySnapshotsByTenant：默认值 + scopeType/scopeRef 过滤 + snapshotAt desc
 * - createServiceLevelIndicator + listServiceLevelIndicatorsByTenant：breach_only 过滤 + measuredAt desc
 * - getCapacityAlertsByTenant：返回 breach=true 的 SLI + 关联 snapshot + 跳转引用
 *
 * 不变量（事实源：11 文档 S11-W07 行 89-94）：
 * - 汇总 Token、模型费用、Tool 费用、Runtime 资源、队列等待、Environment 占用和 Artifact 存储。
 * - 可按组织、Agent、Revision、模型、ToolProvider、Environment、Job 类型和时间窗口切分。
 * - 容量页面区分调用量、并发、冷启动、积压、限额和故障，不只展示总 Token。
 * - 告警从可执行阈值产生，并能跳转相关 Invocation/Event/Trace，不建设无来源的装饰仪表盘。
 * - 跨租户隔离：所有查询按 tenantId 过滤
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import {
  createCapacitySnapshot,
  createOrUpdateCostAggregate,
  createServiceLevelIndicator,
  createUsageRecord,
  getCapacityAlertsByTenant,
  getCapacitySnapshotById,
  getCostAggregateById,
  getServiceLevelIndicatorById,
  getUsageRecordById,
  listCapacitySnapshotsByTenant,
  listCostAggregatesByTenant,
  listServiceLevelIndicatorsByTenant,
  listUsageRecordsByTenant,
} from "@/lib/v11/operations/usage-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 租户 ─────────────────────────────────────

async function seedTenant() {
  const tenant = await ensureDefaultTenant();
  return { tenantId: tenant.id };
}

/** 创建一个默认 UsageRecord（token_input 维度，tenant scope）。 */
async function createDefaultRecord(
  tenantId: string,
  options?: {
    dimension?:
      | "token_input"
      | "token_output"
      | "model_call"
      | "tool_call"
      | "runtime_seconds"
      | "queue_wait_seconds"
      | "env_seconds"
      | "artifact_bytes";
    scopeType?:
      | "tenant"
      | "organization"
      | "agent"
      | "agent_revision"
      | "model"
      | "tool_provider"
      | "environment"
      | "job";
    scopeRef?: string | null;
    quantity?: bigint | number;
    unitCostMicros?: bigint | number | null;
    totalCostMicros?: bigint | number | null;
    observedAt?: Date;
    agentRevisionId?: string | null;
    modelRef?: string | null;
    toolProviderId?: string | null;
    environmentId?: string | null;
    jobId?: string | null;
    invocationId?: string | null;
  },
) {
  return createUsageRecord({
    tenantId,
    dimension: options?.dimension ?? "token_input",
    scopeType: options?.scopeType ?? "tenant",
    scopeRef: options?.scopeRef ?? null,
    agentRevisionId: options?.agentRevisionId ?? null,
    modelRef: options?.modelRef ?? null,
    toolProviderId: options?.toolProviderId ?? null,
    environmentId: options?.environmentId ?? null,
    jobId: options?.jobId ?? null,
    invocationId: options?.invocationId ?? null,
    quantity: options?.quantity ?? 1000n,
    unitCostMicros: options?.unitCostMicros ?? null,
    totalCostMicros: options?.totalCostMicros ?? null,
    observedAt: options?.observedAt,
  });
}

// ─── createUsageRecord ─────────────────────────────────

describe("createUsageRecord 成功路径", () => {
  it("默认值（quantity 透传 + unit/total cost 为 null）", async () => {
    const fx = await seedTenant();

    const record = await createUsageRecord({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "tenant",
      quantity: 1500n,
    });

    expect(record.tenantId).toBe(fx.tenantId);
    expect(record.dimension).toBe("token_input");
    expect(record.scopeType).toBe("tenant");
    expect(record.scopeRef).toBeNull();
    expect(record.agentRevisionId).toBeNull();
    expect(record.modelRef).toBeNull();
    expect(record.toolProviderId).toBeNull();
    expect(record.environmentId).toBeNull();
    expect(record.jobId).toBeNull();
    expect(record.invocationId).toBeNull();
    expect(record.quantity).toBe(1500n);
    expect(record.unitCostMicros).toBeNull();
    expect(record.totalCostMicros).toBeNull();
    expect(record.observedAt).toBeInstanceOf(Date);
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it("全字段透传 + bigint 序列化", async () => {
    const fx = await seedTenant();
    const agentRevisionId = randomUUID();
    const toolProviderId = randomUUID();
    const environmentId = randomUUID();
    const jobId = randomUUID();
    const invocationId = randomUUID();
    const observedAt = new Date("2026-07-21T10:00:00.000Z");

    const record = await createUsageRecord({
      tenantId: fx.tenantId,
      dimension: "model_call",
      scopeType: "agent_revision",
      scopeRef: "agent-rev-001",
      agentRevisionId,
      modelRef: "doubao-pro-32k",
      toolProviderId,
      environmentId,
      jobId,
      invocationId,
      quantity: 9_999_999_999n, // > Number.MAX_SAFE_INTEGER 测试
      unitCostMicros: 1500n,
      totalCostMicros: 14_999_999_998_500n,
      observedAt,
    });

    expect(record.dimension).toBe("model_call");
    expect(record.scopeType).toBe("agent_revision");
    expect(record.scopeRef).toBe("agent-rev-001");
    expect(record.agentRevisionId).toBe(agentRevisionId);
    expect(record.modelRef).toBe("doubao-pro-32k");
    expect(record.toolProviderId).toBe(toolProviderId);
    expect(record.environmentId).toBe(environmentId);
    expect(record.jobId).toBe(jobId);
    expect(record.invocationId).toBe(invocationId);
    expect(record.quantity).toBe(9_999_999_999n);
    expect(record.unitCostMicros).toBe(1500n);
    expect(record.totalCostMicros).toBe(14_999_999_998_500n);
    expect(record.observedAt.toISOString()).toBe(observedAt.toISOString());
    // BigInt 序列化为 string 不丢精度
    expect(record.quantity.toString()).toBe("9999999999");
    expect(record.totalCostMicros?.toString()).toBe("14999999998500");
  });

  it("number 入参自动转 BigInt", async () => {
    const fx = await seedTenant();
    const record = await createUsageRecord({
      tenantId: fx.tenantId,
      dimension: "tool_call",
      scopeType: "tool_provider",
      scopeRef: "provider-001",
      quantity: 42, // number 入参
      unitCostMicros: 100, // number 入参
      totalCostMicros: 4200, // number 入参
    });
    expect(record.quantity).toBe(42n);
    expect(record.unitCostMicros).toBe(100n);
    expect(record.totalCostMicros).toBe(4200n);
  });
});

// ─── getUsageRecordById ────────────────────────────────

describe("getUsageRecordById", () => {
  it("命中同租户记录", async () => {
    const fx = await seedTenant();
    const record = await createDefaultRecord(fx.tenantId);

    const found = await getUsageRecordById(fx.tenantId, record.id);
    expect(found?.id).toBe(record.id);
  });

  it("不存在返回 null", async () => {
    const fx = await seedTenant();
    const found = await getUsageRecordById(fx.tenantId, randomUUID());
    expect(found).toBeNull();
  });

  it("跨租户查询返回 null", async () => {
    const fx = await seedTenant();
    const record = await createDefaultRecord(fx.tenantId);

    const crossTenant = await getUsageRecordById(randomUUID(), record.id);
    expect(crossTenant).toBeNull();
  });
});

// ─── listUsageRecordsByTenant ─────────────────────────

describe("listUsageRecordsByTenant", () => {
  it("按 observedAt 降序返回", async () => {
    const fx = await seedTenant();
    const t1 = new Date("2026-07-21T10:00:00.000Z");
    const t2 = new Date("2026-07-21T11:00:00.000Z");
    const r1 = await createDefaultRecord(fx.tenantId, { observedAt: t1 });
    const r2 = await createDefaultRecord(fx.tenantId, { observedAt: t2 });

    const result = await listUsageRecordsByTenant(fx.tenantId);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.id).toBe(r2.id); // 最新的在前
    expect(result.items[1]?.id).toBe(r1.id);
    expect(result.nextCursor).toBeNull();
  });

  it("dimension 过滤", async () => {
    const fx = await seedTenant();
    await createDefaultRecord(fx.tenantId, { dimension: "token_input" });
    await createDefaultRecord(fx.tenantId, { dimension: "token_output" });
    await createDefaultRecord(fx.tenantId, { dimension: "token_input" });

    const inputOnly = await listUsageRecordsByTenant(fx.tenantId, { dimension: "token_input" });
    expect(inputOnly.items).toHaveLength(2);
    expect(inputOnly.items.every((r) => r.dimension === "token_input")).toBe(true);

    const outputOnly = await listUsageRecordsByTenant(fx.tenantId, { dimension: "token_output" });
    expect(outputOnly.items).toHaveLength(1);
  });

  it("scopeType 过滤", async () => {
    const fx = await seedTenant();
    await createDefaultRecord(fx.tenantId, { scopeType: "tenant" });
    await createDefaultRecord(fx.tenantId, { scopeType: "agent", scopeRef: "agent-001" });

    const tenantScope = await listUsageRecordsByTenant(fx.tenantId, { scopeType: "tenant" });
    expect(tenantScope.items).toHaveLength(1);
    expect(tenantScope.items[0]?.scopeType).toBe("tenant");

    const agentScope = await listUsageRecordsByTenant(fx.tenantId, { scopeType: "agent" });
    expect(agentScope.items).toHaveLength(1);
    expect(agentScope.items[0]?.scopeRef).toBe("agent-001");
  });

  it("observedFrom / observedTo 时间窗口过滤", async () => {
    const fx = await seedTenant();
    await createDefaultRecord(fx.tenantId, { observedAt: new Date("2026-07-21T08:00:00.000Z") });
    await createDefaultRecord(fx.tenantId, { observedAt: new Date("2026-07-21T10:00:00.000Z") });
    await createDefaultRecord(fx.tenantId, { observedAt: new Date("2026-07-21T12:00:00.000Z") });

    const windowed = await listUsageRecordsByTenant(fx.tenantId, {
      observedFrom: new Date("2026-07-21T09:00:00.000Z"),
      observedTo: new Date("2026-07-21T11:00:00.000Z"),
    });
    expect(windowed.items).toHaveLength(1);
    expect(windowed.items[0]?.observedAt.toISOString()).toBe("2026-07-21T10:00:00.000Z");
  });

  it("cursor 分页：limit+1 策略 + nextCursor 续读", async () => {
    const fx = await seedTenant();
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await createDefaultRecord(fx.tenantId, {
        observedAt: new Date(2026, 6, 21, 10, 0, i),
      });
      created.push(r.id);
    }
    // created 数组按时间升序，列表按 observed_at desc 返回，所以反转
    const expectedDesc = [...created].reverse();

    const page1 = await listUsageRecordsByTenant(fx.tenantId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]?.id).toBe(expectedDesc[0]);
    expect(page1.items[1]?.id).toBe(expectedDesc[1]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listUsageRecordsByTenant(fx.tenantId, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0]?.id).toBe(expectedDesc[2]);
    expect(page2.items[1]?.id).toBe(expectedDesc[3]);

    const page3 = await listUsageRecordsByTenant(fx.tenantId, {
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0]?.id).toBe(expectedDesc[4]);
    expect(page3.nextCursor).toBeNull();
  });

  it("跨租户查询返回空数组", async () => {
    const fx = await seedTenant();
    await createDefaultRecord(fx.tenantId);

    const otherTenant = await listUsageRecordsByTenant(randomUUID());
    expect(otherTenant.items).toHaveLength(0);
    expect(otherTenant.nextCursor).toBeNull();
  });

  it("非法 cursor 抛错", async () => {
    const fx = await seedTenant();
    const badCursor = Buffer.from(
      JSON.stringify({ observed_at: "2026-07-21T00:00:00.000Z" }),
    ).toString("base64url");
    await expect(listUsageRecordsByTenant(fx.tenantId, { cursor: badCursor })).rejects.toThrow(
      /cursor 缺少 observed_at\/id 字段/,
    );
  });
});

// ─── createOrUpdateCostAggregate ───────────────────────

describe("createOrUpdateCostAggregate", () => {
  it("首次插入：默认字段透传 + bigint 序列化", async () => {
    const fx = await seedTenant();
    const windowStart = new Date("2026-07-21T10:00:00.000Z");
    const windowEnd = new Date("2026-07-21T11:00:00.000Z");

    const agg = await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "agent",
      scopeRef: "agent-001",
      windowStart,
      windowEnd,
      granularity: "hour",
      totalQuantity: 1_500_000n,
      totalCostMicros: 22_500_000n,
      recordCount: 42,
    });

    expect(agg.tenantId).toBe(fx.tenantId);
    expect(agg.dimension).toBe("token_input");
    expect(agg.scopeType).toBe("agent");
    expect(agg.scopeRef).toBe("agent-001");
    expect(agg.windowStart.toISOString()).toBe(windowStart.toISOString());
    expect(agg.windowEnd.toISOString()).toBe(windowEnd.toISOString());
    expect(agg.granularity).toBe("hour");
    expect(agg.totalQuantity).toBe(1_500_000n);
    expect(agg.totalCostMicros).toBe(22_500_000n);
    expect(agg.recordCount).toBe(42);
    expect(agg.createdAt).toBeInstanceOf(Date);
    expect(agg.updatedAt).toBeInstanceOf(Date);
    expect(agg.totalQuantity.toString()).toBe("1500000");
  });

  it("upsert：同 UNIQUE key 覆盖 totalQuantity/totalCostMicros/recordCount", async () => {
    const fx = await seedTenant();
    const windowStart = new Date("2026-07-21T10:00:00.000Z");
    const windowEnd = new Date("2026-07-21T11:00:00.000Z");

    const agg1 = await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "agent",
      scopeRef: "agent-001",
      windowStart,
      windowEnd,
      granularity: "hour",
      totalQuantity: 1000n,
      totalCostMicros: 15_000n,
      recordCount: 5,
    });

    const agg2 = await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "agent",
      scopeRef: "agent-001",
      windowStart,
      windowEnd: new Date("2026-07-21T12:00:00.000Z"), // window_end 覆盖
      granularity: "hour",
      totalQuantity: 2000n,
      totalCostMicros: 30_000n,
      recordCount: 10,
    });

    // 同 UNIQUE key 应返回同一行
    expect(agg1.id).toBe(agg2.id);
    expect(agg2.totalQuantity).toBe(2000n);
    expect(agg2.totalCostMicros).toBe(30_000n);
    expect(agg2.recordCount).toBe(10);
    expect(agg2.windowEnd.toISOString()).toBe("2026-07-21T12:00:00.000Z");
    // updatedAt 应推进
    expect(agg2.updatedAt.getTime()).toBeGreaterThanOrEqual(agg1.updatedAt.getTime());

    // 数据库中应只有 1 行
    const list = await listCostAggregatesByTenant(fx.tenantId);
    expect(list.items).toHaveLength(1);
  });

  it("不同 UNIQUE key 共存：scope_ref 不同时各占一行", async () => {
    const fx = await seedTenant();
    const windowStart = new Date("2026-07-21T10:00:00.000Z");
    const windowEnd = new Date("2026-07-21T11:00:00.000Z");

    await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "agent",
      scopeRef: "agent-A",
      windowStart,
      windowEnd,
      granularity: "hour",
      totalQuantity: 1000n,
      totalCostMicros: 15_000n,
      recordCount: 5,
    });
    await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "agent",
      scopeRef: "agent-B",
      windowStart,
      windowEnd,
      granularity: "hour",
      totalQuantity: 2000n,
      totalCostMicros: 30_000n,
      recordCount: 8,
    });

    const list = await listCostAggregatesByTenant(fx.tenantId);
    expect(list.items).toHaveLength(2);
  });

  it("scope_ref=null 时同 key 也覆盖", async () => {
    const fx = await seedTenant();
    const windowStart = new Date("2026-07-21T10:00:00.000Z");
    const windowEnd = new Date("2026-07-21T11:00:00.000Z");

    await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "tenant",
      scopeRef: null,
      windowStart,
      windowEnd,
      granularity: "day",
      totalQuantity: 100n,
      totalCostMicros: 1000n,
      recordCount: 1,
    });
    const updated = await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "tenant",
      scopeRef: null,
      windowStart,
      windowEnd,
      granularity: "day",
      totalQuantity: 200n,
      totalCostMicros: 2000n,
      recordCount: 2,
    });

    expect(updated.totalQuantity).toBe(200n);
    const list = await listCostAggregatesByTenant(fx.tenantId);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.scopeRef).toBeNull();
  });
});

// ─── listCostAggregatesByTenant ───────────────────────

describe("listCostAggregatesByTenant", () => {
  it("dimension/scopeType/granularity 过滤 + windowStart 降序", async () => {
    const fx = await seedTenant();
    await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "agent",
      scopeRef: "a1",
      windowStart: new Date("2026-07-21T10:00:00.000Z"),
      windowEnd: new Date("2026-07-21T11:00:00.000Z"),
      granularity: "hour",
      totalQuantity: 100n,
      totalCostMicros: 1000n,
      recordCount: 1,
    });
    await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_output",
      scopeType: "agent",
      scopeRef: "a2",
      windowStart: new Date("2026-07-21T12:00:00.000Z"),
      windowEnd: new Date("2026-07-21T13:00:00.000Z"),
      granularity: "hour",
      totalQuantity: 200n,
      totalCostMicros: 2000n,
      recordCount: 2,
    });

    const inputHour = await listCostAggregatesByTenant(fx.tenantId, {
      dimension: "token_input",
      granularity: "hour",
    });
    expect(inputHour.items).toHaveLength(1);
    expect(inputHour.items[0]?.dimension).toBe("token_input");
    expect(inputHour.items[0]?.scopeRef).toBe("a1");

    // windowStart 降序：12:00 在前
    const all = await listCostAggregatesByTenant(fx.tenantId);
    expect(all.items).toHaveLength(2);
    expect(all.items[0]?.windowStart.toISOString()).toBe("2026-07-21T12:00:00.000Z");
    expect(all.items[1]?.windowStart.toISOString()).toBe("2026-07-21T10:00:00.000Z");
  });

  it("windowFrom / windowTo 时间窗口过滤", async () => {
    const fx = await seedTenant();
    await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "tenant",
      scopeRef: null,
      windowStart: new Date("2026-07-21T08:00:00.000Z"),
      windowEnd: new Date("2026-07-21T09:00:00.000Z"),
      granularity: "hour",
      totalQuantity: 100n,
      totalCostMicros: 1000n,
      recordCount: 1,
    });
    await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "tenant",
      scopeRef: null,
      windowStart: new Date("2026-07-21T10:00:00.000Z"),
      windowEnd: new Date("2026-07-21T11:00:00.000Z"),
      granularity: "hour",
      totalQuantity: 200n,
      totalCostMicros: 2000n,
      recordCount: 2,
    });

    const windowed = await listCostAggregatesByTenant(fx.tenantId, {
      windowFrom: new Date("2026-07-21T09:00:00.000Z"),
      windowTo: new Date("2026-07-21T09:30:00.000Z"),
    });
    expect(windowed.items).toHaveLength(0);

    const windowed2 = await listCostAggregatesByTenant(fx.tenantId, {
      windowFrom: new Date("2026-07-21T09:00:00.000Z"),
      windowTo: new Date("2026-07-21T11:00:00.000Z"),
    });
    expect(windowed2.items).toHaveLength(1);
    expect(windowed2.items[0]?.windowStart.toISOString()).toBe("2026-07-21T10:00:00.000Z");
  });

  it("跨租户查询返回空数组", async () => {
    const fx = await seedTenant();
    await createOrUpdateCostAggregate({
      tenantId: fx.tenantId,
      dimension: "token_input",
      scopeType: "tenant",
      scopeRef: null,
      windowStart: new Date("2026-07-21T10:00:00.000Z"),
      windowEnd: new Date("2026-07-21T11:00:00.000Z"),
      granularity: "hour",
      totalQuantity: 100n,
      totalCostMicros: 1000n,
      recordCount: 1,
    });

    const other = await listCostAggregatesByTenant(randomUUID());
    expect(other.items).toHaveLength(0);
  });
});

// ─── CapacitySnapshot ─────────────────────────────────

describe("CapacitySnapshot", () => {
  it("createCapacitySnapshot：默认值 + 全字段透传", async () => {
    const fx = await seedTenant();
    const snapshotAt = new Date("2026-07-21T10:00:00.000Z");

    const snapshot = await createCapacitySnapshot({
      tenantId: fx.tenantId,
      scopeType: "tenant",
      snapshotAt,
    });

    expect(snapshot.tenantId).toBe(fx.tenantId);
    expect(snapshot.scopeType).toBe("tenant");
    expect(snapshot.scopeRef).toBeNull();
    expect(snapshot.activeInvocations).toBe(0);
    expect(snapshot.queuedJobs).toBe(0);
    expect(snapshot.coldStartsLastHour).toBe(0);
    expect(snapshot.limitInvocationsPerMinute).toBeNull();
    expect(snapshot.limitTokensPerMinute).toBeNull();
    expect(snapshot.limitCostPerHourMicros).toBeNull();
    expect(snapshot.failureCountLastHour).toBe(0);
    expect(snapshot.snapshotAt.toISOString()).toBe(snapshotAt.toISOString());
    expect(snapshot.createdAt).toBeInstanceOf(Date);
  });

  it("全字段透传 + bigint 限额", async () => {
    const fx = await seedTenant();
    const snapshot = await createCapacitySnapshot({
      tenantId: fx.tenantId,
      scopeType: "agent",
      scopeRef: "agent-001",
      activeInvocations: 5,
      queuedJobs: 12,
      coldStartsLastHour: 3,
      limitInvocationsPerMinute: 100,
      limitTokensPerMinute: 1_000_000n,
      limitCostPerHourMicros: 5_000_000n,
      failureCountLastHour: 2,
    });

    expect(snapshot.activeInvocations).toBe(5);
    expect(snapshot.queuedJobs).toBe(12);
    expect(snapshot.coldStartsLastHour).toBe(3);
    expect(snapshot.limitInvocationsPerMinute).toBe(100);
    expect(snapshot.limitTokensPerMinute).toBe(1_000_000n);
    expect(snapshot.limitCostPerHourMicros).toBe(5_000_000n);
    expect(snapshot.failureCountLastHour).toBe(2);
    expect(snapshot.limitTokensPerMinute?.toString()).toBe("1000000");
  });

  it("getCapacitySnapshotById：命中 + 跨租户隔离", async () => {
    const fx = await seedTenant();
    const s = await createCapacitySnapshot({
      tenantId: fx.tenantId,
      scopeType: "tenant",
    });

    const found = await getCapacitySnapshotById(fx.tenantId, s.id);
    expect(found?.id).toBe(s.id);

    const missing = await getCapacitySnapshotById(fx.tenantId, randomUUID());
    expect(missing).toBeNull();

    const crossTenant = await getCapacitySnapshotById(randomUUID(), s.id);
    expect(crossTenant).toBeNull();
  });

  it("listCapacitySnapshotsByTenant：snapshotAt 降序 + scopeType/scopeRef 过滤", async () => {
    const fx = await seedTenant();
    const t1 = new Date("2026-07-21T10:00:00.000Z");
    const t2 = new Date("2026-07-21T11:00:00.000Z");
    await createCapacitySnapshot({
      tenantId: fx.tenantId,
      scopeType: "agent",
      scopeRef: "a1",
      snapshotAt: t1,
    });
    await createCapacitySnapshot({
      tenantId: fx.tenantId,
      scopeType: "agent",
      scopeRef: "a2",
      snapshotAt: t2,
    });
    await createCapacitySnapshot({
      tenantId: fx.tenantId,
      scopeType: "tenant",
      snapshotAt: t1,
    });

    const agentScope = await listCapacitySnapshotsByTenant(fx.tenantId, { scopeType: "agent" });
    expect(agentScope.items).toHaveLength(2);
    expect(agentScope.items[0]?.snapshotAt.toISOString()).toBe(t2.toISOString()); // 降序

    const a1Only = await listCapacitySnapshotsByTenant(fx.tenantId, {
      scopeType: "agent",
      scopeRef: "a1",
    });
    expect(a1Only.items).toHaveLength(1);
    expect(a1Only.items[0]?.scopeRef).toBe("a1");
  });

  it("listCapacitySnapshotsByTenant 跨租户隔离", async () => {
    const fx = await seedTenant();
    await createCapacitySnapshot({ tenantId: fx.tenantId, scopeType: "tenant" });

    const other = await listCapacitySnapshotsByTenant(randomUUID());
    expect(other.items).toHaveLength(0);
  });
});

// ─── ServiceLevelIndicator ────────────────────────────

describe("ServiceLevelIndicator", () => {
  it("createServiceLevelIndicator：默认 breach=false + decimal 字段透传", async () => {
    const fx = await seedTenant();
    const measuredAt = new Date("2026-07-21T10:00:00.000Z");

    const sli = await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "tenant",
      indicatorKey: "invocation_p95_ms",
      indicatorValue: 450,
      thresholdValue: 500,
      measuredAt,
    });

    expect(sli.tenantId).toBe(fx.tenantId);
    expect(sli.scopeType).toBe("tenant");
    expect(sli.scopeRef).toBeNull();
    expect(sli.indicatorKey).toBe("invocation_p95_ms");
    expect(sli.indicatorValue).toBe("450.000000"); // decimal 读出为 string
    expect(sli.thresholdValue).toBe("500.000000");
    expect(sli.breach).toBe(false);
    expect(sli.alertInvocationId).toBeNull();
    expect(sli.alertTraceId).toBeNull();
    expect(sli.measuredAt.toISOString()).toBe(measuredAt.toISOString());
  });

  it("显式 breach=true + alert 跳转引用", async () => {
    const fx = await seedTenant();
    const invocationId = randomUUID();
    const traceId = randomUUID();

    const sli = await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "agent",
      scopeRef: "agent-001",
      indicatorKey: "tool_call_failure_rate",
      indicatorValue: "0.15",
      thresholdValue: "0.05",
      breach: true,
      alertInvocationId: invocationId,
      alertTraceId: traceId,
    });

    expect(sli.breach).toBe(true);
    expect(sli.alertInvocationId).toBe(invocationId);
    expect(sli.alertTraceId).toBe(traceId);
    expect(sli.indicatorValue).toBe("0.150000");
    expect(sli.thresholdValue).toBe("0.050000");
  });

  it("getServiceLevelIndicatorById：命中 + 跨租户隔离", async () => {
    const fx = await seedTenant();
    const sli = await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "tenant",
      indicatorKey: "job_success_rate",
      indicatorValue: "0.95",
    });

    const found = await getServiceLevelIndicatorById(fx.tenantId, sli.id);
    expect(found?.id).toBe(sli.id);

    const missing = await getServiceLevelIndicatorById(fx.tenantId, randomUUID());
    expect(missing).toBeNull();

    const crossTenant = await getServiceLevelIndicatorById(randomUUID(), sli.id);
    expect(crossTenant).toBeNull();
  });

  it("listServiceLevelIndicatorsByTenant：measuredAt 降序 + breach_only 过滤", async () => {
    const fx = await seedTenant();
    const t1 = new Date("2026-07-21T10:00:00.000Z");
    const t2 = new Date("2026-07-21T11:00:00.000Z");
    await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "tenant",
      indicatorKey: "invocation_p95_ms",
      indicatorValue: 450,
      measuredAt: t1,
    });
    await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "tenant",
      indicatorKey: "tool_call_failure_rate",
      indicatorValue: 0.2,
      thresholdValue: 0.05,
      breach: true,
      measuredAt: t2,
    });

    const all = await listServiceLevelIndicatorsByTenant(fx.tenantId);
    expect(all.items).toHaveLength(2);
    expect(all.items[0]?.measuredAt.toISOString()).toBe(t2.toISOString()); // 降序

    const breaches = await listServiceLevelIndicatorsByTenant(fx.tenantId, { breachOnly: true });
    expect(breaches.items).toHaveLength(1);
    expect(breaches.items[0]?.breach).toBe(true);
    expect(breaches.items[0]?.indicatorKey).toBe("tool_call_failure_rate");
  });

  it("indicator_key 与 scopeType 复合过滤", async () => {
    const fx = await seedTenant();
    await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "tenant",
      indicatorKey: "invocation_p50_ms",
      indicatorValue: 100,
    });
    await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "agent",
      scopeRef: "a1",
      indicatorKey: "invocation_p50_ms",
      indicatorValue: 200,
    });

    const tenantP50 = await listServiceLevelIndicatorsByTenant(fx.tenantId, {
      scopeType: "tenant",
      indicatorKey: "invocation_p50_ms",
    });
    expect(tenantP50.items).toHaveLength(1);
    expect(tenantP50.items[0]?.scopeType).toBe("tenant");
  });
});

// ─── getCapacityAlertsByTenant ────────────────────────

describe("getCapacityAlertsByTenant", () => {
  it("只返回 breach=true 的 SLI + 关联最近 snapshot", async () => {
    const fx = await seedTenant();
    const invocationId = randomUUID();
    const traceId = randomUUID();
    const measuredAt = new Date("2026-07-21T10:00:00.000Z");
    const snapshotAt = new Date("2026-07-21T10:30:00.000Z");

    // 非 breach 的 SLI（不应出现在告警列表）
    await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "tenant",
      indicatorKey: "invocation_p95_ms",
      indicatorValue: 400,
      thresholdValue: 500,
      breach: false,
      measuredAt,
    });
    // breach SLI + alert 跳转引用
    const breachSli = await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "agent",
      scopeRef: "agent-001",
      indicatorKey: "tool_call_failure_rate",
      indicatorValue: 0.2,
      thresholdValue: 0.05,
      breach: true,
      alertInvocationId: invocationId,
      alertTraceId: traceId,
      measuredAt,
    });
    // 同 scope 的 capacity snapshot（关联到告警）
    const snapshot = await createCapacitySnapshot({
      tenantId: fx.tenantId,
      scopeType: "agent",
      scopeRef: "agent-001",
      activeInvocations: 8,
      queuedJobs: 20,
      coldStartsLastHour: 5,
      failureCountLastHour: 4,
      snapshotAt,
    });

    const result = await getCapacityAlertsByTenant(fx.tenantId);
    expect(result.items).toHaveLength(1);
    const alert = result.items[0];
    expect(alert).toBeDefined();
    expect(alert?.indicator.id).toBe(breachSli.id);
    expect(alert?.indicator.breach).toBe(true);
    expect(alert?.alertInvocationId).toBe(invocationId);
    expect(alert?.alertTraceId).toBe(traceId);
    expect(alert?.latestSnapshot).not.toBeNull();
    expect(alert?.latestSnapshot?.id).toBe(snapshot.id);
    expect(alert?.latestSnapshot?.activeInvocations).toBe(8);
    expect(alert?.latestSnapshot?.failureCountLastHour).toBe(4);
  });

  it("无关联 snapshot 时 latestSnapshot=null", async () => {
    const fx = await seedTenant();
    await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "environment",
      scopeRef: "env-001",
      indicatorKey: "queue_wait_p95_ms",
      indicatorValue: 5000,
      thresholdValue: 1000,
      breach: true,
    });

    const result = await getCapacityAlertsByTenant(fx.tenantId);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.latestSnapshot).toBeNull();
  });

  it("scopeType 过滤：只返回匹配 scope 的告警", async () => {
    const fx = await seedTenant();
    await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "agent",
      scopeRef: "a1",
      indicatorKey: "tool_call_failure_rate",
      indicatorValue: 0.2,
      thresholdValue: 0.05,
      breach: true,
    });
    await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "environment",
      scopeRef: "env-1",
      indicatorKey: "queue_wait_p95_ms",
      indicatorValue: 5000,
      thresholdValue: 1000,
      breach: true,
    });

    const agentAlerts = await getCapacityAlertsByTenant(fx.tenantId, { scopeType: "agent" });
    expect(agentAlerts.items).toHaveLength(1);
    expect(agentAlerts.items[0]?.indicator.scopeType).toBe("agent");

    const envAlerts = await getCapacityAlertsByTenant(fx.tenantId, { scopeType: "environment" });
    expect(envAlerts.items).toHaveLength(1);
    expect(envAlerts.items[0]?.indicator.scopeType).toBe("environment");
  });

  it("跨租户查询返回空数组", async () => {
    const fx = await seedTenant();
    await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "tenant",
      indicatorKey: "tool_call_failure_rate",
      indicatorValue: 0.2,
      thresholdValue: 0.05,
      breach: true,
    });

    const other = await getCapacityAlertsByTenant(randomUUID());
    expect(other.items).toHaveLength(0);
  });

  it("关联 snapshot 按 snapshotAt desc 取最近一次", async () => {
    const fx = await seedTenant();
    await createServiceLevelIndicator({
      tenantId: fx.tenantId,
      scopeType: "agent",
      scopeRef: "a1",
      indicatorKey: "tool_call_failure_rate",
      indicatorValue: 0.2,
      thresholdValue: 0.05,
      breach: true,
      measuredAt: new Date("2026-07-21T12:00:00.000Z"),
    });
    // 旧 snapshot
    await createCapacitySnapshot({
      tenantId: fx.tenantId,
      scopeType: "agent",
      scopeRef: "a1",
      activeInvocations: 1,
      snapshotAt: new Date("2026-07-21T10:00:00.000Z"),
    });
    // 新 snapshot（应被关联）
    const latest = await createCapacitySnapshot({
      tenantId: fx.tenantId,
      scopeType: "agent",
      scopeRef: "a1",
      activeInvocations: 99,
      snapshotAt: new Date("2026-07-21T11:30:00.000Z"),
    });

    const result = await getCapacityAlertsByTenant(fx.tenantId);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.latestSnapshot?.id).toBe(latest.id);
    expect(result.items[0]?.latestSnapshot?.activeInvocations).toBe(99);
  });
});
