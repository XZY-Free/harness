import { composeCommitMessage, parseCommitMessage } from "@/lib/git/commit-message";
import { describe, expect, it } from "vitest";

/**
 * V3.7 Stage A：commit message Lore trailer 协议往返测试。
 * 覆盖：全字段 compose、字段缺失省略、parse 反向、subject 与 trailer 混排、未知 trailer 忽略。
 */

describe("composeCommitMessage", () => {
  it("全字段 → 主题行 + 6 个 trailer（固定顺序）", () => {
    const msg = composeCommitMessage({
      subject: "新增 git 工具组并接入 ask 权限审批",
      constraint: "git write ops default to ask",
      rejected: "Allow gitCommit without approval",
      confidence: "high",
      scopeRisk: "moderate",
      tested: "pnpm vitest run lib/ai/tools/git.test.ts",
      notTested: "Real ask→approve→retry loop against live git remote",
    });
    expect(msg).toBe(
      [
        "新增 git 工具组并接入 ask 权限审批",
        "Constraint: git write ops default to ask",
        "Rejected: Allow gitCommit without approval",
        "Confidence: high",
        "Scope-risk: moderate",
        "Tested: pnpm vitest run lib/ai/tools/git.test.ts",
        "Not-tested: Real ask→approve→retry loop against live git remote",
      ].join("\n"),
    );
  });

  it("仅 subject → 单行，无 trailer", () => {
    expect(composeCommitMessage({ subject: "fix: typo" })).toBe("fix: typo");
  });

  it("字段缺失 → 省略对应 trailer，不补空行", () => {
    const msg = composeCommitMessage({
      subject: "feat: x",
      confidence: "high",
      tested: "pnpm test",
    });
    expect(msg).toBe("feat: x\nConfidence: high\nTested: pnpm test");
  });

  it("空 subject → 不输出主题行（仅 trailer）", () => {
    const msg = composeCommitMessage({ subject: "  ", confidence: "high" });
    expect(msg).toBe("Confidence: high");
  });
});

describe("parseCommitMessage", () => {
  it("全字段往返：compose → parse 还原", () => {
    const fields = {
      subject: "feat: delivery summary",
      constraint: "must not block on non-GitHub",
      rejected: "Require gh for all",
      confidence: "medium",
      scopeRisk: "moderate",
      tested: "summary.test.ts",
      notTested: "live gh pr create",
    };
    const parsed = parseCommitMessage(composeCommitMessage(fields));
    expect(parsed).toEqual(fields);
  });

  it("首个非 trailer 行作为 subject", () => {
    const parsed = parseCommitMessage("fix typo\nConfidence: high\nTested: pnpm test");
    expect(parsed.subject).toBe("fix typo");
    expect(parsed.confidence).toBe("high");
    expect(parsed.tested).toBe("pnpm test");
  });

  it("未知 trailer 标签被忽略（向前兼容）", () => {
    const parsed = parseCommitMessage("subj\nUnknown-Key: value\nConfidence: high");
    expect(parsed.subject).toBe("subj");
    expect(parsed.confidence).toBe("high");
    expect(parsed.notTested).toBeUndefined();
  });

  it("空串 → subject 空", () => {
    expect(parseCommitMessage("")).toEqual({ subject: "" });
  });
});
