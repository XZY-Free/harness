import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { executeToolRun } from "@/lib/ai/tool-runtime";
import { buildTools } from "@/lib/ai/tools";
import { __resetFormatterAvailableForTest } from "@/lib/policy/hooks";
import { staticPreviewRuntime } from "@/lib/runtime/preview-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 直接测 buildTools() 返回的 tool.execute 封装层（不绕过到底层 workspace 函数）。
 * safeJoin / listWorkspaceFiles 的底层行为另由 workspace.test.ts 覆盖。
 */

const TEST_ROOT = resolve(".test-workspaces-tools");
const TID = "test-tools-unit";
const orig = process.env.SNOW_WORKSPACES_DIR;
const origQaGateEnabled = process.env.QA_GATE_ENABLED;
const queryMocks = vi.hoisted(() => ({
  updateThreadPreviewUrl: vi.fn(),
  updateThreadStatus: vi.fn(),
  createToolRun: vi.fn(),
  appendThreadEvent: vi.fn(),
  finishToolRunSuccess: vi.fn(),
  finishToolRunFailure: vi.fn(),
  listPermissionRules: vi.fn(),
  findMatchingApprovals: vi.fn(),
  consumeOnceApproval: vi.fn(),
  requestApprovalAtomic: vi.fn(),
}));

vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: vi.fn() }));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: vi.fn(),
  updateThreadPreviewUrl: queryMocks.updateThreadPreviewUrl,
  updateThreadStatus: queryMocks.updateThreadStatus,
  createToolRun: queryMocks.createToolRun,
  appendThreadEvent: queryMocks.appendThreadEvent,
  finishToolRunSuccess: queryMocks.finishToolRunSuccess,
  finishToolRunFailure: queryMocks.finishToolRunFailure,
  // V3.1：executeToolRun 权限引擎依赖（默认无 DB 规则、无既有批准 → 走默认规则）
  listPermissionRules: queryMocks.listPermissionRules,
  findMatchingApprovals: queryMocks.findMatchingApprovals,
  consumeOnceApproval: queryMocks.consumeOnceApproval,
  requestApprovalAtomic: queryMocks.requestApprovalAtomic,
}));

// Phase 4-1：policy hook 的执行 seam 单独 mock，避免单测里真起 shell 跑 prettier/npm test。
// （runCommand 工具自身动态 import execa，不走此 seam，仍跑真实命令。）
const execMocks = vi.hoisted(() => ({ runWorkspaceCommand: vi.fn() }));
vi.mock("@/lib/policy/exec", () => ({
  runWorkspaceCommand: execMocks.runWorkspaceCommand,
}));

// readSkillFile 只读本地 git 快照（02 文档 §六.3），mock 底层读取避免真起 git。
const skillReadMocks = vi.hoisted(() => ({
  readSkillFileAtSha: vi.fn(),
}));
vi.mock("@/lib/skill/repo", () => ({
  readSkillFileAtSha: skillReadMocks.readSkillFileAtSha,
}));

type ToolLike = { execute?: (...args: never[]) => unknown };
function callExecute(tool: ToolLike, input: unknown): Promise<unknown> {
  if (!tool.execute) {
    throw new Error("tool.execute missing");
  }
  return Promise.resolve(tool.execute(input as never, { toolCallId: "t", messages: [] } as never));
}

beforeEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = TEST_ROOT;
  process.env.QA_GATE_ENABLED = "false";
  __resetFormatterAvailableForTest(); // S1（07-P2-2）：重置 formatter 可用性缓存（防跨测试泄漏）
  await rm(join(TEST_ROOT, TID), { recursive: true, force: true });
  queryMocks.updateThreadPreviewUrl.mockReset();
  queryMocks.updateThreadStatus.mockReset();
  queryMocks.createToolRun.mockReset();
  queryMocks.appendThreadEvent.mockReset();
  queryMocks.finishToolRunSuccess.mockReset();
  queryMocks.finishToolRunFailure.mockReset();
  queryMocks.listPermissionRules.mockReset();
  queryMocks.findMatchingApprovals.mockReset();
  queryMocks.requestApprovalAtomic.mockReset();
  execMocks.runWorkspaceCommand.mockReset();
  skillReadMocks.readSkillFileAtSha.mockReset();
  queryMocks.createToolRun.mockResolvedValue({ id: "run-1", threadId: TID, status: "running" });
  // V3.1：默认无 DB 权限规则覆盖、无既有批准 → 引擎走 buildDefaultRules 默认规则
  queryMocks.listPermissionRules.mockResolvedValue([]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
  // policy hook 执行层默认成功（best-effort 副作用不影响断言）
  execMocks.runWorkspaceCommand.mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
});

afterEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = orig;
  if (origQaGateEnabled !== undefined) process.env.QA_GATE_ENABLED = origQaGateEnabled;
  else {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.QA_GATE_ENABLED;
  }
  await staticPreviewRuntime.stop(TID);
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("buildTools 工具白名单 (Phase 3 §6.2)", () => {
  it("不传 allowedTools → 返回全部 61 个工具", () => {
    const tools = buildTools(TID);
    expect(Object.keys(tools).sort()).toEqual(
      [
        "writeFile",
        "editFile",
        "multiEditFile",
        "applyPatch",
        "deleteFile",
        "readFile",
        "readFileRange",
        "statFile",
        "glob",
        "grep",
        "listFiles",
        "runCommand",
        "runTests",
        "reportReady",
        "startPreview",
        "stopPreview",
        "getPreviewStatus",
        "startBackgroundTask",
        "readTaskLogs",
        "stopBackgroundTask",
        "listBackgroundTasks",
        "runBuild",
        "installDependencies",
        "gitStatus",
        "gitDiff",
        "gitCheckpoint",
        "gitRestoreCheckpoint",
        "gitCreateBranch",
        "gitCommit",
        "gitPush",
        "createPullRequest",
        "deliverySummary",
        "rememberFact",
        "webFetch",
        "webSearch",
        "searchDocs",
        "listMcpTools",
        "callMcpTool",
        "spawnSubagent",
        "joinSubagent",
        "joinSubagents",
        "capturePreview",
        "runBrowserCheck",
        "runResponsiveCheck",
        "runAccessibilitySmoke",
        "visualVerdict",
        "deployToEnvironment",
        "deployStatus",
        "rollback",
        // V9 阶段 6：AI 浏览器工具
        "browserGetTabs",
        "browserSnapshot",
        "browserGetConsole",
        "browserGetNetwork",
        "browserScreenshot",
        "browserGetPageText",
        "browserNavigate",
        "browserClick",
        "browserType",
        "browserScroll",
        "browserPressKey",
        "browserSelectOption",
        // V9 阶段 8：下载与上传工具
        "browserListDownloads",
        "browserUploadFile",
      ].sort(),
    );
  });

  it("传 null → 返回全部（向后兼容）；传空数组 → 仅含强制注入的 readSkillFile", () => {
    expect(Object.keys(buildTools(TID, null)).length).toBe(63);
    // 审计修复：空 allowlist 不再等价于 null（原行为是安全漏洞：empty → allow-all）。
    // 空数组 → 白名单仅含强制注入的 readSkillFile（无 skillContext 时不存在，结果 0 工具）
    expect(Object.keys(buildTools(TID, [])).length).toBe(0);
  });

  it("传 ['readFile'] → 只含 readFile", () => {
    const tools = buildTools(TID, ["readFile"]);
    expect(Object.keys(tools)).toEqual(["readFile"]);
  });

  it("示例 skill 白名单必须含 reportReady（§4.4 预览闸门依赖）", () => {
    const tools = buildTools(TID, [
      "writeFile",
      "readFile",
      "listFiles",
      "runCommand",
      "runTests",
      "reportReady",
    ]);
    expect(tools).toHaveProperty("reportReady");
  });

  it("白名单外的工具名被静默丢弃", () => {
    const tools = buildTools(TID, ["readFile", "noSuchTool"]);
    expect(Object.keys(tools)).toEqual(["readFile"]);
  });

  it("V3.4 自定义工具注入 buildTools + 白名单过滤", () => {
    const decl = {
      name: "deploy",
      description: "部署",
      inputSchema: { type: "object" },
      executorType: "webhook" as const,
      executorConfig: { url: "https://example.com/hook", method: "POST" },
    };
    // 不传 allowedTools → 自定义工具可见
    const all = buildTools(TID, undefined, undefined, undefined, [decl]);
    expect(all).toHaveProperty("deploy");
    // 白名单不含 deploy → 被过滤
    const filtered = buildTools(TID, ["readFile"], undefined, undefined, [decl]);
    expect(filtered).not.toHaveProperty("deploy");
    expect(filtered).toHaveProperty("readFile");
    // 白名单含 deploy → 保留
    const incl = buildTools(TID, ["readFile", "deploy"], undefined, undefined, [decl]);
    expect(incl).toHaveProperty("deploy");
    // 不传 declarations → 无自定义工具（零回归）
    const none = buildTools(TID);
    expect(none).not.toHaveProperty("deploy");
  });
});

