import { computeArgFingerprint } from "@/lib/permission/approval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.7 Stage B：git 工具组单测。
 * 直接测 buildGitTools 返回的 tool.execute（经 executeToolRun 包裹）。
 * 用真实权限引擎（buildDefaultRules 含新 git ask 规则）+ mock DB/ops/checkpoint：
 * - 写工具默认 ask → awaitingApproval（配合 V3.1 引擎，无 mock 规则）。
 * - status/diff 无 ask 规则 → allow → runner 执行。
 * - 批准升级（findMatchingApprovals 返回匹配 approved）→ ask→allow → runner 执行。
 */

const TID = "test-git-tools";

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

const ops = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitDiff: vi.fn(),
  gitAdd: vi.fn(),
  gitCommit: vi.fn(),
  gitBranch: vi.fn(),
  gitPush: vi.fn(),
  gitRemoteUrl: vi.fn(),
}));
vi.mock("@/lib/git/ops", () => ({
  gitStatus: ops.gitStatus,
  gitDiff: ops.gitDiff,
  gitAdd: ops.gitAdd,
  gitCommit: ops.gitCommit,
  gitBranch: ops.gitBranch,
  gitPush: ops.gitPush,
  gitRemoteUrl: ops.gitRemoteUrl,
  gitTag: vi.fn(),
  gitResetHard: vi.fn(),
  ensureRemote: vi.fn(),
}));

const execaMock = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa: execaMock }));

const summaryMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/delivery/summary", () => ({ buildDeliverySummary: summaryMock }));

const cp = vi.hoisted(() => ({
  createCheckpoint: vi.fn(),
  restoreCheckpoint: vi.fn(),
  listCheckpoints: vi.fn(),
}));
vi.mock("@/lib/git/checkpoint", () => ({
  createCheckpoint: cp.createCheckpoint,
  restoreCheckpoint: cp.restoreCheckpoint,
  listCheckpoints: cp.listCheckpoints,
}));

import { buildGitTools } from "./git";

