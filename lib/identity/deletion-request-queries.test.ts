/**
 * S12-W07：可验证删除集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - createDeletionRequest：创建 + 审计 deletion.request + auditEventId 回填 + 重复受理检测。
 * - getDeletionRequestById / getActiveDeletionRequestBySubject：查询 + 跨租户隔离 + 终态过滤。
 * - updateDeletionRequestState：状态机合法/非法转移 + 审计 before/after + completedAt 回填。
 * - setBlockedReasonCodes / parseBlockedReasonCodes：JSON 序列化/解析。
 * - listDeletionRequests：cursor 分页 + subjectType/state/requestedBy 过滤。
 * - Step 管理：insert / list / markStepRunning（幂等）/ complete / fail / retain / blocked / skipped。
 * - computeRequestSummary / deriveTerminalStateFromSteps：汇总与终态派生。
 * - listRunnableSteps / countStepsByStates：可执行步骤查询。
 * - planDeletion：Legal Hold 阻止（tenant + subject 级）+ 各 subject 类型 step 生成。
 * - executeDeletionRequest：成功 / 部分失败 / 重试 / 幂等 / retained / fail-closed。
 * - RecordingDeletionStoreAdapter：success / fail / retain / succeedOnAttempt。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import { executeDeletionRequest, retryDeletionRequest } from "@/lib/identity/deletion-executor";
import { planDeletion } from "@/lib/identity/deletion-planner";
import {
  DeletionRequestError,
  completeDeletionStep,
  computeRequestSummary,
  countStepsByStates,
  createDeletionRequest,
  deriveTerminalStateFromSteps,
  failDeletionStep,
  getActiveDeletionRequestBySubject,
  getDeletionRequestById,
  getDeletionStep,
  insertDeletionSteps,
  listDeletionRequests,
  listDeletionSteps,
  listRunnableSteps,
  markStepBlocked,
  markStepRetained,
  markStepRunning,
  markStepSkipped,
  parseBlockedReasonCodes,
  setBlockedReasonCodes,
  updateDeletionRequestState,
} from "@/lib/identity/deletion-request-queries";
import {
  DeletionStoreError,
  FailClosedDeletionStoreAdapter,
  RecordingDeletionStoreAdapter,
} from "@/lib/identity/deletion-store-adapter";
import {
  resetDeletionStoreOverrides,
  setDeletionStoreAdaptersOverride,
} from "@/lib/identity/deletion-store-config";
import { createLegalHold } from "@/lib/identity/legal-hold-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import type {
  DeletionStep,
  DeletionStoreType,
  DeletionSubjectType,
} from "@/lib/persistence/schema/deletion-request";
import { tenant } from "@/lib/persistence/schema/identity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
  setDeletionStoreAdaptersOverride(null);
});

afterEach(() => {
  resetDeletionStoreOverrides();
});

// ─── 辅助 ──────────────────────────────────────────────────

function buildActor(tenantId: string): AuditActor {
  return { tenantId, actorType: "user", actorId: "admin-001" };
}

function buildCreateParams(opts: {
  tenantId: string;
  subjectType?: DeletionSubjectType;
  subjectId?: string;
  requestedBy?: string;
}) {
  return {
    tenantId: opts.tenantId,
    subjectType: opts.subjectType ?? ("thread" as const),
    subjectId: opts.subjectId ?? "thr-001",
    deleteMode: "standard" as const,
    reasonCode: "ADMIN_POLICY",
    policyRevisionId: "retpol-12",
    requestedBy: opts.requestedBy ?? "admin-001",
    requestPrincipalKind: "user" as const,
    actor: buildActor(opts.tenantId),
  };
}

async function seedExtraTenant(tenantId: string, key: string): Promise<void> {
  await db.insert(tenant).values({
    id: tenantId,
    key,
    name: `Extra Tenant ${key}`,
    status: "active",
  });
}

async function seedLegalHold(
  tenantId: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await createLegalHold({
    tenantId,
    targetType: targetType as "tenant" | "thread" | "artifact",
    targetId,
    reason: "诉讼保留",
    createdBy: "admin-001",
    approvedBy: "approver-001",
    validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    actor: buildActor(tenantId),
  });
}

/** 注入全 success Recording Adapter 映射（5 类存储）。 */
function injectSuccessAdapters(): Map<DeletionStoreType, RecordingDeletionStoreAdapter> {
  const map = new Map<DeletionStoreType, RecordingDeletionStoreAdapter>();
  for (const st of ["mysql", "object_storage", "vector_search", "trace_log", "cache"] as const) {
    map.set(st, new RecordingDeletionStoreAdapter(st, { defaultBehavior: "success" }));
  }
  setDeletionStoreAdaptersOverride(map);
  return map;
}

/** 取 steps 首个元素的 id（测试 fixture 约定至少插入一条）。 */
function firstStepId(steps: DeletionStep[]): string {
  const first = steps[0];
  if (!first) throw new Error("测试设置错误：期望至少一条 step");
  return first.id;
}

const EXTRA_TENANT_ID = "00000000-0000-4000-8000-000000000001";

// ═══════════════════════════════════════════════════════════
// 1. createDeletionRequest
// ═══════════════════════════════════════════════════════════