describe("多 skill 工具可见性收敛 (Phase 3 Stage E)", () => {
  it("refactor-ui skill 白名单不含 runCommand → agent 看不到 runCommand", () => {
    // 第二个 skill 故意收窄：只读 + 写，不给执行命令权
    const refactorUiTools = ["readFile", "writeFile", "listFiles", "reportReady"];
    const tools = buildTools(TID, refactorUiTools);
    const names = Object.keys(tools).sort();
    expect(names).toEqual(["listFiles", "readFile", "reportReady", "writeFile"]);
    expect(names).not.toContain("runCommand");
    expect(names).not.toContain("runTests");
    // reportReady 仍在 → 预览闸门可用（不同 skill 仍可交付预览）
    expect(names).toContain("reportReady");
  });

  it("示例 skill 与 refactor-ui 工具集不同，并存互不干扰", () => {
    const defaultTools = Object.keys(
      buildTools(TID, [
        "writeFile",
        "readFile",
        "listFiles",
        "runCommand",
        "runTests",
        "reportReady",
      ]),
    ).sort();
    const refactorTools = Object.keys(
      buildTools(TID, ["readFile", "writeFile", "listFiles", "reportReady"]),
    ).sort();
    expect(defaultTools).toHaveLength(6);
    expect(refactorTools).toHaveLength(4);
    expect(defaultTools).not.toEqual(refactorTools);
  });
});

// ─── V8 阶段 6：Skill 不再作为工具安全边界 ───

describe("buildTools V8 Skill 不影响工具可见性 (阶段 6)", () => {
  it("chat 路径传 undefined → 全部工具可见（不受 Skill allowedTools 限制）", () => {
    // V8：chat 路径不再传 allowedTools，即使 Skill 声明了 allowedTools 也不影响工具可见性
    const tools = buildTools(TID, undefined, undefined, {
      source: "local",
      name: "test-skill",
      commitSha: "abc123",
      skillVersionId: "v1",
    });
    // 64 = 63 内置工具 + readSkillFile（skillContext 有 commitSha 时挂载）
    expect(Object.keys(tools)).toHaveLength(64);
    expect(tools).toHaveProperty("runCommand");
    expect(tools).toHaveProperty("readSkillFile");
  });

  it("Skill 有 skillContext 但不传 allowedTools → readSkillFile 挂载 + 全部工具可见", () => {
    const tools = buildTools(TID, undefined, undefined, {
      source: "local",
      name: "s",
      commitSha: "abc",
      skillVersionId: "v1",
    });
    // 64 = 63 内置 + readSkillFile（skillContext 挂载）
    expect(Object.keys(tools)).toHaveLength(64);
    expect(tools).toHaveProperty("readSkillFile");
    expect(tools).toHaveProperty("writeFile");
    expect(tools).toHaveProperty("runCommand");
    expect(tools).toHaveProperty("deployToEnvironment");
  });

  it("无 Skill → 全部工具可见（零回归）", () => {
    const tools = buildTools(TID);
    expect(Object.keys(tools)).toHaveLength(63);
  });

  it("subagent 路径仍可用 allowedTools 做可见工具过滤（与 Skill 安全边界无关）", () => {
    // subagent 的 allowedTools 是子代理工具范围限制，不是 Skill 安全边界
    const tools = buildTools(TID, ["readFile", "glob", "grep"]);
    expect(Object.keys(tools).sort()).toEqual(["glob", "grep", "readFile"]);
  });
});

