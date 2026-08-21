import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.7 Stage C：buildDeliverySummary 聚合测试。
 * mock 正式链（listThreadEvents）+ DB（listToolRunsByThread）+ ops（gitStatus / gitRemoteUrl），
 * 断言聚合字段完整、空字段不报错、blindCommit 标记逻辑。
 * 02-3：正式 Thread 无 previewUrl，previewUrl 恒为 null（Delivery 域 02-9 承接）。
 */

const db = vi.hoisted(() => ({
  listToolRunsByThread: vi.fn(),
}));
vi.mock("@/lib/db/queries", () => ({
  listToolRunsByThread: db.listToolRunsByThread,
}));

const threadQueries = vi.hoisted(() => ({
  listThreadEvents: vi.fn(),
}));
vi.mock("@/lib/conversations/thread-queries", () => ({
  listThreadEvents: threadQueries.listThreadEvents,
}));

const ops = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitRemoteUrl: vi.fn(),
}));
vi.mock("@/lib/git/ops", () => ({
  gitStatus: ops.gitStatus,
  gitRemoteUrl: ops.gitRemoteUrl,
}));

import { buildDeliverySummary } from "@/lib/delivery/summary";

const TENANT = "acme";
const TID = "sum-thread";

beforeEach(() => {
  vi.clearAllMocks();
  db.listToolRunsByThread.mockResolvedValue([]);
  threadQueries.listThreadEvents.mockResolvedValue([]);
  ops.gitStatus.mockResolvedValue({
    isRepo: true,
    current: "main",
    staged: [],
    modified: [],
    untracked: [],
    ahead: 0,
    behind: 0,
  });
  ops.gitRemoteUrl.mockResolvedValue("https://github.com/owner/repo.git");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function toolRun(p: {
  toolName: string;
  status?: string;
  startedAt: Date;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}) {
  return {
    id: `r-${p.toolName}`,
    threadId: TID,
    toolName: p.toolName,
    status: p.status ?? "succeeded",
    input: p.input ?? {},
    output: p.output ?? null,
    error: null,
    startedAt: p.startedAt,
    finishedAt: p.startedAt,
  };
}

describe("buildDeliverySummary 空状态", () => {
  it("无任何交付 ToolRun → commitSha/branch=null，pushed=false，blindCommit=false", async () => {
    const s = await buildDeliverySummary(TENANT, TID);
    expect(s.commitSha).toBeNull();
    expect(s.pushed).toBe(false);
    expect(s.prUrl).toBeNull();
    expect(s.blindCommit).toBe(false);
    expect(s.previewUrl).toBeNull();
    expect(s.filesChanged).toEqual([]);
    expect(s.testResults).toEqual({ passed: 0, failed: 0, summary: "" });
    expect(s.screenshots).toEqual([]);
  });
});

describe("buildDeliverySummary 聚合", () => {
  it("聚合 commit/push/tests/PR/filesChanged/tested", async () => {
    const t0 = new Date("2026-06-01T00:00:00Z");
    const t1 = new Date("2026-06-01T00:01:00Z");
    const t2 = new Date("2026-06-01T00:02:00Z");
    const t3 = new Date("2026-06-01T00:03:00Z");
    db.listToolRunsByThread.mockResolvedValue([
      toolRun({
        toolName: "gitStatus",
        startedAt: t0, // commit 前读过 → not blind
      }),
      toolRun({
        toolName: "gitCommit",
        startedAt: t1,
        input: { subject: "feat: x", tested: "pnpm test", notTested: "live push" },
        output: { commitSha: "abc123" },
      }),
      toolRun({
        toolName: "gitPush",
        startedAt: t2,
        output: { pushed: true, branch: "main", remote: "origin" },
      }),
      toolRun({
        toolName: "createPullRequest",
        startedAt: t3,
        output: {
          prUrl: "https://github.com/owner/repo/pull/1",
          deliveryLink: "https://github.com/owner/repo/pull/1",
        },
      }),
      toolRun({
        toolName: "runTests",
        startedAt: t3,
        output: { stdout: "Tests  12 passed | 1 failed" },
      }),
    ]);
    ops.gitStatus.mockResolvedValue({
      isRepo: true,
      current: "main",
      staged: [],
      modified: ["src/a.ts", "src/b.ts"],
      untracked: ["c.ts"],
      ahead: 0,
      behind: 0,
    });

    const s = await buildDeliverySummary(TENANT, TID);
    expect(s.commitSha).toBe("abc123");
    expect(s.branch).toBe("main");
    expect(s.pushed).toBe(true);
    expect(s.prUrl).toBe("https://github.com/owner/repo/pull/1");
    expect(s.deliveryLink).toBe("https://github.com/owner/repo/pull/1");
    expect(s.tested).toBe("pnpm test");
    expect(s.notTested).toBe("live push");
    expect(s.testResults).toEqual({
      passed: 12,
      failed: 1,
      summary: "Tests  12 passed | 1 failed",
    });
    expect(s.filesChanged).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "modified" },
      { path: "c.ts", status: "untracked" },
    ]);
    expect(s.blindCommit).toBe(false);
  });

  it("blindCommit=true：gitCommit 前未读 gitStatus/gitDiff", async () => {
    const t0 = new Date("2026-06-01T00:00:00Z");
    db.listToolRunsByThread.mockResolvedValue([
      toolRun({
        toolName: "gitCommit",
        startedAt: t0,
        input: { subject: "blind" },
        output: { commitSha: "sha1" },
      }),
    ]);
    const s = await buildDeliverySummary(TENANT, TID);
    expect(s.blindCommit).toBe(true);
  });

  it("prUrl 注入优先（opts.prUrl）", async () => {
    const s = await buildDeliverySummary(TENANT, TID, { prUrl: "https://injected/pr/9" });
    expect(s.prUrl).toBe("https://injected/pr/9");
  });

  it("无测试 ToolRun → testResults 全 0，不报错", async () => {
    const s = await buildDeliverySummary(TENANT, TID);
    expect(s.testResults).toEqual({ passed: 0, failed: 0, summary: "" });
  });
});