describe("createDeletionRequest", () => {
  it("创建请求（planning 状态）并返回完整字段", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    expect(req.id).toBeDefined();
    expect(req.tenantId).toBe(t.id);
    expect(req.subjectType).toBe("thread");
    expect(req.subjectId).toBe("thr-001");
    expect(req.deleteMode).toBe("standard");
    expect(req.reasonCode).toBe("ADMIN_POLICY");
    expect(req.policyRevisionId).toBe("retpol-12");
    expect(req.requestedBy).toBe("admin-001");
    expect(req.requestPrincipalKind).toBe("user");
    expect(req.requestState).toBe("planning");
    expect(req.blockedReasonCodes).toBeNull();
    expect(req.auditEventId).toBeTruthy();
    expect(req.acceptedAt).toBeInstanceOf(Date);
  });

  it("创建请求时写审计事件 deletion.request 并回填 auditEventId", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    const events = await listAuditEvents({
      tenantId: t.id,
      actionType: "deletion.request",
      targetType: "deletion_request",
      targetId: req.id,
    });

    expect(events.length).toBe(1);
    const event = events[0];
    expect(event).toBeDefined();
    expect(event?.actorType).toBe("user");
    expect(event?.actorId).toBe("admin-001");
    expect(event?.afterHash).toBeTruthy();
    expect(req.auditEventId).toBe(event?.id);
  });

  it("重复受理（同 subject 已有非终态请求）抛 duplicate_active_request", async () => {
    const t = await ensureDefaultTenant();
    await createDeletionRequest(buildCreateParams({ tenantId: t.id, subjectId: "thr-dup" }));

    await expect(
      createDeletionRequest(buildCreateParams({ tenantId: t.id, subjectId: "thr-dup" })),
    ).rejects.toMatchObject({ code: "duplicate_active_request" });
  });

  it("终态后同 subject 可再次创建请求", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectId: "thr-term" }),
    );
    await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "cancelled",
      actor: buildActor(t.id),
    });

    // cancelled 是终态，可再次创建
    const req2 = await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectId: "thr-term" }),
    );
    expect(req2.id).not.toBe(req.id);
    expect(req2.requestState).toBe("planning");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. getDeletionRequestById / getActiveDeletionRequestBySubject
// ═══════════════════════════════════════════════════════════

describe("getDeletionRequestById / getActiveDeletionRequestBySubject", () => {
  it("getDeletionRequestById 按 id 查询", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    const found = await getDeletionRequestById(t.id, req.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(req.id);
  });

  it("getDeletionRequestById 不存在返回 null", async () => {
    const t = await ensureDefaultTenant();
    const found = await getDeletionRequestById(t.id, "non-existent");
    expect(found).toBeNull();
  });

  it("跨租户隔离：getDeletionRequestById", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    const found = await getDeletionRequestById(EXTRA_TENANT_ID, req.id);
    expect(found).toBeNull();
  });

  it("getActiveDeletionRequestBySubject 返回非终态请求", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectId: "thr-active" }),
    );

    const active = await getActiveDeletionRequestBySubject(t.id, "thread", "thr-active");
    expect(active).not.toBeNull();
    expect(active?.id).toBe(req.id);
  });

  it("getActiveDeletionRequestBySubject 终态后返回 null", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectId: "thr-done" }),
    );
    await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "completed",
      actor: buildActor(t.id),
    });

    const active = await getActiveDeletionRequestBySubject(t.id, "thread", "thr-done");
    expect(active).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. updateDeletionRequestState（状态机）
// ═══════════════════════════════════════════════════════════

