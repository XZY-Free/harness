import {
  executeToolRun,
  getCurrentToolApprovalId,
  resolveToolTimeoutMs,
  runInSubagentScope,
} from "@/lib/ai/tool-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.1 Stage B：executeToolRun 的 ask 暂停-恢复分支独立测试。
 *
 * 既有 writeFile/runCommand 的 allow/deny 行为散测于 tools.test.ts（不回归）；
 * 本文件聚焦 ask：不跑 runner、落 awaiting_approval、创建审批请求、thread 暂停；
 * 以及 ask + 既有批准 → 升级 allow 跑 runner。
 */

const TID = "tid-runtime";

const queryMocks = vi.hoisted(() => ({
  createToolRun: vi.fn(),
  appendThreadEvent: vi.fn(),
  finishToolRunSuccess: vi.fn(),
  finishToolRunFailure: vi.fn(),
  updateThreadStatus: vi.fn(),
  listPermissionRules: vi.fn(),
  findMatchingApprovals: vi.fn(),
  consumeOnceApproval: vi.fn(),
  requestApprovalAtomic: vi.fn(),
  getThreadById: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  createToolRun: queryMocks.createToolRun,
  appendThreadEvent: queryMocks.appendThreadEvent,
  finishToolRunSuccess: queryMocks.finishToolRunSuccess,
  finishToolRunFailure: queryMocks.finishToolRunFailure,
  updateThreadStatus: queryMocks.updateThreadStatus,
  listPermissionRules: queryMocks.listPermissionRules,
  findMatchingApprovals: queryMocks.findMatchingApprovals,
  consumeOnceApproval: queryMocks.consumeOnceApproval,
  requestApprovalAtomic: queryMocks.requestApprovalAtomic,
  getThreadById: queryMocks.getThreadById,
  updateThreadPreviewUrl: vi.fn(),
}));

// 写后格式化走 policy/exec seam，mock 掉避免真起 shell
const execMocks = vi.hoisted(() => ({ runWorkspaceCommand: vi.fn() }));
vi.mock("@/lib/policy/exec", () => ({
  runWorkspaceCommand: execMocks.runWorkspaceCommand,
}));

// S1（07-P2-4）：高危工具审计走 recordAdminAudit，mock 掉避免真落库
const auditMocks = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));
vi.mock("@/lib/studio/admin-audit", () => ({
  recordAdminAudit: auditMocks.recordAdminAudit,
}));

beforeEach(() => {
  for (const m of Object.values(queryMocks)) m.mockReset();
  execMocks.runWorkspaceCommand.mockReset();
  auditMocks.recordAdminAudit.mockReset();
  queryMocks.createToolRun.mockResolvedValue({ id: "run-1", threadId: TID, status: "running" });
  queryMocks.listPermissionRules.mockResolvedValue([]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
  queryMocks.consumeOnceApproval.mockResolvedValue(true);
  queryMocks.requestApprovalAtomic.mockResolvedValue({
    run: { id: "run-ask", threadId: TID, status: "awaiting_approval" },
    approval: { id: "apr-1" },
  });
  // S1（07-P2-4）：高危工具审计查 thread.userId 取 actor
  queryMocks.getThreadById.mockResolvedValue({ id: TID, userId: "user-1" });
  auditMocks.recordAdminAudit.mockResolvedValue(undefined);
  execMocks.runWorkspaceCommand.mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executeToolRun ask 暂停（fail-fast，不跑 runner）", () => {
  it("deleteFile 默认 ask：不跑 runner，返回 awaitingApproval", async () => {
    const runner = vi.fn(async () => ({ ok: true }));
    const out = (await executeToolRun(TID, "deleteFile", { path: "secret.txt" }, runner)) as {
      ok: boolean;
      awaitingApproval: boolean;
      pendingApprovalId: string;
      approvalId: string;
    };

    expect(runner).not.toHaveBeenCalled();
    expect(out).toEqual({
      ok: false,
      awaitingApproval: true,
      pendingApprovalId: "apr-1",
      approvalId: "apr-1",
    });
  });

  it("ask 时 requestApprovalAtomic 单事务建 run+approval+暂停 thread", async () => {
    await executeToolRun(TID, "deleteFile", { path: "x" }, vi.fn());
    expect(queryMocks.requestApprovalAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: TID,
        toolName: "deleteFile",
        permissionKey: "tool.deleteFile",
        argFingerprint: "path:x",
      }),
    );
    // ask 路径不再走分散 createToolRun（事务内建 run）
    expect(queryMocks.createToolRun).not.toHaveBeenCalled();
  });

  it("ask 时落 tool.approval_requested + agent.status_changed（事务外事件）", async () => {
    await executeToolRun(TID, "deleteFile", { path: "x" }, vi.fn());

    expect(queryMocks.requestApprovalAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: TID,
        toolName: "deleteFile",
        permissionKey: "tool.deleteFile",
        argFingerprint: "path:x",
      }),
    );
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("tool.called");
    expect(types).toContain("tool.approval_requested");
    expect(types).toContain("agent.status_changed");
    // 不落 tool.succeeded / tool.failed（未跑 runner）
    expect(types).not.toContain("tool.succeeded");
    expect(types).not.toContain("tool.failed");

    const statusChange = queryMocks.appendThreadEvent.mock.calls.find(
      (c) => c[1] === "agent.status_changed",
    );
    expect(statusChange?.[2]).toMatchObject({ to: "awaiting_approval" });
    // thread 状态由 requestApprovalAtomic 事务内更新，不再单独调 updateThreadStatus
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalledWith(TID, "awaiting_approval");
    expect(queryMocks.finishToolRunSuccess).not.toHaveBeenCalled();
    expect(queryMocks.finishToolRunFailure).not.toHaveBeenCalled();
  });

  it("applyPatch / multiEditFile 同样默认 ask 暂停", async () => {
    for (const toolName of ["applyPatch", "multiEditFile"]) {
      queryMocks.appendThreadEvent.mockClear();
      const runner = vi.fn(async () => ({ ok: true }));
      const input =
        toolName === "applyPatch" ? { patch: "--- a\n+++ b\n" } : { path: "a.js", edits: [] };
      await executeToolRun(TID, toolName, input, runner);
      expect(runner).not.toHaveBeenCalled();
      const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
      expect(types).toContain("tool.approval_requested");
    }
  });
});