type ToolLike = { execute?: (...args: never[]) => unknown };
function callExecute(tool: ToolLike, input: unknown): Promise<unknown> {
  if (!tool.execute) throw new Error("tool.execute missing");
  return Promise.resolve(tool.execute(input as never, { toolCallId: "t", messages: [] } as never));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMocks.createToolRun.mockImplementation(async (p: { status?: string }) => ({
    id: "run-1",
    threadId: TID,
    status: p.status ?? "running",
  }));
  queryMocks.appendThreadEvent.mockResolvedValue({});
  queryMocks.finishToolRunSuccess.mockResolvedValue(undefined);
  queryMocks.finishToolRunFailure.mockResolvedValue(undefined);
  queryMocks.updateThreadStatus.mockResolvedValue(undefined);
  queryMocks.requestApprovalAtomic.mockResolvedValue({
    run: { id: "run-ask", status: "awaiting_approval" },
    approval: { id: "appr-1" },
  });
  // 默认无 DB 规则、无已批准 → 写工具走 ask
  queryMocks.listPermissionRules.mockResolvedValue([]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
  execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
  Reflect.deleteProperty(process.env, "GITLAB_TOKEN");
  Reflect.deleteProperty(process.env, "GITLAB_URL");
  Reflect.deleteProperty(process.env, "PR_BASE_BRANCH");
  summaryMock.mockResolvedValue({
    commitSha: "abc",
    branch: "main",
    remoteUrl: "https://github.com/o/r.git",
    pushed: true,
    prUrl: null,
    filesChanged: [],
    testResults: { passed: 1, failed: 0, summary: "" },
    previewUrl: "/preview/t/",
    screenshots: [],
    deliveryLink: null,
    tested: null,
    notTested: null,
    blindCommit: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 构造一个匹配 input 的 approved approval（thread scope，未过期），用于 ask→allow 升级。 */
function approvedApprovalFor(permissionKey: string, input: Record<string, unknown>) {
  return {
    id: "appr-ok",
    threadId: TID,
    toolRunId: "run-old",
    toolName: permissionKey.replace(/^tool\./, ""),
    permissionKey,
    argFingerprint: computeArgFingerprint(permissionKey, input),
    argSummary: "sum",
    status: "approved" as const,
    approvedScope: "thread" as const,
    resolvedBy: "u1",
    resolvedAt: new Date(),
    createdAt: new Date(),
    expiresAt: null,
  };
}

describe("gitStatus / gitDiff（read，不触发 ask）", () => {
  it("gitStatus → allow → 透传结构化状态 + tool.called/tool.succeeded", async () => {
    ops.gitStatus.mockResolvedValue({
      isRepo: true,
      current: "main",
      staged: ["a.ts"],
      modified: [],
      untracked: ["b.ts"],
      ahead: 0,
      behind: 0,
    });
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitStatus, {});
    expect(r).toMatchObject({ ok: true, current: "main", staged: ["a.ts"], untracked: ["b.ts"] });
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("tool.called");
    expect(types).toContain("tool.succeeded");
    expect(queryMocks.requestApprovalAtomic).not.toHaveBeenCalled();
  });

  it("gitDiff → allow → 透传 diff + truncated", async () => {
    ops.gitDiff.mockResolvedValue({ diff: "diff text", truncated: false });
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitDiff, { pathFilter: "src/a.ts" });
    expect(r).toMatchObject({ ok: true, diff: "diff text", truncated: false });
    expect(ops.gitDiff).toHaveBeenCalledWith(TID, { pathFilter: "src/a.ts" });
  });
});

describe("git 写工具默认 ask（无既定批准 → awaitingApproval）", () => {
  it("gitCommit → awaitingApproval + 创建审批请求 + thread 转 awaiting_approval", async () => {
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitCommit, { subject: "feat: x", confidence: "high" });
    expect(r).toMatchObject({ ok: false, awaitingApproval: true, approvalId: "appr-1" });
    expect(queryMocks.requestApprovalAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: TID,
        toolName: "gitCommit",
        permissionKey: "tool.gitCommit",
      }),
    );
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalledWith(TID, "awaiting_approval");
    // ask 路径不跑 runner
    expect(ops.gitAdd).not.toHaveBeenCalled();
    expect(ops.gitCommit).not.toHaveBeenCalled();
  });

  it("gitPush → awaitingApproval", async () => {
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitPush, { branch: "main" });
    expect(r).toMatchObject({ ok: false, awaitingApproval: true });
    expect(ops.gitPush).not.toHaveBeenCalled();
  });

  it("gitRestoreCheckpoint → awaitingApproval（reset --hard 不可逆）", async () => {
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitRestoreCheckpoint, { checkpointId: "cp1" });
    expect(r).toMatchObject({ ok: false, awaitingApproval: true });
    expect(cp.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it("gitCheckpoint → awaitingApproval", async () => {
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitCheckpoint, { reason: "before push" });
    expect(r).toMatchObject({ ok: false, awaitingApproval: true });
    expect(cp.createCheckpoint).not.toHaveBeenCalled();
  });

  it("gitCreateBranch → awaitingApproval", async () => {
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitCreateBranch, { name: "feature" });
    expect(r).toMatchObject({ ok: false, awaitingApproval: true });
    expect(ops.gitBranch).not.toHaveBeenCalled();
  });
});

