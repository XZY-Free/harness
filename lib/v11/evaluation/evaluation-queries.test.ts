/**
 * S11-W06：V11 Evaluation 仓储集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - createEvaluationRun：成功 + 默认值 + 全字段透传
 * - getEvaluationRunById：成功 + 不存在返回 null + 跨租户隔离
 * - listEvaluationRunsByTenant：createdAt 降序 + state/agent_revision_id 过滤 + cursor 分页
 * - updateEvaluationRunState：状态转换 + startedAt/finishedAt 写入
 * - updateEvaluationRunSummary：summary 投影写入 + 覆盖更新
 * - createEvaluationCase：成功 + 默认 pending + 跨 run 同 caseKey 允许
 * - getEvaluationCaseById：成功 + 跨租户隔离
 * - listEvaluationCasesByRun：createdAt 升序 + caseState 过滤
 * - createEvaluationResult：Run 级 + Case 级 + comparator/threshold 默认
 * - listEvaluationResultsByRun：metric_key 过滤 + limit
 * - listEvaluationResultsByCase：Case 级 Result 查询
 *
 * 不变量（事实源：11 文档 S11-W06 行 82-87）：
 * - 评测对象明确绑定 AgentRevision、RuntimeRevision、Route、模型、数据集和评测策略
 * - 评测执行使用独立 Job/Environment、真实持久数据和受控工具；不使用生产数据或生产 Credential
 * - 结果保留案例级证据、版本引用、失败原因和可比较指标；阈值只按 Agent 风险配置，不一刀切
 * - 跨租户隔离：所有查询按 tenantId 过滤
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createEvaluationCase,
  createEvaluationResult,
  createEvaluationRun,
  getEvaluationCaseById,
  getEvaluationRunById,
  listEvaluationCasesByRun,
  listEvaluationResultsByCase,
  listEvaluationResultsByRun,
  listEvaluationRunsByTenant,
  updateEvaluationRunState,
  updateEvaluationRunSummary,
} from "@/lib/v11/evaluation/evaluation-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { v11Job } from "@/lib/v11/schema/job";
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

/** 直接插入一个最小 V11Job 行（供 EvaluationRun.jobId FK 引用）。 */
async function seedJob(tenantId: string): Promise<string> {
  const jobId = randomUUID();
  await db.insert(v11Job).values({
    id: jobId,
    tenantId,
    agentId: randomUUID(),
    jobType: "evaluation",
    triggerRef: "evaluation-test-trigger",
    completionPolicyJson: { type: "all_success" },
  });
  return jobId;
}

/** 创建一个默认 EvaluationRun（deterministic_protocol 策略）。 */
async function createDefaultRun(
  tenantId: string,
  options?: {
    agentRevisionId?: string;
    strategyKey?: "deterministic_protocol" | "safety" | "permission" | "tool_schema" | "regression";
    datasetRef?: string;
    jobId?: string | null;
    runtimeRevisionId?: string | null;
    routeId?: string | null;
    modelRef?: string | null;
    thresholdConfigJson?: Record<string, unknown> | null;
    createdBy?: string | null;
  },
) {
  return createEvaluationRun({
    tenantId,
    agentRevisionId: options?.agentRevisionId ?? randomUUID(),
    strategyKey: options?.strategyKey ?? "deterministic_protocol",
    datasetRef: options?.datasetRef ?? "dataset://protocol/case-v1",
    jobId: options?.jobId ?? null,
    runtimeRevisionId: options?.runtimeRevisionId ?? null,
    routeId: options?.routeId ?? null,
    modelRef: options?.modelRef ?? null,
    thresholdConfigJson: options?.thresholdConfigJson ?? null,
    createdBy: options?.createdBy ?? null,
  });
}

// ─── createEvaluationRun ───────────────────────────────

