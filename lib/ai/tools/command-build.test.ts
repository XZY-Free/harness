import { computeArgFingerprint } from "@/lib/permission/approval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.2 Stage D：runBuild / installDependencies 单测。
 * - runBuild：默认 npm run build，120s 超时，走 deny-list（rm -rf 等被 deny）。
 * - installDependencies：默认 ask（无既有批准 → awaitingApproval）；有批准 → 执行。
 */

const TID = "test-command-build";

const queryMocks = vi.hoisted(() => ({
  createToolRun: vi.fn(),
  appendThreadEvent: vi.fn(),
  finishToolRunSuccess: vi.fn(),
  finishToolRunFailure: vi.fn(),
  listPermissionRules: vi.fn(),
  findMatchingApprovals: vi.fn(),
  consumeOnceApproval: vi.fn(),
  requestApprovalAtomic: vi.fn(),
  updateThreadStatus: vi.fn(),
}));
vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: vi.fn() }));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: vi.fn(),
  updateThreadPreviewUrl: vi.fn(),
  updateThreadStatus: queryMocks.updateThreadStatus,
  createToolRun: queryMocks.createToolRun,
  appendThreadEvent: queryMocks.appendThreadEvent,
  finishToolRunSuccess: queryMocks.finishToolRunSuccess,
  finishToolRunFailure: queryMocks.finishToolRunFailure,
  listPermissionRules: queryMocks.listPermissionRules,
  findMatchingApprovals: queryMocks.findMatchingApprovals,
  consumeOnceApproval: queryMocks.consumeOnceApproval,
  requestApprovalAtomic: queryMocks.requestApprovalAtomic,
}));

import { buildCommandBuildTools } from "./command-build";

/** fake execution：exec spy 可控返回。 */
function makeRuntime(exec: ReturnType<typeof vi.fn>) {
  return { workspace: {}, preview: {}, execution: { exec } } as unknown as Parameters<
    typeof buildCommandBuildTools
  >[1];
}

type ToolLike = { execute?: (...args: never[]) => unknown };
function callExecute(tool: ToolLike, input: unknown): Promise<unknown> {
  if (!tool.execute) throw new Error("tool.execute missing");
  return Promise.resolve(tool.execute(input as never, { toolCallId: "t", messages: [] } as never));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMocks.createToolRun.mockResolvedValue({ id: "run-1", threadId: TID, status: "running" });
  queryMocks.appendThreadEvent.mockResolvedValue({});
  queryMocks.finishToolRunSuccess.mockResolvedValue(undefined);
  queryMocks.finishToolRunFailure.mockResolvedValue(undefined);
  // 默认无 DB 规则覆盖、无既有批准 → 引擎走 buildDefaultRules 默认规则
  queryMocks.listPermissionRules.mockResolvedValue([]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
  // ask 路径需要 createApprovalRequest 返回带 id 的审批记录
  queryMocks.requestApprovalAtomic.mockResolvedValue({
    run: { id: "run-ask", status: "awaiting_approval" },
    approval: { id: "appr-1" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runBuild", () => {
  it("默认命令 npm run build，120s 超时，成功路径落 tool.succeeded", async () => {
    const exec = vi.fn().mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "build done",
      stderr: "",
      command: "npm run build",
    });
    const tools = buildCommandBuildTools(TID, makeRuntime(exec), "host");
    const r = await callExecute(tools.runBuild, {});
    expect(r).toMatchObject({ ok: true, exitCode: 0, stdout: "build done" });
    expect(exec).toHaveBeenCalledWith("npm run build", { timeoutMs: 120_000 });
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("tool.called");
    expect(types).toContain("tool.succeeded");
  });

  it("自定义 command 透传", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ ok: true, exitCode: 0, stdout: "", stderr: "", command: "pnpm build" });
    const tools = buildCommandBuildTools(TID, makeRuntime(exec), "host");
    await callExecute(tools.runBuild, { command: "pnpm build" });
    expect(exec).toHaveBeenCalledWith("pnpm build", { timeoutMs: 120_000 });
  });

  it("走 deny-list：rm -rf 命令被 policy 拦截，不调 exec", async () => {
    const exec = vi.fn();
    const tools = buildCommandBuildTools(TID, makeRuntime(exec), "host");
    const r = await callExecute(tools.runBuild, { command: "rm -rf /" });
    expect(r).toMatchObject({ ok: false });
    expect(exec).not.toHaveBeenCalled();
    // 落 tool.failed(policy)
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("tool.failed");
  });
});

describe("installDependencies 默认 ask", () => {
  it("无既有批准 → awaitingApproval，不调 exec，thread 转 awaiting_approval", async () => {
    const exec = vi.fn();
    const tools = buildCommandBuildTools(TID, makeRuntime(exec), "host");
    const r = (await callExecute(tools.installDependencies, {})) as {
      ok: boolean;
      awaitingApproval?: boolean;
    };
    expect(r.ok).toBe(false);
    expect(r.awaitingApproval).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(queryMocks.requestApprovalAtomic).toHaveBeenCalled();
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalledWith(TID, "awaiting_approval");
  });

  it("有匹配批准 → 升级 allow，执行 npm install，180s 超时", async () => {
    // fingerprint = cmd:<首2token>:<hash>（P1-2：installDependencies 在 COMMAND_TOOLS，取首2token+完整命令hash）
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "appr-1",
        threadId: TID,
        permissionKey: "tool.installDependencies",
        argFingerprint: computeArgFingerprint("tool.installDependencies", {
          command: "npm install",
          packageManager: "npm",
        }),
        status: "approved",
        approvedScope: "thread",
        expiresAt: null,
      },
    ]);
    const exec = vi.fn().mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "added 1 package",
      stderr: "",
      command: "npm install",
    });
    const tools = buildCommandBuildTools(TID, makeRuntime(exec), "host");
    const r = await callExecute(tools.installDependencies, {});
    expect(r).toMatchObject({ ok: true, exitCode: 0, stdout: "added 1 package" });
    expect(exec).toHaveBeenCalledWith("npm install", { timeoutMs: 180_000 });
  });

  it("packageManager=pnpm → 命令 pnpm install", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "appr-2",
        threadId: TID,
        permissionKey: "tool.installDependencies",
        argFingerprint: computeArgFingerprint("tool.installDependencies", {
          command: "pnpm install",
          packageManager: "pnpm",
        }),
        status: "approved",
        approvedScope: "thread",
        expiresAt: null,
      },
    ]);
    const exec = vi.fn().mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      command: "pnpm install",
    });
    const tools = buildCommandBuildTools(TID, makeRuntime(exec), "host");
    await callExecute(tools.installDependencies, { packageManager: "pnpm" });
    expect(exec).toHaveBeenCalledWith("pnpm install", { timeoutMs: 180_000 });
  });
});
