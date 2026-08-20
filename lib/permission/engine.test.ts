import type { ToolApprovalRequest } from "@/lib/db/schema";
import { defaultPolicyConfig, resetPolicyConfig, setPolicyConfig } from "@/lib/policy/config";
import { beforeTool, decideCommand, decideWrite } from "@/lib/policy/hooks";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePermission, matchToolPattern } from "./engine";
import { buildDefaultRules } from "./rules";

/**
 * V3.1 Stage A：权限引擎纯函数测试。
 *
 * 覆盖三态判定、规则优先级、scope 升级、deny 与现有 decideWrite/decideCommand 等价（零回归）。
 */

afterEach(() => resetPolicyConfig());

function approval(over: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest {
  return {
    id: "apr-1",
    threadId: "tid",
    toolRunId: "tr-1",
    toolName: "deleteFile",
    permissionKey: "tool.deleteFile",
    argFingerprint: "path:secret.txt",
    argSummary: "path=secret.txt",
    projectId: null,
    status: "approved",
    approvedScope: "thread",
    resolvedBy: "u-1",
    resolvedAt: new Date(),
    createdAt: new Date(),
    expiresAt: null,
    ...over,
  };
}

describe("matchToolPattern", () => {
  it("'*' 匹配全部；'tool.*' 匹配任意 tool.X；精确匹配", () => {
    expect(matchToolPattern("*", "tool.writeFile")).toBe(true);
    expect(matchToolPattern("tool.*", "tool.deleteFile")).toBe(true);
    expect(matchToolPattern("tool.*", "tool")).toBe(false);
    expect(matchToolPattern("tool.writeFile", "tool.writeFile")).toBe(true);
    expect(matchToolPattern("tool.writeFile", "tool.readFile")).toBe(false);
    expect(matchToolPattern("writeFile", "tool.writeFile")).toBe(true);
  });

  // ─── V3.4 Stage A：多前缀（mcp./web./docs./custom.）零回归 ───
  it("V3.4 多前缀：mcp.*/web.*/docs.*/custom.* 各自匹配，不串扰 tool.*", () => {
    // mcp.* 匹配任意 mcp.X，不匹配 tool./web.
    expect(matchToolPattern("mcp.*", "mcp.github.create_issue")).toBe(true);
    expect(matchToolPattern("mcp.*", "mcp.filesystem.read")).toBe(true);
    expect(matchToolPattern("mcp.*", "tool.writeFile")).toBe(false);
    expect(matchToolPattern("mcp.*", "web.fetch")).toBe(false);
    expect(matchToolPattern("mcp.*", "mcp")).toBe(false); // 裸前缀无下级不算匹配

    // mcp.github.* 匹配 mcp.github.<tool>，不匹配 mcp.other.<tool>
    expect(matchToolPattern("mcp.github.*", "mcp.github.create_issue")).toBe(true);
    expect(matchToolPattern("mcp.github.*", "mcp.other.create_issue")).toBe(false);
    expect(matchToolPattern("mcp.github.*", "mcpgithub.x")).toBe(false);

    // 精确 mcp.<server>.<tool>
    expect(matchToolPattern("mcp.github.create_issue", "mcp.github.create_issue")).toBe(true);
    expect(matchToolPattern("mcp.github.create_issue", "mcp.github.list_issues")).toBe(false);

    // web.* / docs.* / custom.*
    expect(matchToolPattern("web.*", "web.fetch")).toBe(true);
    expect(matchToolPattern("web.*", "web.search")).toBe(true);
    expect(matchToolPattern("web.*", "tool.writeFile")).toBe(false);
    expect(matchToolPattern("web.fetch", "web.fetch")).toBe(true);
    expect(matchToolPattern("docs.*", "docs.search")).toBe(true);
    expect(matchToolPattern("custom.*", "custom.deploy")).toBe(true);
    expect(matchToolPattern("custom.deploy", "custom.deploy")).toBe(true);
    expect(matchToolPattern("custom.deploy", "custom.build")).toBe(false);
  });

  it("V3.4 零回归：既有 tool.* / tool.writeFile / 裸名 行为逐字不变", () => {
    // 对照 V3.1 既有断言逐字复述
    expect(matchToolPattern("*", "tool.writeFile")).toBe(true);
    expect(matchToolPattern("tool.*", "tool.deleteFile")).toBe(true);
    expect(matchToolPattern("tool.*", "tool")).toBe(false);
    expect(matchToolPattern("tool.writeFile", "tool.writeFile")).toBe(true);
    expect(matchToolPattern("tool.writeFile", "tool.readFile")).toBe(false);
    expect(matchToolPattern("writeFile", "tool.writeFile")).toBe(true);
    // tool.* 不应误匹配 mcp./web./custom.（多前缀隔离）
    expect(matchToolPattern("tool.*", "mcp.github.create_issue")).toBe(false);
    expect(matchToolPattern("tool.*", "web.fetch")).toBe(false);
    expect(matchToolPattern("tool.*", "custom.deploy")).toBe(false);
  });

  it("V3.4 修复：mcp.github.* 不再被错规范化为 tool.mcp.github.*（DB 规则可命中）", () => {
    // 旧实现会把 mcp.github.* → tool.mcp.github.* → 与 mcp.* key 永不匹配
    expect(matchToolPattern("mcp.github.*", "mcp.github.create_issue")).toBe(true);
    expect(matchToolPattern("mcp.*", "mcp.github.create_issue")).toBe(true);
  });
});

describe("deny 零回归：与 decideWrite/decideCommand 等价", () => {
  it("writeFile 受保护路径：engine deny === decideWrite deny（含 ./ 前缀、子路径变体）", () => {
    for (const path of [".git", ".git/config", "./.git/refs/heads/main"]) {
      const engine = evaluatePermission({
        toolName: "writeFile",
        input: { path, content: "" },
        threadId: "tid",
      });
      const legacy = decideWrite(path);
      expect(engine.decision).toBe(legacy.allow ? "allow" : "deny");
      expect(engine.decision).toBe("deny");
    }
  });

  it("writeFile 正常路径：engine allow === decideWrite allow（不回归）", () => {
    for (const path of ["index.html", "src/main.js", "package.json", "./dist/bundle.js"]) {
      const engine = evaluatePermission({
        toolName: "writeFile",
        input: { path, content: "" },
        threadId: "tid",
      });
      const legacy = decideWrite(path);
      expect(engine.decision).toBe(legacy.allow ? "allow" : "deny");
      expect(engine.decision).toBe("allow");
    }
  });

  it("runCommand 高危命令：engine deny === decideCommand deny", () => {
    for (const cmd of ["rm -rf /", "rm -rf ~", ":(){ :|:& };:", "mkfs.ext4 /dev/sda1"]) {
      const engine = evaluatePermission({
        toolName: "runCommand",
        input: { command: cmd },
        threadId: "tid",
      });
      const legacy = decideCommand(cmd);
      expect(engine.decision).toBe(legacy.allow ? "allow" : "deny");
      expect(engine.decision).toBe("deny");
    }
  });

  it("runCommand 正常命令：engine allow === decideCommand allow（不回归）", () => {
    for (const cmd of ["npm install", "npx vite build", "rm -rf node_modules", "echo hi"]) {
      const engine = evaluatePermission({
        toolName: "runCommand",
        input: { command: cmd },
        threadId: "tid",
      });
      const legacy = decideCommand(cmd);
      expect(engine.decision).toBe(legacy.allow ? "allow" : "deny");
      expect(engine.decision).toBe("allow");
    }
  });

  it("engine deny 与 beforeTool 分发结果一致（writeFile/runCommand）", () => {
    const cases = [
      { toolName: "writeFile", input: { path: ".git/x", content: "" } },
      { toolName: "writeFile", input: { path: "ok.js", content: "" } },
      { toolName: "runCommand", input: { command: "rm -rf /" } },
      { toolName: "runCommand", input: { command: "npm test" } },
    ] as const;
    for (const c of cases) {
      const engine = evaluatePermission({ ...c, threadId: "tid" });
      const legacy = beforeTool(c.toolName, c.input);
      expect(engine.decision).toBe(legacy.allow ? "allow" : "deny");
    }
  });

  it("自定义 protectedPaths 生效（setPolicyConfig 后 engine deny）", () => {
    setPolicyConfig({ ...defaultPolicyConfig, protectedPaths: [/^secrets\//] });
    const engine = evaluatePermission({
      toolName: "writeFile",
      input: { path: "secrets/key.pem", content: "" },
      threadId: "tid",
    });
    expect(engine.decision).toBe("deny");
    expect(engine.reason).toContain("secrets");
  });
});

describe("ask 默认规则（deleteFile/applyPatch/multiEditFile）", () => {
  it("deleteFile 默认 ask，无批准 → ask", () => {
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
    });
    expect(v.decision).toBe("ask");
    expect(v.matchedRuleId).toContain("deleteFile");
  });

  it("applyPatch 默认 ask", () => {
    const v = evaluatePermission({
      toolName: "applyPatch",
      input: { patch: "--- a\n+++ b\n" },
      threadId: "tid",
    });
    expect(v.decision).toBe("ask");
  });

  it("multiEditFile 默认 ask", () => {
    const v = evaluatePermission({
      toolName: "multiEditFile",
      input: { path: "a.js", edits: [] },
      threadId: "tid",
    });
    expect(v.decision).toBe("ask");
  });

  it("writeFile 非 protectedPaths 路径 → allow（不误伤代码生成主链路）", () => {
    const v = evaluatePermission({
      toolName: "writeFile",
      input: { path: "src/app.ts", content: "x" },
      threadId: "tid",
    });
    expect(v.decision).toBe("allow");
  });
});

describe("ask + 既有批准 → 升级 allow", () => {
  it("同 threadId + thread scope + 匹配 fingerprint → allow（带 existingApprovalId）", () => {
    const a = approval({ approvedScope: "thread", threadId: "tid" });
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
      existingApprovals: [a],
    });
    expect(v.decision).toBe("allow");
    expect(v.existingApprovalId).toBe("apr-1");
  });

  it("thread scope 但不同 threadId → 仍 ask（不跨 thread 复用）", () => {
    const a = approval({ approvedScope: "thread", threadId: "other-thread" });
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
      existingApprovals: [a],
    });
    expect(v.decision).toBe("ask");
    expect(v.existingApprovalId).toBeUndefined();
  });

  it("always scope 跨 thread 复用 → allow", () => {
    const a = approval({ approvedScope: "always", threadId: "other-thread" });
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
      existingApprovals: [a],
    });
    expect(v.decision).toBe("allow");
  });

  it("once scope 不跨 thread 复用", () => {
    const a = approval({ approvedScope: "once", threadId: "other-thread" });
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
      existingApprovals: [a],
    });
    expect(v.decision).toBe("ask");
    expect(v.existingApprovalId).toBeUndefined();
  });

  it("once scope 同 thread 升级 allow，并返回 scope 供调用方消费", () => {
    const a = approval({ approvedScope: "once", threadId: "tid" });
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
      existingApprovals: [a],
    });
    expect(v.decision).toBe("allow");
    expect(v.existingApprovalId).toBe("apr-1");
    expect(v.existingApprovalScope).toBe("once");
  });

  it("fingerprint 不匹配（不同 path）→ 仍 ask", () => {
    const a = approval({ argFingerprint: "path:other.txt" });
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
      existingApprovals: [a],
    });
    expect(v.decision).toBe("ask");
  });

  it("已过期的批准不复用 → 仍 ask", () => {
    const a = approval({ expiresAt: new Date(Date.now() - 1000) });
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
      existingApprovals: [a],
    });
    expect(v.decision).toBe("ask");
  });

  it("status 非_approved 不复用", () => {
    const a = approval({ status: "pending" });
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
      existingApprovals: [a],
    });
    expect(v.decision).toBe("ask");
  });

  it("Stage 0 #7：denied 审批不恢复为 allow → 仍 ask", () => {
    const a = approval({ status: "denied" });
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
      existingApprovals: [a],
    });
    expect(v.decision).toBe("ask");
    expect(v.existingApprovalId).toBeUndefined();
  });

  it("Stage 0 #7：denied 审批即使 always scope + 同 thread 也不恢复为 allow", () => {
    const a = approval({ status: "denied", approvedScope: "always", threadId: "tid" });
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
      existingApprovals: [a],
    });
    expect(v.decision).toBe("ask");
    expect(v.existingApprovalId).toBeUndefined();
  });

  it("Stage 0 #7：superseded（once 已消费）审批不恢复为 allow", () => {
    const a = approval({ status: "superseded", approvedScope: "once", threadId: "tid" });
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "secret.txt" },
      threadId: "tid",
      existingApprovals: [a],
    });
    expect(v.decision).toBe("ask");
    expect(v.existingApprovalId).toBeUndefined();
  });
});