describe("executeToolRun ask + 既有批准 → 升级 allow 跑 runner", () => {
  it("findMatchingApprovals 返回匹配批准 → allow，跑 runner，tool.called 带 approvedBy", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-existing",
        threadId: TID,
        toolRunId: "tr-old",
        toolName: "deleteFile",
        permissionKey: "tool.deleteFile",
        argFingerprint: "path:secret.txt",
        argSummary: "path=secret.txt",
        status: "approved",
        approvedScope: "thread",
        resolvedBy: "u1",
        resolvedAt: new Date(),
        createdAt: new Date(),
        expiresAt: null,
      },
    ]);
    const runner = vi.fn(async () => ({
      ok: true,
      path: "secret.txt",
      approvalId: getCurrentToolApprovalId(),
    }));
    const out = (await executeToolRun(TID, "deleteFile", { path: "secret.txt" }, runner)) as {
      ok: boolean;
      approvalId: string | null;
    };

    expect(runner).toHaveBeenCalled();
    expect(out.approvalId).toBe("apr-existing");
    expect(out.ok).toBe(true);
    expect(queryMocks.finishToolRunSuccess).toHaveBeenCalled();
    // tool.called payload 标注 approvedBy
    const called = queryMocks.appendThreadEvent.mock.calls.find((c) => c[1] === "tool.called");
    expect(called?.[2]).toMatchObject({ approvedBy: "apr-existing" });
    // 不暂停
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).not.toContain("tool.approval_requested");
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalledWith(TID, "awaiting_approval");
  });

  it("P1-10: finishToolRunSuccess 抛错 → 工具结果仍成功返回(fail-open,不崩溃 run)", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-e2",
        threadId: TID,
        toolRunId: "tr-old",
        toolName: "deleteFile",
        permissionKey: "tool.deleteFile",
        argFingerprint: "path:x",
        argSummary: "path=x",
        status: "approved",
        approvedScope: "thread",
        resolvedBy: "u1",
        resolvedAt: new Date(),
        createdAt: new Date(),
        expiresAt: null,
      },
    ]);
    queryMocks.finishToolRunSuccess.mockRejectedValueOnce(new Error("db down"));
    const runner = vi.fn(async () => ({ ok: true, path: "x" }));
    const out = (await executeToolRun(TID, "deleteFile", { path: "x" }, runner)) as {
      ok: boolean;
    };
    expect(out.ok).toBe(true);
  });

  it("once 批准只消费一次：抢占成功才执行 runner", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-once",
        threadId: TID,
        toolRunId: "tr-old",
        toolName: "deleteFile",
        permissionKey: "tool.deleteFile",
        argFingerprint: "path:secret.txt",
        argSummary: "path=secret.txt",
        status: "approved",
        approvedScope: "once",
        resolvedBy: "u1",
        resolvedAt: new Date(),
        createdAt: new Date(),
        expiresAt: null,
      },
    ]);
    const runner = vi.fn(async () => ({ ok: true }));

    await executeToolRun(TID, "deleteFile", { path: "secret.txt" }, runner);

    expect(runner).toHaveBeenCalled();
    expect(queryMocks.consumeOnceApproval).toHaveBeenCalledWith("apr-once");
  });

  it("once 批准并发下抢占失败 → 不跑 runner，记录 tool.failed", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-once",
        threadId: TID,
        toolRunId: "tr-old",
        toolName: "deleteFile",
        permissionKey: "tool.deleteFile",
        argFingerprint: "path:secret.txt",
        argSummary: "path=secret.txt",
        status: "approved",
        approvedScope: "once",
        resolvedBy: "u1",
        resolvedAt: new Date(),
        createdAt: new Date(),
        expiresAt: null,
      },
    ]);
    queryMocks.consumeOnceApproval.mockResolvedValue(false);
    const runner = vi.fn(async () => ({ ok: true }));

    const out = (await executeToolRun(TID, "deleteFile", { path: "secret.txt" }, runner)) as {
      ok: boolean;
      error: string;
    };

    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain("一次性审批已被使用");
    expect(runner).not.toHaveBeenCalled();
    expect(queryMocks.finishToolRunFailure).toHaveBeenCalledWith(
      "run-1",
      expect.stringContaining("一次性审批已被使用"),
    );
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("tool.called");
    expect(types).toContain("tool.failed");
    const failed = queryMocks.appendThreadEvent.mock.calls.find((c) => c[1] === "tool.failed");
    expect(failed?.[2]).toMatchObject({ reason: "once_approval_consumed" });
  });

  it("既有批准但 fingerprint 不匹配 → 仍 ask 暂停", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-other",
        threadId: TID,
        toolRunId: "tr-old",
        toolName: "deleteFile",
        permissionKey: "tool.deleteFile",
        argFingerprint: "path:other.txt",
        argSummary: "path=other.txt",
        status: "approved",
        approvedScope: "thread",
        resolvedBy: "u1",
        resolvedAt: new Date(),
        createdAt: new Date(),
        expiresAt: null,
      },
    ]);
    const runner = vi.fn(async () => ({ ok: true }));
    await executeToolRun(TID, "deleteFile", { path: "secret.txt" }, runner);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("executeToolRun deny 零回归（policy 拦截）", () => {
  it("writeFile .git → deny，不跑 runner，落 tool.failed(policy)", async () => {
    const runner = vi.fn(async () => ({ ok: true }));
    const out = (await executeToolRun(
      TID,
      "writeFile",
      { path: ".git/config", content: "" },
      runner,
    )) as { ok: boolean; error: string };

    expect(runner).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.error).toContain("policy 拦截");
    const failed = queryMocks.appendThreadEvent.mock.calls.find((c) => c[1] === "tool.failed");
    expect(failed?.[2]).toMatchObject({ failureKind: "policy" });
    expect(queryMocks.finishToolRunFailure).toHaveBeenCalled();
  });
});