describe("readSkillFile 按 source 分发 (V8 补充方案阶段 4)", () => {
  it("local source：读 git 快照成功，evidence 记本地 sha256 截断", async () => {
    skillReadMocks.readSkillFileAtSha.mockResolvedValue("# 指令\n步骤一");
    const evidence: import("@/lib/ai/tools").SkillLoadEvidenceEntry[] = [];
    const tools = buildTools(TID, undefined, undefined, {
      source: "local",
      name: "build-from-idea",
      commitSha: "abc1234",
      skillVersionId: "v1",
      evidence,
    });
    const r = (await callExecute(tools.readSkillFile!, { path: "SKILL.md" })) as {
      ok: boolean;
      path: string;
      content: string;
    };
    expect(r.ok).toBe(true);
    expect(r.path).toBe("SKILL.md");
    expect(r.content).toBe("# 指令\n步骤一");
    expect(skillReadMocks.readSkillFileAtSha).toHaveBeenCalledWith(
      "build-from-idea",
      "SKILL.md",
      "abc1234",
    );
    // local 源 evidence 用本地 sha256 截断 16 位
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.path).toBe("SKILL.md");
    expect(evidence[0]?.skillVersionId).toBe("v1");
    expect(evidence[0]?.contentHash).toHaveLength(16);
    expect(evidence[0]?.truncated).toBe(false);
  });

  it("local source：文件不存在 → ok:false", async () => {
    skillReadMocks.readSkillFileAtSha.mockResolvedValue(null);
    const tools = buildTools(TID, undefined, undefined, {
      source: "local",
      name: "s",
      commitSha: "abc",
    });
    const r = (await callExecute(tools.readSkillFile!, { path: "nope.md" })) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("文件不存在");
  });
});

describe("buildTools().execute", () => {
  it("writeFile 写入后 readFile 读回", async () => {
    const tools = buildTools(TID);
    const w = await callExecute(tools.writeFile, { path: "a.txt", content: "hi" });
    expect(w).toMatchObject({ ok: true, path: "a.txt" });
    const r = await callExecute(tools.readFile, { path: "a.txt" });
    expect(r).toMatchObject({ ok: true, content: "hi" });
  });

  it("readFile 不存在 → ok:false + 文件不存在", async () => {
    const r = await callExecute(buildTools(TID).readFile, { path: "nope.txt" });
    expect(r).toEqual({ ok: false, path: "nope.txt", error: "文件不存在" });
  });

  it("readFile 越界 → ok:false", async () => {
    const r = await callExecute(buildTools(TID).readFile, { path: "../../etc/passwd" });
    expect(r).toMatchObject({ ok: false });
  });

  it("runCommand 跑 echo 返回 stdout/exitCode", async () => {
    const tools = buildTools(TID);
    // 先写一个文件确保工作区目录存在（runCommand 的 cwd）
    await callExecute(tools.writeFile, { path: ".keep", content: "" });
    const r = (await callExecute(tools.runCommand, { command: "echo hi" })) as {
      ok: boolean;
      exitCode: number;
      stdout: string;
    };
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hi");
  });

  it("listFiles 返回写入的文件", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: "x/y.txt", content: "1" });
    const r = (await callExecute(tools.listFiles, {})) as { files: string[] };
    expect(r.files).toContain("x/y.txt");
  });

  it("reportReady 在探活成功后返回 url 并落 ready_for_review", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>ok</body></html>",
    });

    const r = (await callExecute(tools.reportReady, { summary: "已完成自检" })) as {
      ok: boolean;
      url: string;
      summary: string;
    };

    expect(r.ok).toBe(true);
    expect(r.url).toBe(`/preview/${TID}/index.html`);
    expect(r.summary).toBe("已完成自检");
    expect(queryMocks.updateThreadPreviewUrl).toHaveBeenCalledWith(TID, r.url);
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "ready_for_review");
  });

  it("reportReady 在探活失败后返回错误并保持 executing", async () => {
    const tools = buildTools(TID);

    const r = (await callExecute(tools.reportReady, { summary: "已完成自检" })) as {
      ok: boolean;
      error: string;
      summary: string;
    };

    expect(r.ok).toBe(false);
    expect(r.error).toContain("探活失败：HTTP 404");
    expect(r.summary).toBe("已完成自检");
    expect(queryMocks.updateThreadPreviewUrl).toHaveBeenCalledWith(TID, null);
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "executing");
  });
});

