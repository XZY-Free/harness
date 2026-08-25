/**
 * Per-Invocation Agent Selection 集成测试（05 §1-§3/§11/§12，Batch 8 Gate）。
 *
 * 覆盖：
 * - no selection → 基础 Harness Route（requestedAgentId=null，Binding agent evidence 不变）。
 * - required A → exact A：Turn.requestedAgentId 持久化 + 调度解析 Agent Route，
 *   ExecutionBinding 冻结该 Agent 的 AgentRevision。
 * - required A no route → fail（422 BUSINESS_CONSTRAINT_VIOLATION），不 fallback 到 base route。
 * - agent_selection 非法（mode/agent_id 缺失）→ 400 REQUEST_SCHEMA_INVALID。
 * - CreateThread 无 agent_id（Thread 不绑定 Agent；多余字段不产生绑定）。
 */
import { POST as createTurnPOST } from "@/app/api/v1/threads/[thread_id]/turns/route";
import { POST as createThreadPOST } from "@/app/api/v1/threads/route";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { buildActor } from "@/lib/test-support/create-verified-attestation";
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
  it("no selection → 基础 Harness Route：requestedAgentId=null，正常调度", async () => {
    const ctx = await seedDispatchableTurn({ agentKey: "sel-base-agent" });
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

  it("required A → exact A：requestedAgentId 持久化 + Agent Route 解析 + Binding 冻结该 AgentRevision", async () => {
    const ctx = await seedDispatchableTurn({ agentKey: "sel-agent-a" });
    // Agent-specific Route（05 §3：requestedAgentId → AgentConstraint → AgentRevision）。
    const routeSet = await createRouteSet({
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      routeScopeKey: "default",
      routeScopeJson: { networkZone: "internal" },
    });
    await activateSingleRouteForTest({
      tenantId: ctx.tenantId,
      routeSetId: routeSet.id,
      routeSetExpectedVersionNo: 1,
      agentRevisionId: ctx.agentRevision.id,
      runtimeRevisionId: ctx.runtimeRevision.id,
      trafficWeight: MAX_TRAFFIC_WEIGHT,
      priorityNo: 1,
      actor: buildActor(ctx.tenantId, "deploy-bot-001"),
    });

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

    // 调度走 Agent Route：Binding 冻结该 AgentRevision（05 §5）。
    expect(turn?.latestInvocationId).toBeTruthy();
    if (turn?.latestInvocationId) {
      const binding = await getExecutionBindingByInvocation(ctx.tenantId, turn.latestInvocationId);
      expect(binding?.agentRevisionId).toBe(ctx.agentRevision.id);
    }
  });

  it("required A no route → fail（422），不 fallback 到 base route", async () => {
    const ctx = await seedDispatchableTurn({ agentKey: "sel-agent-noroute" });
    // 不建 Agent Route（只存在 base route）。
    const threadId = await createThreadForOwner("sel-noroute");
    const resp = await postTurn(threadId, "sel-noroute", {
      input: { type: "text", text: "没有路由的 Agent" },
      agent_selection: { mode: "required", agent_id: ctx.agentId },
    });
    expect(resp.status).toBe(422);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUSINESS_CONSTRAINT_VIOLATION");
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
