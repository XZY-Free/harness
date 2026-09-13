import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const openapi = JSON.parse(readFileSync("docs/contracts/openapi.json", "utf8"));
const events = JSON.parse(readFileSync("docs/contracts/event-catalog.json", "utf8"));
const errors = JSON.parse(readFileSync("docs/contracts/error-codes.json", "utf8"));

describe("Topic 01 AgentUse 机器合同", () => {
  it("Create Turn 精确约束 agent_use preferred wire", () => {
    const schema =
      openapi.paths["/api/v1/threads/{thread_id}/turns"].post.requestBody.content[
        "application/json"
      ].schema.properties.agent_use;
    expect(schema.anyOf).toContainEqual({ type: "null" });
    expect(schema.anyOf).toContainEqual({
      type: "object",
      properties: {
        mode: { type: "string", const: "preferred" },
        agent_id: { type: "string", minLength: 1 },
      },
      required: ["mode", "agent_id"],
      additionalProperties: false,
    });
  });

  it("Harness action Event 与 AgentCall 错误目录已发布", () => {
    for (const eventType of [
      "harness.action.proposed",
      "harness.action.started",
      "harness.action.completed",
      "harness.action.failed",
    ]) {
      expect(events.events).toHaveProperty(eventType);
    }
    for (const errorCode of [
      "AGENT_CALL_EXECUTOR_UNAVAILABLE",
      "AGENT_CALL_BINDING_INVALID",
      "AGENT_CALL_CREDENTIAL_UNAVAILABLE",
      "AGENT_CALL_FAILED",
      "AGENT_CALL_IDEMPOTENCY_CONFLICT",
      "AGENT_CALL_TRANSPORT_FAILED",
    ]) {
      expect(errors.errors).toHaveProperty(errorCode);
    }
  });
});
