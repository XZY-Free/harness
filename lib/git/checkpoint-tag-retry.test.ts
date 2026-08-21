import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1（09-P2-5）：checkpoint tag 碰撞重试专项测试。
 *
 * createCheckpoint 的 gitTag 碰撞(already exists)时重试新 tag(最多 3 次)。
 * 原 checkpoint.test 用真实 git 难造碰撞,未覆盖重试路径。
 * mock ops.gitTag 第一次抛 already exists、第二次成功,验证重试 + 最终成功;
 * 3 次全碰撞 → 抛错冒泡。
 */

const ops = vi.hoisted(() => ({
  gitTag: vi.fn(),
  gitDiff: vi.fn().mockResolvedValue({ diff: "", truncated: false }),
}));

const q = vi.hoisted(() => ({
  createCheckpointRow: vi.fn(),
}));

vi.mock("@/lib/git/ops", () => ({
  gitTag: ops.gitTag,
  gitDiff: ops.gitDiff,
}));

vi.mock("@/lib/workspace", () => ({ workspaceRoot: () => "/tmp/ws" }));

vi.mock("@/lib/db/queries", () => ({
  createCheckpointRow: q.createCheckpointRow,
}));

import { createCheckpoint } from "@/lib/git/checkpoint";

beforeEach(() => {
  ops.gitTag.mockReset();
  ops.gitDiff.mockReset().mockResolvedValue({ diff: "", truncated: false });
  q.createCheckpointRow
    .mockReset()
    .mockImplementation(async (p: { tag: string; commitSha: string }) => ({
      id: "cp-1",
      threadId: "t1",
      tag: p.tag,
      commitSha: p.commitSha,
      reason: "r",
      filesChanged: null,
      toolRunId: null,
      createdAt: new Date(),
    }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCheckpoint tag 碰撞重试（09-P2-5）", () => {
  it("首次成功 → 不重试(1 次 gitTag)", async () => {
    ops.gitTag.mockResolvedValueOnce({ commitSha: "sha-1" });
    await createCheckpoint("t1", { reason: "r" });
    expect(ops.gitTag).toHaveBeenCalledTimes(1);
  });

  it("首次碰撞(already exists) → 重试新 tag,第二次成功", async () => {
    ops.gitTag
      .mockRejectedValueOnce(new Error("fatal: tag 'cp-xxx' already exists"))
      .mockResolvedValueOnce({ commitSha: "sha-2" });
    await createCheckpoint("t1", { reason: "r" });
    expect(ops.gitTag).toHaveBeenCalledTimes(2);
    // 两次用的 tag 不同(重试生成新 tag)
    const tag1 = ops.gitTag.mock.calls[0]?.[1];
    const tag2 = ops.gitTag.mock.calls[1]?.[1];
    expect(tag1).not.toBe(tag2);
  });

  it("碰撞消息 'tag exists'(小写) → 也重试", async () => {
    ops.gitTag
      .mockRejectedValueOnce(new Error("tag exists"))
      .mockResolvedValueOnce({ commitSha: "sha-3" });
    await createCheckpoint("t1", { reason: "r" });
    expect(ops.gitTag).toHaveBeenCalledTimes(2);
  });

  it("非碰撞错误(如 push 失败) → 不重试,直接抛错", async () => {
    ops.gitTag.mockRejectedValueOnce(new Error("fatal: not a git repository"));
    await expect(createCheckpoint("t1", { reason: "r" })).rejects.toThrow(/not a git repository/);
    expect(ops.gitTag).toHaveBeenCalledTimes(1);
  });

  it("3 次全碰撞 → 抛错冒泡(不吞)", async () => {
    ops.gitTag
      .mockRejectedValueOnce(new Error("already exists"))
      .mockRejectedValueOnce(new Error("already exists"))
      .mockRejectedValueOnce(new Error("already exists"));
    await expect(createCheckpoint("t1", { reason: "r" })).rejects.toThrow(/already exists/);
    expect(ops.gitTag).toHaveBeenCalledTimes(3);
  });

  it("重试成功 → createCheckpointRow 用最终成功的 tag", async () => {
    ops.gitTag
      .mockRejectedValueOnce(new Error("already exists"))
      .mockResolvedValueOnce({ commitSha: "sha-final" });
    await createCheckpoint("t1", { reason: "r" });
    const finalTag = ops.gitTag.mock.calls[1]?.[1];
    expect(q.createCheckpointRow).toHaveBeenCalledWith(
      expect.objectContaining({ tag: finalTag, commitSha: "sha-final" }),
    );
  });
});
