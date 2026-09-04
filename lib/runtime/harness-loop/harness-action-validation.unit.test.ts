import { describe, expect, it } from "vitest";
import {
  CapabilityActionValidationError,
  buildCapabilityCatalogSnapshot,
  validateHarnessActionAgainstCatalog,
} from "./capability-catalog";

const built = buildCapabilityCatalogSnapshot({
  invocationId: "inv-validate",
  preferredAgentId: "agent-hr",
  agentCandidate: {
    agentId: "agent-hr",
    agentRevisionId: "agent-rev-1",
    routeRevisionId: "route-rev-1",
    contractSnapshotId: "contract-1",
    contractDigest: `sha256:${"2".repeat(64)}`,
    publicationRecordId: "publication-1",
    displayName: "HR Agent",
    description: "员工数据查询",
    applicableScenarios: ["查询个人年假"],
    excludedScenarios: ["普通寒暄"],
    contractSummary: "只读查询",
    contextRequirements: ["employee_identity:required"],
  },
  tools: [
    {
      toolId: "tool-mail",
      operationId: "send-email",
      schemaRevisionId: "schema-1",
      schemaHash: `sha256:${"1".repeat(64)}`,
      displayName: "发送邮件",
      description: "发送邮件",
      inputSchema: {
        type: "object",
        required: ["recipient"],
        properties: { recipient: { type: "string", minLength: 3 } },
        additionalProperties: false,
      },
      sideEffect: "write",
      confirmation: "required",
      idempotent: true,
    },
  ],
  knowledgeSources: [
    {
      sourceRef: "knowledge-base:policy",
      knowledgeBaseId: "kb-policy",
      displayName: "制度库",
      description: "员工制度",
    },
  ],
  sourceRefs: [],
  now: new Date("2026-09-04T04:20:00.000Z"),
});

describe("Harness frozen capability authorization", () => {
  it("拒绝目录外 Agent", () => {
    expect(() =>
      validateHarnessActionAgainstCatalog(
        {
          actionId: "a1",
          stepNo: 1,
          actionType: "agent.call",
          purposeCode: "lookup",
          shortPurpose: "查询",
          payload: { agentId: "agent-other", task: "查询年假" },
        },
        built.snapshot,
      ),
    ).toThrowError(expect.objectContaining({ code: "AGENT_ACTION_NOT_ALLOWED" }));
  });

  it("拒绝目录外 Tool Operation", () => {
    expect(() =>
      validateHarnessActionAgainstCatalog(
        {
          actionId: "a2",
          stepNo: 1,
          actionType: "tool.call",
          purposeCode: "send",
          shortPurpose: "发送",
          payload: { toolId: "tool-mail", operationId: "delete-mail", arguments: {} },
        },
        built.snapshot,
      ),
    ).toThrow(CapabilityActionValidationError);
  });

  it("按冻结 JSON Schema 拒绝非法 Tool 输入", () => {
    expect(() =>
      validateHarnessActionAgainstCatalog(
        {
          actionId: "a3",
          stepNo: 1,
          actionType: "tool.call",
          purposeCode: "send",
          shortPurpose: "发送",
          payload: {
            toolId: "tool-mail",
            operationId: "send-email",
            arguments: { recipient: 42 },
          },
        },
        built.snapshot,
      ),
    ).toThrowError(expect.objectContaining({ code: "TOOL_ARGUMENTS_INVALID" }));
  });

  it("返回需要确认的冻结 Tool 条目，执行层不得直接执行", () => {
    const result = validateHarnessActionAgainstCatalog(
      {
        actionId: "a4",
        stepNo: 1,
        actionType: "tool.call",
        purposeCode: "send",
        shortPurpose: "发送",
        payload: {
          toolId: "tool-mail",
          operationId: "send-email",
          arguments: { recipient: "employee@example.com" },
        },
      },
      built.snapshot,
    );
    expect(result.tool?.confirmation).toBe("required");
  });

  it("拒绝目录外 Knowledge source ref", () => {
    expect(() =>
      validateHarnessActionAgainstCatalog(
        {
          actionId: "a5",
          stepNo: 1,
          actionType: "knowledge.search",
          purposeCode: "policy",
          shortPurpose: "查制度",
          payload: { query: "年假", preferredSourceRefs: ["knowledge-base:secret"] },
        },
        built.snapshot,
      ),
    ).toThrowError(expect.objectContaining({ code: "ACTION_SCOPE_DENIED" }));
  });
});
