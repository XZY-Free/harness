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
});