describe("规则优先级与 DB 覆盖", () => {
  it("DB allow 规则优先级高于默认 ask → allow", () => {
    const dbRules = [
      {
        id: "db:deleteFile:allow",
        scope: "global" as const,
        scopeRef: null,
        toolPattern: "tool.deleteFile",
        argMatcher: null,
        decision: "allow" as const,
        reason: "DB 放行",
        priority: 200,
      },
    ];
    const v = evaluatePermission({
      toolName: "deleteFile",
      input: { path: "x.txt" },
      threadId: "tid",
      dbRules,
    });
    expect(v.decision).toBe("allow");
    expect(v.matchedRuleId).toBe("db:deleteFile:allow");
  });

  it("同优先级 deny > ask > allow", () => {
    // 三条同 priority=50 的规则，deny 应胜出
    const dbRules = [
      {
        id: "r-allow",
        scope: "global" as const,
        scopeRef: null,
        toolPattern: "tool.customTool",
        argMatcher: null,
        decision: "allow" as const,
        reason: null,
        priority: 50,
      },
      {
        id: "r-ask",
        scope: "global" as const,
        scopeRef: null,
        toolPattern: "tool.customTool",
        argMatcher: null,
        decision: "ask" as const,
        reason: null,
        priority: 50,
      },
      {
        id: "r-deny",
        scope: "global" as const,
        scopeRef: null,
        toolPattern: "tool.customTool",
        argMatcher: null,
        decision: "deny" as const,
        reason: "deny wins",
        priority: 50,
      },
    ];
    const v = evaluatePermission({
      toolName: "customTool",
      input: {},
      threadId: "tid",
      dbRules,
    });
    expect(v.decision).toBe("deny");
    expect(v.matchedRuleId).toBe("r-deny");
  });

  it("DB deny 优先级低于默认 deny 时不影响 writeFile protectedPaths（高优先级 deny 仍在）", () => {
    const dbRules = [
      {
        id: "db:writeFile:allow-low",
        scope: "global" as const,
        scopeRef: null,
        toolPattern: "tool.writeFile",
        argMatcher: null,
        decision: "allow" as const,
        reason: "low pri allow",
        priority: 10,
      },
    ];
    const v = evaluatePermission({
      toolName: "writeFile",
      input: { path: ".git/config", content: "" },
      threadId: "tid",
      dbRules,
    });
    // 默认 deny priority=100 > DB allow priority=10 → deny
    expect(v.decision).toBe("deny");
  });

  it("thread scope 规则仅对同 thread 生效", () => {
    const dbRules = [
      {
        id: "db:thread-ask",
        scope: "thread" as const,
        scopeRef: "tid",
        toolPattern: "tool.someTool",
        argMatcher: null,
        decision: "ask" as const,
        reason: "thread ask",
        priority: 200,
      },
    ];
    const same = evaluatePermission({
      toolName: "someTool",
      input: {},
      threadId: "tid",
      dbRules,
    });
    expect(same.decision).toBe("ask");
    const other = evaluatePermission({
      toolName: "someTool",
      input: {},
      threadId: "other",
      dbRules,
    });
    expect(other.decision).toBe("allow"); // 无规则命中 → 默认 allow
  });
});

