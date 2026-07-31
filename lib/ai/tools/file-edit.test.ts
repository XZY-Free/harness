import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildTools } from "@/lib/ai/tools";
import { computeArgFingerprint } from "@/lib/permission/approval";
import { staticPreviewRuntime } from "@/lib/runtime/preview-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.1 Stage D：editFile / multiEditFile / applyPatch / deleteFile 工具测试。
 *
 * 在真实临时工作区跑 host 实现；queries 经 mock。deleteFile/applyPatch/multiEditFile
 * 默认 ask（rules.ts）→ findMatchingApprovals 返回 [] 时触发 awaiting_approval。
 */

const TEST_ROOT = resolve(".test-workspaces-file-edit");
const TID = "test-file-edit";
const orig = process.env.SNOW_WORKSPACES_DIR;

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

const execMocks = vi.hoisted(() => ({ runWorkspaceCommand: vi.fn() }));
vi.mock("@/lib/policy/exec", () => ({
  runWorkspaceCommand: execMocks.runWorkspaceCommand,
}));

type ToolLike = { execute?: (...args: never[]) => unknown };
function callExecute(tool: ToolLike, input: unknown): Promise<unknown> {
  if (!tool.execute) throw new Error("tool.execute missing");
  return Promise.resolve(tool.execute(input as never, { toolCallId: "t", messages: [] } as never));
}

beforeEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = TEST_ROOT;
  await rm(join(TEST_ROOT, TID), { recursive: true, force: true });
  for (const m of Object.values(queryMocks)) m.mockReset();
  execMocks.runWorkspaceCommand.mockReset();
  queryMocks.createToolRun.mockResolvedValue({ id: "run-1", threadId: TID, status: "running" });
  queryMocks.listPermissionRules.mockResolvedValue([]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
  queryMocks.requestApprovalAtomic.mockResolvedValue({
    run: { id: "run-ask", status: "awaiting_approval" },
    approval: { id: "apr-1" },
  });
  execMocks.runWorkspaceCommand.mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
});

afterEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = orig;
  await staticPreviewRuntime.stop(TID);
  await rm(TEST_ROOT, { recursive: true, force: true });
});

/** 准备一个文件并返回其工具集。 */
async function setupFile(path: string, content: string) {
  const tools = buildTools(TID);
  await callExecute(tools.writeFile, { path, content });
  return tools;
}

/**
 * mock 一个匹配的已批准审批，使 ask 工具升级为 allow（跑 runner）。
 * 用于测试 multiEditFile/applyPatch/deleteFile 的 runner 业务逻辑。
 */
function mockApproved(permissionKey: string, input: Record<string, unknown>) {
  queryMocks.findMatchingApprovals.mockResolvedValue([
    {
      id: "apr-existing",
      threadId: TID,
      toolRunId: "tr-old",
      toolName: permissionKey.replace("tool.", ""),
      permissionKey,
      argFingerprint: computeArgFingerprint(permissionKey, input),
      argSummary: "s",
      status: "approved",
      approvedScope: "thread",
      resolvedBy: "u1",
      resolvedAt: new Date(),
      createdAt: new Date(),
      expiresAt: null,
    },
  ]);
}

