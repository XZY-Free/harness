import { randomUUID } from "node:crypto";
import {
  createCheckpointRow,
  getCheckpoint,
  listCheckpointsByThread,
  markCheckpointRestored,
} from "@/lib/db/queries";
import type { GitCheckpoint } from "@/lib/db/schema";
import { gitDiff, gitResetHard, gitStatus, gitTag } from "@/lib/git/ops";

/**
 * Stage A：checkpoint 创建 / 列表 / 恢复（plan §5）。
 *
 * checkpoint = 轻量 git tag `snow-checkpoint-{shortId}` + `GitCheckpoint` 表行。
 * restore = `git reset --hard <tag>`（不可逆，由工具层 gitRestoreCheckpoint 走 ask 审批）。
 *
 * 编排：ops 原语产出 tag/commitSha → DB 行 → `git.checkpoint_*` 事件。
 * owner scope：restore 校验 checkpoint 属于当前 thread，防跨 thread 回滚。
 */

/** 生成 `snow-checkpoint-{12 字符 shortId}`。12 字符降碰撞概率，碰撞时重试。 */
function checkpointTag(): string {
  return `snow-checkpoint-${randomUUID().slice(0, 12)}`;
}

/**
 * 创建一个 checkpoint：tag 当前 HEAD → 写 DB 行 → 追加 `git.checkpoint_created` 事件。
 * 要求工作区已是 repo 且有至少一个 commit（否则 gitTag 的 rev-parse HEAD 抛错）。
 * tag 碰撞时重试（最多 3 次）。
 */
export async function createCheckpoint(
  threadId: string,
  params: { reason: string; toolRunId?: string | null },
): Promise<GitCheckpoint> {
  let tag = checkpointTag();
  let commitSha = "";
  // tag 碰撞重试
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await gitTag(threadId, tag);
      commitSha = r.commitSha;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists|tag exists/i.test(msg) && attempt < 2) {
        tag = checkpointTag(); // 重试新 tag
        continue;
      }
      throw err;
    }
  }
  // 取 diff 摘要（变更文件列表，供回滚前快速判断 checkpoint 内容）
  const diffResult = await gitDiff(threadId).catch(() => ({ diff: "", truncated: false }));
  const filesChanged = diffResult.diff.slice(0, 2000) || null;

  const row = await createCheckpointRow({
    threadId,
    tag,
    commitSha,
    reason: params.reason,
    createdByToolRunId: params.toolRunId ?? null,
    filesChanged,
  });
  // 02-3：git.checkpoint_created 事件（Filesystem 域事实）由 02-9 正式 GitCheckpoint Authority 承接。
  return row;
}

/** 列 thread 的全部 checkpoint（最近在前，含 restoredAt）。 */
export async function listCheckpoints(threadId: string): Promise<GitCheckpoint[]> {
  return listCheckpointsByThread(threadId);
}

/**
 * 恢复到指定 checkpoint：`git reset --hard <tag>` → 回填 restoredAt → `git.checkpoint_restored` 事件。
 * checkpoint 不存在或不属于当前 thread → 抛错（工具层转 ok:false）。
 *
 * restore 前检查工作区脏状态——有未提交改动时抛错拒绝（防数据丢失），
 * 调用方（gitRestoreCheckpoint 工具）应提示用户先 commit/stash 或自动创建 checkpoint。
 */
export async function restoreCheckpoint(
  threadId: string,
  checkpointId: string,
): Promise<GitCheckpoint> {
  const cp = await getCheckpoint(checkpointId);
  if (!cp) throw new Error("checkpoint 不存在");
  if (cp.threadId !== threadId) throw new Error("checkpoint 不属于当前 thread");

  // 脏检查——有未提交改动时拒绝 restore（防数据丢失）
  const status = await gitStatus(threadId);
  if (
    status.isRepo &&
    (status.modified.length > 0 || status.staged.length > 0 || status.untracked.length > 0)
  ) {
    throw new Error(
      `工作区有未提交改动（${status.modified.length + status.staged.length} 改 + ${status.untracked.length} 新），restore 会丢失。请先 commit/stash 或创建新 checkpoint。`,
    );
  }

  await gitResetHard(threadId, cp.tag);
  const updated = await markCheckpointRestored(checkpointId);
  // 02-3：git.checkpoint_restored 事件由 02-9 正式 GitCheckpoint Authority 承接。
  return updated ?? cp;
}