describe("buildDefaultRules", () => {
  it("含 protectedPaths deny + commandDenyList deny(runCommand+runBuild) + 4 个 ask 默认", () => {
    const rules = buildDefaultRules(defaultPolicyConfig);
    const denyWrite = rules.filter(
      (r) => r.toolPattern === "tool.writeFile" && r.decision === "deny",
    );
    const denyCmd = rules.filter(
      (r) => r.toolPattern === "tool.runCommand" && r.decision === "deny",
    );
    // V3.2：commandDenyList 镜像到 tool.runBuild deny
    const denyBuild = rules.filter(
      (r) => r.toolPattern === "tool.runBuild" && r.decision === "deny",
    );
    const asks = rules.filter((r) => r.decision === "ask");
    expect(denyWrite.length).toBe(defaultPolicyConfig.protectedPaths.length);
    expect(denyCmd.length).toBe(defaultPolicyConfig.commandDenyList.length);
    expect(denyBuild.length).toBe(defaultPolicyConfig.commandDenyList.length);
    expect(asks.map((r) => r.toolPattern).sort()).toEqual([
      "tool.applyPatch",
      "tool.createPullRequest",
      "tool.deleteFile",
      "tool.deployToEnvironment",
      "tool.gitCheckpoint",
      "tool.gitCommit",
      "tool.gitCreateBranch",
      "tool.gitPush",
      "tool.gitRestoreCheckpoint",
      "tool.installDependencies",
      "tool.multiEditFile",
      "tool.rollback",
    ]);
  });
});

