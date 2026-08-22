/**
 * 02-6 P6 Formal Policy Evaluator 单测（纯函数 · 冻结方案 §15 / §16 / §18 / §55.5）。
 *
 * 覆盖：toolPattern 匹配（* / 完整 key / prefix.*）/ argMatcher（pathRegex/commandRegex/risk）/
 * scope（tenant/thread/project/skill）/ priority 排序 / 同优先级 block>pause>allow /
 * defaultDecision / Agent 风险收紧（toolRiskMax，只能收紧）/ block 永不降级 /
 * Grant 只满足 pause→allow、不降级 block / 平台强制规则 fail-closed / argMatcher 缺失字段 fail-closed。
 */
import { describe, expect, it } from "vitest";
import {
  type AgentPermissionRequirements,
  type PolicyEvaluatorInput,
  type PolicyRuleView,
  evaluatePolicy,
  matchPolicyPattern,
  sortPolicyRules,
  tighterDecision,
} from "./policy-evaluator";

type Decision = "allow" | "pause" | "block";

function view(patch: Partial<PolicyRuleView>): PolicyRuleView {
  return {
    ruleKey: "r1",
    toolPattern: "*",
    argMatcher: null,
    decision: "allow",
    scope: null,
    priority: 0,
    ...patch,
  };
}

function input(patch: Partial<PolicyEvaluatorInput>): PolicyEvaluatorInput {
  return {
    toolKey: "tool.writeFile",
    arguments: { path: "/tmp/foo.txt" },
    toolRiskClass: "low",
    scopeContext: { threadId: "thread-1", projectId: "proj-1", skillId: "skill-1" },
    defaultDecision: "pause",
    rules: [],
    agentRequirements: null,
    grantScopes: [],
    ...patch,
  };
}

describe("toolPattern 匹配（§6.4）", () => {
  it("* 匹配全部", () => {
    expect(matchPolicyPattern("*", "tool.writeFile")).toBe(true);
    expect(matchPolicyPattern("*", "anything")).toBe(true);
  });
  it("完整 key 精确匹配", () => {
    expect(matchPolicyPattern("tool.writeFile", "tool.writeFile")).toBe(true);
    expect(matchPolicyPattern("tool.writeFile", "tool.readFile")).toBe(false);
  });
  it("prefix.* 匹配一层以上", () => {
    expect(matchPolicyPattern("tool.*", "tool.writeFile")).toBe(true);
    expect(matchPolicyPattern("tool.*", "tool.a.b")).toBe(true);
    expect(matchPolicyPattern("tool.*", "mcp.writeFile")).toBe(false);
  });
  it("裸名规范化补 tool. 前缀", () => {
    expect(matchPolicyPattern("writeFile", "tool.writeFile")).toBe(true);
  });
});

describe("evaluatePolicy · PolicyRevision 规则（§15.2）", () => {
  it("首个命中规则（priority 最高；同优先级 block>pause>allow）", () => {
    const res = evaluatePolicy(
      input({
        rules: [
          view({ ruleKey: "lo", decision: "allow", priority: 0 }),
          view({ ruleKey: "hi", decision: "block", priority: 100 }),
        ],
      }),
    );
    expect(res.decision).toBe("block");
    expect(res.matchedRule?.ruleKey).toBe("hi");
    expect(res.reasonCodes).toContain("policy.block");
  });

  it("同优先级 block>pause>allow", () => {
    const res = evaluatePolicy(
      input({
        rules: [
          view({ ruleKey: "a", decision: "allow", priority: 0 }),
          view({ ruleKey: "b", decision: "pause", priority: 0 }),
          view({ ruleKey: "c", decision: "block", priority: 0 }),
        ],
      }),
    );
    expect(res.decision).toBe("block");
    expect(res.matchedRule?.ruleKey).toBe("c");
  });

  it("argMatcher.pathRegex 命中", () => {
    const hit = evaluatePolicy(
      input({
        arguments: { path: "/.env" },
        rules: [view({ ruleKey: "p", decision: "block", argMatcher: { pathRegex: "^\\.env$" } })],
      }),
    );
    // 归一化后 path "/.env" → ".env"；匹配 ^\.env$
    expect(hit.decision).toBe("block");
  });

  it("argMatcher 缺失约束字段 → fail-closed 不匹配（走 defaultDecision）", () => {
    const res = evaluatePolicy(
      input({
        // 规则约束 commandRegex，但 input 无 command 字段 → 不匹配
        rules: [view({ ruleKey: "c", decision: "block", argMatcher: { commandRegex: "rm" } })],
      }),
    );
    expect(res.decision).toBe("pause"); // 默认
    expect(res.matchedRule).toBeNull();
  });

  it("无规则命中 → defaultDecision", () => {
    const res = evaluatePolicy(input({ defaultDecision: "pause", rules: [] }));
    expect(res.decision).toBe("pause");
    expect(res.reasonCodes).toContain("policy.default_pause");
  });

  it("scope：thread 不匹配 → 规则不适用", () => {
    const res = evaluatePolicy(
      input({
        scopeContext: { threadId: "other-thread" },
        rules: [
          view({ ruleKey: "t", decision: "block", scope: { type: "thread", ref: "thread-1" } }),
        ],
      }),
    );
    expect(res.decision).toBe("pause"); // 走默认
  });
});