describe("executeToolRun 事件配对 (Stage B)", () => {
  it("成功路径：tool.called → tool.succeeded，落 tool_runs.succeeded", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: "a.txt", content: "hi" });

    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toEqual(["tool.called", "tool.succeeded"]);
    // V3.0 Stage B：tool.called payload 附带 category/risk/permissionKey metadata
    // V7 S2-3：appendThreadEvent 新增第 4 个 runId 参数（测试未设置 run scope → null）
    expect(queryMocks.appendThreadEvent).toHaveBeenCalledWith(
      TID,
      "tool.called",
      {
        toolRunId: "run-1",
        toolName: "writeFile",
        input: { path: "a.txt", content: "hi" },
        category: "file",
        risk: "write",
        permissionKey: "tool.writeFile",
      },
      null,
    );
    expect(queryMocks.finishToolRunSuccess).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ ok: true, path: "a.txt" }),
    );
    expect(queryMocks.finishToolRunFailure).not.toHaveBeenCalled();
  });

  it("crash 失败：runner 抛异常 → tool.failed(crash) + tool_runs.failed，收敛为 {ok:false} 返回（P1-4：不中断主循环）", async () => {
    // P1-4：crash 不再重新抛出，而是收敛为 { ok:false, failureKind:"crash" } 让 agent 决定重试/换方案。
    // 仅 AbortError（中断信号）向上抛，让 streamText 正常终止。
    const out = await executeToolRun(TID, "boomTool", { x: 1 }, async () => {
      throw new Error("kaboom");
    });
    expect(out).toMatchObject({ ok: false, error: "kaboom", failureKind: "crash" });

    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toEqual(["tool.called", "tool.failed"]);
    expect(queryMocks.finishToolRunFailure).toHaveBeenCalledWith("run-1", "kaboom");
    expect(queryMocks.finishToolRunSuccess).not.toHaveBeenCalled();
    const failed = queryMocks.appendThreadEvent.mock.calls.find((c) => c[1] === "tool.failed");
    expect(failed?.[2]).toMatchObject({ failureKind: "crash" });
  });

  it("crash 失败：AbortError 仍向上抛（P1-4：中断信号传播，让 streamText 终止）", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    await expect(
      executeToolRun(TID, "abortTool", { x: 1 }, async () => {
        throw abort;
      }),
    ).rejects.toBe(abort);
  });

  it("business 失败：runner 返回 {ok:false} → tool.failed(business) + tool_runs.failed，结果原样透传", async () => {
    const out = await executeToolRun(TID, "bizTool", { x: 1 }, async () => ({
      ok: false,
      error: "boom-business",
    }));
    // 不抛、原样透传给上层（agent 契约不变）
    expect(out).toEqual({ ok: false, error: "boom-business" });
    // 但落 tool_runs.failed + tool.failed(business)
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toEqual(["tool.called", "tool.failed"]);
    expect(queryMocks.finishToolRunFailure).toHaveBeenCalledWith("run-1", "boom-business");
    expect(queryMocks.finishToolRunSuccess).not.toHaveBeenCalled();
    const failed = queryMocks.appendThreadEvent.mock.calls.find((c) => c[1] === "tool.failed");
    expect(failed?.[2]).toMatchObject({ failureKind: "business" });
  });

  it("reportReady 成功仍保持 {ok,url,summary} 契约", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>ok</body></html>",
    });
    const r = (await callExecute(tools.reportReady, { summary: "done" })) as {
      ok: boolean;
      url: string;
      summary: string;
    };
    expect(r).toMatchObject({ ok: true, summary: "done" });
    expect(r.url).toBe(`/preview/${TID}/index.html`);
    // reportReady 同样经 executeToolRun，留下 tool.called → tool.succeeded
    const types = queryMocks.appendThreadEvent.mock.calls
      .filter((c) => c[1] !== undefined)
      .map((c) => c[1]);
    expect(types).toContain("tool.called");
    expect(types).toContain("tool.succeeded");
  });
});