describe("createEvaluationRun 成功路径", () => {
  it("成功创建 Run + 默认值（runState=queued, versionNo=1, summary=null）", async () => {
    const fx = await seedTenant();
    const agentRevisionId = randomUUID();

    const run = await createEvaluationRun({
      tenantId: fx.tenantId,
      agentRevisionId,
      strategyKey: "deterministic_protocol",
      datasetRef: "dataset://protocol/case-v1",
    });

    expect(run.tenantId).toBe(fx.tenantId);
    expect(run.agentRevisionId).toBe(agentRevisionId);
    expect(run.strategyKey).toBe("deterministic_protocol");
    expect(run.datasetRef).toBe("dataset://protocol/case-v1");
    expect(run.runState).toBe("queued");
    expect(run.versionNo).toBe("1");
    expect(run.summaryJson).toBeNull();
    expect(run.thresholdConfigJson).toBeNull();
    expect(run.jobId).toBeNull();
    expect(run.runtimeRevisionId).toBeNull();
    expect(run.routeId).toBeNull();
    expect(run.modelRef).toBeNull();
    expect(run.createdBy).toBeNull();
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.createdAt).toBeInstanceOf(Date);
    expect(run.updatedAt).toBeInstanceOf(Date);
  });

  it("全字段透传：jobId/runtimeRevisionId/routeId/modelRef/thresholdConfigJson/createdBy", async () => {
    const fx = await seedTenant();
    const agentRevisionId = randomUUID();
    const jobId = await seedJob(fx.tenantId);
    const runtimeRevisionId = randomUUID();
    const routeId = randomUUID();
    const userId = randomUUID();
    const thresholdConfig = { pass_rate: 0.95, max_latency_ms: 500 };

    const run = await createEvaluationRun({
      tenantId: fx.tenantId,
      agentRevisionId,
      strategyKey: "regression",
      datasetRef: "dataset://regression/v2",
      jobId,
      runtimeRevisionId,
      routeId,
      modelRef: "doubao-pro-32k",
      thresholdConfigJson: thresholdConfig,
      createdBy: userId,
    });

    expect(run.jobId).toBe(jobId);
    expect(run.runtimeRevisionId).toBe(runtimeRevisionId);
    expect(run.routeId).toBe(routeId);
    expect(run.modelRef).toBe("doubao-pro-32k");
    expect(run.datasetRef).toBe("dataset://regression/v2");
    expect(run.strategyKey).toBe("regression");
    expect(run.thresholdConfigJson).toMatchObject(thresholdConfig);
    expect(run.createdBy).toBe(userId);
  });
});

// ─── getEvaluationRunById ──────────────────────────────

describe("getEvaluationRunById", () => {
  it("命中同租户 Run", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);

    const found = await getEvaluationRunById(fx.tenantId, run.id);
    expect(found?.id).toBe(run.id);
  });

  it("不存在返回 null", async () => {
    const fx = await seedTenant();
    const found = await getEvaluationRunById(fx.tenantId, randomUUID());
    expect(found).toBeNull();
  });

  it("跨租户查询返回 null", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);

    const crossTenant = await getEvaluationRunById(randomUUID(), run.id);
    expect(crossTenant).toBeNull();
  });
});

// ─── listEvaluationRunsByTenant ────────────────────────

