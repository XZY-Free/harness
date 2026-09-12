import {
  activityKindFor,
  isRiskAction,
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
    expect(entry?.block).toBe("决定：查询排班");
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
    expect(state.activity).toHaveLength(2);

    state = threadProjectionReducer(state, {
      type: "event.received",
      event: actionEvent("harness.action.completed", { observation: { shift: "early" } }, 3),
    });
    // completed 不新增行，结果合并进 proposed 行
    expect(state.activity).toHaveLength(2);
    const proposed = state.activity.find((e) => e.phase === "completed");
    expect(proposed?.block).toContain("2026-09-13");
    expect(proposed?.block).toContain("shift");
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
