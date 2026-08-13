import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildTools } from "@/lib/ai/tools";
import { staticPreviewRuntime } from "@/lib/runtime/preview-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.1 Stage C：readFileRange / statFile / glob / grep 工具测试。
 *
 * 在真实临时工作区跑 host 实现（rg 14.x）。queries 经 mock（与 tools.test.ts 同风格），
 * 不落真实 DB。glob/grep 走真实 rg。
 */

const TEST_ROOT = resolve(".test-workspaces-file-search");
const TID = "test-file-search";
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
  createApprovalRequest: vi.fn(),
}));

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
  createApprovalRequest: queryMocks.createApprovalRequest,
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
  execMocks.runWorkspaceCommand.mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });

  // 准备工作区文件
  const tools = buildTools(TID);
  await callExecute(tools.writeFile, {
    path: "src/a.ts",
    content: "line1\nline2 foo\nline3\nline4 foo\nline5\n",
  });
  await callExecute(tools.writeFile, {
    path: "src/b.js",
    content: "const x = 1;\n",
  });
  await callExecute(tools.writeFile, {
    path: "README.md",
    content: "# project\n",
  });
});

afterEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = orig;
  await staticPreviewRuntime.stop(TID);
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("readFileRange", () => {
  it("读取指定行范围（带行号，1-based 闭区间）", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.readFileRange, {
      path: "src/a.ts",
      startLine: 2,
      endLine: 4,
    })) as { ok: boolean; content: string; startLine: number; endLine: number };
    expect(r.ok).toBe(true);
    expect(r.startLine).toBe(2);
    expect(r.endLine).toBe(4);
    expect(r.content).toBe("2\tline2 foo\n3\tline3\n4\tline4 foo");
  });

  it("endLine 省略 → 读到末尾", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.readFileRange, {
      path: "src/a.ts",
      startLine: 4,
    })) as { ok: boolean; content: string };
    expect(r.ok).toBe(true);
    expect(r.content).toContain("4\tline4 foo");
    expect(r.content).toContain("5\tline5");
  });

  it("startLine 越界 → ok:false 错误", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.readFileRange, {
      path: "src/a.ts",
      startLine: 999,
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("超出文件总行数");
  });

  it("文件不存在 → ok:false", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.readFileRange, {
      path: "nope.ts",
      startLine: 1,
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("文件不存在");
  });

  it("超 MAX_RANGE_LINES 截断并标记 truncated", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "big.txt",
      content: Array.from({ length: 3000 }, (_, i) => `l${i}`).join("\n"),
    });
    const r = (await callExecute(tools.readFileRange, {
      path: "big.txt",
      startLine: 1,
      endLine: 3000,
    })) as { ok: boolean; truncated: boolean; endLine: number };
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.endLine).toBeLessThan(3000);
  });
});

describe("statFile", () => {
  it("返回存在文件的 size/mtime/isDirectory", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.statFile, { path: "src/a.ts" })) as {
      ok: boolean;
      size: number;
      isDirectory: boolean;
      mtime: string;
    };
    expect(r.ok).toBe(true);
    expect(r.size).toBeGreaterThan(0);
    expect(r.isDirectory).toBe(false);
    expect(r.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("不存在 → ok:false", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.statFile, { path: "nope" })) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("文件不存在");
  });
});

describe("glob", () => {
  it("按 **/*.ts 匹配 .ts 文件", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.glob, { pattern: "**/*.ts" })) as {
      ok: boolean;
      files: string[];
    };
    expect(r.ok).toBe(true);
    expect(r.files).toContain("src/a.ts");
    expect(r.files).not.toContain("src/b.js");
  });

  it("includeIgnored 默认尊重 .gitignore", async () => {
    const tools = buildTools(TID);
    // 写 .gitignore 忽略 node_modules
    await callExecute(tools.writeFile, {
      path: ".gitignore",
      content: "node_modules/\n",
    });
    await callExecute(tools.writeFile, {
      path: "node_modules/secret.js",
      content: "x",
    });
    const r = (await callExecute(tools.glob, { pattern: "**/*.js" })) as {
      ok: boolean;
      files: string[];
    };
    expect(r.files).toContain("src/b.js");
    expect(r.files).not.toContain("node_modules/secret.js");
  });

  it("无匹配 → 空数组", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.glob, { pattern: "**/*.py" })) as {
      ok: boolean;
      files: string[];
    };
    expect(r.ok).toBe(true);
    expect(r.files).toEqual([]);
  });
});

describe("grep", () => {
  it("返回结构化匹配（path/line/text）", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.grep, { pattern: "foo" })) as {
      ok: boolean;
      matches: Array<{ path: string; line: number; text: string }>;
    };
    expect(r.ok).toBe(true);
    expect(r.matches.length).toBe(2);
    const paths = r.matches.map((m) => m.path);
    expect(paths.every((p) => p === "src/a.ts")).toBe(true);
    expect(r.matches.map((m) => m.line).sort()).toEqual([2, 4]);
    expect(r.matches[0]?.text).toContain("foo");
  });

  it("caseInsensitive 大小写不敏感", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "case-insensitive.md",
      content: "Hello\nHELLO\nhello\n",
    });
    const r = (await callExecute(tools.grep, {
      pattern: "hello",
      caseInsensitive: true,
    })) as { ok: boolean; matches: Array<{ line: number }> };
    expect(r.ok).toBe(true);
    expect(r.matches.length).toBe(3);
  });

  it("glob 限定搜索文件", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.grep, {
      pattern: "foo",
      glob: "*.js",
    })) as { ok: boolean; matches: unknown[] };
    expect(r.ok).toBe(true);
    // foo 只在 a.ts，限定 *.js → 无匹配
    expect(r.matches.length).toBe(0);
  });

  it("maxResults 截断并标记 truncated", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "many-matches.md",
      content: Array.from({ length: 20 }, () => "foo").join("\n"),
    });
    const r = (await callExecute(tools.grep, {
      pattern: "foo",
      maxResults: 5,
    })) as { ok: boolean; matches: unknown[]; truncated: boolean };
    expect(r.ok).toBe(true);
    expect(r.matches.length).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it("无匹配 → 空 matches，非错误", async () => {
    const tools = buildTools(TID);
    const r = (await callExecute(tools.grep, { pattern: "zzzNoSuchThing" })) as {
      ok: boolean;
      matches: unknown[];
    };
    expect(r.ok).toBe(true);
    expect(r.matches).toEqual([]);
  });
});

describe("新工具经 executeToolRun 收口", () => {
  it("readFileRange 落 tool.called → tool.succeeded", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.readFileRange, { path: "src/a.ts", startLine: 1, endLine: 1 });
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("tool.called");
    expect(types).toContain("tool.succeeded");
    expect(queryMocks.finishToolRunSuccess).toHaveBeenCalled();
  });

  it("glob 的 tool.called 含 permissionKey=tool.glob", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.glob, { pattern: "**/*.ts" });
    const called = queryMocks.appendThreadEvent.mock.calls
      .filter((c) => c[1] === "tool.called")
      .find((c) => (c[2] as { toolName: string }).toolName === "glob");
    expect(called?.[2]).toMatchObject({
      toolName: "glob",
      permissionKey: "tool.glob",
      category: "file",
      risk: "read",
    });
  });
});
