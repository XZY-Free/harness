import type { ClientGoal, ClientThread, ClientTurn } from "@/lib/v11/client/types";
/**
 * S10-W02：ThreadHeader 组件测试。
 *
 * 覆盖：
 * - 渲染 Thread 标题 + 默认 "新会话" 回退。
 * - 任务状态推导：无 Turn → "空闲"；turn_state 各状态 → 中文标签 + tone。
 * - Goal 展示：active/blocked/completed/cancelled 4 种 goal_state 中文。
 * - 主 Agent / 执行位置显示（id 前 8 位）。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadHeader } from "./thread-header";

afterEach(() => {
  cleanup();
});

function buildThread(overrides: Partial<ClientThread> = {}): ClientThread {
  return {
    id: "thread-001",
    title: "测试会话",
    primary_agent_id: "agent-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    active_goal_id: null,
    default_workspace_id: null,
    default_model_ref: null,
    default_environment_definition_id: null,
    lifecycle_state: "active",
    last_activity_at: "2026-07-21T00:00:00.000Z",
    last_event_sequence: 1,
    pending_queue_version_no: 1,
    version_no: 1,
    created_at: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

function buildTurn(turnState: ClientTurn["turn_state"]): ClientTurn {
  return {
    id: "turn-001",
    turn_sequence: 1,
    trigger_type: "user_message",
    trigger_ref: null,
    trigger_item_id: null,
    turn_state: turnState,
    active_invocation_id: null,
    latest_invocation_id: null,
    adopted_invocation_id: null,
    final_item_id: null,
    error_code: null,
    regeneration_no: 0,
    accepted_at: "2026-07-21T00:00:00.000Z",
    started_at: null,
    waiting_at: null,
    finished_at: null,
  };
}

function buildGoal(state: ClientGoal["goal_state"]): ClientGoal {
  return {
    id: "goal-001",
    thread_id: "thread-001",
    objective: "完成月度报告",
    success_criteria: {},
    constraints: {},
    current_state: {},
    goal_state: state,
    created_at: "2026-07-21T00:00:00.000Z",
    completed_at: null,
  };
}

describe("ThreadHeader", () => {
  it("渲染 Thread 标题", () => {
    render(
      <ThreadHeader
        thread={buildThread({ title: "我的会话" })}
        activeGoal={null}
        latestTurn={null}
      />,
    );
    expect(screen.getByText("我的会话")).not.toBeNull();
  });

  it("title 为 null 时回退为「新会话」", () => {
    render(
      <ThreadHeader thread={buildThread({ title: null })} activeGoal={null} latestTurn={null} />,
    );
    expect(screen.getByText("新会话")).not.toBeNull();
  });

  it("无 Turn 时显示「空闲」", () => {
    render(<ThreadHeader thread={buildThread()} activeGoal={null} latestTurn={null} />);
    expect(screen.getByText("空闲")).not.toBeNull();
  });

  it("Turn running 时显示「执行中」", () => {
    render(
      <ThreadHeader thread={buildThread()} activeGoal={null} latestTurn={buildTurn("running")} />,
    );
    expect(screen.getByText("执行中")).not.toBeNull();
  });

  it("Turn waiting_user 时显示「等待确认」", () => {
    render(
      <ThreadHeader
        thread={buildThread()}
        activeGoal={null}
        latestTurn={buildTurn("waiting_user")}
      />,
    );
    expect(screen.getByText("等待确认")).not.toBeNull();
  });

  it("Turn accepted/queued 时显示「排队中」", () => {
    const { rerender } = render(
      <ThreadHeader thread={buildThread()} activeGoal={null} latestTurn={buildTurn("accepted")} />,
    );
    expect(screen.getByText("排队中")).not.toBeNull();

    rerender(
      <ThreadHeader thread={buildThread()} activeGoal={null} latestTurn={buildTurn("queued")} />,
    );
    expect(screen.getByText("排队中")).not.toBeNull();
  });

  it("Turn completed 时显示「已完成」", () => {
    render(
      <ThreadHeader thread={buildThread()} activeGoal={null} latestTurn={buildTurn("completed")} />,
    );
    expect(screen.getByText("已完成")).not.toBeNull();
  });

  it("Turn interrupted 时显示「已停止」", () => {
    render(
      <ThreadHeader
        thread={buildThread()}
        activeGoal={null}
        latestTurn={buildTurn("interrupted")}
      />,
    );
    expect(screen.getByText("已停止")).not.toBeNull();
  });

  it("Turn failed 时显示「失败」", () => {
    render(
      <ThreadHeader thread={buildThread()} activeGoal={null} latestTurn={buildTurn("failed")} />,
    );
    expect(screen.getByText("失败")).not.toBeNull();
  });

  it("Turn cancelled 时显示「已取消」", () => {
    render(
      <ThreadHeader thread={buildThread()} activeGoal={null} latestTurn={buildTurn("cancelled")} />,
    );
    expect(screen.getByText("已取消")).not.toBeNull();
  });

  it("Turn regenerating 时显示「重新生成中」", () => {
    render(
      <ThreadHeader
        thread={buildThread()}
        activeGoal={null}
        latestTurn={buildTurn("regenerating")}
      />,
    );
    expect(screen.getByText("重新生成中")).not.toBeNull();
  });

  it("展示主 Agent id 前 8 位", () => {
    render(<ThreadHeader thread={buildThread()} activeGoal={null} latestTurn={null} />);
    expect(screen.getByText("agent-aa")).not.toBeNull();
  });

  it("default_environment_definition_id 为 null 时显示 Cloud", () => {
    render(
      <ThreadHeader
        thread={buildThread({ default_environment_definition_id: null })}
        activeGoal={null}
        latestTurn={null}
      />,
    );
    expect(screen.getByText("Cloud")).not.toBeNull();
  });

  it("展示 Goal active 状态", () => {
    render(
      <ThreadHeader thread={buildThread()} activeGoal={buildGoal("active")} latestTurn={null} />,
    );
    expect(screen.getByText("完成月度报告")).not.toBeNull();
    expect(screen.getByText("进行中")).not.toBeNull();
  });

  it("展示 Goal blocked 状态", () => {
    render(
      <ThreadHeader thread={buildThread()} activeGoal={buildGoal("blocked")} latestTurn={null} />,
    );
    expect(screen.getByText("已阻塞")).not.toBeNull();
  });

  it("展示 Goal completed 状态", () => {
    render(
      <ThreadHeader thread={buildThread()} activeGoal={buildGoal("completed")} latestTurn={null} />,
    );
    expect(screen.getByText("已完成")).not.toBeNull();
  });

  it("展示 Goal cancelled 状态", () => {
    render(
      <ThreadHeader thread={buildThread()} activeGoal={buildGoal("cancelled")} latestTurn={null} />,
    );
    expect(screen.getByText("已取消")).not.toBeNull();
  });
});
