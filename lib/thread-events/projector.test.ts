import type { ThreadEvent } from "@/lib/db/schema";
import { projectThread } from "@/lib/thread-events/projector";
import { describe, expect, it } from "vitest";

/** 构造事件的极简 helper，省去与投影无关的字段。 */
function ev(
  type: ThreadEvent["type"],
  payload: Record<string, unknown>,
  sequence = 1,
): ThreadEvent {
  return {
    id: `e${sequence}`,
    threadId: "tid",
    sequence,
    type,
    runId: null,
    payload,
    createdAt: new Date(),
  };
}

describe("projectThread 状态投影", () => {
  it("空事件序列 → status null、无 artifact", () => {
    expect(projectThread([])).toEqual({
      status: null,
      previewUrl: null,
      latestArtifact: null,
      subagents: [],
    });
  });

  // S1（04-G10）：subagent 事件投影
  it("subagent.spawned/joined/failed → subagents 投影（runId→最近状态）", () => {
    const events = [
      ev("subagent.spawned", { runId: "r1", role: "explore" }, 1),
      ev("subagent.spawned", { runId: "r2", role: "researcher" }, 2),
      ev("subagent.joined", { runId: "r1", status: "completed" }, 3),
      ev("subagent.failed", { runId: "r2", status: "failed" }, 4),
    ];
    const proj = projectThread(events);
    const map = new Map(proj.subagents.map((s) => [s.runId, s.status]));
    expect(map.get("r1")).toBe("completed");
    expect(map.get("r2")).toBe("failed");
  });

  it("idle：最后一个 status_changed.to = idle", () => {
    const events = [
      ev("agent.status_changed", { from: "executing", to: "idle", reason: "run_idle" }),
    ];
    expect(projectThread(events).status).toBe("idle");
  });

  it("executing：agent.started + status_changed→executing", () => {
    const events = [
      ev("agent.started", { reason: "user_message_received" }, 1),
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 2),
    ];
    expect(projectThread(events).status).toBe("executing");
    expect(projectThread(events).previewUrl).toBeNull();
  });

  it("ready_for_review：探活通过后 artifact.created + status_changed→ready_for_review", () => {
    const url = "/preview/prev/";
    const events = [
      ev("agent.started", { reason: "user_message_received" }, 1),
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 2),
      ev("artifact.created", { type: "preview", status: "ready_for_review", previewUrl: url }, 3),
      ev(
        "agent.status_changed",
        { from: "executing", to: "ready_for_review", reason: "preview_ready" },
        4,
      ),
    ];
    const proj = projectThread(events);
    expect(proj.status).toBe("ready_for_review");
    expect(proj.previewUrl).toBe(url);
    expect(proj.latestArtifact).toMatchObject({
      type: "preview",
      status: "ready_for_review",
      previewUrl: url,
    });
  });

  it("failed：收尾 status_changed→failed 为最终态", () => {
    const events = [
      ev("agent.started", { reason: "user_message_received" }, 1),
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 2),
      ev("agent.status_changed", { from: "executing", to: "failed", reason: "run_failed" }, 3),
    ];
    expect(projectThread(events).status).toBe("failed");
    expect(projectThread(events).previewUrl).toBeNull();
  });
});

describe("projectThread artifact 投影", () => {
  it("artifact.updated 覆盖 latestArtifact 与 previewUrl", () => {
    const events = [
      ev(
        "artifact.created",
        { type: "preview", status: "ready_for_review", previewUrl: "http://a/" },
        1,
      ),
      ev(
        "artifact.updated",
        { type: "preview", status: "ready_for_review", previewUrl: "http://b/" },
        2,
      ),
    ];
    const proj = projectThread(events);
    expect(proj.previewUrl).toBe("http://b/");
    expect(proj.latestArtifact?.previewUrl).toBe("http://b/");
  });

  it("忽略 tool.* 事件，不影响 status / artifact", () => {
    const events = [
      ev("tool.called", { toolRunId: "r1", toolName: "writeFile", input: {} }, 1),
      ev("tool.succeeded", { toolRunId: "r1", output: { ok: true } }, 2),
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 3),
    ];
    const proj = projectThread(events);
    expect(proj.status).toBe("executing");
    expect(proj.latestArtifact).toBeNull();
  });
});