describe("S1（07-P1-1）skill-scope 规则真解释", () => {
  // 原 engine.ts:148 注释自承"不解释,scopeRef null 放行,否则不匹配"——空壳。
  // 修复:ctx 加 skillId,scope=skill + scopeRef=skillId 仅对绑定该 skill 的 thread 匹配。
  const skillRule = (scopeRef: string | null) => ({
    id: `skill-rule:${scopeRef ?? "null"}`,
    scope: "skill" as const,
    scopeRef,
    toolPattern: "tool.writeFile",
    argMatcher: null,
    decision: "deny" as const,
    reason: "skill-scope deny",
    priority: 100,
  });

  it("scopeRef=skillId + ctx.skillId 匹配 → deny 命中", () => {
    const v = evaluatePermission({
      toolName: "writeFile",
      input: { path: "x.txt" },
      threadId: "tid",
      skillId: "skill-42",
      dbRules: [skillRule("skill-42")],
    });
    expect(v.decision).toBe("deny");
    expect(v.matchedRuleId).toBe("skill-rule:skill-42");
  });

  it("scopeRef=skillId + ctx.skillId 不匹配 → 规则不适用,回落 allow", () => {
    const v = evaluatePermission({
      toolName: "writeFile",
      input: { path: "x.txt" },
      threadId: "tid",
      skillId: "skill-other",
      dbRules: [skillRule("skill-42")],
    });
    // skill-scope 规则不匹配(当前 thread 绑定别的 skill)→ 无规则命中 → 默认 allow
    expect(v.decision).toBe("allow");
    expect(v.matchedRuleId).toBeUndefined();
  });

  it("scopeRef=skillId + ctx 无 skillId(未绑定) → 不匹配,放行", () => {
    const v = evaluatePermission({
      toolName: "writeFile",
      input: { path: "x.txt" },
      threadId: "tid",
      dbRules: [skillRule("skill-42")],
    });
    expect(v.decision).toBe("allow");
  });

  it("scopeRef=null(全局 skill 规则) → 对所有 thread 放行(无论是否绑 skill)", () => {
    const v = evaluatePermission({
      toolName: "writeFile",
      input: { path: "x.txt" },
      threadId: "tid",
      skillId: null,
      dbRules: [skillRule(null)],
    });
    expect(v.decision).toBe("deny");
    expect(v.matchedRuleId).toBe("skill-rule:null");
  });
});

