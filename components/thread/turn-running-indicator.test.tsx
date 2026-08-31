/**
 * TurnRunningIndicator 定向测试（真实运行状态反馈）。
 *
 * 验证（06 真实状态语义）：
 * - 非终态 Turn（accepted/queued/running）渲染运行指示；终态/等待态不渲染。
 * - accepted/queued → 正在准备...；running → 正在处理...。
 * - progress.snapshot 携带公开 message 时展示该文本；缺失时保持通用文案。
 * - elapsed 只按 started_at/accepted_at 客户端计算，不依赖服务端。
 * - 纯 UI：不产生任何 ThreadItem。
 */
import type { ClientItem, ClientTurn } from "@/lib/client/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TurnRunningIndicator } from "./turn-running-indicator";

function makeTurn(state: string, overrides: Partial<ClientTurn> = {}): ClientTurn {
  return {
    controls: { cancel_supported: false, resume_supported: false, steer_supported: false },
    id: "turn-1",
    preferred_agent_id: null,
    agent_use_mode: null,
    turn_sequence: 1,
    trigger_type: "user_message",
    trigger_ref: null,
    trigger_item_id: null,
    turn_state: state,
    active_invocation_id: null,
    latest_invocation_id: null,
    adopted_invocation_id: null,
    final_item_id: null,
    error_code: null,
    regeneration_no: 0,
    accepted_at: new Date(Date.now() - 2000).toISOString(),
    started_at: state === "running" ? new Date(Date.now() - 1000).toISOString() : null,
    waiting_at: null,
    finished_at: null,
    ...overrides,
  };
}

const NO_ITEMS: readonly ClientItem[] = [];

afterEach(cleanup);

describe("TurnRunningIndicator（真实运行状态反馈）", () => {
  it("running：显示 正在处理... 与 elapsed 秒", () => {
    render(<TurnRunningIndicator turn={makeTurn("running")} items={NO_ITEMS} />);
    const indicator = screen.getByTestId("turn-running-indicator");
    expect(indicator.textContent).toContain("正在处理...");
    expect(indicator.textContent).toMatch(/1 秒/);
  });

  it("accepted/queued：显示 正在准备...", () => {
    const { unmount } = render(
      <TurnRunningIndicator turn={makeTurn("accepted")} items={NO_ITEMS} />,
    );
    expect(screen.getByTestId("turn-running-indicator").textContent).toContain("正在准备...");
    unmount();
    render(<TurnRunningIndicator turn={makeTurn("queued")} items={NO_ITEMS} />);
    expect(screen.getByTestId("turn-running-indicator").textContent).toContain("正在准备...");
  });

  it("progress.snapshot 携带公开 message 时展示该文本", () => {
    const items: readonly ClientItem[] = [
      {
        id: "guide-1",
        turn_id: "turn-1",
        item_sequence: 2,
        item_type: "user_guidance",
        item_state: "completed",
        content: { kind: "progress.snapshot", task_state: "working", message: "正在生成结果..." },
        created_at: "2026-08-27T00:00:00.000Z",
      },
    ];
    render(<TurnRunningIndicator turn={makeTurn("running")} items={items} />);
    expect(screen.getByTestId("turn-running-indicator").textContent).toContain("正在生成结果...");
    // 通用推断文案不得出现（黑盒 Agent 内部阶段不可知）。
    expect(screen.getByTestId("turn-running-indicator").textContent).not.toContain("正在查询");
  });

  it("progress.snapshot 无 message 时保持通用文案", () => {
    const items: readonly ClientItem[] = [
      {
        id: "guide-2",
        turn_id: "turn-1",
        item_sequence: 2,
        item_type: "user_guidance",
        item_state: "completed",
        content: { kind: "progress.snapshot", task_state: "working", message: null },
        created_at: "2026-08-27T00:00:00.000Z",
      },
    ];
    render(<TurnRunningIndicator turn={makeTurn("running")} items={items} />);
    expect(screen.getByTestId("turn-running-indicator").textContent).toContain("正在处理...");
  });

  it("超过 8 秒仍显示 仍在处理中...（不定义超时失败）", () => {
    const turn = makeTurn("running", {
      accepted_at: new Date(Date.now() - 30_000).toISOString(),
      started_at: new Date(Date.now() - 30_000).toISOString(),
    });
    render(<TurnRunningIndicator turn={turn} items={NO_ITEMS} />);
    const text = screen.getByTestId("turn-running-indicator").textContent ?? "";
    expect(text).toContain("仍在处理中...");
    expect(text).not.toContain("失败");
  });

  it("终态与 waiting_user 不渲染指示", () => {
    for (const state of ["completed", "failed", "interrupted", "waiting_user", "cancelled"]) {
      const { container, unmount } = render(
        <TurnRunningIndicator turn={makeTurn(state)} items={NO_ITEMS} />,
      );
      expect(container.querySelector('[data-testid="turn-running-indicator"]')).toBeNull();
      unmount();
    }
  });

  it("turn 为 null 不渲染指示", () => {
    render(<TurnRunningIndicator turn={null} items={NO_ITEMS} />);
    expect(screen.queryByTestId("turn-running-indicator")).toBeNull();
  });
});
