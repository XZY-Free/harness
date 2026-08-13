import type { ThreadEvent } from "@/lib/db/schema";

/**
 * Stage E：事件回放 / projector（方案 ）。
 *
 * 纯函数：输入某 thread 的 append-only 事件序列，输出当前投影状态。
 * 只负责 thread 状态解释，不重建完整消息流（.2）。
 *
 * 投影规则（§11 Stage E）：
 * - status：取最后一个 `agent.status_changed.to`；无则 null
 * - previewUrl / latestArtifact：取最后一个 `artifact.created` / `artifact.updated`
 * 的 payload（预览是 artifact 的一种，payload.type = "preview"）
 *
 * `tool.approval_requested` / `tool.approval_resolved` 不参与 status / artifact
 * 投影（审批状态由 ToolApprovalRequest 表承载，见 lib/permission/）。未知事件类型一律忽略。
 *
 * `subagent.spawned` / `subagent.joined` / `subagent.failed` 不参与 status / artifact
 * 投影（子代理状态由 SubagentRun 表承载，见 lib/subagent/）。未知事件类型一律忽略——
 * 故 subagent.* 事件天然不破坏投影，无需特判。
 */

export type ArtifactProjection = {
  type: string;
  status?: string;
  previewUrl?: string;
};

export type SubagentProjection = {
  runId: string;
  status: string;
};

export type ThreadProjection = {
  status: string | null;
  previewUrl: string | null;
  latestArtifact: ArtifactProjection | null;
  /**
   * 子代理投影。从 subagent.spawned/joined/failed 事件推导每个 run 的最近状态,
   * 供 Studio 实时展示（替代 5s 轮询）。仍以 SubagentRun 表为权威源,投影仅作快速回放。
   */
  subagents: SubagentProjection[];
};

export function projectThread(events: ThreadEvent[]): ThreadProjection {
  let status: string | null = null;
  let latestArtifact: ArtifactProjection | null = null;
  // subagent run → 最近状态（spawned=running, joined=completed/cancelled, failed=failed/timed_out）
  const subagentMap = new Map<string, string>();

  for (const event of events) {
    if (event.type === "agent.status_changed") {
      const payload = event.payload as { to?: string };
      if (payload.to) {
        status = payload.to;
      }
    } else if (event.type === "artifact.created" || event.type === "artifact.updated") {
      const payload = event.payload as { type?: string; status?: string; previewUrl?: string };
      latestArtifact = {
        type: payload.type ?? "preview",
        status: payload.status,
        previewUrl: payload.previewUrl,
      };
    } else if (event.type === "subagent.spawned") {
      const payload = event.payload as { runId?: string };
      if (payload.runId) subagentMap.set(payload.runId, "running");
    } else if (event.type === "subagent.joined") {
      const payload = event.payload as { runId?: string; status?: string };
      if (payload.runId) subagentMap.set(payload.runId, payload.status ?? "completed");
    } else if (event.type === "subagent.failed") {
      const payload = event.payload as { runId?: string; status?: string };
      if (payload.runId) subagentMap.set(payload.runId, payload.status ?? "failed");
    }
  }

  return {
    status,
    previewUrl: latestArtifact?.previewUrl ?? null,
    latestArtifact,
    subagents: [...subagentMap.entries()].map(([runId, s]) => ({ runId, status: s })),
  };
}