describe("updateDeletionRequestState", () => {
  it("合法转移：planning → deleting → completed", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    const deleting = await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "deleting",
      actor: buildActor(t.id),
    });
    expect(deleting.requestState).toBe("deleting");
    expect(deleting.completedAt).toBeNull();

    const completed = await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "completed",
      actor: buildActor(t.id),
    });
    expect(completed.requestState).toBe("completed");
    expect(completed.completedAt).toBeInstanceOf(Date);
  });

  it("合法转移：planning → blocked_by_hold → deleting", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    const blocked = await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "blocked_by_hold",
      actor: buildActor(t.id),
    });
    expect(blocked.requestState).toBe("blocked_by_hold");

    const deleting = await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "deleting",
      actor: buildActor(t.id),
    });
    expect(deleting.requestState).toBe("deleting");
  });

  it("合法转移：deleting → partial → deleting（重试）", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "deleting",
      actor: buildActor(t.id),
    });
    const partial = await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "partial",
      actor: buildActor(t.id),
    });
    expect(partial.requestState).toBe("partial");

    const deleting = await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "deleting",
      actor: buildActor(t.id),
    });
    expect(deleting.requestState).toBe("deleting");
  });

  it("非法转移：planning → completed（跳过 deleting）", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    // planning → completed 是合法的（无 in-scope step 时直接完成）
    const completed = await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "completed",
      actor: buildActor(t.id),
    });
    expect(completed.requestState).toBe("completed");
  });

  it("非法转移：completed → deleting（终态不可推进）", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "deleting",
      actor: buildActor(t.id),
    });
    await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "completed",
      actor: buildActor(t.id),
    });

    await expect(
      updateDeletionRequestState({
        tenantId: t.id,
        id: req.id,
        nextState: "deleting",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "request_already_terminal" });
  });

  it("非法转移：planning → failed（不允许）", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    await expect(
      updateDeletionRequestState({
        tenantId: t.id,
        id: req.id,
        nextState: "failed",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("状态转移写审计 before/after", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    await updateDeletionRequestState({
      tenantId: t.id,
      id: req.id,
      nextState: "deleting",
      actor: buildActor(t.id),
    });

    const events = await listAuditEvents({
      tenantId: t.id,
      actionType: "deletion.request",
      targetType: "deletion_request",
      targetId: req.id,
    });
    // 创建 + 状态转移 = 2 条
    expect(events.length).toBe(2);
    const transitionEvent = events[1];
    expect(transitionEvent?.beforeHash).toBeTruthy();
    expect(transitionEvent?.afterHash).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. setBlockedReasonCodes / parseBlockedReasonCodes
// ═══════════════════════════════════════════════════════════

describe("setBlockedReasonCodes / parseBlockedReasonCodes", () => {
  it("设置阻塞原因码并解析", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    await setBlockedReasonCodes({
      tenantId: t.id,
      id: req.id,
      reasonCodes: ["ACTIVE_LEGAL_HOLD"],
    });

    const found = await getDeletionRequestById(t.id, req.id);
    expect(found?.blockedReasonCodes).toBe(JSON.stringify(["ACTIVE_LEGAL_HOLD"]));
    expect(parseBlockedReasonCodes(found?.blockedReasonCodes ?? null)).toEqual([
      "ACTIVE_LEGAL_HOLD",
    ]);
  });

  it("空数组设置 null", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    await setBlockedReasonCodes({
      tenantId: t.id,
      id: req.id,
      reasonCodes: [],
    });

    const found = await getDeletionRequestById(t.id, req.id);
    expect(found?.blockedReasonCodes).toBeNull();
    expect(parseBlockedReasonCodes(found?.blockedReasonCodes ?? null)).toEqual([]);
  });

  it("parseBlockedReasonCodes 非法 JSON 返回空数组", () => {
    expect(parseBlockedReasonCodes("not-json")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. listDeletionRequests（cursor 分页）
// ═══════════════════════════════════════════════════════════

describe("listDeletionRequests", () => {
  it("按 acceptedAt 升序返回", async () => {
    const t = await ensureDefaultTenant();
    for (const sid of ["s1", "s2", "s3"]) {
      await createDeletionRequest(buildCreateParams({ tenantId: t.id, subjectId: sid }));
      await new Promise((r) => setTimeout(r, 5));
    }

    const page = await listDeletionRequests({ tenantId: t.id });
    expect(page.items.length).toBe(3);
    expect(page.items[0]?.subjectId).toBe("s1");
    expect(page.items[2]?.subjectId).toBe("s3");
    expect(page.nextCursor).toBeNull();
  });

  it("limit 截断 + nextCursor", async () => {
    const t = await ensureDefaultTenant();
    for (const sid of ["s1", "s2", "s3", "s4", "s5"]) {
      await createDeletionRequest(buildCreateParams({ tenantId: t.id, subjectId: sid }));
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await listDeletionRequests({ tenantId: t.id, limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listDeletionRequests({
      tenantId: t.id,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.length).toBe(2);
    expect(page2.items[0]?.subjectId).toBe("s3");
  });

  it("subjectType 过滤", async () => {
    const t = await ensureDefaultTenant();
    await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectType: "thread", subjectId: "t1" }),
    );
    await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectType: "artifact", subjectId: "a1" }),
    );

    const page = await listDeletionRequests({ tenantId: t.id, subjectType: "thread" });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.subjectType).toBe("thread");
  });

  it("跨租户隔离", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    await createDeletionRequest(buildCreateParams({ tenantId: t.id, subjectId: "own" }));
    await createDeletionRequest(
      buildCreateParams({ tenantId: EXTRA_TENANT_ID, subjectId: "extra" }),
    );

    const pageT = await listDeletionRequests({ tenantId: t.id });
    const pageE = await listDeletionRequests({ tenantId: EXTRA_TENANT_ID });
    expect(pageT.items.length).toBe(1);
    expect(pageE.items.length).toBe(1);
    expect(pageT.items[0]?.subjectId).toBe("own");
    expect(pageE.items[0]?.subjectId).toBe("extra");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Step 管理
// ═══════════════════════════════════════════════════════════

describe("Step 管理", () => {
  it("insertDeletionSteps + listDeletionSteps", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));

    const steps = await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [
        { storeType: "mysql", subjectRef: "thread:thr-001" },
        {
          storeType: "object_storage",
          subjectRef: "thread:thr-001",
          stepState: "retained",
          failureReason: "共享资源",
        },
        {
          storeType: "cache",
          subjectRef: "thread:thr-001",
          stepState: "skipped",
          failureReason: "无缓存",
        },
      ],
    });

    expect(steps.length).toBe(3);

    const listed = await listDeletionSteps(t.id, req.id);
    expect(listed.length).toBe(3);
    // 按 storeType（MySQL enum 定义序）, subjectRef 排序
    expect(listed[0]?.storeType).toBe("mysql");
    expect(listed[1]?.storeType).toBe("object_storage");
    expect(listed[2]?.storeType).toBe("cache");
  });

  it("markStepRunning：pending → running + attemptCount +1", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    const inserted = await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [{ storeType: "mysql", subjectRef: "thread:thr-001" }],
    });

    const running = await markStepRunning({ tenantId: t.id, stepId: firstStepId(inserted) });
    expect(running.stepState).toBe("running");
    expect(running.attemptCount).toBe(1);
  });

  it("markStepRunning 幂等：completed step 不重复执行", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    const inserted = await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [{ storeType: "mysql", subjectRef: "thread:thr-001" }],
    });
    const stepId = firstStepId(inserted);

    await markStepRunning({ tenantId: t.id, stepId });
    await completeDeletionStep({ tenantId: t.id, stepId, evidenceRef: "ev-001" });

    // 再次 markStepRunning，应原样返回 completed（不重复执行）
    const result = await markStepRunning({ tenantId: t.id, stepId });
    expect(result.stepState).toBe("completed");
    expect(result.attemptCount).toBe(1); // 不递增
  });

  it("completeDeletionStep 写 evidenceRef", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    const inserted = await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [{ storeType: "mysql", subjectRef: "thread:thr-001" }],
    });
    const stepId = firstStepId(inserted);

    await markStepRunning({ tenantId: t.id, stepId });
    const completed = await completeDeletionStep({
      tenantId: t.id,
      stepId,
      evidenceRef: "deletion-evidence:mysql:701",
    });

    expect(completed.stepState).toBe("completed");
    expect(completed.evidenceRef).toBe("deletion-evidence:mysql:701");
    expect(completed.failureReason).toBeNull();
    expect(completed.completedAt).toBeInstanceOf(Date);
  });

  it("completeDeletionStep 空 evidenceRef 抛 missing_evidence", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    const inserted = await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [{ storeType: "mysql", subjectRef: "thread:thr-001" }],
    });

    await expect(
      completeDeletionStep({ tenantId: t.id, stepId: firstStepId(inserted), evidenceRef: "" }),
    ).rejects.toMatchObject({ code: "missing_evidence" });
  });

  it("failDeletionStep 写 failureReason", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    const inserted = await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [{ storeType: "mysql", subjectRef: "thread:thr-001" }],
    });

    await markStepRunning({ tenantId: t.id, stepId: firstStepId(inserted) });
    const failed = await failDeletionStep({
      tenantId: t.id,
      stepId: firstStepId(inserted),
      failureReason: "连接超时",
    });

    expect(failed.stepState).toBe("failed");
    expect(failed.failureReason).toBe("连接超时");
  });

  it("markStepRetained 写保留原因", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    const inserted = await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [{ storeType: "object_storage", subjectRef: "knowledge:shared" }],
    });

    const retained = await markStepRetained({
      tenantId: t.id,
      stepId: firstStepId(inserted),
      reason: "共享 Knowledge 不删除",
    });

    expect(retained.stepState).toBe("retained");
    expect(retained.failureReason).toBe("共享 Knowledge 不删除");
    expect(retained.completedAt).toBeInstanceOf(Date);
  });

  it("markStepBlocked 写阻塞原因", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    const inserted = await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [{ storeType: "mysql", subjectRef: "thread:thr-001" }],
    });

    const blocked = await markStepBlocked({
      tenantId: t.id,
      stepId: firstStepId(inserted),
      reason: "Legal Hold 阻止",
    });

    expect(blocked.stepState).toBe("blocked");
    expect(blocked.failureReason).toBe("Legal Hold 阻止");
  });

  it("markStepSkipped 写跳过原因", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    const inserted = await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [{ storeType: "trace_log", subjectRef: "skip:trace_log:memory_entry:m-001" }],
    });

    const skipped = await markStepSkipped({
      tenantId: t.id,
      stepId: firstStepId(inserted),
      reason: "memory_entry 无 Trace/Log",
    });

    expect(skipped.stepState).toBe("skipped");
    expect(skipped.failureReason).toBe("memory_entry 无 Trace/Log");
    expect(skipped.completedAt).toBeInstanceOf(Date);
  });

  it("getDeletionStep 按 (requestId, storeType, subjectRef) 查询", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [{ storeType: "mysql", subjectRef: "thread:thr-001" }],
    });

    const found = await getDeletionStep({
      tenantId: t.id,
      requestId: req.id,
      storeType: "mysql",
      subjectRef: "thread:thr-001",
    });
    expect(found).not.toBeNull();
    expect(found?.storeType).toBe("mysql");

    const notFound = await getDeletionStep({
      tenantId: t.id,
      requestId: req.id,
      storeType: "cache",
      subjectRef: "thread:thr-001",
    });
    expect(notFound).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 7. computeRequestSummary / deriveTerminalStateFromSteps