describe("beforeTool policy 拦截 (Phase 4-1 Stage B)", () => {
  it("writeFile 写 .git/ → ok:false + 未真正写入 + tool.failed(policy)", async () => {
    const tools = buildTools(TID);
    const w = (await callExecute(tools.writeFile, {
      path: ".git/config",
      content: "evil",
    })) as { ok: boolean; error?: string };

    expect(w.ok).toBe(false);
    expect(w.error).toContain("policy 拦截");
    // runner 未跑 → 文件未写入
    const r = (await callExecute(tools.readFile, { path: ".git/config" })) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    // 落 tool.failed(policy)，payload 带 reason
    const failed = queryMocks.appendThreadEvent.mock.calls.find((c) => c[1] === "tool.failed");
    expect(failed?.[2]).toMatchObject({ failureKind: "policy" });
    expect(queryMocks.finishToolRunFailure).toHaveBeenCalledWith(
      "run-1",
      expect.stringContaining("policy 拦截"),
    );
    expect(queryMocks.finishToolRunSuccess).not.toHaveBeenCalled();
  });

  it("runCommand rm -rf / → ok:false + 命令未执行", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: ".keep", content: "" }); // 确保工作区存在
    const r = (await callExecute(tools.runCommand, { command: "rm -rf /" })) as {
      ok: boolean;
      error?: string;
      exitCode?: number;
    };

    expect(r.ok).toBe(false);
    expect(r.error).toContain("policy 拦截");
    // runner 未跑：结果无 exitCode（若跑了会返回 execa 的 exitCode 字段）
    expect(r.exitCode).toBeUndefined();
    // 落 tool.failed(policy)
    const failed = queryMocks.appendThreadEvent.mock.calls
      .filter((c) => c[1] === "tool.failed")
      .at(-1);
    expect(failed?.[2]).toMatchObject({ failureKind: "policy" });
  });

  it("正常 writeFile / runCommand 不受 policy 影响（不回归）", async () => {
    const tools = buildTools(TID);
    const w = await callExecute(tools.writeFile, { path: "a.txt", content: "hi" });
    expect(w).toMatchObject({ ok: true, path: "a.txt" });
    const c = (await callExecute(tools.runCommand, { command: "echo hi" })) as {
      ok: boolean;
      exitCode: number;
    };
    expect(c.ok).toBe(true);
    expect(c.exitCode).toBe(0);
  });
});

