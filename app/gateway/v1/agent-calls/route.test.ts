/**
 * Gateway AgentCall endpoints 集成测试（专题01 Batch8 · Gateway 收口）。
 *
 * 真实 MySQL + 真实 loopback A2A Provider（复用 seedAgentCallExecutionScenario，
 * 不 mock transport / store / DB）。POST 的核心编排 createAgentCallViaGateway 注入
 * mock RouteResolver（复用 validAgentRouteResolution 覆盖为 scenario 真实证据），
 * 与 harness-required-agent.test.ts 一致。
 *
 * 目标不变量（Batch8）：
 * 1. Runtime 调 Agent 通过 AgentCall Gateway，不直接拿 endpoint secret / credential。
 * 2. Gateway token 精确绑定 parent Harness Invocation（跨 Invocation 隐藏式 404）。
 * 3. 幂等：同 (parentInvocationId, agentId) 重试只创建一个 AgentCall。
 * 4. POST 创建 / GET 查询 / resume / cancel 走 AgentCall 子域 Authority，parent 不变。
 * 5. 认证失败 → 401；body 非法 → 400。
 * 6. 响应不透出 endpoint secret / credential。
 */
import { randomUUID } from "node:crypto";
import { POST as cancelCall } from "@/app/gateway/v1/agent-calls/[call_id]/cancel/route";
import { POST as resumeCall } from "@/app/gateway/v1/agent-calls/[call_id]/resume/route";
import { GET as getCall } from "@/app/gateway/v1/agent-calls/[call_id]/route";
import { POST, createAgentCallViaGateway } from "@/app/gateway/v1/agent-calls/route";
import {
  EXECUTION_FIXTURE_CONTRACT,
  seedAgentCallExecutionScenario,
} from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { validAgentRouteResolution } from "@/lib/agents/calls/test/agent-call-test-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { bootstrapTenantBaselines } from "@/lib/identity/tenant-bootstrap";
import { issueWorkloadToken } from "@/lib/identity/workload-token";
import { agentCallBindingTable, agentCallTable } from "@/lib/persistence/schema/agent-calls";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** 构造 Gateway Workload Token（audience=gateway，绑定 parent invocationId）。 */
function gatewayToken(tenantId: string, invocationId: string): string {
  return issueWorkloadToken({
    type: "gateway",
    tenantId,
    invocationId,
    audience: "gateway",
    expiresAt: Date.now() + 300_000,
  });
}

/** 支持 input-required/resume/cancel 的合同（interaction 覆盖为能力=true）。 */
const RESUME_CAPABLE_CONTRACT = {
  ...EXECUTION_FIXTURE_CONTRACT,
  interaction: {
    ...EXECUTION_FIXTURE_CONTRACT.interaction,
    input_required: true,
    resume: true,
    cancel: true,
  },
};

/** mock RouteResolver：返回覆盖为 scenario 真实证据的 agent RouteResolution。 */
function mockResolveRoute(
  scenario: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>,
): RouteResolver {
  return async () => ({
    status: "resolved" as const,
    eligibleCandidateCount: 1,
    resolution: validAgentRouteResolution({
      target: {
        kind: "agent",
        agentRevisionId: scenario.agentRevisionId,
        agentEndpointRef: scenario.endpoint,
        agentIdentityMode: "bearer",
        agentCredentialRefId: scenario.credentialRefId,
        agentNetworkZone: "private",
      },
      policyRevisionId: null,
      controlPlaneEvidence: {
        ...validAgentRouteResolution().controlPlaneEvidence,
        agentContractSnapshotId: scenario.agentContractSnapshotId,
        agentContractDigest: scenario.agentContractDigest,
        agentContextDigest: scenario.agentContextDigest,
        agentPublicationRecordId: scenario.agentPublicationRecordId,
      },
    }),
  });
}