describe("listEvaluationRunsByTenant", () => {
  it("按 createdAt 降序返回", async () => {
    const fx = await seedTenant();
    const r1 = await createDefaultRun(fx.tenantId);
    // 加微小延迟保证 createdAt 不同
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await createDefaultRun(fx.tenantId);

    const result = await listEvaluationRunsByTenant(fx.tenantId);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.id).toBe(r2.id); // 最新的在前
    expect(result.items[1]?.id).toBe(r1.id);
    expect(result.nextCursor).toBeNull();
  });

  it("state 过滤：只返回 queued", async () => {
    const fx = await seedTenant();
    const r1 = await createDefaultRun(fx.tenantId);
    const r2 = await createDefaultRun(fx.tenantId);
    // 把 r1 推进到 running
    await updateEvaluationRunState(fx.tenantId, r1.id, {
      runState: "running",
      startedAt: new Date(),
    });

    const queued = await listEvaluationRunsByTenant(fx.tenantId, { runState: "queued" });
    expect(queued.items).toHaveLength(1);
    expect(queued.items[0]?.id).toBe(r2.id);

    const running = await listEvaluationRunsByTenant(fx.tenantId, { runState: "running" });
    expect(running.items).toHaveLength(1);
    expect(running.items[0]?.id).toBe(r1.id);
  });

  it("agent_revision_id 过滤", async () => {
    const fx = await seedTenant();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const r1 = await createDefaultRun(fx.tenantId, { agentRevisionId: agentA });
    const r2 = await createDefaultRun(fx.tenantId, { agentRevisionId: agentB });
    const r3 = await createDefaultRun(fx.tenantId, { agentRevisionId: agentA });

    const agentARuns = await listEvaluationRunsByTenant(fx.tenantId, {
      agentRevisionId: agentA,
    });
    expect(agentARuns.items).toHaveLength(2);
    expect(agentARuns.items.map((r) => r.id).sort()).toEqual([r1.id, r3.id].sort());

    const agentBRuns = await listEvaluationRunsByTenant(fx.tenantId, {
      agentRevisionId: agentB,
    });
    expect(agentBRuns.items).toHaveLength(1);
    expect(agentBRuns.items[0]?.id).toBe(r2.id);
  });

  it("cursor 分页：limit+1 策略 + nextCursor 续读", async () => {
    const fx = await seedTenant();
    // 创建 5 个 Run，按 createdAt 降序
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await createDefaultRun(fx.tenantId);
      created.push(r.id);
      await new Promise((res) => setTimeout(res, 10));
    }
    // created 数组按时间升序，但列表返回时是降序，所以反转
    const expectedDesc = [...created].reverse();

    // 第一页 limit=2
    const page1 = await listEvaluationRunsByTenant(fx.tenantId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]?.id).toBe(expectedDesc[0]);
    expect(page1.items[1]?.id).toBe(expectedDesc[1]);
    expect(page1.nextCursor).not.toBeNull();

    // 第二页：用 page1 的 cursor
    const page2 = await listEvaluationRunsByTenant(fx.tenantId, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0]?.id).toBe(expectedDesc[2]);
    expect(page2.items[1]?.id).toBe(expectedDesc[3]);
    expect(page2.nextCursor).not.toBeNull();

    // 第三页：只剩 1 条
    const page3 = await listEvaluationRunsByTenant(fx.tenantId, {
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0]?.id).toBe(expectedDesc[4]);
    expect(page3.nextCursor).toBeNull();
  });

  it("跨租户查询返回空数组", async () => {
    const fx = await seedTenant();
    await createDefaultRun(fx.tenantId);

    const otherTenant = await listEvaluationRunsByTenant(randomUUID());
    expect(otherTenant.items).toHaveLength(0);
    expect(otherTenant.nextCursor).toBeNull();
  });

  it("非法 cursor 抛错", async () => {
    const fx = await seedTenant();
    // cursor 缺少 id 字段
    const badCursor = Buffer.from(
      JSON.stringify({ created_at: "2026-07-21T00:00:00.000Z" }),
    ).toString("base64url");
    await expect(listEvaluationRunsByTenant(fx.tenantId, { cursor: badCursor })).rejects.toThrow(
      /cursor 缺少 created_at\/id 字段/,
    );
  });
});

// ─── updateEvaluationRunState / Summary ────────────────