// ─── 审计修复：路径 ".." 规范化 ───
describe("matchArg 路径规范化（防 .. 绕过）", () => {
  it("foo/../../etc/passwd 规范化后匹配 ^etc/ deny 规则", () => {
    const v = evaluatePermission({
      toolName: "writeFile",
      input: { path: "foo/../../etc/passwd" },
      threadId: "tid",
      dbRules: [
        {
          id: "deny-etc",
          toolPattern: "tool.writeFile",
          decision: "deny",
          scope: "global",
          scopeRef: null,
          priority: 100,
          argMatcher: { pathRegex: "^etc/" },
          reason: "禁止写入 etc 目录",
        },
      ],
    });
    expect(v.decision).toBe("deny");
    expect(v.matchedRuleId).toBe("deny-etc");
  });

  it("./secrets/foo 规范化后匹配 ^secrets/ deny 规则", () => {
    const v = evaluatePermission({
      toolName: "writeFile",
      input: { path: "./secrets/foo" },
      threadId: "tid",
      dbRules: [
        {
          id: "deny-secrets",
          toolPattern: "tool.writeFile",
          decision: "deny",
          scope: "global",
          scopeRef: null,
          priority: 100,
          argMatcher: { pathRegex: "^secrets/" },
          reason: "禁止写入 secrets 目录",
        },
      ],
    });
    expect(v.decision).toBe("deny");
  });

  it("普通路径不受影响（零回归）", () => {
    const v = evaluatePermission({
      toolName: "writeFile",
      input: { path: "src/main.ts" },
      threadId: "tid",
      dbRules: [
        {
          id: "deny-etc",
          toolPattern: "tool.writeFile",
          decision: "deny",
          scope: "global",
          scopeRef: null,
          priority: 100,
          argMatcher: { pathRegex: "^etc/" },
          reason: "禁止写入 etc 目录",
        },
      ],
    });
    expect(v.decision).toBe("allow");
  });
});

