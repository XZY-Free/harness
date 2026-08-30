/**
 * Per-Invocation Agent Selection 集成测试（05 §1-§3/§11/§12，Batch 8 Gate）。
 *
 * 覆盖（专题01 冻结架构：顶层 Employee Turn 恒走基础 Harness Route，
 * ExecutionBinding 为 runtime-only，不再冻结 AgentRevision）：
 * - no selection → 基础 Harness Route（requestedAgentId=null，正常调度）。
 * - required A → Turn.requestedAgentId 持久化 + 顶层走 base route 正常调度
 *   （用户选择 Agent 是"本轮使用该 Agent 能力"的约束，不改变顶层执行目标）。
 * - required A no route → POST Turn 正常 201（顶层不受 Agent route 影响；
 *   Agent 不可用由 AgentCall 层 fail-closed，属后续 AgentCall 域）。
 * - agent_selection 非法（mode/agent_id 缺失）→ 400 REQUEST_SCHEMA_INVALID。
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

describe("Per-Invocation Agent Selection（05）", () => {
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
      agent_selection: { mode: "required", agent_id: ctx.agentId },
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
      agent_selection: { mode: "required", agent_id: ctx.agentId },
    });
    expect(response.status).toBe(403);
  });

  it("foreign/unknown Agent id 不查存在性，统一返回 403", async () => {
    await seedDispatchableTurn({ agentKey: "sel-foreign-agent" });
    const threadId = await createThreadForOwner("sel-foreign");
    const response = await postTurn(threadId, "sel-foreign", {
      input: { type: "text", text: "选择外部 id" },
      agent_selection: { mode: "required", agent_id: "foreign-agent-id" },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ACTION_SCOPE_DENIED");
  });

  it("no selection → 基础 Harness Route：requestedAgentId=null，正常调度", async () => {
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
    expect(turn?.requestedAgentId).toBeNull();
    expect(turn?.agentSelectionMode).toBeNull();
    // 基础路径正常调度（base route 已由 seed 建立）。
    expect(turn?.latestInvocationId).toBeTruthy();
  });

  it("required A：requestedAgentId 持久化 + 顶层走 base route 调度 + Web 回显", async () => {
    const ctx = await seedDispatchableTurn({ agentKey: "sel-agent-a" });
    // 专题01 冻结架构：顶层 Employee Turn 恒走基础 Harness Route（seed 已建 base route），
    // 用户选择 required A 只作为"本轮使用该 Agent 能力"的约束记录在 Turn，不改变顶层执行目标，
    // 也不再为顶层创建 Agent-specific Route（Agent route 属 AgentCall 层）。
    const threadId = await createThreadForOwner("sel-exact");
    const resp = await postTurn(threadId, "sel-exact", {
      input: { type: "text", text: "必须用 A" },
      agent_selection: { mode: "required", agent_id: ctx.agentId },
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { turn: { id: string } };

    // Turn 持久化 requested facts（05 §2）。
    const turn = await getTurnById(ctx.tenantId, body.turn.id);
    expect(turn?.requestedAgentId).toBe(ctx.agentId);
    expect(turn?.agentSelectionMode).toBe("required");

    const params = { params: Promise.resolve({ thread_id: threadId }) };
    const detail = await getThreadGET(
      buildApiRequest({ audience: "employee", method: "GET", path: `/threads/${threadId}` }),
      params,
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()).latest_turn.requested_agent_id).toBe(ctx.agentId);
    const turns = await getTurnsGET(
      buildApiRequest({ audience: "employee", method: "GET", path: `/threads/${threadId}/turns` }),
      params,
    );
    expect(turns.status).toBe(200);
    expect((await turns.json()).turns.at(-1).requested_agent_id).toBe(ctx.agentId);

    // 调度走 Agent Route：Binding 存在（专题01 冻结架构：ExecutionBinding 不再携带 Agent 证据字段）。
    expect(turn?.latestInvocationId).toBeTruthy();
    if (turn?.latestInvocationId) {
      const binding = await getExecutionBindingByInvocation(ctx.tenantId, turn.latestInvocationId);
      expect(binding).toBeTruthy();
    }
  });

  it("required A no route → POST Turn 201（顶层恒走 base route；Agent 不可用由 AgentCall 层 fail-closed）", async () => {
    const ctx = await seedDispatchableTurn({ agentKey: "sel-agent-noroute" });
    // 专题01 冻结架构：顶层 Employee Turn 不再解析 Agent Route，required Agent 无 route
    // 不影响 POST Turn —— 顶层恒走 base route 正常启动；Agent 不可用由 AgentCall 层（后续域）
    // fail-closed，禁止在 POST Turn 阶段因 Agent no-route 直接 422。
    const threadId = await createThreadForOwner("sel-noroute");
    const resp = await postTurn(threadId, "sel-noroute", {
      input: { type: "text", text: "没有路由的 Agent" },
      agent_selection: { mode: "required", agent_id: ctx.agentId },
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { turn: { id: string } };

    // Turn 持久化 required facts。
    const turn = await getTurnById(ctx.tenantId, body.turn.id);
    expect(turn?.requestedAgentId).toBe(ctx.agentId);
    expect(turn?.agentSelectionMode).toBe("required");

    // 顶层走 base route 正常调度：创建 runtime-only ExecutionBinding（不冻结 Agent）。
    expect(turn?.latestInvocationId).toBeTruthy();
    if (turn?.latestInvocationId) {
      const binding = await getExecutionBindingByInvocation(ctx.tenantId, turn.latestInvocationId);
      expect(binding).toBeTruthy();
    }
  });

  it("agent_selection 非法 → 400 REQUEST_SCHEMA_INVALID", async () => {
    await seedDispatchableTurn({ agentKey: "sel-agent-invalid" });
    const threadId = await createThreadForOwner("sel-invalid");

    const badMode = await postTurn(threadId, "sel-invalid-mode", {
      input: { type: "text", text: "非法 mode" },
      agent_selection: { mode: "preferred", agent_id: "agent-x" },
    });
    expect(badMode.status).toBe(400);

    const noAgent = await postTurn(threadId, "sel-invalid-agent", {
      input: { type: "text", text: "缺 agent_id" },
      agent_selection: { mode: "required" },
    });
    expect(noAgent.status).toBe(400);
  });
});