describe("updateEvaluationRunState + Summary", () => {
  it("queued → running：startedAt 写入", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);

    const startedAt = new Date();
    const updated = await updateEvaluationRunState(fx.tenantId, run.id, {
      runState: "running",
      startedAt,
    });
    expect(updated.runState).toBe("running");
    expect(updated.startedAt?.toISOString()).toBe(startedAt.toISOString());
    expect(updated.finishedAt).toBeNull();
  });

  it("running → completed：finishedAt 写入", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);
    await updateEvaluationRunState(fx.tenantId, run.id, {
      runState: "running",
      startedAt: new Date(),
    });

    const finishedAt = new Date();
    const completed = await updateEvaluationRunState(fx.tenantId, run.id, {
      runState: "completed",
      finishedAt,
    });
    expect(completed.runState).toBe("completed");
    expect(completed.finishedAt?.toISOString()).toBe(finishedAt.toISOString());
  });

  it("Run 不存在抛错", async () => {
    const fx = await seedTenant();
    await expect(
      updateEvaluationRunState(fx.tenantId, randomUUID(), { runState: "running" }),
    ).rejects.toThrow(/EvaluationRun 行未找到/);
  });

  it("updateEvaluationRunSummary：写入 summary + 覆盖更新", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);
    expect(run.summaryJson).toBeNull();

    const summary1 = { pass_rate: 0.95, total_cases: 100, passed_cases: 95 };
    const updated1 = await updateEvaluationRunSummary(fx.tenantId, run.id, summary1);
    expect(updated1.summaryJson).toMatchObject(summary1);

    // 覆盖更新
    const summary2 = { pass_rate: 0.96, total_cases: 100, passed_cases: 96 };
    const updated2 = await updateEvaluationRunSummary(fx.tenantId, run.id, summary2);
    expect(updated2.summaryJson).toMatchObject(summary2);
    expect(updated2.summaryJson).not.toMatchObject({ pass_rate: 0.95 });
  });

  it("updateEvaluationRunSummary：Run 不存在抛错", async () => {
    const fx = await seedTenant();
    await expect(
      updateEvaluationRunSummary(fx.tenantId, randomUUID(), { foo: "bar" }),
    ).rejects.toThrow(/EvaluationRun 行未找到/);
  });
});

// ─── EvaluationCase ────────────────────────────────────

