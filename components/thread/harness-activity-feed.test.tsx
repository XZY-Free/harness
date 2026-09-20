import type { ActivityEntry } from "@/lib/client/activity-projection";
import type { ClientTurn } from "@/lib/client/types";
import { apiSuccess } from "@/lib/http";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivitySummary, HarnessActivityFeed, TurnActivitySummary } from "./harness-activity-feed";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-fetch", () => ({ apiFetch }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const entries: ActivityEntry[] = [
  {
    key: "think-1",
    turnId: "turn-1",
    kind: "think",
    phase: "think",
    label: "思考中…",
    block: "需要先查看项目文档。",
    risk: false,
    actionId: null,
    occurredAt: "2026-09-12T00:00:00Z",
  },
  {
    key: "read-1",
    turnId: "turn-1",
    kind: "read",
    phase: "completed",
    label: "已执行 · 读取文档",
    block: "README.md",
    risk: false,
    actionId: "action-1",
    occurredAt: "2026-09-12T00:00:02Z",
  },
];

describe("过程摘要", () => {
  it("实时终态和历史加载结果展示相同摘要，重复展开不重新请求", async () => {
    const live = render(<ActivitySummary entries={entries} elapsedMs={2000} failed={false} />);
    const summary = screen.getByTestId("harness-activity-summary") as HTMLDetailsElement;
    expect(summary.open).toBe(false);
    const liveLabel = summary.querySelector("summary")?.textContent;
    expect(liveLabel).toBe("用时 2 秒");
    const liveSteps = summary.querySelector(".ha-steps")?.textContent;
    live.unmount();

    apiFetch.mockResolvedValue(apiSuccess({ entries }));
    const turn = {
      id: "turn-1",
      turn_state: "completed",
      started_at: "2026-09-12T00:00:00Z",
      finished_at: "2026-09-12T00:00:02Z",
    } as ClientTurn;
    render(<TurnActivitySummary threadId="thread-1" turn={turn} />);
    const history = screen.getByTestId("harness-activity-summary") as HTMLDetailsElement;
    expect(history.open).toBe(false);
    expect(history.querySelector("summary")?.textContent).toBe("用时 2 秒");
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(history.querySelector("summary") as HTMLElement);
    await waitFor(() => expect(history.querySelector(".ha-steps")?.textContent).toBe(liveSteps));
    expect(history.querySelector(".ha-steps")?.textContent).toBe(liveSteps);
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/v1/threads/thread-1/turns/turn-1/activity",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fireEvent.click(history.querySelector("summary") as HTMLElement);
    fireEvent.click(history.querySelector("summary") as HTMLElement);
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it("失败摘要只统计完成的操作，空历史结果仍允许收起", () => {
    const view = render(<ActivitySummary entries={entries} elapsedMs={2000} failed />);
    expect(screen.getByText("执行失败")).toBeTruthy();
    view.rerender(<ActivitySummary entries={[]} elapsedMs={2000} failed />);
    expect(screen.getByText("执行失败")).toBeTruthy();
  });
});

it("公开说明按正文展示，完成后不再显示无内容的思考状态", () => {
  render(
    <HarnessActivityFeed
      entries={[
        ...entries,
        { ...entries[0]!, key: "pending", block: null, label: "正在组织回答…" },
      ]}
      turnActive={false}
    />,
  );
  expect(screen.getByText("需要先查看项目文档。").closest("summary")).toBeNull();
  expect(screen.queryByText("正在组织回答…")).toBeNull();
  fireEvent.click(screen.getByText("已执行 · 读取文档"));
  expect(screen.getByRole("button", { name: "复制代码" })).toBeTruthy();
  expect(screen.getByText("成功")).toBeTruthy();
});

it("历史加载失败可重试，不能伪装为空记录", async () => {
  apiFetch
    .mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockResolvedValueOnce(apiSuccess({ entries }));
  render(
    <TurnActivitySummary
      threadId="t"
      turn={{ id: "turn", turn_state: "completed" } as ClientTurn}
    />,
  );
  fireEvent.click(screen.getByTestId("harness-activity-summary").querySelector("summary")!);
  await screen.findByText("执行记录加载失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("需要先查看项目文档。");
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it("实时过程完成后保持可见，耗时从接纳开始而不是最后恢复开始", async () => {
  apiFetch.mockResolvedValue(apiSuccess({ entries }));
  const turn = {
    id: "t",
    turn_state: "running",
    accepted_at: "2026-09-12T00:00:00Z",
    started_at: "2026-09-12T00:01:59Z",
    finished_at: "2026-09-12T00:02:00Z",
  } as unknown as ClientTurn;
  const view = render(<TurnActivitySummary threadId="thread" turn={turn} liveEntries={entries} />);
  await screen.findByText("需要先查看项目文档。");
  view.rerender(
    <TurnActivitySummary
      threadId="thread"
      turn={{ ...turn, turn_state: "completed" }}
      liveEntries={entries}
    />,
  );
  expect((screen.getByTestId("harness-activity-summary") as HTMLDetailsElement).open).toBe(true);
  expect(screen.getByText("用时 2 分钟 0 秒")).toBeTruthy();
});

it("智能体请求与返回展示在同一个过程折叠中", () => {
  const duplicateTechnicalEntry: ActivityEntry = {
    key: "agent-action-1",
    turnId: "turn-agent",
    kind: "exec",
    phase: "completed",
    label: "已执行 · 调用智能体",
    block: '{"agentId":"hr-agent","contextRefs":[]}',
    risk: false,
    actionId: "action-1",
    occurredAt: "2026-09-12T00:00:01Z",
  };
  const turn = {
    id: "turn-agent",
    turn_state: "completed",
    accepted_at: "2026-09-12T00:00:00Z",
    finished_at: "2026-09-12T00:00:16Z",
    actual_agent_calls: {
      calls: [
        {
          call_id: "call-1",
          parent_invocation_id: "inv-1",
          agent_id: "hr-agent",
          display_name: "企业人力智能助手",
          action_id: "action-1",
          state: "completed",
          created_at: "2026-09-12T00:00:01Z",
          started_at: "2026-09-12T00:00:02Z",
          waiting_at: null,
          finished_at: "2026-09-12T00:00:16Z",
          duration_ms: 14_000,
          error_code: null,
        },
      ],
    },
  } as unknown as ClientTurn;

  render(
    <TurnActivitySummary
      threadId="thread"
      turn={turn}
      requestText="查询我本人的医疗期"
      liveEntries={[duplicateTechnicalEntry]}
    />,
  );

  const process = screen.getByTestId("harness-activity-summary");
  const request = screen.getByText("已向企业人力智能助手发送请求");
  const response = screen.getByText("已收到企业人力智能助手返回结果 · 14 秒");
  expect(process.contains(request)).toBe(true);
  expect(process.contains(response)).toBe(true);
  expect(screen.queryByText("已执行 · 调用智能体")).toBeNull();
  expect(screen.queryByText(/contextRefs/)).toBeNull();
  fireEvent.click(request);
  const requestCopy = screen.getByText("你的请求：查询我本人的医疗期");
  expect(requestCopy.classList.contains("ha-agent-copy")).toBe(true);
  expect(requestCopy.closest(".ha-output")?.querySelector('[aria-label="复制代码"]')).toBeNull();
});
