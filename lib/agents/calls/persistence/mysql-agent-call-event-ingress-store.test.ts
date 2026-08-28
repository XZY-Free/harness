/**
 * mysqlAgentCallEventIngressStore 集成测试 — 真实 MySQL。
 *
 * 目标不变量（专题01 02 §六）：
 * 1. accept 幂等：同 (callId, producerEventId) 重复提交 → duplicate（payloadHash 相同）。
 * 2. hash 冲突：同 (callId, producerEventId) 不同 payloadHash → hash_conflict（拒绝）。
 * 3. producerSequence 冲突（不同 eventId 同 seq）→ duplicate / hash_conflict 兜底。
 * 4. markMapped 仅 accepted→mapped；rejected 不可 mapped。
 * 5. cross-tenant：ingress 查询按 callId + tenantId 隔离。
 * 6. AgentCall event 归一化到 AgentCall 域，不触碰 parent Invocation（应用层验证）。
 */
import { randomUUID } from "node:crypto";
import { mysqlAgentCallEventIngressStore } from "@/lib/agents/calls/persistence/mysql-agent-call-event-ingress-store";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import {
  computePayloadHash,
  seedInvocation,
  seedTenant,
  validBindingConfig,
} from "@/lib/agents/calls/test/agent-call-test-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { agentCallEventIngressTable } from "@/lib/persistence/schema/agent-calls";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-28T00:00:00.000Z");

beforeEach(async () => {
  await resetDatabase(db);
});

async function seedCall() {
  const tenantId = await seedTenant();
  const parentId = await seedInvocation(tenantId);
  const { call } = await mysqlAgentCallStore.createIdempotent({
    id: randomUUID(),
    tenantId,
    parentInvocationId: parentId,
    agentId: "agent-1",
    agentRevisionId: "agent-rev-1",
    sourceType: "user_selected",
    sourceRef: "turn-1",
    logicalCallKey: "required-agent:turn-1:agent-1",
    binding: validBindingConfig(),
    bindingHash: `sha256:${"0".repeat(64)}`,
    createdAt: NOW,
  });
  return { tenantId, parentId, call };
}

function seedIngress(
  callId: string,
  tenantId: string,
  overrides: {
    producerEventId?: string;
    producerSequence?: number;
    candidateType?: string;
    payload?: unknown;
  } = {},
) {
  const payload = overrides.payload ?? { kind: "call.completed", text: "ok" };
  const payloadHash = computePayloadHash(payload);
  return {
    id: randomUUID(),
    callId,
    tenantId,
    producerEventId: overrides.producerEventId ?? "evt-1",
    producerSequence: overrides.producerSequence ?? 1,
    candidateType: overrides.candidateType ?? "call.completed",
    payloadHash,
    payloadJson: payload,
    receivedAt: NOW,
  };
}

const ingressFor = seedIngress;

describe("mysqlAgentCallEventIngressStore", () => {
  it("accept 首次提交 → accepted", async () => {
    const { tenantId, call } = await seedCall();
    const res = await mysqlAgentCallEventIngressStore.accept(ingressFor(call.id, tenantId));
    expect(res.status).toBe("accepted");
    if (res.status === "accepted") {
      expect(res.ingress.ingressState).toBe("accepted");
      expect(res.ingress.candidateType).toBe("call.completed");
    }
  });

  it("accept 幂等：同 (callId, producerEventId) 同 payloadHash → duplicate", async () => {
    const { tenantId, call } = await seedCall();
    await mysqlAgentCallEventIngressStore.accept(ingressFor(call.id, tenantId));
    const dup = await mysqlAgentCallEventIngressStore.accept(ingressFor(call.id, tenantId));
    expect(dup.status).toBe("duplicate");
    const [cnt] = await db
      .select({ c: agentCallEventIngressTable.id })
      .from(agentCallEventIngressTable);
    expect(cnt).toBeTruthy();
    expect((await db.select().from(agentCallEventIngressTable)).length).toBe(1);
  });

  it("hash 冲突：同 (callId, producerEventId) 不同 payloadHash → hash_conflict", async () => {
    const { tenantId, call } = await seedCall();
    await mysqlAgentCallEventIngressStore.accept(ingressFor(call.id, tenantId));
    const conflict = await mysqlAgentCallEventIngressStore.accept(
      ingressFor(call.id, tenantId, { payload: { kind: "call.failed", text: "boom" } }),
    );
    expect(conflict.status).toBe("hash_conflict");
  });

  it("producerSequence 冲突兜底：同 seq 同 hash → duplicate", async () => {
    const { tenantId, call } = await seedCall();
    // 先占住 seq=1 用 evt-1；再用不同 eventId 但同 seq=1 且同 hash → duplicate。
    await mysqlAgentCallEventIngressStore.accept(ingressFor(call.id, tenantId));
    const seqDup = await mysqlAgentCallEventIngressStore.accept(
      ingressFor(call.id, tenantId, { producerEventId: "evt-other", producerSequence: 1 }),
    );
    expect(seqDup.status).toBe("duplicate");
  });

  it("producerSequence 冲突兜底：同 seq 不同 hash → hash_conflict", async () => {
    const { tenantId, call } = await seedCall();
    await mysqlAgentCallEventIngressStore.accept(ingressFor(call.id, tenantId));
    const seqConflict = await mysqlAgentCallEventIngressStore.accept(
      ingressFor(call.id, tenantId, {
        producerEventId: "evt-other",
        producerSequence: 1,
        payload: { kind: "call.failed" },
      }),
    );
    expect(seqConflict.status).toBe("hash_conflict");
  });

  it("markMapped：accepted → mapped", async () => {
    const { tenantId, call } = await seedCall();
    const res = await mysqlAgentCallEventIngressStore.accept(ingressFor(call.id, tenantId));
    if (res.status !== "accepted") throw new Error("expected accepted");
    const mapped = await mysqlAgentCallEventIngressStore.markMapped({
      ingressId: res.ingress.id,
      callId: call.id,
      tenantId,
      now: NOW,
    });
    expect(mapped.ingressState).toBe("mapped");
    expect(mapped.mappedAt).toBeTruthy();
  });

  it("跨租户隔离：异租户 markMapped 抛错", async () => {
    const { tenantId, call } = await seedCall();
    const otherTenant = await seedTenant();
    const res = await mysqlAgentCallEventIngressStore.accept(ingressFor(call.id, tenantId));
    if (res.status !== "accepted") throw new Error("expected accepted");
    await expect(
      mysqlAgentCallEventIngressStore.markMapped({
        ingressId: res.ingress.id,
        callId: call.id,
        tenantId: otherTenant,
        now: NOW,
      }),
    ).rejects.toThrow(/不存在/);
  });

  it("事件账本不触碰 parent Invocation（AgentCall 子执行域隔离）", async () => {
    const { tenantId, parentId, call } = await seedCall();
    await mysqlAgentCallEventIngressStore.accept(ingressFor(call.id, tenantId));
    const [parentRow] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, parentId))
      .limit(1);
    expect(parentRow?.executionState).toBe("queued");
  });
});
