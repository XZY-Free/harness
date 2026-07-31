/**
 * S02-C04：V11 命令幂等账本集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - computeRequestHash：纯逻辑（字段顺序无关、method/path 影响、不同 body 不同 hash）。
 * - callerFromPrincipal / callerFromWorkloadPrincipal：纯逻辑（身份映射）。
 * - idempotency-queries：DB（find/insert/complete/fail/reset/getById/deleteExpired）。
 * - enforceIdempotency：DB（new/replay/in_flight/retry_allowed/conflict + 并发唯一约束）。
 * - buildReplayResponse / buildIdempotencyErrorResponse：纯逻辑（响应构造）。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  type IdempotencyOutcome,
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  callerFromWorkloadPrincipal,
  completeRecord,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/v11/identity/idempotency";
import {
  type IdempotencyRecord,
  completeIdempotencyRecord,
  deleteExpiredRecords,
  failIdempotencyRecord,
  findIdempotencyRecord,
  getIdempotencyRecordById,
  insertProcessingRecord,
  resetFailedForRetry,
} from "@/lib/v11/identity/idempotency-queries";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import type { V11Principal, V11WorkloadPrincipal } from "@/lib/v11/identity/resolver";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 租户 + 用户 + principal ─────────────────────

async function seedCaller(tenantId: string, externalSubject: string, email: string) {
  const identity = await upsertUserIdentity({
    tenantId,
    externalSubject,
    email,
    displayName: `Test ${externalSubject}`,
  });
  await upsertPrincipalBinding({
    tenantId,
    subjectType: "user",
    externalId: externalSubject,
    displayName: `Test ${externalSubject}`,
    userIdentityId: identity.id,
  });
  return identity;
}

function buildPrincipal(tenantId: string, userIdentityId: string): V11Principal {
  return {
    tenantId,
    tenantKey: "default",
    userIdentityId,
    externalSubject: "user-001",
    email: "user001@example.com",
    displayName: "Test user-001",
    audience: "employee",
  };
}

function buildServicePrincipal(tenantId: string, serviceId: string): V11WorkloadPrincipal {
  return {
    tenantId,
    audience: "admin",
    callerType: "service",
    claims: {
      type: "service",
      tenantId,
      jti: "jti-service-idempotency-001",
      audience: "admin",
      serviceId,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    },
    serviceId,
    invocationId: null,
    runtimeRevisionId: null,
  };
}

function buildWorkloadPrincipal(tenantId: string, invocationId: string): V11WorkloadPrincipal {
  return {
    tenantId,
    audience: "runtime",
    callerType: "workload",
    claims: {
      type: "runtime",
      tenantId,
      jti: "jti-runtime-idempotency-001",
      audience: "runtime",
      invocationId,
      runtimeRevisionId: "rr_test",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    },
    serviceId: null,
    invocationId,
    runtimeRevisionId: "rr_test",
  };
}

// ─── computeRequestHash（纯逻辑）──────────────────────────

describe("V11 computeRequestHash", () => {
  it("相同 method/path/body → 相同 hash", () => {
    const a = computeRequestHash("POST", "/api/v1/threads", { title: "t1" });
    const b = computeRequestHash("POST", "/api/v1/threads", { title: "t1" });
    expect(a).toBe(b);
  });

  it("body 字段顺序无关 → 相同 hash", () => {
    const a = computeRequestHash("POST", "/api/v1/x", { a: 1, b: 2 });
    const b = computeRequestHash("POST", "/api/v1/x", { b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("嵌套 object 字段顺序无关 → 相同 hash", () => {
    const a = computeRequestHash("POST", "/api/v1/x", { outer: { z: 1, a: 2 } });
    const b = computeRequestHash("POST", "/api/v1/x", { outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it("method 不同 → 不同 hash", () => {
    const a = computeRequestHash("POST", "/api/v1/x", { a: 1 });
    const b = computeRequestHash("PUT", "/api/v1/x", { a: 1 });
    expect(a).not.toBe(b);
  });

  it("path 不同 → 不同 hash", () => {
    const a = computeRequestHash("POST", "/api/v1/x", { a: 1 });
    const b = computeRequestHash("POST", "/api/v1/y", { a: 1 });
    expect(a).not.toBe(b);
  });

  it("body 不同 → 不同 hash", () => {
    const a = computeRequestHash("POST", "/api/v1/x", { a: 1 });
    const b = computeRequestHash("POST", "/api/v1/x", { a: 2 });
    expect(a).not.toBe(b);
  });

  it("method 大小写归一化", () => {
    const a = computeRequestHash("post", "/api/v1/x", { a: 1 });
    const b = computeRequestHash("POST", "/api/v1/x", { a: 1 });
    expect(a).toBe(b);
  });

  it("hash 是 64 字符 hex（sha256）", () => {
    const hash = computeRequestHash("POST", "/api/v1/x", { a: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("null/undefined body 可计算", () => {
    expect(() => computeRequestHash("POST", "/api/v1/x", null)).not.toThrow();
    expect(() => computeRequestHash("POST", "/api/v1/x", undefined)).not.toThrow();
  });

  it("数组顺序敏感", () => {
    const a = computeRequestHash("POST", "/api/v1/x", [1, 2, 3]);
    const b = computeRequestHash("POST", "/api/v1/x", [3, 2, 1]);
    expect(a).not.toBe(b);
  });
});

// ─── callerFromPrincipal / callerFromWorkloadPrincipal（纯逻辑）───

describe("V11 callerFromPrincipal", () => {
  it("V11Principal → callerType=user, callerId=userIdentityId", () => {
    const principal = buildPrincipal("tnt_1", "uid_1");
    const caller = callerFromPrincipal(principal);
    expect(caller.tenantId).toBe("tnt_1");
    expect(caller.audience).toBe("employee");
    expect(caller.callerType).toBe("user");
    expect(caller.callerId).toBe("uid_1");
  });
});

describe("V11 callerFromWorkloadPrincipal", () => {
  it("service → callerType=service, callerId=serviceId", () => {
    const principal = buildServicePrincipal("tnt_1", "cicd");
    const caller = callerFromWorkloadPrincipal(principal);
    expect(caller.callerType).toBe("service");
    expect(caller.callerId).toBe("cicd");
  });

  it("service 缺失 serviceId 抛错", () => {
    const principal = buildServicePrincipal("tnt_1", "cicd");
    principal.serviceId = null;
    expect(() => callerFromWorkloadPrincipal(principal)).toThrow(/缺失 serviceId/);
  });

  it("workload → callerType=workload, callerId=invocationId", () => {
    const principal = buildWorkloadPrincipal("tnt_1", "inv_1");
    const caller = callerFromWorkloadPrincipal(principal);
    expect(caller.callerType).toBe("workload");
    expect(caller.callerId).toBe("inv_1");
  });

  it("workload 缺失 invocationId 抛错", () => {
    const principal = buildWorkloadPrincipal("tnt_1", "inv_1");
    principal.invocationId = null;
    expect(() => callerFromWorkloadPrincipal(principal)).toThrow(/缺失 invocationId/);
  });
});

// ─── idempotency-queries（DB）─────────────────────────────

describe("V11 idempotency-queries", () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await ensureDefaultTenant();
    tenantId = tenant.id;
  });

  it("insertProcessingRecord 创建 processing 记录", async () => {
    const record = await insertProcessingRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-1",
      requestHash: "hash-1",
    });
    expect(record.id).toBeDefined();
    expect(record.processingState).toBe("processing");
    expect(record.httpStatus).toBeNull();
    expect(record.completedAt).toBeNull();
    expect(record.expiresAt).toBeDefined();
  });

  it("insertProcessingRecord 并发同 key 抛 ER_DUP_ENTRY", async () => {
    await insertProcessingRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-dup",
      requestHash: "hash-1",
    });
    await expect(
      insertProcessingRecord({
        tenantId,
        audience: "employee",
        callerType: "user",
        callerId: "uid_1",
        commandScope: "thread.create:",
        idempotencyKey: "key-dup",
        requestHash: "hash-2",
      }),
    ).rejects.toThrow();
  });

  it("findIdempotencyRecord 存在时返回记录", async () => {
    await insertProcessingRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-find",
      requestHash: "hash-1",
    });
    const found = await findIdempotencyRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-find",
    });
    expect(found).not.toBeNull();
    expect(found?.requestHash).toBe("hash-1");
  });

  it("findIdempotencyRecord 不存在返回 null", async () => {
    const found = await findIdempotencyRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_missing",
      commandScope: "thread.create:",
      idempotencyKey: "key-missing",
    });
    expect(found).toBeNull();
  });

  it("findIdempotencyRecord 跨租户隔离", async () => {
    await insertProcessingRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-x",
      requestHash: "hash-1",
    });
    const found = await findIdempotencyRecord({
      tenantId: "other-tenant",
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-x",
    });
    expect(found).toBeNull();
  });

  it("completeIdempotencyRecord 回填 completed + httpStatus + responseRef", async () => {
    const record = await insertProcessingRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-complete",
      requestHash: "hash-1",
    });
    const ok = await completeIdempotencyRecord({
      recordId: record.id,
      httpStatus: 201,
      responseRef: "thr_1",
      responseRedactedJson: '{"id":"thr_1"}',
    });
    expect(ok).toBe(true);

    const after = await getIdempotencyRecordById(record.id);
    expect(after?.processingState).toBe("completed");
    expect(after?.httpStatus).toBe(201);
    expect(after?.responseRef).toBe("thr_1");
    expect(after?.responseRedactedJson).toBe('{"id":"thr_1"}');
    expect(after?.completedAt).not.toBeNull();
  });

  it("completeIdempotencyRecord 对 completed 记录返回 false（不可重复完成）", async () => {
    const record = await insertProcessingRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-complete2",
      requestHash: "hash-1",
    });
    await completeIdempotencyRecord({ recordId: record.id, httpStatus: 200 });
    const second = await completeIdempotencyRecord({ recordId: record.id, httpStatus: 500 });
    expect(second).toBe(false);
  });

  it("failIdempotencyRecord 回填 failed + completedAt", async () => {
    const record = await insertProcessingRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-fail",
      requestHash: "hash-1",
    });
    const ok = await failIdempotencyRecord(record.id);
    expect(ok).toBe(true);

    const after = await getIdempotencyRecordById(record.id);
    expect(after?.processingState).toBe("failed");
    expect(after?.completedAt).not.toBeNull();
    expect(after?.httpStatus).toBeNull();
  });

  it("resetFailedForRetry 把 failed → processing + 更新 requestHash", async () => {
    const record = await insertProcessingRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-retry",
      requestHash: "hash-old",
    });
    await failIdempotencyRecord(record.id);

    const ok = await resetFailedForRetry({ recordId: record.id, requestHash: "hash-new" });
    expect(ok).toBe(true);

    const after = await getIdempotencyRecordById(record.id);
    expect(after?.processingState).toBe("processing");
    expect(after?.requestHash).toBe("hash-new");
    expect(after?.completedAt).toBeNull();
    expect(after?.httpStatus).toBeNull();
  });

  it("resetFailedForRetry 对 processing 记录返回 false", async () => {
    const record = await insertProcessingRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-retry2",
      requestHash: "hash-1",
    });
    const ok = await resetFailedForRetry({ recordId: record.id, requestHash: "hash-2" });
    expect(ok).toBe(false);
  });

  it("deleteExpiredRecords 清理过期记录", async () => {
    // 插入一条已过期记录
    await insertProcessingRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-expired",
      requestHash: "hash-1",
      expiresAt: new Date(Date.now() - 1000),
    });
    // 插入一条未过期记录
    await insertProcessingRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-valid",
      requestHash: "hash-1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const deleted = await deleteExpiredRecords();
    expect(deleted).toBe(1);

    const expired = await findIdempotencyRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-expired",
    });
    const valid = await findIdempotencyRecord({
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-valid",
    });
    expect(expired).toBeNull();
    expect(valid).not.toBeNull();
  });
});

// ─── enforceIdempotency（DB）──────────────────────────────

describe("V11 enforceIdempotency", () => {
  let tenantId: string;
  let userIdentityId: string;
  let caller: { tenantId: string; audience: "employee"; callerType: "user"; callerId: string };

  beforeEach(async () => {
    const tenant = await ensureDefaultTenant();
    tenantId = tenant.id;
    const identity = await seedCaller(tenantId, "user-001", "user001@example.com");
    userIdentityId = identity.id;
    caller = {
      tenantId,
      audience: "employee",
      callerType: "user",
      callerId: userIdentityId,
    };
  });

  it("首次请求 → new（processing 记录）", async () => {
    const outcome = await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "key-new",
      requestHash: computeRequestHash("POST", "/api/v1/threads", { title: "t1" }),
    });
    expect(outcome.kind).toBe("new");
    if (outcome.kind === "new") {
      expect(outcome.record.processingState).toBe("processing");
      expect(outcome.record.callerId).toBe(userIdentityId);
    }
  });

  it("同 key 同 body completed → replay（返回原状态码与响应）", async () => {
    const requestHash = computeRequestHash("POST", "/api/v1/threads", { title: "t1" });
    const first = await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "key-replay",
      requestHash,
    });
    expect(first.kind).toBe("new");
    if (first.kind !== "new") return;

    // 模拟业务完成
    await completeRecord({
      recordId: first.record.id,
      httpStatus: 201,
      responseRef: "thr_1",
      responseRedactedJson: JSON.stringify({ id: "thr_1", title: "t1" }),
    });

    // 重放
    const second = await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "key-replay",
      requestHash,
    });
    expect(second.kind).toBe("replay");
    if (second.kind === "replay") {
      expect(second.record.httpStatus).toBe(201);
      expect(second.record.responseRef).toBe("thr_1");
    }
  });

  it("同 key 不同 body → conflict（409 IDEMPOTENCY_CONFLICT）", async () => {
    const hash1 = computeRequestHash("POST", "/api/v1/threads", { title: "t1" });
    const hash2 = computeRequestHash("POST", "/api/v1/threads", { title: "t2" });

    await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "key-conflict",
      requestHash: hash1,
    });

    const second = await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "key-conflict",
      requestHash: hash2,
    });
    expect(second.kind).toBe("conflict");
    if (second.kind === "conflict") {
      expect(second.existingRecord.requestHash).toBe(hash1);
    }
  });

  it("同 key 同 body processing → in_flight（不重放）", async () => {
    const requestHash = computeRequestHash("POST", "/api/v1/threads", { title: "t1" });
    await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "key-inflight",
      requestHash,
    });

    const second = await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "key-inflight",
      requestHash,
    });
    expect(second.kind).toBe("in_flight");
  });

  it("同 key 同 body failed → retry_allowed（重置后重新执行）", async () => {
    const requestHash = computeRequestHash("POST", "/api/v1/threads", { title: "t1" });
    const first = await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "key-retry",
      requestHash,
    });
    expect(first.kind).toBe("new");
    if (first.kind !== "new") return;

    // 业务失败
    await failRecord(first.record.id);

    // 同 key 重试
    const second = await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "key-retry",
      requestHash,
    });
    expect(second.kind).toBe("retry_allowed");
    if (second.kind !== "retry_allowed") return;

    // 重置后重新执行
    const reset = await prepareRetryForFailedRecord({
      record: second.record,
      requestHash,
    });
    expect(reset).not.toBeNull();
    expect(reset?.processingState).toBe("processing");

    // 第三次同 key → in_flight（已重置为 processing）
    const third = await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "key-retry",
      requestHash,
    });
    expect(third.kind).toBe("in_flight");
  });

  it("同 key 不同 command_scope → new（不冲突，scope 隔离）", async () => {
    await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "shared-key",
      requestHash: "hash-1",
    });
    const second = await enforceIdempotency({
      caller,
      commandScope: "turn.create:thr_1",
      idempotencyKey: "shared-key",
      requestHash: "hash-1",
    });
    expect(second.kind).toBe("new");
  });

  it("同 key 不同 callerId → new（不冲突，调用方隔离）", async () => {
    await enforceIdempotency({
      caller,
      commandScope: "thread.create:",
      idempotencyKey: "shared-key",
      requestHash: "hash-1",
    });
    const otherCaller = { ...caller, callerId: "other-user-id" };
    const second = await enforceIdempotency({
      caller: otherCaller,
      commandScope: "thread.create:",
      idempotencyKey: "shared-key",
      requestHash: "hash-1",
    });
    expect(second.kind).toBe("new");
  });

  it("同 key 不同 audience → new（不冲突，audience 隔离）", async () => {
    await enforceIdempotency({
      caller,
      commandScope: "command.x:",
      idempotencyKey: "shared-key",
      requestHash: "hash-1",
    });
    const adminCaller = { ...caller, audience: "admin" as const };
    const second = await enforceIdempotency({
      caller: adminCaller,
      commandScope: "command.x:",
      idempotencyKey: "shared-key",
      requestHash: "hash-1",
    });
    expect(second.kind).toBe("new");
  });

  it("service caller → callerType=service, callerId=serviceId", async () => {
    const servicePrincipal = buildServicePrincipal(tenantId, "cicd");
    const serviceCaller = callerFromWorkloadPrincipal(servicePrincipal);
    const outcome = await enforceIdempotency({
      caller: serviceCaller,
      commandScope: "agent.revision.draft:",
      idempotencyKey: "cicd-key-1",
      requestHash: computeRequestHash("POST", "/admin/api/v1/agents/agt_1/revisions", {}),
    });
    expect(outcome.kind).toBe("new");
    if (outcome.kind === "new") {
      expect(outcome.record.callerType).toBe("service");
      expect(outcome.record.callerId).toBe("cicd");
      expect(outcome.record.audience).toBe("admin");
    }
  });

  it("workload caller → callerType=workload, callerId=invocationId", async () => {
    const workloadPrincipal = buildWorkloadPrincipal(tenantId, "inv_01");
    const workloadCaller = callerFromWorkloadPrincipal(workloadPrincipal);
    const outcome = await enforceIdempotency({
      caller: workloadCaller,
      commandScope: "runtime.command:inv_01",
      idempotencyKey: "rt-key-1",
      requestHash: computeRequestHash("POST", "/runtime/v1/invocations/inv_01/commands", {}),
    });
    expect(outcome.kind).toBe("new");
    if (outcome.kind === "new") {
      expect(outcome.record.callerType).toBe("workload");
      expect(outcome.record.callerId).toBe("inv_01");
      expect(outcome.record.audience).toBe("runtime");
    }
  });
});

// ─── buildReplayResponse / buildIdempotencyErrorResponse（纯逻辑）──

describe("V11 buildReplayResponse", () => {
  function buildCompletedRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
    return {
      id: "rec_1",
      tenantId: "tnt_1",
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-1",
      requestHash: "hash-1",
      processingState: "completed",
      httpStatus: 201,
      responseRef: "thr_1",
      responseRedactedJson: '{"id":"thr_1"}',
      createdAt: new Date(),
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

  it("completed + responseRedactedJson → 返回原状态码与解析后 body", async () => {
    const record = buildCompletedRecord();
    const response = buildReplayResponse(record, "req_test");
    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBe("req_test");
    expect(response.headers.get("x-idempotent-resource-ref")).toBe("thr_1");
    const body = await response.json();
    expect(body).toEqual({ id: "thr_1" });
  });

  it("completed + 空 responseRedactedJson → 返回 redacted + resource_ref", async () => {
    const record = buildCompletedRecord({ responseRedactedJson: null });
    const response = buildReplayResponse(record);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ redacted: true, resource_ref: "thr_1" });
  });

  it("completed + 非法 responseRedactedJson → 返回 redacted 占位", async () => {
    const record = buildCompletedRecord({ responseRedactedJson: "not json" });
    const response = buildReplayResponse(record);
    const body = await response.json();
    expect(body).toEqual({ redacted: true });
  });

  it("非 completed 记录抛错", () => {
    const record = buildCompletedRecord({ processingState: "processing" });
    expect(() => buildReplayResponse(record)).toThrow(/非 completed/);
  });
});

describe("V11 buildIdempotencyErrorResponse", () => {
  function buildRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
    return {
      id: "rec_1",
      tenantId: "tnt_1",
      audience: "employee",
      callerType: "user",
      callerId: "uid_1",
      commandScope: "thread.create:",
      idempotencyKey: "key-1",
      requestHash: "hash-existing",
      processingState: "completed",
      httpStatus: 200,
      responseRef: null,
      responseRedactedJson: null,
      createdAt: new Date(),
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

  it("reason=conflict → 409 + existing_request_hash", async () => {
    const record = buildRecord();
    const response = buildIdempotencyErrorResponse({
      record,
      reason: "conflict",
      requestId: "req_x",
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("x-request-id")).toBe("req_x");
    const body = await response.json();
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details.existing_request_hash).toBe("hash-existing");
    expect(body.error.details.idempotency_key).toBe("key-1");
  });

  it("reason=in_flight → 409 + record_id + state", async () => {
    const record = buildRecord({ processingState: "processing" });
    const response = buildIdempotencyErrorResponse({ record, reason: "in_flight" });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(body.error.details.record_id).toBe("rec_1");
    expect(body.error.details.state).toBe("processing");
  });
});
