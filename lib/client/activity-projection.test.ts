import {
  activityKindFor,
  isRiskAction,
  mergeThinkEntries,
  projectActivityEvent,
  projectProgressItem,
} from "@/lib/client/activity-projection";
import { createInitialState, threadProjectionReducer } from "@/lib/client/thread-reducer";
import type { ClientEvent } from "@/lib/client/types";
import { describe, expect, it } from "vitest";

function actionEvent(type: string, extra: Record<string, unknown> = {}, seq = 1): ClientEvent {
  return {
    event_id: `ev-${type}-${seq}`,
    sequence: seq,
    schema_version: 1,
    thread_id: "t1",
    turn_id: "turn1",
    item_id: null,
    occurred_at: "2026-09-12T08:00:00.000Z",
    event_type: type,
    payload: {
      action_id: "act-1",
      step_no: 1,
      action_type: "tool_call",
      purpose_code: "query_schedule",
      short_purpose: "查询排班",
      action_payload: { date: "2026-09-13" },
      ...extra,
    },
  } as unknown as ClientEvent;
}

describe("activityKindFor / isRiskAction", () => {
  it("按 purpose 映射图标类别", () => {
    expect(activityKindFor("tool_call", "query_schedule")).toBe("search");
    expect(activityKindFor("tool_call", "read_doc")).toBe("read");
    expect(activityKindFor("tool_call", "reminder_create")).toBe("write");
    expect(activityKindFor("tool_call", "run_script")).toBe("exec");
  });
  it("写类动作标记高危", () => {
    expect(isRiskAction("tool_call", "reminder_create")).toBe(true);
    expect(isRiskAction("tool_call", "query_schedule")).toBe(false);
  });
});

describe("projectActivityEvent", () => {
  it("proposed 携带命令块", () => {
    const entry = projectActivityEvent(actionEvent("harness.action.proposed"));
    expect(entry?.phase).toBe("proposed");
    expect(entry?.label).toContain("准备执行");
    expect(entry?.block).toContain("2026-09-13");
  });
  it("completed 携带命令+结果块", () => {
    const entry = projectActivityEvent(
      actionEvent("harness.action.completed", { observation: { shift: "early" } }),
    );
    expect(entry?.phase).toBe("completed");
    expect(entry?.block).toContain("shift");
  });
  it("failed 投影为 fail 类别", () => {
    const entry = projectActivityEvent(
      actionEvent("harness.action.failed", { error_code: "TOOL_UNAVAILABLE" }),
    );
    expect(entry?.kind).toBe("fail");
    expect(entry?.label).toContain("TOOL_UNAVAILABLE");
  });
  it("非动作事件返回 null", () => {
    expect(projectActivityEvent(actionEvent("turn.accepted"))).toBeNull();
  });
});

describe("projectProgressItem", () => {
  it("progress.snapshot item 投影为思考条目", () => {
    const entry = projectProgressItem({
      id: "item-1",
      turn_id: "turn1",
      content: { kind: "progress.snapshot", message: "正在思考下一步…", think: "决定：查询排班" },
      created_at: "2026-09-12T08:00:00.000Z",
    });
    expect(entry?.kind).toBe("think");
    expect(entry?.block).toBe("查询排班");
  });
  it("非 progress item 返回 null", () => {
    expect(projectProgressItem({ id: "i2", turn_id: "t", content: { kind: "other" } })).toBeNull();
  });
});

describe("threadProjectionReducer activity ring", () => {
  it("动作事件进入 activity，completed 结果合并回 proposed 行块", () => {
    let state = createInitialState("t1");
    state = threadProjectionReducer(state, {
      type: "event.received",
      event: actionEvent("harness.action.proposed", {}, 1),
    });
    expect(state.activity).toHaveLength(1);
    expect(state.activity[0]?.phase).toBe("proposed");

    state = threadProjectionReducer(state, {
      type: "event.received",
      event: actionEvent("harness.action.started", {}, 2),
    });
    expect(state.activity).toHaveLength(1);

    state = threadProjectionReducer(state, {
      type: "event.received",
      event: actionEvent("harness.action.completed", { observation: { shift: "early" } }, 3),
    });
    // completed 不新增行，结果合并进 proposed 行
    expect(state.activity).toHaveLength(1);
    const proposed = state.activity.find((e) => e.phase === "completed");
    expect(proposed?.block).toContain("2026-09-13");
    expect(proposed?.block).toContain("shift");
    expect(proposed?.label).toContain("已执行");
    expect(state.activity.some((e) => e.phase === "started")).toBe(false);
  });

  it("snapshot.loaded 重置 live ring", () => {
    let state = createInitialState("t1");
    state = threadProjectionReducer(state, {
      type: "event.received",
      event: actionEvent("harness.action.proposed", {}, 1),
    });
    state = threadProjectionReducer(state, {
      type: "snapshot.loaded",
      items: [],
      turns: [],
      latestEventCursor: { sequence: 5, event_id: "ev-x" },
    } as never);
    expect(state.activity).toHaveLength(0);
  });
});