describe("matchArg fail-closed（审计修复 H2：无对应字段时不匹配）", () => {
  it("pathRegex deny 规则不匹配无 path 字段的 runCommand 调用", () => {
    // 管理员创建一条针对 .env 文件的 deny 规则
    const v = evaluatePermission({
      toolName: "runCommand",
      input: { command: "ls -la" }, // 无 path 字段
      threadId: "tid",
      dbRules: [
        {
          id: "deny-env",
          toolPattern: "tool.*", // 宽泛匹配所有工具
          decision: "deny",
          scope: "global",
          scopeRef: null,
          priority: 100,
          argMatcher: { pathRegex: "\\.env$" },
          reason: "禁止操作 .env 文件",
        },
      ],
    });
    // 审计修复后：runCommand 无 path 字段 → pathRegex 约束不满足 → allow（不匹配）
    expect(v.decision).toBe("allow");
  });

  it("commandRegex deny 规则不匹配无 command 字段的 writeFile 调用", () => {
    const v = evaluatePermission({
      toolName: "writeFile",
      input: { path: "test.txt" }, // 无 command 字段
      threadId: "tid",
      dbRules: [
        {
          id: "deny-rm",
          toolPattern: "tool.*",
          decision: "deny",
          scope: "global",
          scopeRef: null,
          priority: 100,
          argMatcher: { commandRegex: "^rm " },
          reason: "禁止 rm 命令",
        },
      ],
    });
    // writeFile 无 command 字段 → commandRegex 约束不满足 → allow
    expect(v.decision).toBe("allow");
  });

  it("pathRegex deny 规则仍正确匹配有 path 字段且路径匹配的工具", () => {
    const v = evaluatePermission({
      toolName: "writeFile",
      input: { path: ".env.local" },
      threadId: "tid",
      dbRules: [
        {
          id: "deny-env",
          toolPattern: "tool.*",
          decision: "deny",
          scope: "global",
          scopeRef: null,
          priority: 100,
          argMatcher: { pathRegex: "\\.env" },
          reason: "禁止操作 .env 文件",
        },
      ],
    });
    // writeFile 有 path 字段且匹配 .env → deny
    expect(v.decision).toBe("deny");
  });
});
