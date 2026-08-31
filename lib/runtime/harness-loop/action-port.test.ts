import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpHarnessActionPort } from "./action-port";

const action = {
  actionId: "action-agent-1",
  stepNo: 1,
  actionType: "agent.call" as const,
  purposeCode: "query_balance",
  shortPurpose: "查询余额",
  payload: { agentId: "agent-1", task: "查询当前员工年假余额" },
};

const context = {
  invocationId: "invocation-1",
  tenantId: "tenant-1",
  threadId: "thread-1",
  turnId: "turn-1",
  actionDigest: `sha256:${"a".repeat(64)}`,
  producerSequenceStart: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpHarnessActionPort", () => {
  it("保留 Gateway durable pending disposition", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          state: "started",
          disposition: "pending",
          pending: { kind: "agent_call", callId: "call-1", state: "running" },
          authority_ref: "agent-call:call-1",
          next_producer_sequence: 3,
        }),
      ),
    );
    const port = createHttpHarnessActionPort({
      endpoint: "https://gateway.example.test/capability-actions",
      gatewayAccessToken: "test-token",
    });

    await expect(port.execute(action, context)).resolves.toEqual({
      pending: { kind: "agent_call", callId: "call-1", state: "running" },
      authorityRef: "agent-call:call-1",
      nextProducerSequence: 3,
    });
  });

  it("把 Gateway 稳定错误码保留到 Error.code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "AGENT_ROUTE_UNAVAILABLE", message: "无可用 Agent Route" } },
          { status: 503 },
        ),
      ),
    );
    const port = createHttpHarnessActionPort({
      endpoint: "https://gateway.example.test/capability-actions",
      gatewayAccessToken: "test-token",
    });

    await expect(port.execute(action, context)).rejects.toMatchObject({
      code: "AGENT_ROUTE_UNAVAILABLE",
      message: "无可用 Agent Route",
    });
  });
});
