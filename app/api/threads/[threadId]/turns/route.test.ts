import { POST } from "@/app/api/threads/[threadId]/turns/route";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const acceptUserMessageTurn = vi.hoisted(() => vi.fn());
const dispatchEmployeeTurn = vi.hoisted(() => vi.fn());
const failUndispatchedTurn = vi.hoisted(() => vi.fn(async () => "TURN_DISPATCH_ERROR"));
const enforceIdempotency = vi.hoisted(() =>
  vi.fn(async () => ({ kind: "proceed", record: { id: "rec-1" } })),
);
const failRecord = vi.hoisted(() => vi.fn(async () => undefined));
const completeRecord = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/conversations/route-helpers", () => ({
  resolveEmployeePrincipal: async () => ({ tenantId: "t1", userIdentityId: "u1" }),
  conversationErrorToResponse: () => null,
  employeeAuthErrorResponse: () => null,
  schemaInvalidTable: () => new Response(null, { status: 400 }),
}));
vi.mock("@/lib/conversations/thread-queries", () => ({
  getThreadById: async () => ({ id: "th1", ownerUserId: "u1" }),
  getThreadsByThread: undefined,
}));
vi.mock("@/lib/conversations/turn-queries", () => ({
  acceptUserMessageTurn,
  getTurnsByThread: async () => [],
}));
vi.mock("@/lib/identity/idempotency", () => ({
  enforceIdempotency,
  failRecord,
  completeRecord,
  computeRequestHash: () => "hash",
  callerFromPrincipal: () => ({ type: "user", id: "u1" }),
  buildReplayResponse: () => new Response(null, { status: 409 }),
  buildIdempotencyErrorResponse: () => new Response(null, { status: 409 }),
  prepareRetryForFailedRecord: async () => ({ id: "rec-1" }),
}));
vi.mock("@/lib/identity/authorization", () => ({
  requireAgentInvokeScope: async () => ({ ok: true }),
}));
vi.mock("@/lib/agents/calls/application/agent-call-projection", () => ({
  loadTurnAgentActivity: async () => new Map(),
  emptyTurnAgentActivity: () => ({ agent_use: null, actual_agent_calls: [] }),
}));
vi.mock("@/lib/runtime/employee-turn-dispatcher", () => ({
  dispatchEmployeeTurn,
  failUndispatchedTurn,
}));

function turnRequest(): NextRequest {
  return new NextRequest("https://snow.example.com/api/threads/th1/turns", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "key-1",
    },
    body: JSON.stringify({ input: { type: "message", text: "你好" } }),
  });
}

const acceptedResult = {
  turn: {
    id: "turn1",
    threadId: "th1",
    turnState: "accepted",
    turnSequence: 1,
    triggerType: "user_message",
    errorCode: null,
  },
  item: { id: "i1", itemType: "user_message", itemSequence: 1, itemState: "final" },
  events: [],
  thread: { lastEventSequence: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  acceptUserMessageTurn.mockResolvedValue(acceptedResult);
});

describe("POST /api/threads/{id}/turns 原子性", () => {
  it("调度抛错时把已接纳 Turn 兜底收口为 failed", async () => {
    dispatchEmployeeTurn.mockRejectedValue(new Error("context handle secret 缺失"));

    await expect(
      POST(turnRequest(), { params: Promise.resolve({ threadId: "th1" }) }),
    ).rejects.toThrow("context handle secret 缺失");

    expect(failUndispatchedTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "turn1", reason: "dispatch_error" }),
    );
    expect(failRecord).toHaveBeenCalledWith("rec-1");
  });

  it("调度成功时不做兜底收口", async () => {
    dispatchEmployeeTurn.mockResolvedValue({ dispatched: true, turnState: "running" });

    const response = await POST(turnRequest(), {
      params: Promise.resolve({ threadId: "th1" }),
    });

    expect(response.status).toBe(201);
    expect(failUndispatchedTurn).not.toHaveBeenCalled();
    expect(completeRecord).toHaveBeenCalled();
  });
});