describe("evaluatePolicy · Agent 收紧 + Grant + 平台强制（§15.2）", () => {
  it("Agent toolRiskMax 收紧：工具风险超上限 → pause", () => {
    const agent: AgentPermissionRequirements = { toolRiskMax: "low" };
    const res = evaluatePolicy(input({ toolRiskClass: "high", agentRequirements: agent }));
    expect(res.decision).toBe("pause");
    expect(res.agentGated).toBe(true);
    expect(res.reasonCodes).toContain("agent.risk_gate");
  });

  it("Agent 只收紧：policy=allow + agent=allow 保持 allow", () => {
    const res = evaluatePolicy(
      input({
        rules: [view({ decision: "allow" })],
        agentRequirements: { toolRiskMax: "low" },
        toolRiskClass: "low",
      }),
    );
    expect(res.decision).toBe("allow");
  });

  it("Agent 不能把 block 降级", () => {
    const res = evaluatePolicy(
      input({
        rules: [view({ decision: "block" })],
        agentRequirements: { toolRiskMax: "low" },
        toolRiskClass: "low",
      }),
    );
    expect(res.decision).toBe("block");
  });

  it("Grant 满足 pause→allow（允许缺口）", () => {
    const res = evaluatePolicy(
      input({
        defaultDecision: "pause",
        rules: [],
        grantScopes: ["tool:tool.writeFile"],
      }),
    );
    expect(res.decision).toBe("allow");
    expect(res.grantSatisfied).toBe(true);
  });

  it("Grant 不降级 block", () => {
    const res = evaluatePolicy(
      input({
        rules: [view({ decision: "block" })],
        grantScopes: ["tool:execute"],
      }),
    );
    expect(res.decision).toBe("block");
  });

  it("平台强制规则命中 → fail-closed block", () => {
    const res = evaluatePolicy(
      input({
        rules: [view({ decision: "allow" })],
        platformRules: [view({ ruleKey: "platform", decision: "block", priority: 999 })],
      }),
    );
    expect(res.decision).toBe("block");
    expect(res.matchedRule?.ruleKey).toBe("platform");
  });
});

describe("sortPolicyRules / tighterDecision", () => {
  it("排序：priority DESC → decision(block>pause>allow) → toolPattern ASC → ruleKey ASC", () => {
    const sorted = sortPolicyRules([
      view({ ruleKey: "z", decision: "allow", priority: 10, toolPattern: "b" }),
      view({ ruleKey: "a", decision: "block", priority: 0 }),
      view({ ruleKey: "m", decision: "pause", priority: 10, toolPattern: "a" }),
      view({ ruleKey: "n", decision: "allow", priority: 10, toolPattern: "a" }),
    ]);
    expect(sorted.map((r) => r.ruleKey)).toEqual(["m", "n", "z", "a"]);
  });

  it("tighterDecision 返回更严格者", () => {
    expect(tighterDecision("allow", "pause")).toBe("pause");
    expect(tighterDecision("pause", "block")).toBe("block");
    expect(tighterDecision("block", "allow")).toBe("block");
  });
});