describe("批准升级后执行（ask→allow）", () => {
  it("gitCommit 批准 → gitAdd + composeCommitMessage + gitCommit；无改动 nothingToCommit", async () => {
    ops.gitCommit.mockResolvedValue({ nothingToCommit: true });
    const input = { subject: "feat: x", confidence: "high" };
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.gitCommit", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitCommit, input);
    expect(r).toMatchObject({ ok: true, nothingToCommit: true });
    expect(ops.gitAdd).toHaveBeenCalledWith(TID);
    // commit message 含主题行与 trailer
    const message = ops.gitCommit.mock.calls[0]?.[1] as string;
    expect(message).toContain("feat: x");
    expect(message).toContain("Confidence: high");
  });

  it("gitCommit 批准 + 有改动 → 返回 commitSha + tool.succeeded", async () => {
    ops.gitCommit.mockResolvedValue({ commitSha: "abc123" });
    const input = { subject: "feat: y" };
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.gitCommit", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitCommit, input);
    expect(r).toMatchObject({ ok: true, commitSha: "abc123" });
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("tool.succeeded");
  });

  it("gitRestoreCheckpoint 批准 → restoreCheckpoint 执行，返回 restored", async () => {
    cp.restoreCheckpoint.mockResolvedValue({
      id: "cp1",
      threadId: TID,
      tag: "snow-checkpoint-abcd1234",
      commitSha: "sha1",
      restoredAt: new Date(),
    });
    const input = { checkpointId: "cp1" };
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.gitRestoreCheckpoint", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitRestoreCheckpoint, input);
    expect(r).toMatchObject({ ok: true, checkpointId: "cp1", tag: "snow-checkpoint-abcd1234" });
    expect(cp.restoreCheckpoint).toHaveBeenCalledWith(TID, "cp1");
  });

  it("gitPush 批准 → 缺省 branch 取当前分支", async () => {
    ops.gitStatus.mockResolvedValue({
      isRepo: true,
      current: "main",
      staged: [],
      modified: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    });
    ops.gitPush.mockResolvedValue({ pushed: true, branch: "main", remote: "origin" });
    const input = {};
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.gitPush", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitPush, input);
    expect(r).toMatchObject({ ok: true, pushed: true, branch: "main" });
    expect(ops.gitPush).toHaveBeenCalledWith(TID, {
      remote: "origin",
      branch: "main",
      force: false,
    });
  });

  it("gitPush 批准但无当前分支 → ok:false（不调 gitPush）", async () => {
    ops.gitStatus.mockResolvedValue({
      isRepo: false,
      current: null,
      staged: [],
      modified: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    });
    const input = {};
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.gitPush", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitPush, input);
    expect(r).toMatchObject({ ok: false });
    expect(ops.gitPush).not.toHaveBeenCalled();
  });
});

// S1（09-P2-7）：gitCommit 接入 validateCommitMessage——subject 校验失败阻断，conventional 不符仅 warn
describe("gitCommit validateCommitMessage 接入", () => {
  it("空 subject → ok:false 阻断提交，不调 gitAdd/gitCommit，不创建 toolRun", async () => {
    const tools = buildGitTools(TID);
    const r = (await callExecute(tools.gitCommit, { subject: "   " })) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不能为空");
    // 校验在 executeToolRun 外层，未进入 runner
    expect(ops.gitAdd).not.toHaveBeenCalled();
    expect(ops.gitCommit).not.toHaveBeenCalled();
    expect(queryMocks.createToolRun).not.toHaveBeenCalled();
  });

  it("超 72 字符 subject → ok:false 阻断提交", async () => {
    const longSubject = "x".repeat(73);
    const tools = buildGitTools(TID);
    const r = (await callExecute(tools.gitCommit, { subject: longSubject })) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("> 72");
    expect(ops.gitCommit).not.toHaveBeenCalled();
  });

  it("合规 conventional subject → ok:true（无 warning）", async () => {
    ops.gitCommit.mockResolvedValue({ commitSha: "sha1" });
    const input = { subject: "feat: 新增登录页" };
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.gitCommit", input),
    ]);
    const tools = buildGitTools(TID);
    const r = (await callExecute(tools.gitCommit, input)) as {
      ok: boolean;
      warning?: string;
      commitSha?: string;
    };
    expect(r.ok).toBe(true);
    expect(r.commitSha).toBe("sha1");
    expect(r.warning).toBeUndefined();
  });

  it("非 conventional subject → ok:true + warning（不阻断）", async () => {
    ops.gitCommit.mockResolvedValue({ commitSha: "sha2" });
    const input = { subject: "随便写的主题" };
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.gitCommit", input),
    ]);
    const tools = buildGitTools(TID);
    const r = (await callExecute(tools.gitCommit, input)) as {
      ok: boolean;
      warning?: string;
      commitSha?: string;
    };
    expect(r.ok).toBe(true);
    expect(r.commitSha).toBe("sha2");
    expect(r.warning).toContain("conventional");
  });
});