describe("EvaluationCase", () => {
  it("createEvaluationCase：默认 caseState=pending + 全字段透传", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);

    const caseRow = await createEvaluationCase({
      tenantId: fx.tenantId,
      runId: run.id,
      caseKey: "case-001",
      scenarioRef: "scenario://protocol/dispatch",
      inputRedactedJson: { prompt: "hello [REDACTED]" },
      expectedJson: { should_dispatch: true },
      actualRedactedJson: { dispatched: true },
      evidenceJson: { trace_id: "trace-001", span_id: "span-001" },
    });

    expect(caseRow.tenantId).toBe(fx.tenantId);
    expect(caseRow.runId).toBe(run.id);
    expect(caseRow.caseKey).toBe("case-001");
    expect(caseRow.scenarioRef).toBe("scenario://protocol/dispatch");
    expect(caseRow.inputRedactedJson).toMatchObject({ prompt: "hello [REDACTED]" });
    expect(caseRow.expectedJson).toMatchObject({ should_dispatch: true });
    expect(caseRow.actualRedactedJson).toMatchObject({ dispatched: true });
    expect(caseRow.caseState).toBe("pending");
    expect(caseRow.failureReason).toBeNull();
    expect(caseRow.evidenceJson).toMatchObject({ trace_id: "trace-001", span_id: "span-001" });
    expect(caseRow.createdAt).toBeInstanceOf(Date);
  });

  it("createEvaluationCase：显式 caseState=failed + failureReason", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);

    const caseRow = await createEvaluationCase({
      tenantId: fx.tenantId,
      runId: run.id,
      caseKey: "case-failed",
      inputRedactedJson: { prompt: "test" },
      caseState: "failed",
      failureReason: "protocol_violation: dispatch binds immutable config",
    });

    expect(caseRow.caseState).toBe("failed");
    expect(caseRow.failureReason).toBe("protocol_violation: dispatch binds immutable config");
  });

  it("getEvaluationCaseById：命中 + 不存在 + 跨租户隔离", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);
    const caseRow = await createEvaluationCase({
      tenantId: fx.tenantId,
      runId: run.id,
      caseKey: "case-get",
      inputRedactedJson: { foo: "bar" },
    });

    const found = await getEvaluationCaseById(fx.tenantId, caseRow.id);
    expect(found?.id).toBe(caseRow.id);

    const missing = await getEvaluationCaseById(fx.tenantId, randomUUID());
    expect(missing).toBeNull();

    const crossTenant = await getEvaluationCaseById(randomUUID(), caseRow.id);
    expect(crossTenant).toBeNull();
  });

  it("listEvaluationCasesByRun：createdAt 升序 + caseState 过滤", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);

    const c1 = await createEvaluationCase({
      tenantId: fx.tenantId,
      runId: run.id,
      caseKey: "c1",
      inputRedactedJson: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    const c2 = await createEvaluationCase({
      tenantId: fx.tenantId,
      runId: run.id,
      caseKey: "c2",
      inputRedactedJson: {},
      caseState: "passed",
    });
    await new Promise((r) => setTimeout(r, 10));
    const c3 = await createEvaluationCase({
      tenantId: fx.tenantId,
      runId: run.id,
      caseKey: "c3",
      inputRedactedJson: {},
      caseState: "failed",
    });

    const all = await listEvaluationCasesByRun(fx.tenantId, run.id);
    expect(all).toHaveLength(3);
    expect(all[0]?.id).toBe(c1.id);
    expect(all[1]?.id).toBe(c2.id);
    expect(all[2]?.id).toBe(c3.id);

    const passed = await listEvaluationCasesByRun(fx.tenantId, run.id, { caseState: "passed" });
    expect(passed).toHaveLength(1);
    expect(passed[0]?.id).toBe(c2.id);

    const failed = await listEvaluationCasesByRun(fx.tenantId, run.id, { caseState: "failed" });
    expect(failed).toHaveLength(1);
    expect(failed[0]?.id).toBe(c3.id);
  });

  it("跨租户查询 Case 返回空数组", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);
    await createEvaluationCase({
      tenantId: fx.tenantId,
      runId: run.id,
      caseKey: "c-cross",
      inputRedactedJson: {},
    });

    const otherTenant = await listEvaluationCasesByRun(randomUUID(), run.id);
    expect(otherTenant).toHaveLength(0);
  });
});

// ─── EvaluationResult ──────────────────────────────────