describe("mergeThinkEntries", () => {
  it("思考摘要并入前一条思考行，一次决策一行", () => {
    const merged = mergeThinkEntries([
      {
        key: "a",
        turnId: "t",
        kind: "think",
        phase: "think",
        label: "正在思考下一步…",
        block: null,
        risk: false,
        actionId: null,
        occurredAt: "2026-09-12T08:00:00.000Z",
      },
      {
        key: "b",
        turnId: "t",
        kind: "think",
        phase: "think",
        label: "思考完成",
        block: "决定：查询排班",
        risk: false,
        actionId: null,
        occurredAt: "2026-09-12T08:00:01.000Z",
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.block).toBe("决定：查询排班");
  });
});

it("连续无正文进度只更新当前状态，不积累思考行", () => {
  const progress = (id: string, message: string) =>
    projectProgressItem({ id, turn_id: "t", content: { kind: "progress.snapshot", message } })!;
  const result = mergeThinkEntries([
    progress("a", "正在思考下一步…"),
    progress("b", "正在思考下一步…"),
    progress("c", "正在组织回答…"),
  ]);
  expect(result).toHaveLength(1);
  expect(result[0]?.label).toBe("正在组织回答…");
});

it("回答正文不重复生成工具记录，命令详情展示实际参数", () => {
  expect(
    projectActivityEvent(
      actionEvent("harness.action.completed", {
        action_type: "respond",
        action_payload: { evidenceRefs: [] },
      }),
    ),
  ).toBeNull();
  const command = projectActivityEvent(
    actionEvent("harness.action.proposed", {
      action_type: "tool.call",
      action_payload: {
        toolId: "internal-id",
        operationId: "shell",
        arguments: { command: "date; pwd" },
      },
    }),
  );
  expect(command?.block).toBe("$ date; pwd");
});

it("确认请求由操作卡片展示，不在执行日志重复展示过时等待状态", () => {
  expect(
    projectActivityEvent(actionEvent("user_action.requested", { request_id: "request-1" })),
  ).toBeNull();
});

it("工具返回失败时不把动作结束显示为执行成功", () => {
  const entry = projectActivityEvent(
    actionEvent("harness.action.completed", {
      observation: { data: { state: "failed", errorCode: "WEB_REQUEST_FAILED" } },
    }),
  );
  expect(entry?.phase).toBe("failed");
  expect(entry?.label).toContain("执行失败");
});

it("命令记录显示原命令与输出，不泄漏执行协议元数据", () => {
  const entry = projectActivityEvent(
    actionEvent("harness.action.completed", {
      action_type: "tool.call",
      purpose_code: "fetch_time",
      action_payload: { operationId: "shell", arguments: { command: "date +%F" } },
      observation: {
        summary: "运行命令 执行完成",
        sourceRefs: ["tool-call:internal"],
        data: {
          state: "succeeded",
          result: { stdout: "2026-09-13\n", stderr: "", exitCode: 0, ok: true },
        },
      },
    }),
  );
  expect(entry?.kind).toBe("exec");
  expect(entry?.label).toBe("已运行 date +%F");
  expect(entry?.block).toBe("$ date +%F\n2026-09-13");
  expect(entry?.block).not.toContain("sourceRefs");
});
it("网页工具使用读取图标和正文，不展示缓存路径或 hash", () => {
  const entry = projectActivityEvent(
    actionEvent("harness.action.completed", {
      action_type: "tool.call",
      action_payload: { operationId: "web-fetch", arguments: { url: "https://example.com" } },
      observation: {
        data: {
          state: "succeeded",
          result: { ok: true, text: "Example Domain", source: { artifactPath: "internal/path" } },
        },
      },
    }),
  );
  expect(entry?.kind).toBe("read");
  expect(entry?.block).toBe("https://example.com\nExample Domain");
});

it("用户拒绝的工具显示未执行，不误报执行失败", () => {
  const entry = projectActivityEvent(
    actionEvent("harness.action.completed", {
      action_type: "tool.call",
      observation: { data: { state: "cancelled", errorCode: "USER_DENIED" } },
    }),
  );
  expect(entry?.phase).toBe("cancelled");
  expect(entry?.label).toContain("未执行");
});
