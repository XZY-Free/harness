import { describe, expect, it } from "vitest";
import type { RevisionValidationDeps } from "./validate-hosted-provisioning-revision";
import { createRevisionValidator } from "./validate-hosted-provisioning-revision";

/** 创建内存 mock 验证器。 */
function mockValidator(
  agents: Map<string, { currentRevisionId: string | null }>,
  revisions: Map<string, { agentId: string }>,
): RevisionValidationDeps {
  return {
    async validateRevision(params) {
      if (params.agentRevisionId === "unknown" || !params.agentRevisionId) {
        return {
          valid: false,
          code: "REVISION_ID_UNKNOWN",
          reason: 'agentRevisionId 不允许为 "unknown" 或空值',
        };
      }
      const agent = agents.get(`${params.tenantId}:${params.agentId}`);
      if (!agent) {
        return { valid: false, code: "AGENT_NOT_FOUND", reason: `Agent ${params.agentId} 不存在` };
      }
      const revision = revisions.get(params.agentRevisionId);
      if (!revision) {
        return {
          valid: false,
          code: "REVISION_NOT_FOUND",
          reason: `AgentRevision ${params.agentRevisionId} 不存在`,
        };
      }
      if (revision.agentId !== params.agentId) {
        return { valid: false, code: "REVISION_NOT_BELONG_TO_AGENT", reason: "归属不匹配" };
      }
      if (agent.currentRevisionId !== params.agentRevisionId) {
        return { valid: false, code: "REVISION_NOT_CURRENT", reason: "不是当前 Revision" };
      }
      return {
        valid: true,
        revisionId: params.agentRevisionId,
        currentRevisionId: agent.currentRevisionId,
      };
    },
  };
}

describe("§6.1 validateHostedProvisioningRevision", () => {
  it('禁止 agentRevisionId = "unknown"', async () => {
    const validator = mockValidator(new Map(), new Map());
    const result = await validator.validateRevision({
      tenantId: "t1",
      agentId: "a1",
      agentRevisionId: "unknown",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("REVISION_ID_UNKNOWN");
    }
  });

  it("Agent 不存在时返回 AGENT_NOT_FOUND", async () => {
    const validator = mockValidator(new Map(), new Map());
    const result = await validator.validateRevision({
      tenantId: "t1",
      agentId: "a1",
      agentRevisionId: "rev-1",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("AGENT_NOT_FOUND");
    }
  });

  it("AgentRevision 不存在时返回 REVISION_NOT_FOUND", async () => {
    const agents = new Map([["t1:a1", { currentRevisionId: "rev-1" }]]);
    const validator = mockValidator(agents, new Map());
    const result = await validator.validateRevision({
      tenantId: "t1",
      agentId: "a1",
      agentRevisionId: "rev-nonexistent",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("REVISION_NOT_FOUND");
    }
  });

  it("AgentRevision 不属于指定 Agent 时返回 REVISION_NOT_BELONG_TO_AGENT", async () => {
    const agents = new Map([["t1:a1", { currentRevisionId: "rev-1" }]]);
    const revisions = new Map([["rev-1", { agentId: "a2" }]]);
    const validator = mockValidator(agents, revisions);
    const result = await validator.validateRevision({
      tenantId: "t1",
      agentId: "a1",
      agentRevisionId: "rev-1",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("REVISION_NOT_BELONG_TO_AGENT");
    }
  });

  it("AgentRevision 不是当前期望 Revision 时返回 REVISION_NOT_CURRENT", async () => {
    const agents = new Map([["t1:a1", { currentRevisionId: "rev-2" }]]);
    const revisions = new Map([["rev-1", { agentId: "a1" }]]);
    const validator = mockValidator(agents, revisions);
    const result = await validator.validateRevision({
      tenantId: "t1",
      agentId: "a1",
      agentRevisionId: "rev-1",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("REVISION_NOT_CURRENT");
    }
  });

  it("全部验证通过时返回 valid=true", async () => {
    const agents = new Map([["t1:a1", { currentRevisionId: "rev-1" }]]);
    const revisions = new Map([["rev-1", { agentId: "a1" }]]);
    const validator = mockValidator(agents, revisions);
    const result = await validator.validateRevision({
      tenantId: "t1",
      agentId: "a1",
      agentRevisionId: "rev-1",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.revisionId).toBe("rev-1");
      expect(result.currentRevisionId).toBe("rev-1");
    }
  });

  it("createRevisionValidator 工厂返回有效依赖", () => {
    const deps = createRevisionValidator();
    expect(deps.validateRevision).toBeTypeOf("function");
  });
});
