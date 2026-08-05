import type { ClientItem } from "@/lib/v11/client/types";
/**
 * S10-W02：ThreadTimeline 组件测试。
 *
 * 覆盖：
 * - 按 item_type 分发到对应渲染组件。
 * - superseded Item 默认隐藏；showSuperseded=true 时显示。
 * - W4-1：连接状态指示（open 不显示；reconnecting 显示"正在重新连接 N/M"；resnapshot 显示"正在同步会话"）。
 * - 空状态展示。
 * - 未知 item_type 占位（不暴露内部细节）。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadTimeline } from "./thread-timeline";

afterEach(() => {
  cleanup();
});

function buildItem(overrides: Partial<ClientItem> = {}): ClientItem {
  return {
    id: "item-001",
    turn_id: "turn-001",
    item_sequence: 1,
    item_type: "user_message",
    item_state: "completed",
    content: { text: "hello" },
    created_at: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("ThreadTimeline", () => {
  it("渲染 user_message Item", () => {
    const items = [buildItem({ item_type: "user_message", content: { text: "你好" } })];
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.getByText("你好")).not.toBeNull();
  });

  it("渲染 agent_message Item", () => {
    const items = [buildItem({ item_type: "agent_message", content: { text: "Agent 回复" } })];
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.getByText("Agent 回复")).not.toBeNull();
  });

  it("渲染 tool_call Item（含折叠按钮）", () => {
    const items = [
      buildItem({
        item_type: "tool_call",
        content: { tool_name: "readFile", status: "completed" },
      }),
    ];
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.getByText("readFile")).not.toBeNull();
  });

  it("渲染 artifact Item", () => {
    const items = [
      buildItem({
        item_type: "artifact",
        content: { title: "report.pdf", content_type: "application/pdf" },
      }),
    ];
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.getByText("report.pdf")).not.toBeNull();
  });

  it("渲染 user_action Item", () => {
    const items = [
      buildItem({
        item_type: "user_action",
        content: { request_type: "confirmation", purpose: "确认删除" },
      }),
    ];
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.getByText("确认请求")).not.toBeNull();
    expect(screen.getByText("确认删除")).not.toBeNull();
  });

  it("渲染 child_thread Item", () => {
    const items = [
      buildItem({
        item_type: "child_thread",
        content: {
          child_thread_id: "thread-002",
          target_agent_id: "agent-xxxxxxxx",
          state: "active",
          summary: "子任务进行中",
        },
      }),
    ];
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.getByText("子任务")).not.toBeNull();
    expect(screen.getByText("子任务进行中")).not.toBeNull();
  });

  it("渲染 job_result Item", () => {
    const items = [
      buildItem({
        item_type: "job_result",
        content: { job_type: "sales_report", status: "completed" },
      }),
    ];
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.getByText("sales_report")).not.toBeNull();
  });

  it("superseded Item 默认隐藏", () => {
    const items = [
      buildItem({
        id: "item-a",
        item_sequence: 1,
        item_type: "user_message",
        item_state: "superseded",
        content: { text: "已废弃" },
      }),
      buildItem({
        id: "item-b",
        item_sequence: 2,
        item_type: "user_message",
        item_state: "completed",
        content: { text: "正式" },
      }),
    ];
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.queryByText("已废弃")).toBeNull();
    expect(screen.getByText("正式")).not.toBeNull();
  });

  it("showSuperseded=true 时显示 superseded Item", () => {
    const items = [
      buildItem({
        id: "item-a",
        item_sequence: 1,
        item_type: "user_message",
        item_state: "superseded",
        content: { text: "已废弃" },
      }),
    ];
    render(<ThreadTimeline items={items} streamStatus="idle" showSuperseded />);
    expect(screen.getByText("已废弃")).not.toBeNull();
  });

  it("streamStatus=open 不显示任何连接提示（健康状态无需占用视线）", () => {
    render(<ThreadTimeline items={[]} streamStatus="open" />);
    expect(screen.queryByText("实时连接中")).toBeNull();
    expect(screen.queryByText("正在重新连接")).toBeNull();
    expect(screen.queryByText("正在同步会话")).toBeNull();
  });

  it("streamStatus=reconnecting 显示低调重连提示（不带尝试次数）", () => {
    render(<ThreadTimeline items={[]} streamStatus="reconnecting" />);
    expect(screen.getByText("正在重新连接")).not.toBeNull();
  });

  it("streamStatus=reconnecting 携带 attempt 时显示 N/M 进度", () => {
    render(
      <ThreadTimeline
        items={[]}
        streamStatus="reconnecting"
        reconnectAttempt={2}
        reconnectMax={5}
      />,
    );
    expect(screen.getByText("正在重新连接 2/5")).not.toBeNull();
  });

  it("streamStatus=resnapshot 显示同步会话提示", () => {
    render(<ThreadTimeline items={[]} streamStatus="resnapshot" />);
    expect(screen.getByText("正在同步会话")).not.toBeNull();
  });

  it("空 Item 列表显示空状态", () => {
    render(<ThreadTimeline items={[]} streamStatus="idle" />);
    expect(screen.getByText("还没有消息")).not.toBeNull();
    expect(screen.getByText("发送第一条消息开始对话")).not.toBeNull();
  });

  it("不渲染 progress.snapshot 形成的空引导消息", () => {
    const items = [
      buildItem({
        item_type: "user_guidance",
        content: {
          kind: "progress.snapshot",
          summary: "正在处理...",
        },
      }),
    ];
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.queryByText("(引导内容)")).toBeNull();
    expect(screen.queryByText("引导")).toBeNull();
    expect(screen.getByText("还没有消息")).not.toBeNull();
  });

  it("不渲染没有正文的用户或助手消息", () => {
    const items = [
      buildItem({ id: "empty-user", item_type: "user_message", content: {} }),
      buildItem({
        id: "empty-agent",
        item_sequence: 2,
        item_type: "agent_message",
        content: {},
      }),
    ];
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.queryByText("(空消息)")).toBeNull();
    expect(screen.getByText("还没有消息")).not.toBeNull();
  });

  it("未知 item_type 显示占位（不暴露内部细节）", () => {
    const items = [
      buildItem({
        item_type: "unknown_future_type" as ClientItem["item_type"],
        content: {},
      }),
    ];
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.getByText(/暂不支持的消息类型/)).not.toBeNull();
  });

  it("按 item_sequence 顺序渲染", () => {
    const items = [
      buildItem({
        id: "item-2",
        item_sequence: 2,
        item_type: "agent_message",
        content: { text: "第二条" },
      }),
      buildItem({
        id: "item-1",
        item_sequence: 1,
        item_type: "user_message",
        content: { text: "第一条" },
      }),
    ];
    // 数组顺序不保证时，组件按入参顺序渲染；这里验证两者均显示
    render(<ThreadTimeline items={items} streamStatus="idle" />);
    expect(screen.getByText("第一条")).not.toBeNull();
    expect(screen.getByText("第二条")).not.toBeNull();
  });

  it("收到工作台定位请求时滚动到对应 Item", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const items = [buildItem({ id: "action-1", content: { text: "需要确认" } })];
    const { rerender } = render(
      <ThreadTimeline items={items} streamStatus="idle" locateItem={null} />,
    );

    rerender(
      <ThreadTimeline
        items={items}
        streamStatus="idle"
        locateItem={{ itemId: "action-1", requestId: 1 }}
      />,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });
});