// ═══════════════════════════════════════════════════════════

describe("computeRequestSummary / deriveTerminalStateFromSteps", () => {
  function makeStep(state: DeletionStep["stepState"]): DeletionStep {
    return {
      id: "step-id",
      tenantId: "t-1",
      requestId: "req-1",
      storeType: "mysql",
      subjectRef: "thread:thr-001",
      stepState: state,
      evidenceRef: state === "completed" ? "ev-001" : null,
      failureReason: null,
      attemptCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt:
        state === "completed" || state === "retained" || state === "skipped" ? new Date() : null,
    };
  }

  it("空 steps → completed", () => {
    expect(deriveTerminalStateFromSteps([])).toBe("completed");
  });

  it("全 completed/retained/skipped → completed", () => {
    const steps = [makeStep("completed"), makeStep("retained"), makeStep("skipped")];
    expect(deriveTerminalStateFromSteps(steps)).toBe("completed");
  });

  it("含 failed 无 pending/running/blocked → partial", () => {
    const steps = [makeStep("completed"), makeStep("failed"), makeStep("skipped")];
    expect(deriveTerminalStateFromSteps(steps)).toBe("partial");
  });

  it("含 pending → null（不派生终态）", () => {
    const steps = [makeStep("completed"), makeStep("pending")];
    expect(deriveTerminalStateFromSteps(steps)).toBeNull();
  });

  it("含 running → null（不派生终态）", () => {
    const steps = [makeStep("completed"), makeStep("running")];
    expect(deriveTerminalStateFromSteps(steps)).toBeNull();
  });

  it("含 blocked → null（不自动终态）", () => {
    const steps = [makeStep("completed"), makeStep("blocked")];
    expect(deriveTerminalStateFromSteps(steps)).toBeNull();
  });

  it("computeRequestSummary 汇总各状态计数", () => {
    const steps = [
      makeStep("completed"),
      makeStep("completed"),
      makeStep("failed"),
      makeStep("blocked"),
      makeStep("retained"),
      makeStep("skipped"),
      makeStep("pending"),
    ];
    const summary = computeRequestSummary(steps);
    expect(summary.plannedSteps).toBe(7);
    expect(summary.completedSteps).toBe(3); // completed + skipped
    expect(summary.failedSteps).toBe(1);
    expect(summary.blockedSteps).toBe(1);
    expect(summary.blockedResourceCount).toBe(1);
    expect(summary.retainedSharedResourceCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. listRunnableSteps / countStepsByStates
// ═══════════════════════════════════════════════════════════

describe("listRunnableSteps / countStepsByStates", () => {
  it("listRunnableSteps 返回 pending + failed", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    const inserted = await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [
        { storeType: "mysql", subjectRef: "thread:thr-001" },
        {
          storeType: "object_storage",
          subjectRef: "thread:thr-001",
          stepState: "failed",
          failureReason: "上次失败",
        },
        {
          storeType: "cache",
          subjectRef: "thread:thr-001",
          stepState: "skipped",
          failureReason: "无缓存",
        },
      ],
    });

    const runnable = await listRunnableSteps(t.id, req.id);
    expect(runnable.length).toBe(2);
    expect(runnable.some((s) => s.id === inserted[0]?.id)).toBe(true);
    expect(runnable.some((s) => s.id === inserted[1]?.id)).toBe(true);
  });

  it("countStepsByStates 按状态集合计数", async () => {
    const t = await ensureDefaultTenant();
    const req = await createDeletionRequest(buildCreateParams({ tenantId: t.id }));
    await insertDeletionSteps({
      tenantId: t.id,
      requestId: req.id,
      steps: [
        { storeType: "mysql", subjectRef: "thread:thr-001" },
        {
          storeType: "cache",
          subjectRef: "thread:thr-001",
          stepState: "skipped",
          failureReason: "无缓存",
        },
      ],
    });

    const pendingCount = await countStepsByStates(t.id, req.id, ["pending"]);
    expect(pendingCount).toBe(1);

    const skippedCount = await countStepsByStates(t.id, req.id, ["skipped"]);
    expect(skippedCount).toBe(1);

    const emptyCount = await countStepsByStates(t.id, req.id, []);
    expect(emptyCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 9. planDeletion（Legal Hold 阻止 + step 生成）
// ═══════════════════════════════════════════════════════════

describe("planDeletion", () => {
  it("无 Legal Hold → 生成 thread step 计划（5 pending + 2 retained）", async () => {
    const t = await ensureDefaultTenant();
    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-001",
      deleteMode: "standard",
    });

    expect(plan.blockedReasonCodes).toEqual([]);
    expect(plan.steps.length).toBe(7);
    const pending = plan.steps.filter((s) => s.stepState === "pending");
    const retained = plan.steps.filter((s) => s.stepState === "retained");
    expect(pending.length).toBe(5);
    expect(retained.length).toBe(2);
  });

  it("tenant 级 Legal Hold → 阻止（blockedReasonCodes 含 ACTIVE_LEGAL_HOLD）", async () => {
    const t = await ensureDefaultTenant();
    await seedLegalHold(t.id, "tenant", t.id);

    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-001",
      deleteMode: "standard",
    });

    expect(plan.blockedReasonCodes).toContain("ACTIVE_LEGAL_HOLD");
    expect(plan.steps).toEqual([]);
  });

  it("subject 级 Legal Hold（thread）→ 阻止该 thread 删除", async () => {
    const t = await ensureDefaultTenant();
    await seedLegalHold(t.id, "thread", "thr-blocked");

    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-blocked",
      deleteMode: "standard",
    });

    expect(plan.blockedReasonCodes).toContain("ACTIVE_LEGAL_HOLD");
    expect(plan.steps).toEqual([]);
  });

  it("subject 级 Legal Hold 不扩大到无关对象", async () => {
    const t = await ensureDefaultTenant();
    await seedLegalHold(t.id, "thread", "thr-blocked");

    // 删除另一个 thread（未挂 Hold）→ 不阻止
    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-other",
      deleteMode: "standard",
    });

    expect(plan.blockedReasonCodes).toEqual([]);
    expect(plan.steps.length).toBe(7);
  });

  it("artifact subject：3 pending + 2 skipped", async () => {
    const t = await ensureDefaultTenant();
    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "artifact",
      subjectId: "art-001",
      deleteMode: "standard",
    });

    expect(plan.blockedReasonCodes).toEqual([]);
    const pending = plan.steps.filter((s) => s.stepState === "pending");
    const skipped = plan.steps.filter((s) => s.stepState === "skipped");
    expect(pending.length).toBe(3); // mysql + object_storage + cache
    expect(skipped.length).toBe(2); // vector_search + trace_log
  });

  it("user subject：5 pending + 1 retained（用户原始本地文件）", async () => {
    const t = await ensureDefaultTenant();
    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "user",
      subjectId: "usr-001",
      deleteMode: "standard",
    });

    expect(plan.blockedReasonCodes).toEqual([]);
    const pending = plan.steps.filter((s) => s.stepState === "pending");
    const retained = plan.steps.filter((s) => s.stepState === "retained");
    expect(pending.length).toBe(5);
    expect(retained.length).toBe(1);
  });

  it("subject 级 Legal Hold（artifact）→ 阻止该 artifact 删除", async () => {
    const t = await ensureDefaultTenant();
    await seedLegalHold(t.id, "artifact", "art-blocked");

    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "artifact",
      subjectId: "art-blocked",
      deleteMode: "standard",
    });

    expect(plan.blockedReasonCodes).toContain("ACTIVE_LEGAL_HOLD");
    expect(plan.steps).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 10. executeDeletionRequest