describe("editFile", () => {
  it("唯一匹配 → 替换并写回（最小 diff）", async () => {
    const tools = await setupFile("a.ts", "line1\nold\nline3\n");
    const r = (await callExecute(tools.editFile, {
      path: "a.ts",
      oldString: "old",
      newString: "new",
    })) as { ok: boolean; changed: boolean; diffSummary: string };
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    const read = (await callExecute(tools.readFile, { path: "a.ts" })) as { content: string };
    expect(read.content).toBe("line1\nnew\nline3\n");
  });

  it("oldString 非唯一 → 不写，返回错误", async () => {
    const tools = await setupFile("a.ts", "dup\ndup\n");
    const r = (await callExecute(tools.editFile, {
      path: "a.ts",
      oldString: "dup",
      newString: "x",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/非唯一/);
    const read = (await callExecute(tools.readFile, { path: "a.ts" })) as { content: string };
    expect(read.content).toBe("dup\ndup\n"); // 未改
  });

  it("oldString 未找到 → 错误", async () => {
    const tools = await setupFile("a.ts", "line1\n");
    const r = (await callExecute(tools.editFile, {
      path: "a.ts",
      oldString: "nope",
      newString: "x",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/未在文件中找到/);
  });

  it("文件不存在 → 错误", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.editFile, {
      path: "missing.ts",
      oldString: "x",
      newString: "y",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("文件不存在");
  });

  it("V6-M2-3: 并发 editFile 同文件 → 互斥锁保证不丢失", async () => {
    // 准备含 5 个独立标记行的文件
    const initial = "line-A\nline-B\nline-C\nline-D\nline-E\n";
    const tools = await setupFile("concurrent.txt", initial);

    // 并发 5 个 editFile，各替换一个不同标记
    const edits = ["A", "B", "C", "D", "E"].map((letter) =>
      callExecute(tools.editFile, {
        path: "concurrent.txt",
        oldString: `line-${letter}`,
        newString: `replaced-${letter}`,
      }),
    );

    const results = await Promise.all(edits);
    // 全部应成功
    for (const r of results) {
      expect((r as { ok: boolean }).ok).toBe(true);
    }

    // 最终文件应包含全部 5 个替换（无丢失）
    const read = (await callExecute(tools.readFile, { path: "concurrent.txt" })) as {
      content: string;
    };
    for (const letter of ["A", "B", "C", "D", "E"]) {
      expect(read.content).toContain(`replaced-${letter}`);
    }
  });
});

describe("multiEditFile", () => {
  it("顺序应用多处 → 全部写回", async () => {
    const tools = await setupFile("a.ts", "a\nb\nc\n");
    const input = {
      path: "a.ts",
      edits: [
        { oldString: "a", newString: "A" },
        { oldString: "c", newString: "C" },
      ],
    };
    mockApproved("tool.multiEditFile", input);
    const r = (await callExecute(tools.multiEditFile, input)) as {
      ok: boolean;
      appliedCount: number;
    };
    expect(r.ok).toBe(true);
    expect(r.appliedCount).toBe(2);
    const read = (await callExecute(tools.readFile, { path: "a.ts" })) as { content: string };
    expect(read.content).toBe("A\nb\nC\n");
  });

  it("第二条非唯一 → 原子回滚，不写", async () => {
    const tools = await setupFile("a.ts", "x\ndup\ndup\n");
    const input = {
      path: "a.ts",
      edits: [
        { oldString: "x", newString: "X" },
        { oldString: "dup", newString: "D" },
      ],
    };
    mockApproved("tool.multiEditFile", input);
    const r = (await callExecute(tools.multiEditFile, input)) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/非唯一.*回滚/);
    const read = (await callExecute(tools.readFile, { path: "a.ts" })) as { content: string };
    expect(read.content).toBe("x\ndup\ndup\n"); // 原子回滚，第一条也未写
  });
});

describe("applyPatch 工具", () => {
  it("应用单文件 patch → 写回", async () => {
    const tools = await setupFile("a.ts", "line1\nold\nline3\n");
    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3
`;
    const input = { patch };
    mockApproved("tool.applyPatch", input);
    const r = (await callExecute(tools.applyPatch, input)) as {
      ok: boolean;
      changedFiles: string[];
    };
    expect(r.ok).toBe(true);
    expect(r.changedFiles).toEqual(["a.ts"]);
    const read = (await callExecute(tools.readFile, { path: "a.ts" })) as { content: string };
    expect(read.content).toBe("line1\nnew\nline3\n");
  });

  it("路径越界 → 拒绝，不写", async () => {
    const tools = await setupFile("a.ts", "x\n");
    const patch = `--- a/../evil
+++ b/../evil
@@ -1,1 +1,1 @@
-x
+y
`;
    const input = { patch };
    mockApproved("tool.applyPatch", input);
    const r = (await callExecute(tools.applyPatch, input)) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/越界|safeJoin/);
  });

  it("context 不匹配 → 拒绝", async () => {
    const tools = await setupFile("a.ts", "line1\nold\nline3\n");
    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 line1
-WRONG
+new
 line3
`;
    const input = { patch };
    mockApproved("tool.applyPatch", input);
    const r = (await callExecute(tools.applyPatch, input)) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/context 不匹配/);
  });
});

describe("deleteFile", () => {
  it("不存在（已批准升级 allow）→ ok:false 文件不存在", async () => {
    const tools = buildTools(TID);
    const input = { path: "nope.ts" };
    mockApproved("tool.deleteFile", input);
    const r = (await callExecute(tools.deleteFile, input)) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("文件不存在");
  });

  it("目录（已批准升级 allow）→ 拒绝", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: "sub/keep.txt", content: "" });
    const input = { path: "sub" };
    mockApproved("tool.deleteFile", input);
    const r = (await callExecute(tools.deleteFile, input)) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
  });
});

