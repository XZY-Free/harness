/**
 * Turn-scoped AgentUseDirective 集成测试（专题01 Batch 1）。
 *
 * 覆盖（专题01 冻结架构：顶层 Employee Turn 恒走基础 Harness Route，
 * ExecutionBinding 为 runtime-only，不再冻结 AgentRevision）：
 * - omitted/null → 本 Turn 无 directive，不继承上一 Turn。
 * - preferred A → Turn.preferredAgentId/agentUseMode 持久化，顶层仍走 Runtime。
 * - preferred A no route → POST Turn 正常 201；偏好不等于必须调用。
 * - agent_use 非法或旧 agent_selection wire → 400 REQUEST_SCHEMA_INVALID。
 * - CreateThread 无 agent_id（Thread 不绑定 Agent；多余字段不产生绑定）。
 */
import { GET as getThreadGET } from "@/app/api/v1/threads/[thread_id]/route";
import {
  POST as createTurnPOST,
  GET as getTurnsGET,
} from "@/app/api/v1/threads/[thread_id]/turns/route";
import { POST as createThreadPOST } from "@/app/api/v1/threads/route";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { revokeActionBinding } from "@/lib/identity/role-action-queries";
import { turnTable } from "@/lib/persistence/schema/conversation";
import { idempotencyRecord } from "@/lib/persistence/schema/idempotency";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

async function createThreadForOwner(key: string): Promise<string> {
  const req = buildApiRequest({
    audience: "employee",
    method: "POST",
    path: "/threads",
    idempotencyKey: `${key}-thread`,
    body: {},
  });
  const resp = await createThreadPOST(req);
  expect(resp.status).toBe(201);
  const { id } = (await resp.json()) as { id: string };
  return id;
}

async function postTurn(
  threadId: string,
  key: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const req = buildApiRequest({
    audience: "employee",
    method: "POST",
    path: `/threads/${threadId}/turns`,
    idempotencyKey: `${key}-turn`,
    body,
  });
  return createTurnPOST(req, { params: Promise.resolve({ thread_id: threadId }) });
}