describe("EvaluationResult", () => {
  it("createEvaluationResult：Run 级指标 + 默认 comparator=higher_better", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);

    const result = await createEvaluationResult({
      tenantId: fx.tenantId,
      runId: run.id,
      metricKey: "pass_rate",
      metricValue: "0.95",
      passed: true,
    });

    expect(result.tenantId).toBe(fx.tenantId);
    expect(result.runId).toBe(run.id);
    expect(result.caseId).toBeNull();
    expect(result.metricKey).toBe("pass_rate");
    expect(result.metricValue).toBe("0.950000");
    expect(result.comparator).toBe("higher_better");
    expect(result.thresholdValue).toBeNull();
    expect(result.passed).toBe(true);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it("createEvaluationResult：Case 级指标 + threshold comparator + thresholdValue", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);
    const caseRow = await createEvaluationCase({
      tenantId: fx.tenantId,
      runId: run.id,
      caseKey: "case-threshold",
      inputRedactedJson: {},
    });

    const result = await createEvaluationResult({
      tenantId: fx.tenantId,
      runId: run.id,
      caseId: caseRow.id,
      metricKey: "latency_p95_ms",
      metricValue: 450,
      comparator: "threshold",
      thresholdValue: 500,
      passed: true,
    });

    expect(result.caseId).toBe(caseRow.id);
    expect(result.metricValue).toBe("450.000000");
    expect(result.comparator).toBe("threshold");
    expect(result.thresholdValue).toBe("500.000000");
    expect(result.passed).toBe(true);
  });

  it("createEvaluationResult：lower_better comparator", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);

    const result = await createEvaluationResult({
      tenantId: fx.tenantId,
      runId: run.id,
      metricKey: "protocol_violation_count",
      metricValue: 0,
      comparator: "lower_better",
      passed: true,
    });

    expect(result.comparator).toBe("lower_better");
    expect(result.metricValue).toBe("0.000000");
  });

  it("listEvaluationResultsByRun：metric_key 过滤 + createdAt 升序", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);

    const r1 = await createEvaluationResult({
      tenantId: fx.tenantId,
      runId: run.id,
      metricKey: "pass_rate",
      metricValue: "0.95",
      passed: true,
    });
    await new Promise((res) => setTimeout(res, 10));
    const r2 = await createEvaluationResult({
      tenantId: fx.tenantId,
      runId: run.id,
      metricKey: "latency_p95_ms",
      metricValue: 450,
      comparator: "lower_better",
      passed: true,
    });
    await new Promise((res) => setTimeout(res, 10));
    const r3 = await createEvaluationResult({
      tenantId: fx.tenantId,
      runId: run.id,
      metricKey: "pass_rate",
      metricValue: "0.92",
      passed: true,
    });

    const all = await listEvaluationResultsByRun(fx.tenantId, run.id);
    expect(all).toHaveLength(3);
    expect(all[0]?.id).toBe(r1.id);
    expect(all[1]?.id).toBe(r2.id);
    expect(all[2]?.id).toBe(r3.id);

    const passRateOnly = await listEvaluationResultsByRun(fx.tenantId, run.id, {
      metricKey: "pass_rate",
    });
    expect(passRateOnly).toHaveLength(2);
    expect(passRateOnly[0]?.id).toBe(r1.id);
    expect(passRateOnly[1]?.id).toBe(r3.id);
  });

  it("listEvaluationResultsByCase：只返回该 Case 的 Result", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);
    const caseA = await createEvaluationCase({
      tenantId: fx.tenantId,
      runId: run.id,
      caseKey: "caseA",
      inputRedactedJson: {},
    });
    const caseB = await createEvaluationCase({
      tenantId: fx.tenantId,
      runId: run.id,
      caseKey: "caseB",
      inputRedactedJson: {},
    });

    const r1 = await createEvaluationResult({
      tenantId: fx.tenantId,
      runId: run.id,
      caseId: caseA.id,
      metricKey: "case_passed",
      metricValue: 1,
      passed: true,
    });
    const r2 = await createEvaluationResult({
      tenantId: fx.tenantId,
      runId: run.id,
      caseId: caseB.id,
      metricKey: "case_passed",
      metricValue: 0,
      passed: false,
    });

    const caseAResults = await listEvaluationResultsByCase(fx.tenantId, caseA.id);
    expect(caseAResults).toHaveLength(1);
    expect(caseAResults[0]?.id).toBe(r1.id);
    expect(caseAResults[0]?.passed).toBe(true);

    const caseBResults = await listEvaluationResultsByCase(fx.tenantId, caseB.id);
    expect(caseBResults).toHaveLength(1);
    expect(caseBResults[0]?.id).toBe(r2.id);
    expect(caseBResults[0]?.passed).toBe(false);
  });

  it("跨租户查询 Result 返回空数组", async () => {
    const fx = await seedTenant();
    const run = await createDefaultRun(fx.tenantId);
    await createEvaluationResult({
      tenantId: fx.tenantId,
      runId: run.id,
      metricKey: "pass_rate",
      metricValue: "0.95",
      passed: true,
    });

    const otherTenant = await listEvaluationResultsByRun(randomUUID(), run.id);
    expect(otherTenant).toHaveLength(0);
  });
});