// S1（07-P2-4）：高危工具执行成功后落专项审计
describe("executeToolRun 高危工具审计 (07-P2-4)", () => {
  it("高危工具（runCommand）allow 执行成功 → 落 tool.high_risk.executed 审计", async () => {
    const runner = vi.fn(async () => ({ ok: true }));
    await executeToolRun(TID, "runCommand", { command: "npm start" }, runner);
    expect(runner).toHaveBeenCalled();
    // 审计调用：action=tool.high_risk.executed，actorUserId 取 thread.userId
    expect(auditMocks.recordAdminAudit).toHaveBeenCalledTimes(1);
    const auditCall = auditMocks.recordAdminAudit.mock.calls[0]?.[0];
    expect(auditCall).toMatchObject({
      action: "tool.high_risk.executed",
      targetType: "tool_run",
      outcome: "succeeded",
      actorUserId: "user-1",
    });
    expect(auditCall.metadata).toMatchObject({
      toolName: "runCommand",
      threadId: TID,
      input: { command: "npm start" },
    });
  });

  it("非高危工具（readFile）→ 不落高危审计", async () => {
    const runner = vi.fn(async () => ({ ok: true, content: "x" }));
    await executeToolRun(TID, "readFile", { path: "x.txt" }, runner);
    expect(auditMocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("高危工具审计 fail-open：recordAdminAudit reject 不阻塞工具结果", async () => {
    auditMocks.recordAdminAudit.mockRejectedValue(new Error("db down"));
    const runner = vi.fn(async () => ({ ok: true }));
    const out = (await executeToolRun(TID, "runCommand", { command: "npm test" }, runner)) as {
      ok: boolean;
    };
    expect(runner).toHaveBeenCalled();
    expect(out.ok).toBe(true); // 审计失败不阻塞工具结果
  });
});

// S1 修复（01-P2-7）：统一工具超时
describe("resolveToolTimeoutMs", () => {
  const orig = { ...process.env };
  afterEach(() => {
    for (const k of ["SNOW_TOOL_TIMEOUT_DEFAULT_MS", "SNOW_TOOL_TIMEOUT_MAX_MS"]) {
      delete process.env[k];
    }
    Object.assign(process.env, orig);
  });

  it("runCommand 默认 30s", () => {
    expect(resolveToolTimeoutMs("runCommand")).toBe(30_000);
  });

  it("runBuild 默认 120s", () => {
    expect(resolveToolTimeoutMs("runBuild")).toBe(120_000);
  });

  it("installDependencies 默认 180s", () => {
    expect(resolveToolTimeoutMs("installDependencies")).toBe(180_000);
  });

  it("callerOverride 取 min(caller, max)", () => {
    // runCommand max 300s；caller 100s → 100s
    expect(resolveToolTimeoutMs("runCommand", 100_000)).toBe(100_000);
    // caller 超 max 300s → 截到 300s
    expect(resolveToolTimeoutMs("runCommand", 500_000)).toBe(300_000);
  });

  it("未声明 defaultTimeoutMs 的工具用全局默认", () => {
    expect(resolveToolTimeoutMs("readFile")).toBe(30_000);
    process.env.SNOW_TOOL_TIMEOUT_DEFAULT_MS = "15000";
    expect(resolveToolTimeoutMs("readFile")).toBe(15_000);
  });

  it("全局 max 上限生效", () => {
    process.env.SNOW_TOOL_TIMEOUT_MAX_MS = "60000";
    // runBuild default 120s 但 max 被 env 收到 60s → 60s
    expect(resolveToolTimeoutMs("runBuild")).toBe(60_000);
  });
});

// S1（04-G11）：subagentScope ALS 测试
describe("subagentScope（04-G11 AsyncLocalStorage）", () => {
  // 工具：取 tool.called 事件 payload 中的 subagent 字段
  function captureSubagentField(): Record<string, unknown> | undefined {
    const called = queryMocks.appendThreadEvent.mock.calls.find((c) => c[1] === "tool.called");
    return (called?.[2] as { subagent?: Record<string, unknown> } | undefined)?.subagent;
  }

  it("runInSubagentScope 内 executeToolRun 自动读取 scope（tool.called 带 subagent）", async () => {
    const runner = vi.fn(async () => ({ ok: true, content: "x" }));
    const scope = { runId: "run-1", definitionId: "def-1", role: "explore" };

    await runInSubagentScope(scope, () =>
      executeToolRun(TID, "readFile", { path: "a.ts" }, runner),
    );

    expect(runner).toHaveBeenCalled();
    // tool.called payload 自动带上 subagent 字段（无需显式传 options.subagentScope）
    expect(captureSubagentField()).toMatchObject({
      runId: "run-1",
      definitionId: "def-1",
      role: "explore",
    });
  });

  it("scope 外 executeToolRun 读到 undefined（tool.called 不含 subagent，主链路零回归）", async () => {
    const runner = vi.fn(async () => ({ ok: true, content: "x" }));

    await executeToolRun(TID, "readFile", { path: "a.ts" }, runner);

    expect(runner).toHaveBeenCalled();
    // 主链路无 scope，tool.called payload 不含 subagent 字段
    expect(captureSubagentField()).toBeUndefined();
  });

  it("嵌套 scope：内层覆盖外层（executeToolRun 读最内层 scope）", async () => {
    const runner = vi.fn(async () => ({ ok: true, content: "x" }));
    const outer = { runId: "run-outer", definitionId: "def-outer", role: "explore" };
    const inner = { runId: "run-inner", definitionId: "def-inner", role: "verifier" };

    await runInSubagentScope(outer, async () =>
      runInSubagentScope(inner, () => executeToolRun(TID, "readFile", { path: "a.ts" }, runner)),
    );

    // 内层 scope 覆盖外层，tool.called 带 inner 的 runId/definitionId/role
    expect(captureSubagentField()).toMatchObject({
      runId: "run-inner",
      definitionId: "def-inner",
      role: "verifier",
    });
  });

  it("显式 options.subagentScope 优先于 ALS（覆盖内层 scope）", async () => {
    const runner = vi.fn(async () => ({ ok: true, content: "x" }));
    const alsScope = { runId: "run-als", definitionId: "def-als", role: "explore" };
    const explicitScope = { runId: "run-explicit", definitionId: "def-explicit", role: "verifier" };

    await runInSubagentScope(alsScope, () =>
      executeToolRun(TID, "readFile", { path: "a.ts" }, runner, { subagentScope: explicitScope }),
    );

    // 显式传入优先于 ALS
    expect(captureSubagentField()).toMatchObject({
      runId: "run-explicit",
      definitionId: "def-explicit",
      role: "verifier",
    });
  });
});