describe("Turn-scoped AgentUseDirective", () => {
  it("无 agent.invoke：selected Agent 统一 403，且不写 Turn/幂等记录", async () => {
    const ctx = await seedDispatchableTurn({
      agentKey: "sel-unauthorized-agent",
      grantAgentInvoke: false,
    });
    const threadId = await createThreadForOwner("sel-unauthorized");
    const turnsBefore = await db.select().from(turnTable);
    const idempotencyBefore = await db.select().from(idempotencyRecord);

    const response = await postTurn(threadId, "sel-unauthorized", {
      input: { type: "text", text: "无授权选择" },
      agent_use: { mode: "preferred", agent_id: ctx.agentId },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ACTION_SCOPE_DENIED");
    expect(await db.select().from(turnTable)).toHaveLength(turnsBefore.length);
    expect(await db.select().from(idempotencyRecord)).toHaveLength(idempotencyBefore.length);
  });

  it("缓存选择后撤销 agent.invoke：再次 POST 必须 403", async () => {
    const ctx = await seedDispatchableTurn({ agentKey: "sel-revoked-agent" });
    if (!ctx.agentInvokeBindingId) throw new Error("撤销用例缺少 agent.invoke binding");
    const threadId = await createThreadForOwner("sel-revoked");
    expect(await revokeActionBinding(ctx.tenantId, ctx.agentInvokeBindingId)).toBe(true);

    const response = await postTurn(threadId, "sel-revoked", {
      input: { type: "text", text: "撤销后继续选择" },
      agent_use: { mode: "preferred", agent_id: ctx.agentId },
    });
    expect(response.status).toBe(403);
  });

  it("foreign/unknown Agent id 不查存在性，统一返回 403", async () => {
    await seedDispatchableTurn({ agentKey: "sel-foreign-agent" });
    const threadId = await createThreadForOwner("sel-foreign");
    const response = await postTurn(threadId, "sel-foreign", {
      input: { type: "text", text: "选择外部 id" },
      agent_use: { mode: "preferred", agent_id: "foreign-agent-id" },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ACTION_SCOPE_DENIED");
  });

  it("省略 agent_use → preferredAgentId/agentUseMode 为 null，正常调度", async () => {
    const ctx = await seedDispatchableTurn({
      agentKey: "sel-base-agent",
      grantAgentInvoke: false,
    });
    const threadId = await createThreadForOwner("sel-base");

    const resp = await postTurn(threadId, "sel-base", {
      input: { type: "text", text: "基础路径" },
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { turn: { id: string } };
    const turn = await getTurnById(ctx.tenantId, body.turn.id);
    expect(turn?.preferredAgentId).toBeNull();
    expect(turn?.agentUseMode).toBeNull();
    // 基础路径正常调度（base route 已由 seed 建立）。
    expect(turn?.latestInvocationId).toBeTruthy();
  });

  it("数据库拒绝 preferredAgentId/agentUseMode 半空或非 preferred 组合", async () => {
    const ctx = await seedDispatchableTurn({
      agentKey: "sel-pair-constraint-agent",
      grantAgentInvoke: false,
    });
    const threadId = await createThreadForOwner("sel-pair-constraint");
    const response = await postTurn(threadId, "sel-pair-constraint", {
      input: { type: "text", text: "创建无 directive Turn" },
    });
    const body = (await response.json()) as { turn: { id: string } };

    await expect(
      db.update(turnTable).set({ agentUseMode: "preferred" }).where(eq(turnTable.id, body.turn.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(turnTable)
        .set({ preferredAgentId: ctx.agentId, agentUseMode: "required" })
        .where(eq(turnTable.id, body.turn.id)),
    ).rejects.toThrow();
  });

  it("preferred A：本 Turn directive 持久化 + 顶层走 Runtime + Web 回显", async () => {
    const ctx = await seedDispatchableTurn({ agentKey: "sel-agent-a" });
    // 专题01 冻结架构：顶层 Employee Turn 恒走基础 Harness Route（seed 已建 base route），
    // 用户选择 preferred A 只表达本轮偏好，不改变顶层执行目标，
    // 也不再为顶层创建 Agent-specific Route（Agent route 属 AgentCall 层）。
    const threadId = await createThreadForOwner("sel-exact");
    const resp = await postTurn(threadId, "sel-exact", {
      input: { type: "text", text: "优先用 A" },
      agent_use: { mode: "preferred", agent_id: ctx.agentId },
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { turn: { id: string } };

    // Turn 只持久化本 Turn directive。
    const turn = await getTurnById(ctx.tenantId, body.turn.id);
    expect(turn?.preferredAgentId).toBe(ctx.agentId);
    expect(turn?.agentUseMode).toBe("preferred");

    const params = { params: Promise.resolve({ thread_id: threadId }) };
    const detail = await getThreadGET(
      buildApiRequest({ audience: "employee", method: "GET", path: `/threads/${threadId}` }),
      params,
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()).latest_turn).toMatchObject({
      preferred_agent_id: ctx.agentId,
      agent_use_mode: "preferred",
    });
    const turns = await getTurnsGET(
      buildApiRequest({ audience: "employee", method: "GET", path: `/threads/${threadId}/turns` }),
      params,
    );
    expect(turns.status).toBe(200);
    expect((await turns.json()).turns.at(-1)).toMatchObject({
      preferred_agent_id: ctx.agentId,
      agent_use_mode: "preferred",
    });

    // 调度走 Agent Route：Binding 存在（专题01 冻结架构：ExecutionBinding 不再携带 Agent 证据字段）。
    expect(turn?.latestInvocationId).toBeTruthy();
    if (turn?.latestInvocationId) {
      const binding = await getExecutionBindingByInvocation(ctx.tenantId, turn.latestInvocationId);
      expect(binding).toBeTruthy();
    }
  });

  it("preferred A no route → POST Turn 201（偏好不约束顶层 Runtime 路由）", async () => {
    const ctx = await seedDispatchableTurn({ agentKey: "sel-agent-noroute" });
    // Turn 接纳不探测 Agent Route；是否需要调用由后续 Harness action 决定。
    const threadId = await createThreadForOwner("sel-noroute");
    const resp = await postTurn(threadId, "sel-noroute", {
      input: { type: "text", text: "没有路由的 Agent" },
      agent_use: { mode: "preferred", agent_id: ctx.agentId },
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { turn: { id: string } };

    // Turn 持久化 preferred directive。
    const turn = await getTurnById(ctx.tenantId, body.turn.id);
    expect(turn?.preferredAgentId).toBe(ctx.agentId);
    expect(turn?.agentUseMode).toBe("preferred");

    // 顶层走 base route 正常调度：创建 runtime-only ExecutionBinding（不冻结 Agent）。
    expect(turn?.latestInvocationId).toBeTruthy();
    if (turn?.latestInvocationId) {
      const binding = await getExecutionBindingByInvocation(ctx.tenantId, turn.latestInvocationId);
      expect(binding).toBeTruthy();
    }
  });

  it("agent_use 非法或旧 agent_selection wire → 400 REQUEST_SCHEMA_INVALID", async () => {
    const ctx = await seedDispatchableTurn({ agentKey: "sel-agent-invalid" });
    const threadId = await createThreadForOwner("sel-invalid");

    const badMode = await postTurn(threadId, "sel-invalid-mode", {
      input: { type: "text", text: "非法 mode" },
      agent_use: { mode: "required", agent_id: "agent-x" },
    });
    expect(badMode.status).toBe(400);

    const noAgent = await postTurn(threadId, "sel-invalid-agent", {
      input: { type: "text", text: "缺 agent_id" },
      agent_use: { mode: "preferred" },
    });
    expect(noAgent.status).toBe(400);

    const oldWire = await postTurn(threadId, "sel-old-wire", {
      input: { type: "text", text: "旧 wire" },
      agent_selection: { mode: "required", agent_id: "agent-x" },
    });
    expect(oldWire.status).toBe(400);

    const extraKey = await postTurn(threadId, "sel-extra-key", {
      input: { type: "text", text: "额外字段" },
      agent_use: { mode: "preferred", agent_id: ctx.agentId, required: true },
    });
    expect(extraKey.status).toBe(400);
  });

  it("同一 Thread 的 preferred → null → omitted → preferred 各自独立且不改写历史", async () => {
    const ctx = await seedDispatchableTurn({ agentKey: "sel-independent-agent" });
    const threadId = await createThreadForOwner("sel-independent");

    const first = await postTurn(threadId, "sel-independent-1", {
      input: { type: "text", text: "第一轮" },
      agent_use: { mode: "preferred", agent_id: ctx.agentId },
    });
    const second = await postTurn(threadId, "sel-independent-2", {
      input: { type: "text", text: "第二轮" },
      agent_use: null,
    });
    const third = await postTurn(threadId, "sel-independent-3", {
      input: { type: "text", text: "第三轮" },
    });
    const fourth = await postTurn(threadId, "sel-independent-4", {
      input: { type: "text", text: "第四轮" },
      agent_use: { mode: "preferred", agent_id: ctx.agentId },
    });
    for (const response of [first, second, third, fourth]) expect(response.status).toBe(201);

    const ids = await Promise.all(
      [first, second, third, fourth].map(
        async (response) => ((await response.clone().json()) as { turn: { id: string } }).turn.id,
      ),
    );
    const rows = await Promise.all(ids.map((id) => getTurnById(ctx.tenantId, id)));
    expect(rows.map((turn) => [turn?.preferredAgentId, turn?.agentUseMode])).toEqual([
      [ctx.agentId, "preferred"],
      [null, null],
      [null, null],
      [ctx.agentId, "preferred"],
    ]);
  });
});
