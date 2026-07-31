import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.7 Stage A：checkpoint 编排测试。
 * mock DB queries（createCheckpointRow/getCheckpoint/markCheckpointRestored/appendThreadEvent/listCheckpointsByThread），
 * 真实 git tag/reset（只 mock workspaceRoot 路径解析器）。
 */

const tmp = vi.hoisted(() => ({ root: "" }));
vi.mock("@/lib/workspace", () => ({
  workspaceRoot: (threadId: string) => join(tmp.root, threadId),
}));

const q = vi.hoisted(() => ({
  createCheckpointRow: vi.fn(),
  getCheckpoint: vi.fn(),
  markCheckpointRestored: vi.fn(),
  appendThreadEvent: vi.fn(),
  listCheckpointsByThread: vi.fn(),
}));
vi.mock("@/lib/db/queries", () => ({
  createCheckpointRow: q.createCheckpointRow,
  getCheckpoint: q.getCheckpoint,
  markCheckpointRestored: q.markCheckpointRestored,
  appendThreadEvent: q.appendThreadEvent,
  listCheckpointsByThread: q.listCheckpointsByThread,
}));

import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "@/lib/git/checkpoint";
import { gitAdd, gitCommit } from "@/lib/git/ops";

const TID = "cp-thread";
function ws(): string {
  return join(tmp.root, TID);
}
function gitCli(args: string[]): string {
  return execFileSync("git", args, { cwd: ws(), encoding: "utf8" }).trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  tmp.root = mkdtempSync(join(tmpdir(), "snow-git-cp-"));
  mkdirSync(ws(), { recursive: true });
  q.appendThreadEvent.mockResolvedValue({});
  q.markCheckpointRestored.mockImplementation(async (id: string) => ({
    id,
    restoredAt: new Date(),
  }));
});

afterEach(() => {
  rmSync(tmp.root, { recursive: true, force: true });
});

/** 工作区准备一个有 commit 的 repo。 */
async function seedRepo(): Promise<void> {
  writeFileSync(join(ws(), "a.txt"), "v1");
  await gitAdd(TID);
  await gitCommit(TID, "first");
}

describe("createCheckpoint", () => {
  it("tag HEAD → 写 DB 行 → 追加 git.checkpoint_created 事件", async () => {
    await seedRepo();
    q.createCheckpointRow.mockImplementation(async (p: { tag: string; commitSha: string }) => ({
      id: "cp-1",
      threadId: TID,
      tag: p.tag,
      commitSha: p.commitSha,
      reason: "before push",
      createdByToolRunId: null,
      restoredAt: null,
      createdAt: new Date(),
    }));

    const cp = await createCheckpoint(TID, { reason: "before push" });

    // tag 真实落地
    expect(cp.tag).toMatch(/^snow-checkpoint-/);
    expect(gitCli(["tag", "--list"])).toContain(cp.tag);
    expect(cp.commitSha).toBe(gitCli(["rev-parse", "HEAD"]));
    // DB 行写入
    expect(q.createCheckpointRow).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: TID, reason: "before push", commitSha: cp.commitSha }),
    );
    // 事件
    expect(q.appendThreadEvent).toHaveBeenCalledWith(
      TID,
      "git.checkpoint_created",
      expect.objectContaining({ checkpointId: "cp-1", tag: cp.tag, reason: "before push" }),
    );
  });

  it("toolRunId 透传到 DB 行", async () => {
    await seedRepo();
    q.createCheckpointRow.mockResolvedValue({ id: "cp-2", threadId: TID });
    await createCheckpoint(TID, { reason: "r", toolRunId: "tr-9" });
    expect(q.createCheckpointRow).toHaveBeenCalledWith(
      expect.objectContaining({ createdByToolRunId: "tr-9" }),
    );
  });
});

describe("listCheckpoints", () => {
  it("透传 listCheckpointsByThread", async () => {
    q.listCheckpointsByThread.mockResolvedValue([{ id: "cp-1", threadId: TID }]);
    const list = await listCheckpoints(TID);
    expect(q.listCheckpointsByThread).toHaveBeenCalledWith(TID);
    expect(list).toHaveLength(1);
  });
});