describe("afterTool 写后自动格式化 (Phase 4-1 Stage C)", () => {
  it("writeFile 成功 → 格式化命令被触发（含路径）", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: "src/a.js", content: "var x=1" });

    expect(execMocks.runWorkspaceCommand).toHaveBeenCalledWith(
      TID,
      expect.stringContaining("prettier --write"),
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    const cmd = execMocks.runWorkspaceCommand.mock.calls.at(-1)?.[1];
    expect(cmd).toContain("src/a.js");
    // 格式化是 afterTool 副作用，writeFile 仍正常落 succeeded
    expect(queryMocks.finishToolRunSuccess).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ ok: true, path: "src/a.js" }),
    );
  });

  it("格式化非零退出 → fail-open，writeFile 仍 ok:true", async () => {
    execMocks.runWorkspaceCommand.mockResolvedValue({
      exitCode: 127, // prettier 未安装
      stdout: "",
      stderr: "prettier: not found",
      timedOut: false,
    });
    const tools = buildTools(TID);
    const w = await callExecute(tools.writeFile, { path: "b.txt", content: "x" });
    expect(w).toMatchObject({ ok: true, path: "b.txt" });
    expect(queryMocks.finishToolRunSuccess).toHaveBeenCalled();
    expect(queryMocks.finishToolRunFailure).not.toHaveBeenCalled();
  });

  it("格式化抛异常 → fail-open，writeFile 仍 ok:true", async () => {
    execMocks.runWorkspaceCommand.mockRejectedValue(new Error("spawn ENOENT"));
    const tools = buildTools(TID);
    const w = await callExecute(tools.writeFile, { path: "c.txt", content: "x" });
    expect(w).toMatchObject({ ok: true, path: "c.txt" });
    expect(queryMocks.finishToolRunSuccess).toHaveBeenCalled();
  });

  it("非 writeFile 工具不触发格式化", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: ".keep", content: "" }); // 建工作区
    execMocks.runWorkspaceCommand.mockClear();
    await callExecute(tools.runCommand, { command: "echo hi" });
    // runCommand 走自己的 execa，不触发 policy/exec 的格式化 seam
    expect(execMocks.runWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("文件名含 shell 元字符 → 格式化命令把路径单引号转义（防注入）", async () => {
    const tools = buildTools(TID);
    // safeJoin 只防越界，不防文件名内的 shell 元字符；治理层自身不能成为注入面
    const evil = "a;touch HACKED.js";
    await callExecute(tools.writeFile, { path: evil, content: "x" });

    const cmd = execMocks.runWorkspaceCommand.mock.calls.at(-1)?.[1] as string;
    // 注入 payload 落在单引号内 → shell 视作字面量文件名，不会拆成独立命令
    expect(cmd).toContain("'a;touch HACKED.js'");
    // 不存在未转义的裸路径形式（即不是 `--write a;touch ...`）
    expect(cmd).not.toMatch(/--write\s+a;touch/);
  });
});

// ─── V3.0 Stage B：tool.called 事件附带 registry metadata ─────

describe("tool.called 事件附带 registry metadata (Stage B)", () => {
  it("writeFile 的 tool.called 含 category=file / risk=write / permissionKey", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: "a.txt", content: "hi" });
    const called = queryMocks.appendThreadEvent.mock.calls.find((c) => c[1] === "tool.called");
    expect(called?.[2]).toMatchObject({
      category: "file",
      risk: "write",
      permissionKey: "tool.writeFile",
    });
  });

  it("runCommand 的 tool.called 含 category=command / risk=execute", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: ".keep", content: "" });
    await callExecute(tools.runCommand, { command: "echo hi" });
    const called = queryMocks.appendThreadEvent.mock.calls
      .filter((c) => c[1] === "tool.called")
      .find((c) => (c[2] as { toolName: string }).toolName === "runCommand");
    expect(called?.[2]).toMatchObject({
      category: "command",
      risk: "execute",
      permissionKey: "tool.runCommand",
    });
  });

  it("skill allowedTools 白名单过滤行为不变（不回归）", () => {
    const tools = buildTools(TID, ["readFile", "writeFile"]);
    expect(Object.keys(tools).sort()).toEqual(["readFile", "writeFile"]);
  });
});