describe("projectThread 一致性校验（§12.4：回放结果应与 Thread 投影一致）", () => {
  it("完整 ready_for_review 流程回放 = Thread 投影列", () => {
    const url = "/preview/prev/";
    const events: ThreadEvent[] = [
      ev("agent.started", { reason: "user_message_received" }, 1),
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 2),
      ev(
        "tool.called",
        { toolRunId: "r1", toolName: "reportReady", input: { summary: "done" } },
        3,
      ),
      ev("artifact.created", { type: "preview", status: "ready_for_review", previewUrl: url }, 4),
      ev("tool.succeeded", { toolRunId: "r1", output: { ok: true, url, summary: "done" } }, 5),
      ev(
        "agent.status_changed",
        { from: "executing", to: "ready_for_review", reason: "preview_ready" },
        6,
      ),
    ];
    const proj = projectThread(events);

    // 与 threads 投影列对齐：status=ready_for_review、previewUrl=url
    expect(proj.status).toBe("ready_for_review");
    expect(proj.previewUrl).toBe(url);
    // latestArtifact 即预览 artifact
    expect(proj.latestArtifact).toMatchObject({ type: "preview", previewUrl: url });
  });

  it("完整 failed 流程回放 = Thread 投影列（previewUrl 为空）", () => {
    const events: ThreadEvent[] = [
      ev("agent.started", { reason: "user_message_received" }, 1),
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 2),
      ev("agent.status_changed", { from: "executing", to: "failed", reason: "run_failed" }, 3),
    ];
    const proj = projectThread(events);
    expect(proj.status).toBe("failed");
    expect(proj.previewUrl).toBeNull();
  });
});

// ─── V3.0：新事件类型不破坏既有投影 ─────────────────────────

describe("projectThread 容忍 V3.0 新事件类型", () => {
  it("context.snapshot_created / plan.* 事件被忽略，不改 status / artifact", () => {
    const events: ThreadEvent[] = [
      ev("agent.started", { reason: "user_message_received" }, 1),
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 2),
      ev("context.snapshot_created", { snapshotId: "s1", estimatedTokens: 1234 }, 3),
      ev("plan.created", { planId: "p1", title: "demo" }, 4),
      ev("plan.item_updated", { itemId: "i1", status: "in_progress" }, 5),
      ev("plan.updated", { planId: "p1", status: "abandoned" }, 6),
    ];
    const proj = projectThread(events);
    expect(proj.status).toBe("executing");
    expect(proj.previewUrl).toBeNull();
    expect(proj.latestArtifact).toBeNull();
  });
});

// ─── V3.1：审批事件不破坏既有投影 ───────────────────────────

describe("projectThread 容忍 V3.1 审批事件", () => {
  it("tool.approval_requested / tool.approval_resolved 被忽略，不改 status / artifact", () => {
    const events: ThreadEvent[] = [
      ev("agent.started", { reason: "user_message_received" }, 1),
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 2),
      ev(
        "tool.approval_requested",
        {
          approvalId: "a1",
          toolRunId: "r1",
          toolName: "deleteFile",
          permissionKey: "tool.deleteFile",
          argSummary: "path=x",
        },
        3,
      ),
      ev(
        "tool.approval_resolved",
        {
          approvalId: "a1",
          toolRunId: "r1",
          decision: "approved",
          scope: "thread",
          resolvedBy: "u1",
        },
        4,
      ),
    ];
    const proj = projectThread(events);
    // 审批状态由 ToolApprovalRequest 表承载，不进 status 投影；status 仍为最后一个 status_changed
    expect(proj.status).toBe("executing");
    expect(proj.previewUrl).toBeNull();
    expect(proj.latestArtifact).toBeNull();
  });
});

// ─── V3.2：后台任务事件不破坏既有投影 ───────────────────────

