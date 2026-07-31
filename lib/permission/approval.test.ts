import type { ToolApprovalRequest } from "@/lib/db/schema";
import { describe, expect, it } from "vitest";
import {
  computeArgFingerprint,
  firstCommandToken,
  firstCommandTokens,
  isApprovalApplicable,
  isApprovalExpired,
  normalizePath,
  summarizeArgs,
} from "./approval";

/**
 * V3.1 Stage A：approval fingerprint 稳定性、scope 命中、过期判定。
 */

describe("normalizePath / firstCommandToken", () => {
  it("去前导 ./ 或 /", () => {
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("/src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("src/a.ts")).toBe("src/a.ts");
  });
  it("command 首 token", () => {
    expect(firstCommandToken("npm install")).toBe("npm");
    expect(firstCommandToken("echo hi")).toBe("echo");
    expect(firstCommandToken("git")).toBe("git");
    expect(firstCommandToken("  rm -rf /  ")).toBe("rm");
  });
  it("command 首 N token（P1-2：区分子命令）", () => {
    expect(firstCommandTokens("npm run build", 2)).toBe("npm run");
    expect(firstCommandTokens("npm install", 2)).toBe("npm install");
    // 单 token 命令:取到几个就是几个,不补齐
    expect(firstCommandTokens("git", 2)).toBe("git");
    expect(firstCommandTokens("  rm -rf /  ", 2)).toBe("rm -rf");
    // 空命令
    expect(firstCommandTokens("   ", 2)).toBe("");
  });
});

describe("computeArgFingerprint 稳定性", () => {
  it("path 工具：相同规范化路径 → 相同 fingerprint；不同路径 → 不同", () => {
    const a = computeArgFingerprint("tool.deleteFile", { path: "./secret.txt" });
    const b = computeArgFingerprint("tool.deleteFile", { path: "secret.txt" });
    const c = computeArgFingerprint("tool.deleteFile", { path: "other.txt" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe("path:secret.txt");
  });

  it("path 工具：不存原始路径外的内容（content 不影响 fingerprint）", () => {
    const a = computeArgFingerprint("tool.writeFile", { path: "a.js", content: "x" });
    const b = computeArgFingerprint("tool.writeFile", { path: "a.js", content: "y" });
    expect(a).toBe(b);
  });

  it("command 工具：首2token 不同 → fingerprint 不同（P1-2：区分子命令）", () => {
    // P1-2 修复：原只取首 token(npm),`npm run evil` 与 `npm run build` 共用 fingerprint。
    // 现取首2token:npm install ≠ npm run ≠ npx vite
    const a = computeArgFingerprint("tool.runCommand", { command: "npm install" });
    const b = computeArgFingerprint("tool.runCommand", { command: "npm run build" });
    const c = computeArgFingerprint("tool.runCommand", { command: "npx vite" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
    // 格式契约:cmd:<首2token>:<hash>
    expect(a.startsWith("cmd:npm install:")).toBe(true);
    expect(b.startsWith("cmd:npm run:")).toBe(true);
  });

  it("command 工具：首2token 相同、完整命令不同 → fingerprint 不同（P1-2：防碰撞）", () => {
    // 首2token 都是 `npm run`,但完整命令不同(evil vs build)→ hash 不同 → fingerprint 不同。
    // 这是 P1-2 防碰撞的核心:`npm run evil` 不能蹭 `npm run build` 的批准。
    const evil = computeArgFingerprint("tool.runCommand", { command: "npm run evil" });
    const build = computeArgFingerprint("tool.runCommand", { command: "npm run build" });
    expect(evil).not.toBe(build);
    expect(evil.startsWith("cmd:npm run:")).toBe(true);
  });

  it("command 工具：相同命令 → 相同 fingerprint（稳定性）", () => {
    const a = computeArgFingerprint("tool.runCommand", { command: "npm run build" });
    const b = computeArgFingerprint("tool.runCommand", { command: "npm run build" });
    expect(a).toBe(b);
  });

  it("applyPatch：相同 patch → 相同；不同 patch → 不同", () => {
    const a = computeArgFingerprint("tool.applyPatch", { patch: "--- a\n+++ b\n" });
    const b = computeArgFingerprint("tool.applyPatch", { patch: "--- a\n+++ b\n" });
    const c = computeArgFingerprint("tool.applyPatch", { patch: "diff" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("patch:")).toBe(true);
  });

  it("复杂 input：稳定 hash（key 顺序无关）", () => {
    const a = computeArgFingerprint("tool.weird", { b: 2, a: 1 });
    const b = computeArgFingerprint("tool.weird", { a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a.startsWith("args:")).toBe(true);
  });
});

describe("summarizeArgs", () => {
  it("path 工具 → path=<normalized>", () => {
    expect(summarizeArgs("deleteFile", { path: "./a.txt" })).toBe("path=a.txt");
  });
  it("command 工具 → command=<完整命令>（P1-2：审批者需看到完整命令）", () => {
    // P1-2 修复：原只展示首 token(npm),审批者看不到完整命令,无法判断 `npm run evil` vs `npm run build`。
    expect(summarizeArgs("runCommand", { command: "npm install" })).toBe("command=npm install");
  });
  it("applyPatch → patch (<n> chars)", () => {
    expect(summarizeArgs("applyPatch", { patch: "abc" })).toBe("patch (3 chars)");
  });
  it("超长摘要截断到 ≤480", () => {
    const long = "x".repeat(600);
    const s = summarizeArgs("deleteFile", { path: long });
    expect(s.length).toBeLessThanOrEqual(480);
    expect(s.endsWith("...")).toBe(true);
  });
});

describe("isApprovalApplicable scope 命中", () => {
  const base = (over: Partial<ToolApprovalRequest>): ToolApprovalRequest => ({
    id: "a1",
    threadId: "tid",
    toolRunId: "tr1",
    toolName: "deleteFile",
    permissionKey: "tool.deleteFile",
    argFingerprint: "path:x",
    argSummary: "path=x",
    status: "approved",
    approvedScope: "thread",
    projectId: null,
    resolvedBy: "u",
    resolvedAt: new Date(),
    createdAt: new Date(),
    expiresAt: null,
    ...over,
  });

  it("always → 跨 thread 适用", () => {
    expect(isApprovalApplicable(base({ approvedScope: "always" }), { threadId: "other" })).toBe(
      true,
    );
  });
  it("thread → 同 thread 适用，不同 thread 不适用", () => {
    expect(isApprovalApplicable(base({ approvedScope: "thread" }), { threadId: "tid" })).toBe(true);
    expect(isApprovalApplicable(base({ approvedScope: "thread" }), { threadId: "other" })).toBe(
      false,
    );
  });
  it("once → 仅同 thread 的恢复重试适用", () => {
    expect(isApprovalApplicable(base({ approvedScope: "once" }), { threadId: "tid" })).toBe(true);
    expect(isApprovalApplicable(base({ approvedScope: "once" }), { threadId: "other" })).toBe(
      false,
    );
  });
  it("session → 同 thread 适用，不同 thread 不适用（短 TTL 由 isApprovalExpired 过滤）", () => {
    expect(isApprovalApplicable(base({ approvedScope: "session" }), { threadId: "tid" })).toBe(
      true,
    );
    expect(isApprovalApplicable(base({ approvedScope: "session" }), { threadId: "other" })).toBe(
      false,
    );
  });
  it("session 短 TTL 过期 → 引擎经 isApprovalExpired 过滤后不升级 allow", () => {
    // session 批准后 expiresAt 收紧到 30min；过期后 isApprovalExpired=true，引擎不再复用。
    const expiredSession = base({
      approvedScope: "session",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(isApprovalExpired(expiredSession, new Date())).toBe(true);
  });

  // V6-M3-5（C4）：project scope 跨 thread 复用
  it("project → 同 project 不同 thread → 适用（跨 thread 复用）", () => {
    expect(
      isApprovalApplicable(base({ approvedScope: "project", projectId: "proj-1" }), {
        threadId: "other-thread",
        projectId: "proj-1",
      }),
    ).toBe(true);
  });
  it("project → 不同 project → 不适用", () => {
    expect(
      isApprovalApplicable(base({ approvedScope: "project", projectId: "proj-1" }), {
        threadId: "tid",
        projectId: "proj-2",
      }),
    ).toBe(false);
  });
  it("project → ctx 无 projectId → 不适用", () => {
    expect(
      isApprovalApplicable(base({ approvedScope: "project", projectId: "proj-1" }), {
        threadId: "tid",
      }),
    ).toBe(false);
  });
});

describe("isApprovalExpired", () => {
  it("expiresAt null → 永不过期", () => {
    expect(isApprovalExpired({ expiresAt: null } as ToolApprovalRequest)).toBe(false);
  });
  it("expiresAt 早于 now → 过期", () => {
    const past = new Date(Date.now() - 1000);
    expect(isApprovalExpired({ expiresAt: past } as ToolApprovalRequest, new Date())).toBe(true);
  });
  it("expiresAt 晚于 now → 未过期", () => {
    const future = new Date(Date.now() + 1000);
    expect(isApprovalExpired({ expiresAt: future } as ToolApprovalRequest, new Date())).toBe(false);
  });
});