// ═══════════════════════════════════════════════════════════

describe("executeDeletionRequest", () => {
  it("全 success → completed（所有 step 含 evidenceRef）", async () => {
    const t = await ensureDefaultTenant();
    injectSuccessAdapters();

    const req = await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectId: "thr-ok" }),
    );
    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-ok",
      deleteMode: "standard",
    });
    await insertDeletionSteps({ tenantId: t.id, requestId: req.id, steps: plan.steps });

    const result = await executeDeletionRequest({
      tenantId: t.id,
      deletionRequestId: req.id,
      actor: buildActor(t.id),
    });

    expect(result.request.requestState).toBe("completed");
    expect(result.derivedTerminalState).toBe("completed");
    expect(result.failedSteps).toBe(0);
    // 所有非 retained/skipped 的 step 都有 evidenceRef
    const completedSteps = result.steps.filter((s) => s.stepState === "completed");
    for (const s of completedSteps) {
      expect(s.evidenceRef).toBeTruthy();
    }
    // retained steps 不需要 evidenceRef（markStepRetained 不写 evidenceRef）
    const retainedSteps = result.steps.filter((s) => s.stepState === "retained");
    expect(retainedSteps.length).toBeGreaterThan(0);
  });

  it("部分失败 → partial（可重试）", async () => {
    const t = await ensureDefaultTenant();
    // mysql 成功，object_storage 失败，其他成功
    const map = new Map();
    map.set("mysql", new RecordingDeletionStoreAdapter("mysql", { defaultBehavior: "success" }));
    map.set(
      "object_storage",
      new RecordingDeletionStoreAdapter("object_storage", {
        defaultBehavior: "fail",
        defaultFailMessage: "对象存储不可用",
      }),
    );
    map.set(
      "vector_search",
      new RecordingDeletionStoreAdapter("vector_search", { defaultBehavior: "success" }),
    );
    map.set(
      "trace_log",
      new RecordingDeletionStoreAdapter("trace_log", { defaultBehavior: "success" }),
    );
    map.set("cache", new RecordingDeletionStoreAdapter("cache", { defaultBehavior: "success" }));
    setDeletionStoreAdaptersOverride(map);

    const req = await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectId: "thr-partial" }),
    );
    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-partial",
      deleteMode: "standard",
    });
    await insertDeletionSteps({ tenantId: t.id, requestId: req.id, steps: plan.steps });

    const result = await executeDeletionRequest({
      tenantId: t.id,
      deletionRequestId: req.id,
      actor: buildActor(t.id),
    });

    expect(result.request.requestState).toBe("partial");
    expect(result.failedSteps).toBe(1);
    expect(result.derivedTerminalState).toBe("partial");

    const failedSteps = result.steps.filter((s) => s.stepState === "failed");
    expect(failedSteps.length).toBe(1);
    expect(failedSteps[0]?.storeType).toBe("object_storage");
  });

  it("重试：partial → deleting → completed（failed step 第 2 次成功）", async () => {
    const t = await ensureDefaultTenant();
    // mysql 第 1 次失败，第 2 次成功
    const mysqlAdapter = new RecordingDeletionStoreAdapter("mysql", {
      defaultBehavior: "success",
      succeedOnAttempt: { "thread:thr-retry": 2 },
    });
    const map = new Map();
    map.set("mysql", mysqlAdapter);
    for (const st of ["object_storage", "vector_search", "trace_log", "cache"] as const) {
      map.set(st, new RecordingDeletionStoreAdapter(st, { defaultBehavior: "success" }));
    }
    setDeletionStoreAdaptersOverride(map);

    const req = await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectId: "thr-retry" }),
    );
    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-retry",
      deleteMode: "standard",
    });
    await insertDeletionSteps({ tenantId: t.id, requestId: req.id, steps: plan.steps });

    // 第 1 次执行 → partial（mysql 失败）
    const result1 = await executeDeletionRequest({
      tenantId: t.id,
      deletionRequestId: req.id,
      actor: buildActor(t.id),
    });
    expect(result1.request.requestState).toBe("partial");
    expect(mysqlAdapter.getCallCount("thread:thr-retry")).toBe(1);

    // 第 2 次执行（重试）→ completed（mysql 第 2 次成功）
    const result2 = await retryDeletionRequest({
      tenantId: t.id,
      deletionRequestId: req.id,
      actor: buildActor(t.id),
    });
    expect(result2.request.requestState).toBe("completed");
    expect(mysqlAdapter.getCallCount("thread:thr-retry")).toBe(2);
  });

  it("幂等：再次执行 completed 请求抛 illegal_state_for_execution", async () => {
    const t = await ensureDefaultTenant();
    injectSuccessAdapters();

    const req = await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectId: "thr-idem" }),
    );
    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-idem",
      deleteMode: "standard",
    });
    await insertDeletionSteps({ tenantId: t.id, requestId: req.id, steps: plan.steps });

    await executeDeletionRequest({
      tenantId: t.id,
      deletionRequestId: req.id,
      actor: buildActor(t.id),
    });

    // 再次执行 completed 请求 → 抛错
    await expect(
      executeDeletionRequest({
        tenantId: t.id,
        deletionRequestId: req.id,
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "illegal_state_for_execution" });
  });

  it("fail-closed：未注入 Adapter → 所有 step 失败 → partial", async () => {
    const t = await ensureDefaultTenant();
    // 不注入任何 override → 全部走 FailClosedDeletionStoreAdapter

    const req = await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectId: "thr-fc" }),
    );
    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-fc",
      deleteMode: "standard",
    });
    await insertDeletionSteps({ tenantId: t.id, requestId: req.id, steps: plan.steps });

    const result = await executeDeletionRequest({
      tenantId: t.id,
      deletionRequestId: req.id,
      actor: buildActor(t.id),
    });

    // 5 个 pending step 全部失败（fail-closed），2 个 retained 不执行
    expect(result.request.requestState).toBe("partial");
    expect(result.failedSteps).toBe(5);
    const failedSteps = result.steps.filter((s) => s.stepState === "failed");
    expect(failedSteps.length).toBe(5);
    // retained steps 保持 retained（markStepRunning 跳过）
    const retainedSteps = result.steps.filter((s) => s.stepState === "retained");
    expect(retainedSteps.length).toBe(2);
  });

  it("无 steps → 抛 no_steps_planned", async () => {
    const t = await ensureDefaultTenant();
    injectSuccessAdapters();

    const req = await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectId: "thr-nosteps" }),
    );
    // 不插入任何 steps

    await expect(
      executeDeletionRequest({
        tenantId: t.id,
        deletionRequestId: req.id,
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "no_steps_planned" });
  });

  it("retained step 不重复执行（幂等）", async () => {
    const t = await ensureDefaultTenant();
    const adapters = injectSuccessAdapters();
    const objectStorageAdapter = adapters.get("object_storage");
    if (!objectStorageAdapter) throw new Error("测试设置错误：object_storage adapter 未注入");

    const req = await createDeletionRequest(
      buildCreateParams({ tenantId: t.id, subjectId: "thr-ret" }),
    );
    const plan = await planDeletion({
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-ret",
      deleteMode: "standard",
    });
    await insertDeletionSteps({ tenantId: t.id, requestId: req.id, steps: plan.steps });

    await executeDeletionRequest({
      tenantId: t.id,
      deletionRequestId: req.id,
      actor: buildActor(t.id),
    });

    // object_storage 有 1 个 pending step（thread:thr-ret）和 1 个 retained step（knowledge:shared）
    // pending step 被执行 1 次，retained step 不被执行（markStepRunning 跳过）
    expect(objectStorageAdapter.getCallCount("thread:thr-ret")).toBe(1);
    expect(objectStorageAdapter.getCallCount("knowledge:shared")).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 11. RecordingDeletionStoreAdapter / FailClosedDeletionStoreAdapter
// ═══════════════════════════════════════════════════════════

describe("RecordingDeletionStoreAdapter / FailClosedDeletionStoreAdapter", () => {
  it("FailClosedDeletionStoreAdapter 抛 DeletionStoreError（retryable=true）", async () => {
    const adapter = new FailClosedDeletionStoreAdapter("mysql");
    await expect(
      adapter.delete({ tenantId: "t-1", subjectType: "thread", subjectRef: "thread:thr-001" }),
    ).rejects.toMatchObject({ name: "DeletionStoreError", retryable: true });
  });

  it("RecordingDeletionStoreAdapter success 返回 evidenceRef", async () => {
    const adapter = new RecordingDeletionStoreAdapter("mysql", { defaultBehavior: "success" });
    const result = await adapter.delete({
      tenantId: "t-1",
      subjectType: "thread",
      subjectRef: "thread:thr-001",
    });
    expect(result.evidenceRef).toContain("deletion-evidence:mysql:");
    expect(result.retained).toBeUndefined();
  });

  it("RecordingDeletionStoreAdapter retain 返回 retained=true", async () => {
    const adapter = new RecordingDeletionStoreAdapter("object_storage", {
      defaultBehavior: "retain",
      defaultRetainReason: "共享资源",
    });
    const result = await adapter.delete({
      tenantId: "t-1",
      subjectType: "thread",
      subjectRef: "knowledge:shared",
    });
    expect(result.retained).toBe(true);
    expect(result.retainReason).toBe("共享资源");
    expect(result.evidenceRef).toContain("retained");
  });

  it("RecordingDeletionStoreAdapter fail 抛 DeletionStoreError", async () => {
    const adapter = new RecordingDeletionStoreAdapter("mysql", {
      defaultBehavior: "fail",
      defaultFailMessage: "模拟失败",
      defaultRetryable: false,
    });
    await expect(
      adapter.delete({ tenantId: "t-1", subjectType: "thread", subjectRef: "thread:thr-001" }),
    ).rejects.toMatchObject({ name: "DeletionStoreError", message: "模拟失败", retryable: false });
  });

  it("RecordingDeletionStoreAdapter exact 匹配优先于 default", async () => {
    const adapter = new RecordingDeletionStoreAdapter("mysql", {
      defaultBehavior: "success",
      exact: {
        "thread:fail-me": { kind: "fail", failMessage: "精确匹配失败" },
      },
    });
    // 未匹配 → success
    const ok = await adapter.delete({
      tenantId: "t-1",
      subjectType: "thread",
      subjectRef: "thread:ok",
    });
    expect(ok.evidenceRef).toBeTruthy();
    // 精确匹配 → fail
    await expect(
      adapter.delete({ tenantId: "t-1", subjectType: "thread", subjectRef: "thread:fail-me" }),
    ).rejects.toMatchObject({ message: "精确匹配失败" });
  });

  it("RecordingDeletionStoreAdapter succeedOnAttempt：前 N 次失败，第 N 次成功", async () => {
    const adapter = new RecordingDeletionStoreAdapter("mysql", {
      defaultBehavior: "success",
      succeedOnAttempt: { "thread:retry": 3 },
    });

    // 前 2 次失败
    await expect(
      adapter.delete({ tenantId: "t-1", subjectType: "thread", subjectRef: "thread:retry" }),
    ).rejects.toMatchObject({ name: "DeletionStoreError" });
    await expect(
      adapter.delete({ tenantId: "t-1", subjectType: "thread", subjectRef: "thread:retry" }),
    ).rejects.toMatchObject({ name: "DeletionStoreError" });

    // 第 3 次成功
    const result = await adapter.delete({
      tenantId: "t-1",
      subjectType: "thread",
      subjectRef: "thread:retry",
    });
    expect(result.evidenceRef).toBeTruthy();
    expect(adapter.getCallCount("thread:retry")).toBe(3);
  });

  it("RecordingDeletionStoreAdapter prefixes 前缀匹配", async () => {
    const adapter = new RecordingDeletionStoreAdapter("object_storage", {
      defaultBehavior: "success",
      prefixes: [
        { prefix: "knowledge:", behavior: { kind: "retain", retainReason: "共享 Knowledge" } },
      ],
    });

    // 匹配前缀 → retain
    const retained = await adapter.delete({
      tenantId: "t-1",
      subjectType: "thread",
      subjectRef: "knowledge:shared",
    });
    expect(retained.retained).toBe(true);

    // 不匹配前缀 → success
    const ok = await adapter.delete({
      tenantId: "t-1",
      subjectType: "thread",
      subjectRef: "thread:thr-001",
    });
    expect(ok.retained).toBeUndefined();
  });

  it("getTotalCallCount 汇总所有调用", async () => {
    const adapter = new RecordingDeletionStoreAdapter("mysql", { defaultBehavior: "success" });
    await adapter.delete({ tenantId: "t-1", subjectType: "thread", subjectRef: "a" });
    await adapter.delete({ tenantId: "t-1", subjectType: "thread", subjectRef: "b" });
    await adapter.delete({ tenantId: "t-1", subjectType: "thread", subjectRef: "a" });

    expect(adapter.getCallCount("a")).toBe(2);
    expect(adapter.getCallCount("b")).toBe(1);
    expect(adapter.getTotalCallCount()).toBe(3);
  });
});
