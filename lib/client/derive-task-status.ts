/**
 * deriveTaskStatus — 从 ClientTurn 推导任务状态标签和语调。
 *
 * 从 lib/client/derive-task-status.ts 迁移至正式位置。
 */

import type { ClientTurn } from "./types";

export function deriveTaskStatus(turn: ClientTurn | null): {
  readonly label: string;
  readonly tone: "idle" | "running" | "waiting" | "success" | "error" | "stopped";
} {
  if (!turn) return { label: "空闲", tone: "idle" };
  switch (turn.turn_state) {
    case "accepted":
    case "queued":
      return { label: "排队中", tone: "running" };
    case "running":
      return { label: "执行中", tone: "running" };
    case "waiting_user":
      return { label: "等待确认", tone: "waiting" };
    case "regenerating":
      return { label: "重新生成中", tone: "running" };
    case "completed":
      return { label: "已完成", tone: "success" };
    case "interrupted":
      return { label: "已停止", tone: "stopped" };
    case "failed":
      return { label: "失败", tone: "error" };
    case "cancelled":
      return { label: "已取消", tone: "stopped" };
    default:
      return { label: "未知", tone: "idle" };
  }
}
