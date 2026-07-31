/**
 * S12-W03：V11 Readiness 检查器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - checkReadiness 全 scope 默认检查：返回 6 个组件 + overall_state 聚合
 * - checkReadiness 单 scope 检查：只返回 1 个组件
 * - database_migration 组件：真实 __drizzle_migrations 表可读 → ready
 * - event_projection 组件：无 quarantined → ready；有 quarantined → degraded
 * - gateway 组件：低并发 → ready
 * - overall_state 聚合规则：任一 unavailable → unavailable；任一 degraded → degraded
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createAgent } from "@/lib/v11/control-plane/agent-queries";
import {
  initEventStreamFloor,
  recordDeliveryFailure,
  updateDeliveryFailureState,
} from "@/lib/v11/conversation/projection-checkpoint-queries";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { resetOverloadProtector } from "@/lib/v11/gateway/overload-protection";
import { resetSSEConnectionQuota } from "@/lib/v11/gateway/sse-connection-quota";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import {
  READINESS_SCOPES,
  checkReadiness,
  isKnownReadinessScope,
} from "@/lib/v11/operations/readiness";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
  resetOverloadProtector();
  resetSSEConnectionQuota();
});

afterEach(() => {
  resetOverloadProtector();
  resetSSEConnectionQuota();
});

// ─── 辅助：seed 租户 + 用户 + Agent + Thread + StreamFloor ──

async function seedFullContext() {
  const tenantRow = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenantRow.id,
    externalSubject: "owner-001",
    email: "owner001@example.com",
    displayName: "Thread Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenantRow.id,
    subjectType: "user",
    externalId: "owner-001",
    displayName: "Thread Owner",
    userIdentityId: identity.id,
  });
  const agent = await createAgent({
    tenantId: tenantRow.id,
    agentKey: "finance",
    displayName: "Finance Agent",
    ownerUserId: identity.id,
    lifecycleState: "enabled",
  });
  const { thread } = await createThread({
    tenantId: tenantRow.id,
    ownerUserId: identity.id,
    primaryAgentId: agent.id,
    actorId: identity.id,
  });
  await initEventStreamFloor({
    streamType: "thread_event",
    streamId: thread.id,
    tenantId: tenantRow.id,
    latestSequence: 1,
  });
  return {
    tenantId: tenantRow.id,
    threadId: thread.id,
    streamType: "thread_event" as const,
    streamId: thread.id,
  };
}

// ─── isKnownReadinessScope ─────────────────────────────

describe("isKnownReadinessScope", () => {
  it("合法 scope 返回 true", () => {
    for (const scope of READINESS_SCOPES) {
      expect(isKnownReadinessScope(scope)).toBe(true);
    }
  });

  it("非法 scope 返回 false", () => {
    expect(isKnownReadinessScope("unknown_scope")).toBe(false);
    expect(isKnownReadinessScope("")).toBe(false);
  });
});

// ─── checkReadiness 全 scope ───────────────────────────

describe("checkReadiness 全 scope 默认检查", () => {
  it("返回 6 个组件 + overall_state 为 ready（无 quarantined）", async () => {
    const tenantRow = await ensureDefaultTenant();
    const result = await checkReadiness(tenantRow.id);

    expect(result.components).toHaveLength(6);
    expect(result.overall_state).toBe("ready");
    expect(result.checked_at).toBeTruthy();

    const names = result.components.map((c) => c.name);
    expect(names).toContain("employee_api");
    expect(names).toContain("runtime_dispatch");
    expect(names).toContain("gateway");
    expect(names).toContain("event_projection");
    expect(names).toContain("job_scheduler");
    expect(names).toContain("deletion");
  });

  it("所有组件都有 state + reason_codes + metrics 字段", async () => {
    const tenantRow = await ensureDefaultTenant();
    const result = await checkReadiness(tenantRow.id);

    for (const component of result.components) {
      expect(component.name).toBeTruthy();
      expect(["ready", "degraded", "unavailable"]).toContain(component.state);
      expect(Array.isArray(component.reason_codes)).toBe(true);
      expect(typeof component.metrics).toBe("object");
      expect(component.metrics).not.toBeNull();
    }
  });
});

// ─── checkReadiness 单 scope ───────────────────────────

describe("checkReadiness 单 scope 检查", () => {
  it("scope=event_projection 只返回 event_projection 组件", async () => {
    const tenantRow = await ensureDefaultTenant();
    const result = await checkReadiness(tenantRow.id, "event_projection");

    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.name).toBe("event_projection");
    expect(result.components[0]?.state).toBe("ready");
  });

  it("scope=gateway 只返回 gateway 组件", async () => {
    const tenantRow = await ensureDefaultTenant();
    const result = await checkReadiness(tenantRow.id, "gateway");

    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.name).toBe("gateway");
    expect(result.components[0]?.state).toBe("ready");
    expect(result.components[0]?.metrics.concurrent_requests).toBe(0);
  });

  it("scope=deletion 只返回 deletion 组件", async () => {
    const tenantRow = await ensureDefaultTenant();
    const result = await checkReadiness(tenantRow.id, "deletion");

    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.name).toBe("deletion");
    expect(result.components[0]?.state).toBe("ready");
    expect(result.components[0]?.metrics.active_requests).toBe(0);
  });
});

// ─── database_migration 组件 ───────────────────────────

describe("database_migration 组件", () => {
  it("真实 __drizzle_migrations 表可读 → ready", async () => {
    const tenantRow = await ensureDefaultTenant();
    const result = await checkReadiness(tenantRow.id, "employee_api");

    const component = result.components[0];
    expect(component?.state).toBe("ready");
    expect(component?.metrics.migration_state).toBe("ready");
  });
});

// ─── event_projection 组件 ─────────────────────────────

describe("event_projection 组件", () => {
  it("无 quarantined failure → ready", async () => {
    const tenantRow = await ensureDefaultTenant();
    const result = await checkReadiness(tenantRow.id, "event_projection");

    expect(result.components[0]?.state).toBe("ready");
    expect(result.components[0]?.reason_codes).toEqual([]);
    expect(result.components[0]?.metrics.quarantined_streams).toBe(0);
  });

  it("有 quarantined failure → degraded + QUARANTINED_STREAMS_PRESENT", async () => {
    const fx = await seedFullContext();

    // 插入一条 delivery failure 并标记为 quarantined
    const failure = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: fx.streamType,
      streamId: fx.streamId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
      lastErrorCode: "UNKNOWN",
    });
    await updateDeliveryFailureState(failure.id, "quarantined");

    const result = await checkReadiness(fx.tenantId, "event_projection");

    expect(result.components[0]?.state).toBe("degraded");
    expect(result.components[0]?.reason_codes).toContain("QUARANTINED_STREAMS_PRESENT");
    expect(result.components[0]?.metrics.quarantined_streams).toBe(1);
  });
});

// ─── gateway 组件 ──────────────────────────────────────

describe("gateway 组件", () => {
  it("低并发时 → ready", async () => {
    const tenantRow = await ensureDefaultTenant();
    const result = await checkReadiness(tenantRow.id, "gateway");

    expect(result.components[0]?.state).toBe("ready");
    expect(result.components[0]?.metrics.concurrent_requests).toBe(0);
    expect(result.components[0]?.metrics.max_concurrent).toBe(500);
    expect(result.components[0]?.metrics.sse_active_tenant).toBe(0);
  });
});

// ─── overall_state 聚合规则 ────────────────────────────

describe("overall_state 聚合规则", () => {
  it("有 quarantined failure → overall_state 为 degraded", async () => {
    const fx = await seedFullContext();

    const failure = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: fx.streamType,
      streamId: fx.streamId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
      lastErrorCode: "UNKNOWN",
    });
    await updateDeliveryFailureState(failure.id, "quarantined");

    const result = await checkReadiness(fx.tenantId);

    // event_projection degraded → overall degraded
    expect(result.overall_state).toBe("degraded");
    const projectionComponent = result.components.find((c) => c.name === "event_projection");
    expect(projectionComponent?.state).toBe("degraded");
  });

  it("无异常 → overall_state 为 ready", async () => {
    const tenantRow = await ensureDefaultTenant();
    const result = await checkReadiness(tenantRow.id);
    expect(result.overall_state).toBe("ready");
  });
});