describe("createPullRequest", () => {
  it("默认 ask（无既定批准 → awaitingApproval）", async () => {
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.createPullRequest, { title: "PR" });
    expect(r).toMatchObject({ ok: false, awaitingApproval: true });
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("批准 + GitHub remote + gh 成功 → prUrl，fallback=false", async () => {
    ops.gitStatus.mockResolvedValue({
      isRepo: true,
      current: "feature",
      staged: [],
      modified: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    });
    ops.gitRemoteUrl.mockResolvedValue("https://github.com/owner/repo.git");
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "https://github.com/owner/repo/pull/1",
      stderr: "",
    });
    const input = { title: "feat: x" };
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.createPullRequest", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.createPullRequest, input);
    expect(r).toMatchObject({
      ok: true,
      prUrl: "https://github.com/owner/repo/pull/1",
      deliveryLink: "https://github.com/owner/repo/pull/1",
      fallback: false,
    });
    expect(execaMock).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "create"]),
      expect.objectContaining({ reject: false }),
    );
  });

  it("批准 + GitLab remote + token → 创建 Merge Request，fallback=false", async () => {
    ops.gitStatus.mockResolvedValue({
      isRepo: true,
      current: "feature",
      staged: [],
      modified: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    });
    ops.gitRemoteUrl.mockResolvedValue("https://gitlab.com/owner/repo.git");
    process.env.GITLAB_TOKEN = "gl-token";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ web_url: "https://gitlab.com/owner/repo/-/merge_requests/1" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { title: "feat: x", targetBranch: "develop" };
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.createPullRequest", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.createPullRequest, input);
    expect(r).toMatchObject({
      ok: true,
      fallback: false,
      provider: "gitlab",
      prUrl: "https://gitlab.com/owner/repo/-/merge_requests/1",
    });
    expect(execaMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/projects/owner%2Frepo/merge_requests",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"target_branch":"develop"'),
      }),
    );
  });

  it("批准 + GitLab remote 但无 token → 返回 fallback 链接，但诚实标记失败", async () => {
    ops.gitStatus.mockResolvedValue({
      isRepo: true,
      current: "feature",
      staged: [],
      modified: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    });
    ops.gitRemoteUrl.mockResolvedValue("https://gitlab.com/owner/repo.git");
    const input = {};
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.createPullRequest", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.createPullRequest, input);
    expect(r).toMatchObject({ ok: false, fallback: true, provider: "gitlab" });
    expect(r).toHaveProperty("deliveryLink");
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("批准 + gh 失败 + GitHub token → REST API 创建 PR", async () => {
    ops.gitStatus.mockResolvedValue({
      isRepo: true,
      current: "feature",
      staged: [],
      modified: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    });
    ops.gitRemoteUrl.mockResolvedValue("https://github.com/owner/repo.git");
    execaMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "command not found" });
    process.env.GITHUB_TOKEN = "gh-token";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/owner/repo/pull/2" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { title: "feat: api" };
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.createPullRequest", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.createPullRequest, input);
    expect(r).toMatchObject({
      ok: true,
      fallback: false,
      provider: "github",
      prUrl: "https://github.com/owner/repo/pull/2",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"base":"main"'),
      }),
    );
  });

  it("批准 + gh 失败且无 token → 返回 fallback 链接，但诚实标记失败", async () => {
    ops.gitStatus.mockResolvedValue({
      isRepo: true,
      current: "feature",
      staged: [],
      modified: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    });
    ops.gitRemoteUrl.mockResolvedValue("https://github.com/owner/repo.git");
    execaMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "command not found" });
    const input = {};
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.createPullRequest", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.createPullRequest, input);
    expect(r).toMatchObject({ ok: false, fallback: true, provider: "github" });
    expect(r).toHaveProperty("deliveryLink");
  });
});

describe("deliverySummary（read，不触发 ask）", () => {
  it("deliverySummary → allow → 透传 buildDeliverySummary 结果", async () => {
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.deliverySummary, {});
    expect(r).toMatchObject({ ok: true });
    expect(summaryMock).toHaveBeenCalledWith(TID);
    expect(queryMocks.requestApprovalAtomic).not.toHaveBeenCalled();
  });
});