describe("projectThread 容忍 V3.2 后台任务事件", () => {
  it("task.started / task.stopped / task.failed 被忽略，不改 status / artifact", () => {
    const events: ThreadEvent[] = [
      ev("agent.started", { reason: "user_message_received" }, 1),
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 2),
      ev(
        "task.started",
        {
          taskId: "bt1",
          kind: "dev-server",
          command: "npm run dev",
          runtimeType: "host",
          pid: 123,
        },
        3,
      ),
      ev("task.stopped", { taskId: "bt1", exitCode: 0, reason: "manual" }, 4),
      ev("task.failed", { taskId: "bt2", error: "boom" }, 5),
    ];
    const proj = projectThread(events);
    // 任务状态由 BackgroundTask 表承载，不进 status 投影；status 仍为最后一个 status_changed
    expect(proj.status).toBe("executing");
    expect(proj.previewUrl).toBeNull();
    expect(proj.latestArtifact).toBeNull();
  });
});

// ─── V3.3a：压缩事件不破坏既有投影 ───────────────────────────

describe("projectThread 容忍 V3.3a 压缩事件", () => {
  it("context.summary_created / context.compressed 被忽略，不改 status / artifact", () => {
    const events: ThreadEvent[] = [
      ev("agent.started", { reason: "user_message_received" }, 1),
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 2),
      ev(
        "context.summary_created",
        {
          summaryId: "sum1",
          type: "toolRun",
          scope: { toolRunIds: ["tr1"] },
          tokenEstimate: 10,
          originalTokenEstimate: 200,
        },
        3,
      ),
      ev(
        "context.compressed",
        {
          snapshotId: "snap1",
          appliedSummaryIds: ["sum1"],
          excludedCandidateCount: 0,
          protectedCount: 3,
          beforeTokens: 1000,
          afterTokens: 400,
        },
        4,
      ),
    ];
    const proj = projectThread(events);
    // 压缩是派生视图，不进 status 投影；status 仍为最后一个 status_changed
    expect(proj.status).toBe("executing");
    expect(proj.previewUrl).toBeNull();
    expect(proj.latestArtifact).toBeNull();
  });
});

// ─── V3.7：交付 / checkpoint 事件不破坏既有投影 ───────────────

describe("projectThread 容忍 V3.7 交付 / checkpoint 事件", () => {
  it("delivery.succeeded / delivery.failed / git.checkpoint_* 被忽略，不改 status / artifact", () => {
    const events: ThreadEvent[] = [
      ev("agent.started", { reason: "user_message_received" }, 1),
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 2),
      ev(
        "agent.status_changed",
        { from: "executing", to: "delivering", reason: "git_push_succeeded" },
        3,
      ),
      ev(
        "git.checkpoint_created",
        {
          checkpointId: "cp1",
          tag: "snow-checkpoint-abcd1234",
          commitSha: "sha1",
          reason: "before push",
        },
        4,
      ),
      ev(
        "git.checkpoint_restored",
        { checkpointId: "cp1", tag: "snow-checkpoint-abcd1234", restoredTo: "sha1" },
        5,
      ),
      ev(
        "delivery.succeeded",
        {
          commitSha: "sha1",
          branch: "main",
          pushed: true,
          filesChanged: [],
          testResults: { passed: 0, failed: 0 },
        },
        6,
      ),
      ev("delivery.failed", { reason: "push rejected" }, 7),
    ];
    const proj = projectThread(events);
    // 交付状态由 thread.status 列承载（agent.status_changed 驱动），delivery.*/git.* 仅作事件流审计
    expect(proj.status).toBe("delivering");
    expect(proj.previewUrl).toBeNull();
    expect(proj.latestArtifact).toBeNull();
  });
});

describe("projectThread V3.3b memory 事件不破坏投影", () => {
  it("memory.created / memory.revoked 被忽略，不影响 status / artifact", () => {
    const events = [
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 1),
      ev(
        "memory.created",
        {
          memoryId: "m1",
          scope: "project",
          kind: "convention",
          textHash: "h",
          confidence: "high",
          provenanceSummary: "user#u1",
        },
        2,
      ),
      ev("memory.revoked", { memoryId: "m1", reason: "过时", revokedBy: "u1" }, 3),
    ];
    const proj = projectThread(events);
    expect(proj.status).toBe("executing");
    expect(proj.previewUrl).toBeNull();
    expect(proj.latestArtifact).toBeNull();
  });
});

