import { describe, expect, it } from "vitest";
import {
  CapabilityCatalogIntegrityError,
  buildCapabilityCatalogSnapshot,
  capabilityCatalogModelView,
  verifyCapabilityCatalogSnapshot,
} from "./capability-catalog";

const now = new Date("2026-09-04T04:20:00.000Z");

function tool(overrides: Record<string, unknown> = {}) {
  return {
    toolId: "tool-mail",
    operationId: "send-email",
    schemaRevisionId: "schema-mail-3",
    schemaHash: `sha256:${"a".repeat(64)}`,
    executionContractDigest: `sha256:${"b".repeat(64)}`,
    displayName: "发送邮件",
    description: "向指定收件人发送邮件",
    inputSchema: {
      type: "object",
      required: ["recipient", "subject"],
      properties: {
        recipient: { type: "string" },
        subject: { type: "string" },
      },
      additionalProperties: false,
    },
    sideEffect: "write" as const,
    idempotent: true,
    ...overrides,
  };
}

describe("Invocation capability catalog", () => {
  it("只冻结 preferred Agent，并向模型提供用途、适用边界、合同与上下文", () => {
    const catalog = buildCapabilityCatalogSnapshot({
      invocationId: "inv-1",
      preferredAgentId: "agent-hr",
      agentCandidate: {
        agentId: "agent-hr",
        agentRevisionId: "agent-rev-7",
        routeRevisionId: "route-rev-2",
        contractSnapshotId: "contract-4",
        contractDigest: `sha256:${"4".repeat(64)}`,
        publicationRecordId: "publication-4",
        displayName: "HR Agent",
        description: "查询员工个人人事数据",
        scenarioDeclaration: "declared",
        applicableScenarios: ["查询个人年假余额"],
        excludedScenarios: ["普通寒暄", "公司制度解释"],
        contractSummary: "返回余额、已用和待审批天数",
        contextRequirements: ["employee_identity:required"],
      },
      tools: [],
      knowledgeSources: [],
      sourceRefs: ["turn:turn-1", "runtime-revision:runtime-1"],
      now,
    });

    expect(catalog.snapshot.agents).toEqual([
      expect.objectContaining({
        agentId: "agent-hr",
        agentRevisionId: "agent-rev-7",
        applicableScenarios: ["查询个人年假余额"],
        excludedScenarios: ["普通寒暄", "公司制度解释"],
        contractSummary: "返回余额、已用和待审批天数",
        contextRequirements: ["employee_identity:required"],
      }),
    ]);
    expect(capabilityCatalogModelView(catalog.snapshot).agents[0]).toMatchObject({
      displayName: "HR Agent",
      excludedScenarios: ["普通寒暄", "公司制度解释"],
    });
  });

  it("没有 preferred Agent 时目录为空，不自动补默认 Agent", () => {
    const catalog = buildCapabilityCatalogSnapshot({
      invocationId: "inv-2",
      preferredAgentId: null,
      agentCandidate: {
        agentId: "agent-other",
        agentRevisionId: "rev-other",
        routeRevisionId: "route-other",
        contractSnapshotId: "contract-other",
        contractDigest: `sha256:${"5".repeat(64)}`,
        publicationRecordId: "publication-other",
        displayName: "Other",
        description: "不应出现",
        scenarioDeclaration: "unspecified",
        applicableScenarios: [],
        excludedScenarios: [],
        contractSummary: "不应出现",
        contextRequirements: [],
      },
      tools: [],
      knowledgeSources: [],
      sourceRefs: [],
      now,
    });
    expect(catalog.snapshot.agents).toEqual([]);
  });

  it("只保留已授权 Tool/Knowledge 安全字段，模型视图不泄漏管理和 Secret 字段", () => {
    const catalog = buildCapabilityCatalogSnapshot({
      invocationId: "inv-3",
      preferredAgentId: null,
      agentCandidate: null,
      tools: [tool()],
      knowledgeSources: [
        {
          sourceRef: "knowledge-base:policy",
          knowledgeBaseId: "kb-policy",
          displayName: "员工制度",
          description: "公开的人事制度与流程",
        },
      ],
      sourceRefs: ["policy-revision:policy-8"],
      now,
    });
    const text = JSON.stringify(capabilityCatalogModelView(catalog.snapshot));
    expect(text).toContain("send-email");
    expect(text).toContain("员工制度");
    expect(text).not.toMatch(/credential|endpoint|secret|vault/i);
  });

  it("摘要由规范化快照生成，配置后续变化不改写旧快照", () => {
    const built = buildCapabilityCatalogSnapshot({
      invocationId: "inv-4",
      preferredAgentId: null,
      agentCandidate: null,
      tools: [tool()],
      knowledgeSources: [],
      sourceRefs: ["tool-schema:schema-mail-3"],
      now,
    });
    const original = structuredClone(built.snapshot);
    const mutableSource = tool({ description: "后来修改的描述" });
    expect(mutableSource.description).not.toBe(original.tools[0]?.description);
    expect(verifyCapabilityCatalogSnapshot(original, built.digest)).toEqual(original);
  });

  it("快照被篡改或摘要不一致时 fail closed", () => {
    const built = buildCapabilityCatalogSnapshot({
      invocationId: "inv-5",
      preferredAgentId: null,
      agentCandidate: null,
      tools: [tool()],
      knowledgeSources: [],
      sourceRefs: [],
      now,
    });
    const tampered = structuredClone(built.snapshot);
    tampered.tools[0]!.description = "被篡改";
    expect(() => verifyCapabilityCatalogSnapshot(tampered, built.digest)).toThrow(
      CapabilityCatalogIntegrityError,
    );
  });
});
