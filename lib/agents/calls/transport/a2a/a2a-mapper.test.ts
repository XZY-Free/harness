import {
  createA2AArtifactCache,
  mapAgentCallUpdate,
} from "@/lib/agents/calls/transport/a2a/a2a-mapper";
import { describe, expect, it } from "vitest";

describe("A2A completed Host Action 投影边界", () => {
  it("单个不安全 URL 动作被过滤，但 completed 文本和结构化数据保留", () => {
    const events = mapAgentCallUpdate(
      "call-1",
      1,
      {
        kind: "status-update",
        taskId: "task-1",
        contextId: "context-1",
        status: {
          state: "completed",
          final: true,
          message: {
            role: "agent",
            parts: [
              { kind: "text", text: "已完成查询" },
              {
                kind: "data",
                data: {
                  result: { status: "ok" },
                  host_controls: {
                    version: "1",
                    ui_actions: [
                      {
                        action_id: "unsafe-support",
                        action_type: "open_external_link",
                        title: "联系支持",
                        label: "联系支持",
                        description: null,
                        target_key: null,
                        url: "javascript:alert(1)",
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
      createA2AArtifactCache(),
      {
        confirmationActionKeys: [],
        uiActionTypes: ["open_external_link"],
        uiActionTargetKeys: [],
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("call.completed");
    expect(events[0]?.payload).toMatchObject({
      text: "已完成查询",
      data: {
        result: { status: "ok" },
        host_controls: { version: "1", ui_actions: [] },
      },
    });
  });

  it("failed 缺少 status.message 时保留最新 artifact 的可读失败原因", () => {
    const artifacts = createA2AArtifactCache();
    mapAgentCallUpdate(
      "call-1",
      1,
      {
        kind: "artifact-update",
        taskId: "task-1",
        contextId: "context-1",
        artifact: {
          artifactId: "artifact-1",
          parts: [
            {
              kind: "text",
              text: "暂时无法取得排班数据，请稍后再试。",
            },
          ],
        },
      },
      artifacts,
    );

    const events = mapAgentCallUpdate(
      "call-1",
      2,
      {
        kind: "status-update",
        taskId: "task-1",
        contextId: "context-1",
        status: { state: "failed", final: true },
      },
      artifacts,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      error: {
        code: "REMOTE_TASK_FAILED",
        message: "暂时无法取得排班数据，请稍后再试。",
      },
    });
  });
});