describe("V3.4 external.*/mcp.* 事件不破坏投影", () => {
  it("external.fetched / mcp.listed / mcp.called 不改变 status / artifact 投影", () => {
    const events: ThreadEvent[] = [
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 1),
      ev("external.fetched", { sourceUrl: "https://x.com", contentHash: "h", truncated: false }, 2),
      ev("mcp.listed", { server: "github", toolCount: 5 }, 3),
      ev(
        "mcp.called",
        {
          server: "github",
          tool: "create_issue",
          permissionKey: "mcp.github.create_issue",
          ok: true,
        },
        4,
      ),
    ];
    const proj = projectThread(events);
    // status 仍取最后一个 status_changed.to，不被新事件干扰
    expect(proj.status).toBe("executing");
    expect(proj.latestArtifact).toBeNull();
    expect(proj.previewUrl).toBeNull();
  });

  it("仅有 external/mcp 事件、无 status_changed → status null（零回归）", () => {
    const events: ThreadEvent[] = [
      ev("external.fetched", { sourceUrl: "https://x.com" }, 1),
      ev("mcp.called", { server: "github", tool: "create_issue", ok: false }, 2),
    ];
    const proj = projectThread(events);
    expect(proj.status).toBeNull();
    expect(proj.latestArtifact).toBeNull();
  });
});

// ─── V3.5：子代理事件不破坏既有投影 ───────────────────────────

describe("projectThread 容忍 V3.5 子代理事件", () => {
  it("subagent.spawned / joined / failed 被忽略，不改 status / artifact", () => {
    const events: ThreadEvent[] = [
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 1),
      ev(
        "subagent.spawned",
        { runId: "sr1", definitionId: "def-1", role: "explore", goal: "find x" },
        2,
      ),
      ev(
        "subagent.joined",
        { runId: "sr1", status: "completed", resultSummary: "found 3", outputArtifactId: "art-1" },
        3,
      ),
      ev("subagent.failed", { runId: "sr2", status: "timed_out", errorMessage: "step limit" }, 4),
    ];
    const proj = projectThread(events);
    // 子代理状态由 SubagentRun 表承载，不进 status 投影；status 仍为最后一个 status_changed
    expect(proj.status).toBe("executing");
    expect(proj.previewUrl).toBeNull();
    expect(proj.latestArtifact).toBeNull();
  });

  it("仅有 subagent.* 事件、无 status_changed → status null（零回归）", () => {
    const events: ThreadEvent[] = [
      ev("subagent.spawned", { runId: "sr1", role: "explore", goal: "g" }, 1),
      ev("subagent.joined", { runId: "sr1", status: "completed" }, 2),
    ];
    const proj = projectThread(events);
    expect(proj.status).toBeNull();
    expect(proj.latestArtifact).toBeNull();
  });
});

// ─── V3.6：QA gate 事件不破坏既有投影 ───────────────────────

describe("projectThread 容忍 V3.6 QA 事件", () => {
  it("qa.check_passed / qa.check_failed 被忽略，不改 status / artifact", () => {
    const events: ThreadEvent[] = [
      ev("agent.status_changed", { from: "idle", to: "executing", reason: "chat_started" }, 1),
      ev(
        "qa.check_passed",
        {
          checkId: "qa1",
          kind: "gate",
          viewports: [375, 768, 1280],
          durationMs: 1200,
          artifactPath: "t/qa/qa1.json",
        },
        2,
      ),
      ev(
        "qa.check_failed",
        {
          checkId: "qa2",
          kind: "browser",
          viewports: [1280],
          failures: [{ type: "console_error", detail: "boom", artifactPath: null }],
          durationMs: 300,
        },
        3,
      ),
    ];
    const proj = projectThread(events);
    // QA 状态由事件流审计承载，不进 status 投影；status 仍为最后一个 status_changed
    expect(proj.status).toBe("executing");
    expect(proj.previewUrl).toBeNull();
    expect(proj.latestArtifact).toBeNull();
  });

  it("仅有 qa.* 事件、无 status_changed → status null（零回归）", () => {
    const events: ThreadEvent[] = [
      ev("qa.check_passed", { checkId: "qa1", kind: "gate", viewports: [], durationMs: 0 }, 1),
      ev("qa.check_failed", { checkId: "qa2", kind: "a11y", failures: [], durationMs: 0 }, 2),
    ];
    const proj = projectThread(events);
    expect(proj.status).toBeNull();
    expect(proj.latestArtifact).toBeNull();
  });
});