describe("高风险工具默认 ask（配合 Stage A rules + Stage B 引擎）", () => {
  it("deleteFile 默认 ask → 触发 awaiting_approval，不跑 runner", async () => {
    const tools = await setupFile("victim.txt", "x\n");
    const r = (await callExecute(tools.deleteFile, { path: "victim.txt" })) as {
      ok: boolean;
      awaitingApproval: boolean;
      approvalId: string;
    };
    expect(r.awaitingApproval).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.approvalId).toBe("apr-1");
    // 未真正删除（runner 没跑）
    const read = (await callExecute(tools.readFile, { path: "victim.txt" })) as {
      ok: boolean;
      content: string;
    };
    expect(read.ok).toBe(true);
    expect(read.content).toBe("x\n");
    // 落 tool.approval_requested
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("tool.approval_requested");
  });

  it("applyPatch / multiEditFile 默认 ask → awaiting_approval", async () => {
    const tools = await setupFile("a.ts", "x\n");
    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-x
+y
`;
    const r1 = (await callExecute(tools.applyPatch, { patch })) as { awaitingApproval: boolean };
    expect(r1.awaitingApproval).toBe(true);

    const r2 = (await callExecute(tools.multiEditFile, {
      path: "a.ts",
      edits: [{ oldString: "x", newString: "y" }],
    })) as { awaitingApproval: boolean };
    expect(r2.awaitingApproval).toBe(true);
  });

  it("editFile 默认 allow（不在 ask 名单）→ 直接执行", async () => {
    const tools = await setupFile("a.ts", "old\n");
    const r = (await callExecute(tools.editFile, {
      path: "a.ts",
      oldString: "old",
      newString: "new",
    })) as { ok: boolean; awaitingApproval?: boolean };
    expect(r.ok).toBe(true);
    expect(r.awaitingApproval).toBeUndefined();
  });

  it("deleteFile 已有批准 → 升级 allow 执行删除", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-existing",
        threadId: TID,
        toolRunId: "tr-old",
        toolName: "deleteFile",
        permissionKey: "tool.deleteFile",
        argFingerprint: "path:victim.txt",
        argSummary: "path=victim.txt",
        status: "approved",
        approvedScope: "thread",
        resolvedBy: "u1",
        resolvedAt: new Date(),
        createdAt: new Date(),
        expiresAt: null,
      },
    ]);
    const tools = await setupFile("victim.txt", "x\n");
    const r = (await callExecute(tools.deleteFile, { path: "victim.txt" })) as {
      ok: boolean;
      deleted: boolean;
    };
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(true);
  });
});