describe("restoreCheckpoint", () => {
  it("git reset --hard <tag> → 回填 restoredAt → git.checkpoint_restored 事件", async () => {
    await seedRepo();
    // 建 checkpoint
    q.createCheckpointRow.mockImplementation(async (p: { tag: string; commitSha: string }) => ({
      id: "cp-1",
      threadId: TID,
      tag: p.tag,
      commitSha: p.commitSha,
      reason: "snap",
      createdByToolRunId: null,
      restoredAt: null,
      createdAt: new Date(),
    }));
    const cp = await createCheckpoint(TID, { reason: "snap" });

    // 制造后续改动并提交
    writeFileSync(join(ws(), "a.txt"), "v2");
    await gitAdd(TID);
    await gitCommit(TID, "second");
    expect(gitCli(["log", "-1", "--format=%s"])).toBe("second");

    // restore
    q.getCheckpoint.mockResolvedValue(cp);
    const restored = await restoreCheckpoint(TID, cp.id);
    expect(restored.restoredAt).toBeInstanceOf(Date);
    // 回到 first
    expect(gitCli(["log", "-1", "--format=%s"])).toBe("first");
    expect(q.markCheckpointRestored).toHaveBeenCalledWith(cp.id);
    expect(q.appendThreadEvent).toHaveBeenCalledWith(
      TID,
      "git.checkpoint_restored",
      expect.objectContaining({ checkpointId: cp.id, tag: cp.tag, restoredTo: cp.commitSha }),
    );
  });

  it("checkpoint 不存在 → 抛错", async () => {
    q.getCheckpoint.mockResolvedValue(null);
    await expect(restoreCheckpoint(TID, "ghost")).rejects.toThrow("checkpoint 不存在");
  });

  it("跨 thread checkpoint → 抛错（owner scope）", async () => {
    q.getCheckpoint.mockResolvedValue({ id: "cp-x", threadId: "other-thread", tag: "t" });
    await expect(restoreCheckpoint(TID, "cp-x")).rejects.toThrow("不属于当前 thread");
  });

  // S1（09-P1-3）：脏检查拒绝路径——有未提交改动时拒绝 restore（防数据丢失）
  it("工作区有未提交改动 → 拒绝 restore 并提示先 commit/stash", async () => {
    await seedRepo();
    q.createCheckpointRow.mockImplementation(async (p: { tag: string; commitSha: string }) => ({
      id: "cp-1",
      threadId: TID,
      tag: p.tag,
      commitSha: p.commitSha,
      reason: "snap",
      createdByToolRunId: null,
      restoredAt: null,
      createdAt: new Date(),
    }));
    const cp = await createCheckpoint(TID, { reason: "snap" });

    // 制造未提交改动（modified + untracked）
    writeFileSync(join(ws(), "a.txt"), "dirty");
    writeFileSync(join(ws(), "new.txt"), "untracked");

    q.getCheckpoint.mockResolvedValue(cp);
    await expect(restoreCheckpoint(TID, cp.id)).rejects.toThrow(/未提交改动/);
    // 未执行 reset
    expect(q.markCheckpointRestored).not.toHaveBeenCalled();
    expect(q.appendThreadEvent).not.toHaveBeenCalledWith(
      TID,
      "git.checkpoint_restored",
      expect.anything(),
    );
  });

  it("工作区干净 → restore 通过（已有用例补充断言：脏检查不误拒）", async () => {
    await seedRepo();
    q.createCheckpointRow.mockImplementation(async (p: { tag: string; commitSha: string }) => ({
      id: "cp-2",
      threadId: TID,
      tag: p.tag,
      commitSha: p.commitSha,
      reason: "snap",
      createdByToolRunId: null,
      restoredAt: null,
      createdAt: new Date(),
    }));
    const cp = await createCheckpoint(TID, { reason: "snap" });

    // 工作区干净（无 modified/staged/untracked）
    q.getCheckpoint.mockResolvedValue(cp);
    const restored = await restoreCheckpoint(TID, cp.id);
    expect(restored.restoredAt).toBeInstanceOf(Date);
    expect(q.markCheckpointRestored).toHaveBeenCalledWith(cp.id);
  });
});