/** 等待 AgentCall 进入指定状态（轮询 DB）。 */
async function waitForCallState(
  tenantId: string,
  callId: string,
  expected: string[],
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const [row] = await db
      .select({ state: agentCallTable.state })
      .from(agentCallTable)
      .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
      .limit(1);
    if (row && expected.includes(String(row.state))) return;
    if (Date.now() - start > timeoutMs)
      throw new Error(`AgentCall 未到达 ${expected}: ${row?.state}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 读取 AgentCall 投影（断言用）。 */
async function loadCall(tenantId: string, callId: string) {
  const [row] = await db
    .select()
    .from(agentCallTable)
    .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
    .limit(1);
  return row;
}

describe("Gateway AgentCall endpoints（Batch8）", () => {
  let scenarios: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>[] = [];

  beforeEach(async () => {
    await resetDatabase(db);
    scenarios = [];
  });

  afterEach(async () => {
    for (const s of scenarios) {
      delete process.env[s.credentialEnvVar];
      await s.provider.server.close();
    }
  });

  async function seedScenario(
    providerScenario: "completed" | "input_required" | "failed",
    contract?: unknown,
  ) {
    const scenario = await seedAgentCallExecutionScenario({
      providerScenario,
      ...(contract ? { contract } : {}),
    });
    scenarios.push(scenario);
    await bootstrapTenantBaselines(db, scenario.tenantId, "harness-test-actor");
    return scenario;
  }

  it("POST 认证失败 → 401（无 Gateway Token）", async () => {
    const req = new Request("http://localhost/gateway/v1/agent-calls", {
      method: "POST",
      body: JSON.stringify({ agent_id: randomUUID(), input: "hi" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("POST body 非法 → 400（input 空）", async () => {
    const scenario = await seedScenario("completed");
    const req = new Request("http://localhost/gateway/v1/agent-calls", {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayToken(scenario.tenantId, scenario.parentInvocationId)}`,
      },
      body: JSON.stringify({ agent_id: scenario.agentId, input: "   " }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("POST 创建：Runtime 经 Gateway 调 Agent → AgentCall 子域创建，响应不透出 endpoint secret", async () => {
    const scenario = await seedScenario("completed");
    const result = await createAgentCallViaGateway({
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      body: { agent_id: scenario.agentId, input: "帮我查余额" },
      resolveRoute: mockResolveRoute(scenario),
    });
    expect(result.status).toBe("created");
    const callId = result.payload.call_id as string;

    // AgentCall 落库，parentInvocationId 精确绑定 parent。
    const call = await loadCall(scenario.tenantId, callId);
    expect(call).toBeTruthy();
    expect(call!.parentInvocationId).toBe(scenario.parentInvocationId);

    // AgentCallBinding 冻结了 endpoint/credential facts，但响应 JSON 不含它们。
    const body = JSON.stringify(result.payload);
    expect(body).not.toContain(scenario.endpoint);
    expect(body).not.toContain("credential");
    const binding = await db
      .select()
      .from(agentCallBindingTable)
      .where(
        and(
          eq(agentCallBindingTable.callId, callId),
          eq(agentCallBindingTable.tenantId, scenario.tenantId),
        ),
      )
      .limit(1);
    expect(binding[0]?.endpointRef).toBe(scenario.endpoint);
  });

  it("幂等：同 (parentInvocationId, agentId) 重试只创建一个 AgentCall", async () => {
    const scenario = await seedScenario("completed");
    const params = {
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      body: { agent_id: scenario.agentId, input: "x" },
      resolveRoute: mockResolveRoute(scenario),
    };
    const r1 = await createAgentCallViaGateway(params);
    const r2 = await createAgentCallViaGateway(params);
    expect(r1.payload.call_id).toBe(r2.payload.call_id);

    // fixture 自身也会创建一个 required-agent 前缀 call；此处只断言 gateway 幂等键唯一。
    const rows = await db
      .select()
      .from(agentCallTable)
      .where(
        and(
          eq(agentCallTable.tenantId, scenario.tenantId),
          eq(agentCallTable.parentInvocationId, scenario.parentInvocationId),
          eq(
            agentCallTable.logicalCallKey,
            `gateway:${scenario.parentInvocationId}:${scenario.agentId}`,
          ),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("GET 查询 + 跨 Invocation 隐藏式 404", async () => {
    const scenario = await seedScenario("completed");
    const result = await createAgentCallViaGateway({
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      body: { agent_id: scenario.agentId, input: "hi" },
      resolveRoute: mockResolveRoute(scenario),
    });
    const callId = result.payload.call_id as string;

    // 正确 token → 200 + 状态。
    const ok = await getCall(
      new Request(`http://localhost/gateway/v1/agent-calls/${callId}`, {
        headers: {
          authorization: `Bearer ${gatewayToken(scenario.tenantId, scenario.parentInvocationId)}`,
        },
      }),
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { call_id: string; state: string };
    expect(okBody.call_id).toBe(callId);

    // 错误 invocation token → 404（隐藏式，不暴露存在性）。
    const wrong = await getCall(
      new Request(`http://localhost/gateway/v1/agent-calls/${callId}`, {
        headers: { authorization: `Bearer ${gatewayToken(scenario.tenantId, randomUUID())}` },
      }),
    );
    expect(wrong.status).toBe(404);
  });

  it("resume：waiting_user → running，复用 SAME AgentCall（不新建顶层 Invocation）", async () => {
    const scenario = await seedScenario("input_required", RESUME_CAPABLE_CONTRACT);
    const result = await createAgentCallViaGateway({
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      body: { agent_id: scenario.agentId, input: "补充" },
      resolveRoute: mockResolveRoute(scenario),
    });
    const callId = result.payload.call_id as string;
    await waitForCallState(scenario.tenantId, callId, ["waiting_user"]);

    const res = await resumeCall(
      new Request(`http://localhost/gateway/v1/agent-calls/${callId}/resume`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gatewayToken(scenario.tenantId, scenario.parentInvocationId)}`,
        },
        body: JSON.stringify({ text: "我的补充信息" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { call_id: string; state: string };
    expect(body.call_id).toBe(callId);

    // 未新建顶层 Invocation（parentInvocationId 仍是原 parent）。
    const call = await loadCall(scenario.tenantId, callId);
    expect(call!.parentInvocationId).toBe(scenario.parentInvocationId);
  });

  it("cancel：running/waiting_user → cancelled（child fact；parent 由 Harness authority 收口）", async () => {
    const scenario = await seedScenario("input_required", RESUME_CAPABLE_CONTRACT);
    const result = await createAgentCallViaGateway({
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      body: { agent_id: scenario.agentId, input: "hi" },
      resolveRoute: mockResolveRoute(scenario),
    });
    const callId = result.payload.call_id as string;
    await waitForCallState(scenario.tenantId, callId, ["waiting_user"]);

    const res = await cancelCall(
      new Request(`http://localhost/gateway/v1/agent-calls/${callId}/cancel`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gatewayToken(scenario.tenantId, scenario.parentInvocationId)}`,
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe("cancelled");
  });

  it("跨租户：异租户 token 查询同 call → 404（隔离）", async () => {
    const scenario = await seedScenario("completed");
    const result = await createAgentCallViaGateway({
      tenantId: scenario.tenantId,
      parentInvocationId: scenario.parentInvocationId,
      body: { agent_id: scenario.agentId, input: "hi" },
      resolveRoute: mockResolveRoute(scenario),
    });
    const callId = result.payload.call_id as string;

    const other = await seedScenario("completed");
    const res = await getCall(
      new Request(`http://localhost/gateway/v1/agent-calls/${callId}`, {
        headers: {
          authorization: `Bearer ${gatewayToken(other.tenantId, other.parentInvocationId)}`,
        },
      }),
    );
    expect(res.status).toBe(404);
  });
});
