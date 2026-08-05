import type { ClientTurn } from "@/lib/v11/client/types";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W3-4 / W4-1：ThreadInput 组件测试。
 *
 * 覆盖：
 * - 空闲状态（无 Turn 或终态）：按钮文案"发送"。
 * - 运行中状态 + 空文本：右下圆钮变「停止任务」（codex 形态）。
 * - 运行中状态 + 有文本：右下圆钮变「加入队列」。
 * - 点击「停止任务」直接 POST /interrupt，无确认对话框。
 * - 已请求停止后按钮变「已请求停止」并禁用。
 * - Enter 发送，Shift+Enter 不发送。
 * - 发送成功后清空输入框。
 * - 发送失败后保留输入 + 显示错误。
 * - 空闲时空文本禁用发送按钮。
 * - busy 时禁用输入和按钮。
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("@/components/hooks/use-v11-catalog", () => ({
  useV11Catalog: () => ({
    items: [],
    loading: false,
    error: null,
    revision: null,
    refresh: vi.fn(),
    clearError: vi.fn(),
  }),
}));

vi.mock("@/components/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    models: [],
    defaultModel: null,
    loading: false,
    error: null,
  }),
}));

// W4-1：ThreadInput 内部承载 PendingInputQueue，需要把队列 hook 平铺为空队列，
// 避免每个测试都得 mock GET /pending-inputs。
vi.mock("@/components/hooks/use-v11-pending-inputs", () => ({
  useV11PendingInputs: () => ({
    pendingInputs: [],
    queueEtag: null,
    loading: false,
    error: null,
    busy: false,
    create: vi.fn(),
    edit: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import { ThreadInput } from "./thread-input";

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  window.sessionStorage.clear();
});

beforeEach(() => {
  fetchMock.mockReset();
});

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

function buildInterruptResponse() {
  return {
    turn_id: "turn-001",
    turn_state: "running",
    interrupt_state: "requested",
    command: { id: "cmd-002", command_state: "queued" },
    already_completed_effects_preserved: true,
    event_id: "evt-002",
  };
}

describe("ThreadInput", () => {
  it("输入区浮在会话内容上，不渲染整条分隔栏", () => {
    render(<ThreadInput threadId="t1" latestTurn={null} />);
    const textarea = screen.getByLabelText("消息输入框");
    const composer = textarea.parentElement;
    const inputRegion = composer?.parentElement?.parentElement;

    expect(composer?.className).toContain("bg-background");
    expect(inputRegion?.className).not.toContain("border-t");
  });

  it("底部工具触发器都有可访问名称", () => {
    render(<ThreadInput threadId="t1" latestTurn={null} />);
    expect(screen.getByRole("button", { name: "添加" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "助手" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "模型" })).not.toBeNull();
  });

  it("无 Turn 时显示「发送」按钮", () => {
    render(<ThreadInput threadId="t1" latestTurn={null} />);
    expect(screen.getByRole("button", { name: "发送" })).not.toBeNull();
  });

  it("Turn completed 时显示「发送」按钮", () => {
    render(<ThreadInput threadId="t1" latestTurn={buildTurn("completed")} />);
    expect(screen.getByRole("button", { name: "发送" })).not.toBeNull();
  });

  it("Turn running + 空文本时显示「停止任务」按钮（codex 形态）", () => {
    render(<ThreadInput threadId="t1" latestTurn={buildTurn("running")} />);
    expect(screen.getByRole("button", { name: "停止任务" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "加入队列" })).toBeNull();
  });

  it("Turn accepted + 空文本时也显示「停止任务」", () => {
    render(<ThreadInput threadId="t1" latestTurn={buildTurn("accepted")} />);
    expect(screen.getByRole("button", { name: "停止任务" })).not.toBeNull();
  });

  it("Turn running + 输入文本后变成「加入队列」按钮", () => {
    render(<ThreadInput threadId="t1" latestTurn={buildTurn("running")} />);
    const textarea = screen.getByLabelText("队列消息输入框");
    fireEvent.change(textarea, { target: { value: "排队消息" } });
    expect(screen.getByRole("button", { name: "加入队列" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "停止任务" })).toBeNull();
  });

  it("空闲时空文本禁用发送按钮", () => {
    render(<ThreadInput threadId="t1" latestTurn={null} />);
    expect(screen.getByRole("button", { name: "发送" }).getAttribute("disabled")).not.toBeNull();
  });

  it("空闲时输入文本后启用发送按钮", () => {
    render(<ThreadInput threadId="t1" latestTurn={null} />);
    const textarea = screen.getByLabelText("消息输入框");
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "发送" }).getAttribute("disabled")).toBeNull();
  });

  it("点击「停止任务」直接 POST /interrupt，不弹确认对话框", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(buildInterruptResponse()), { status: 202 }),
    );
    render(<ThreadInput threadId="t1" latestTurn={buildTurn("running")} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/turns/turn-001/interrupt");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    // W4-1：不再有确认对话框
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("确认停止任务？")).toBeNull();
  });

  it("停止请求成功后按钮变「已请求停止」并禁用", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(buildInterruptResponse()), { status: 202 }),
    );
    render(<ThreadInput threadId="t1" latestTurn={buildTurn("running")} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "已请求停止" })).not.toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "已请求停止" }).getAttribute("disabled"),
    ).not.toBeNull();
  });

  it("Enter 键触发发送（空闲 → POST /turns）", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "turn-new" }), { status: 200 }),
    );
    render(<ThreadInput threadId="t1" latestTurn={null} />);
    const textarea = screen.getByLabelText("消息输入框");
    fireEvent.change(textarea, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.keyDown(textarea, {
        key: "Enter",
        shiftKey: false,
        nativeEvent: { isComposing: false },
      });
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/threads/t1/turns");
  });

  it("Shift+Enter 不触发发送", async () => {
    render(<ThreadInput threadId="t1" latestTurn={null} />);
    const textarea = screen.getByLabelText("消息输入框");
    fireEvent.change(textarea, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.keyDown(textarea, {
        key: "Enter",
        shiftKey: true,
        nativeEvent: { isComposing: false },
      });
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("运行中状态发送触发 POST /pending-inputs", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pending_input: { id: "pi-1", etag: "p-1" },
          queue_etag: "pq-1",
        }),
        { status: 201 },
      ),
    );
    render(<ThreadInput threadId="t1" latestTurn={buildTurn("running")} />);
    const textarea = screen.getByLabelText("队列消息输入框");
    fireEvent.change(textarea, { target: { value: "queued msg" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "加入队列" }));
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/threads/t1/pending-inputs");
  });

  it("发送成功后清空输入框", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "turn-new" }), { status: 200 }),
    );
    render(<ThreadInput threadId="t1" latestTurn={null} />);
    const textarea = screen.getByLabelText("消息输入框");
    fireEvent.change(textarea, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("发送失败时显示错误提示且保留输入", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "REQUEST_SCHEMA_INVALID",
            message: "bad",
            request_id: "r1",
            retryable: false,
          },
        }),
        { status: 400 },
      ),
    );
    render(<ThreadInput threadId="t1" latestTurn={null} />);
    const textarea = screen.getByLabelText("消息输入框");
    fireEvent.change(textarea, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).not.toBeNull();
    });
    expect((textarea as HTMLTextAreaElement).value).toBe("hello");
  });

  it("按会话保存未发送草稿，切换回来后恢复", () => {
    const first = render(<ThreadInput threadId="thread-a" latestTurn={null} />);
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "A 会话未发送内容" },
    });
    first.unmount();

    const second = render(<ThreadInput threadId="thread-b" latestTurn={null} />);
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "B 会话未发送内容" },
    });
    second.unmount();

    render(<ThreadInput threadId="thread-a" latestTurn={null} />);
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe(
      "A 会话未发送内容",
    );
  });

  it("自定义首条消息提交成功后清除新建页草稿", async () => {
    const onSubmitText = vi.fn().mockResolvedValue(true);
    render(
      <ThreadInput threadId="new" draftKey="new" latestTurn={null} onSubmitText={onSubmitText} />,
    );
    const textarea = screen.getByLabelText("消息输入框");
    fireEvent.change(textarea, { target: { value: "首条消息" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(onSubmitText).toHaveBeenCalledWith("首条消息");
      expect((textarea as HTMLTextAreaElement).value).toBe("");
    });
    expect(window.sessionStorage.getItem("snowharness:draft:new")).toBeNull();
  });

  it("网络异常时显示网络错误", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    render(<ThreadInput threadId="t1" latestTurn={null} />);
    const textarea = screen.getByLabelText("消息输入框");
    fireEvent.change(textarea, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    await waitFor(() => {
      expect(screen.getByText(/网络异常/)).not.toBeNull();
    });
  });

  it("关闭错误提示", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "REQUEST_SCHEMA_INVALID",
            message: "bad",
            request_id: "r1",
            retryable: false,
          },
        }),
        { status: 400 },
      ),
    );
    render(<ThreadInput threadId="t1" latestTurn={null} />);
    const textarea = screen.getByLabelText("消息输入框");
    fireEvent.change(textarea, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).not.toBeNull();
    });
    fireEvent.click(screen.getByLabelText("关闭错误提示"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