// ─── V3.7 Stage D：thread 交付生命周期 ───────────────────────

describe("交付生命周期", () => {
  it("gitPush 批准成功 → thread 转 delivering + agent.status_changed", async () => {
    ops.gitStatus.mockResolvedValue({
      isRepo: true,
      current: "main",
      staged: [],
      modified: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    });
    ops.gitPush.mockResolvedValue({ pushed: true, branch: "main", remote: "origin" });
    const input = {};
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.gitPush", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitPush, input);
    expect(r).toMatchObject({ ok: true, pushed: true });
    expect(queryMocks.appendThreadEvent).toHaveBeenCalledWith(
      TID,
      "agent.status_changed",
      expect.objectContaining({ to: "delivering", reason: "git_push_succeeded" }),
    );
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "delivering");
  });

  it("gitPush 批准但 push 抛错 → 仅作为可恢复工具失败，不终结 thread", async () => {
    ops.gitStatus.mockResolvedValue({
      isRepo: true,
      current: "main",
      staged: [],
      modified: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    });
    ops.gitPush.mockRejectedValue(new Error("push rejected"));
    const input = {};
    queryMocks.findMatchingApprovals.mockResolvedValue([
      approvedApprovalFor("tool.gitPush", input),
    ]);

    const tools = buildGitTools(TID);
    const r = await callExecute(tools.gitPush, input);
    expect(r).toMatchObject({ ok: false, error: "push rejected" });
    expect(queryMocks.appendThreadEvent).not.toHaveBeenCalledWith(
      TID,
      "delivery.failed",
      expect.anything(),
    );
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalledWith(TID, "failed");
  });

  it("deliverySummary 已推送 → completed + delivery.succeeded（payload = summary）", async () => {
    summaryMock.mockResolvedValue({
      commitSha: "abc",
      branch: "main",
      remoteUrl: "https://github.com/o/r.git",
      pushed: true,
      prUrl: null,
      filesChanged: [{ path: "a.ts", status: "modified" }],
      testResults: { passed: 1, failed: 0, summary: "" },
      previewUrl: "/preview/t/",
      screenshots: [],
      deliveryLink: null,
      tested: "pnpm test",
      notTested: null,
      blindCommit: false,
    });
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.deliverySummary, {});
    expect(r).toMatchObject({ ok: true });
    expect(queryMocks.appendThreadEvent).toHaveBeenCalledWith(
      TID,
      "delivery.succeeded",
      expect.objectContaining({ commitSha: "abc", pushed: true }),
    );
    expect(queryMocks.appendThreadEvent).toHaveBeenCalledWith(
      TID,
      "agent.status_changed",
      expect.objectContaining({ to: "completed", reason: "delivery_succeeded" }),
    );
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "completed");
  });

  it("deliverySummary 未推送 → 不切 completed，仅返回摘要", async () => {
    summaryMock.mockResolvedValue({
      commitSha: null,
      branch: null,
      remoteUrl: null,
      pushed: false,
      prUrl: null,
      filesChanged: [],
      testResults: { passed: 0, failed: 0, summary: "" },
      previewUrl: null,
      screenshots: [],
      deliveryLink: null,
      tested: null,
      notTested: null,
      blindCommit: false,
    });
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.deliverySummary, {});
    expect(r).toMatchObject({ ok: true });
    expect(queryMocks.appendThreadEvent).not.toHaveBeenCalledWith(
      TID,
      "delivery.succeeded",
      expect.anything(),
    );
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalledWith(TID, "completed");
  });

  it("deliverySummary 聚合抛错 → delivery.failed + failed", async () => {
    summaryMock.mockRejectedValue(new Error("summary boom"));
    const tools = buildGitTools(TID);
    const r = await callExecute(tools.deliverySummary, {});
    expect(r).toMatchObject({ ok: false, error: "summary boom" });
    expect(queryMocks.appendThreadEvent).toHaveBeenCalledWith(
      TID,
      "delivery.failed",
      expect.objectContaining({ step: "deliverySummary", reason: "summary boom" }),
    );
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "failed");
  });
});
