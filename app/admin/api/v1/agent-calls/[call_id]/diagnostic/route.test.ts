import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAdminPrincipalAsync: vi.fn(),
  requireAdminActionScope: vi.fn(),
  loadHarnessExecutionTraceForAgentCall: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/admin/route-helpers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/admin/route-helpers")>();
  return {
    ...original,
    resolveAdminPrincipalAsync: mocks.resolveAdminPrincipalAsync,
    requireAdminActionScope: mocks.requireAdminActionScope,
  };
});
vi.mock("@/lib/observability/harness-execution-trace", () => ({
  loadHarnessExecutionTraceForAgentCall: mocks.loadHarnessExecutionTraceForAgentCall,
}));
vi.mock("@/lib/identity/audit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/identity/audit")>();
  return { ...original, recordAuditEvent: mocks.recordAuditEvent };
});

import { GET } from "./route";

const principal = { tenantId: "tenant-1", userIdentityId: "user-1" };
const trace = {
  trace_id: "req-trace-1",
  turn: { turn_id: "turn-1", agent_use: null },
  parent_invocation: { invocation_id: "inv-1", state: "completed" },
  harness_actions: [],
  agent_calls: [],
  capability_uses: [],
  tool_calls: [],
  final_response: { item_id: "item-final", state: "completed" },
};

function get(): Promise<Response> {
  return GET(new Request("http://localhost/admin/api/v1/agent-calls/call-1/diagnostic"), {
    params: Promise.resolve({ call_id: "call-1" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAdminPrincipalAsync.mockResolvedValue(principal);
  mocks.requireAdminActionScope.mockResolvedValue({ ok: true });
  mocks.loadHarnessExecutionTraceForAgentCall.mockResolvedValue(trace);
  mocks.recordAuditEvent.mockResolvedValue({ id: "audit-1" });
});

describe("GET /admin/api/v1/agent-calls/{call_id}/diagnostic", () => {
  it("只向 audit.read 管理员返回脱敏执行 Trace，并写 diagnostic.view AuditEvent", async () => {
    const response = await get();

    expect(mocks.requireAdminActionScope).toHaveBeenCalledWith(
      principal,
      "audit.read",
      { type: "tenant", id: "tenant-1" },
      expect.any(String),
    );
    expect(mocks.loadHarnessExecutionTraceForAgentCall).toHaveBeenCalledWith("tenant-1", "call-1");
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { tenantId: "tenant-1", actorType: "user", actorId: "user-1" },
        actionType: "diagnostic.view",
        targetType: "agent_call",
        targetId: "call-1",
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data ?? body).toEqual(trace);
    expect(JSON.stringify(body)).not.toMatch(
      /credential|hidden_prompt|chain_of_thought|result_text/i,
    );
  });

  it("AgentCall 不存在或跨租户时 404 且不写查看审计", async () => {
    mocks.loadHarnessExecutionTraceForAgentCall.mockResolvedValue(null);

    const response = await get();

    expect(response.status).toBe(404);
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
  });
});
