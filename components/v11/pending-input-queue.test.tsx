import type { ClientPendingInputListResponse } from "@/lib/v11/client/types";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S10-W03 / W4-1：PendingInputQueue 组件测试。
 *
 * 覆盖：
 * - 空队列不渲染。
 * - 渲染队列项：内容、位置序号、删除按钮、更多操作按钮。
 * - 不再展示「待办队列（N）」标题与「队列版本」内部信息。
 * - 引导流程：onSteer 成功后从队列移除（DELETE）。
 * - 编辑流程：进入编辑、确认/取消。
 * - 删除流程：DELETE 调用。
 * - 上移/下移：reorder 调用。
 * - 错误展示与重试。
 * - busy 时禁用所有操作。
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// 把 DropdownMenu 平铺成普通 div，使菜单项在 jsdom 下始终可见可点击。
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  DropdownMenuContent: ({ children, ...props }: ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
    ...props
  }: ComponentProps<"button"> & {
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

import { PendingInputQueue } from "./pending-input-queue";

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

beforeEach(() => {
  fetchMock.mockReset();
});

function buildListResponse(
  items: Array<{ id: string; text: string; position: number; etag: string }>,
): ClientPendingInputListResponse {
  return {
    thread_id: "t1",
    queue_etag: "pq-1",
    pending_inputs: items.map((it) => ({
      id: it.id,
      queue_position: it.position,
      input: { type: "message", text: it.text },
      etag: it.etag,
    })),
  };
}

function mockList(items: Array<{ id: string; text: string; position: number; etag: string }>) {
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(buildListResponse(items)), { status: 200 })),
  );
}

describe("PendingInputQueue", () => {
  it("空队列不渲染", async () => {
    mockList([]);
    const { container } = render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it("渲染队列项：内容 + 位置序号 + 删除 + 更多操作（不展示待办队列标题）", async () => {
    mockList([
      { id: "pi-1", text: "第一条", position: 1, etag: "p-1" },
      { id: "pi-2", text: "第二条", position: 2, etag: "p-2" },
    ]);
    render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("第一条")).not.toBeNull();
    });
    expect(screen.getByText("第二条")).not.toBeNull();
    expect(screen.getByText("1")).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull();
    expect(screen.getByLabelText("队列位置 1")).not.toBeNull();
    expect(screen.getByLabelText("队列位置 2")).not.toBeNull();
    expect(screen.getAllByLabelText("删除").length).toBe(2);
    expect(screen.getAllByLabelText("更多操作").length).toBe(2);
    // W4-1：不再展示「待办队列（N）」标题与「队列版本」内部信息
    expect(screen.queryByText(/待办队列/)).toBeNull();
    expect(screen.queryByText(/队列版本/)).toBeNull();
  });

  it("未传 onSteer 时不渲染引导按钮", async () => {
    mockList([{ id: "pi-1", text: "内容", position: 1, etag: "p-1" }]);
    render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("内容")).not.toBeNull();
    });
    expect(screen.queryByLabelText("升级为即时引导")).toBeNull();
  });

  it("传入 onSteer 时渲染引导按钮", async () => {
    mockList([{ id: "pi-1", text: "内容", position: 1, etag: "p-1" }]);
    const onSteer = vi.fn().mockResolvedValue(true);
    render(<PendingInputQueue threadId="t1" onSteer={onSteer} />);
    await waitFor(() => {
      expect(screen.getByText("内容")).not.toBeNull();
    });
    expect(screen.getByLabelText("升级为即时引导")).not.toBeNull();
  });

  it("点击引导按钮调用 onSteer 并删除该 PendingInput", async () => {
    mockList([{ id: "pi-1", text: "引导内容", position: 1, etag: "p-1" }]);
    const onSteer = vi.fn().mockResolvedValue(true);
    render(<PendingInputQueue threadId="t1" onSteer={onSteer} />);
    await waitFor(() => {
      expect(screen.getByText("引导内容")).not.toBeNull();
    });
    // 引导成功后调用 DELETE /pending-inputs/{id}
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            pending_input: {
              id: "pi-1",
              thread_id: "t1",
              input_state: "removed",
              removed_at: "2026-07-21T00:00:00.000Z",
            },
            queue_etag: "pq-2",
          }),
          { status: 200 },
        ),
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("升级为即时引导"));
    });
    await waitFor(() => {
      expect(onSteer).toHaveBeenCalledWith(
        expect.objectContaining({ id: "pi-1", input: { type: "message", text: "引导内容" } }),
      );
    });
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/pending-inputs/pi-1"),
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall?.[1]?.method).toBe("DELETE");
    });
  });

  it("onSteer 返回 false 时不删除该 PendingInput", async () => {
    mockList([{ id: "pi-1", text: "引导内容", position: 1, etag: "p-1" }]);
    const onSteer = vi.fn().mockResolvedValue(false);
    render(<PendingInputQueue threadId="t1" onSteer={onSteer} />);
    await waitFor(() => {
      expect(screen.getByText("引导内容")).not.toBeNull();
    });
    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("升级为即时引导"));
    });
    await waitFor(() => {
      expect(onSteer).toHaveBeenCalled();
    });
    // 不应触发 DELETE
    const deleteCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/pending-inputs/pi-1"),
    );
    expect(deleteCall).toBeUndefined();
  });

  it("点击更多操作中的编辑进入编辑模式", async () => {
    mockList([{ id: "pi-1", text: "原内容", position: 1, etag: "p-1" }]);
    render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("原内容")).not.toBeNull();
    });
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.getByText("编辑")).not.toBeNull();
    fireEvent.click(screen.getByText("编辑"));
    expect(screen.getByLabelText("编辑队列消息")).not.toBeNull();
    expect(screen.getByLabelText("确认编辑")).not.toBeNull();
    expect(screen.getByLabelText("取消编辑")).not.toBeNull();
  });

  it("确认编辑触发 PATCH /pending-inputs/{id}", async () => {
    mockList([{ id: "pi-1", text: "原内容", position: 1, etag: "p-1" }]);
    render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("原内容")).not.toBeNull();
    });
    fireEvent.click(screen.getByLabelText("更多操作"));
    fireEvent.click(screen.getByText("编辑"));
    const textarea = screen.getByLabelText("编辑队列消息");
    fireEvent.change(textarea, { target: { value: "新内容" } });
    // PATCH 响应
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            pending_input: {
              id: "pi-1",
              thread_id: "t1",
              input_state: "pending",
              queue_position: 1,
              input: { type: "message", text: "新内容" },
              etag: "p-2",
            },
            queue_etag: "pq-2",
          }),
          { status: 200 },
        ),
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("确认编辑"));
    });
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/pending-inputs/pi-1"),
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.[1]?.method).toBe("PATCH");
    });
  });

  it("取消编辑恢复显示", async () => {
    mockList([{ id: "pi-1", text: "原内容", position: 1, etag: "p-1" }]);
    render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("原内容")).not.toBeNull();
    });
    fireEvent.click(screen.getByLabelText("更多操作"));
    fireEvent.click(screen.getByText("编辑"));
    fireEvent.click(screen.getByLabelText("取消编辑"));
    expect(screen.queryByLabelText("编辑队列消息")).toBeNull();
    expect(screen.getByText("原内容")).not.toBeNull();
  });

  it("删除触发 DELETE /pending-inputs/{id}", async () => {
    mockList([{ id: "pi-1", text: "内容", position: 1, etag: "p-1" }]);
    render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("内容")).not.toBeNull();
    });
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            pending_input: {
              id: "pi-1",
              thread_id: "t1",
              input_state: "removed",
              removed_at: "2026-07-21T00:00:00.000Z",
            },
            queue_etag: "pq-2",
          }),
          { status: 200 },
        ),
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("删除"));
    });
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/pending-inputs/pi-1"),
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall?.[1]?.method).toBe("DELETE");
    });
  });

  it("更多操作中的上移触发 reorder（非首位）", async () => {
    mockList([
      { id: "pi-1", text: "A", position: 1, etag: "p-1" },
      { id: "pi-2", text: "B", position: 2, etag: "p-2" },
    ]);
    render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("A")).not.toBeNull();
    });
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            thread_id: "t1",
            queue_etag: "pq-2",
            pending_inputs: [
              { id: "pi-2", queue_position: 1, input: { type: "message", text: "B" }, etag: "p-2" },
              { id: "pi-1", queue_position: 2, input: { type: "message", text: "A" }, etag: "p-1" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    // 第二项的「更多操作」→「上移」
    const moreButtons = screen.getAllByLabelText("更多操作");
    fireEvent.click(moreButtons[1] as HTMLElement);
    const upButtons = screen.getAllByText("上移");
    await act(async () => {
      fireEvent.click(upButtons[1] as HTMLElement); // 第二项的上移
    });
    await waitFor(() => {
      const reorderCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/pending-inputs:reorder"),
      );
      expect(reorderCall).toBeDefined();
      expect(reorderCall?.[1]?.method).toBe("POST");
    });
  });

  it("首项的「上移」按钮禁用", async () => {
    mockList([
      { id: "pi-1", text: "A", position: 1, etag: "p-1" },
      { id: "pi-2", text: "B", position: 2, etag: "p-2" },
    ]);
    render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("A")).not.toBeNull();
    });
    // 展开第一项的「更多操作」
    fireEvent.click(screen.getAllByLabelText("更多操作")[0] as HTMLElement);
    const upButtons = screen.getAllByText("上移");
    expect(upButtons[0]?.getAttribute("disabled")).not.toBeNull();
  });

  it("末项的「下移」按钮禁用", async () => {
    mockList([
      { id: "pi-1", text: "A", position: 1, etag: "p-1" },
      { id: "pi-2", text: "B", position: 2, etag: "p-2" },
    ]);
    render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("A")).not.toBeNull();
    });
    // 展开第二项的「更多操作」
    fireEvent.click(screen.getAllByLabelText("更多操作")[1] as HTMLElement);
    const downButtons = screen.getAllByText("下移");
    // 末项的「下移」按钮禁用（取最后一个）
    const lastDown = downButtons[downButtons.length - 1];
    expect(lastDown?.getAttribute("disabled")).not.toBeNull();
  });

  it("GET 失败时显示错误并支持重试", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "AUTHENTICATION_REQUIRED",
              message: "no auth",
              request_id: "r1",
              retryable: false,
            },
          }),
          { status: 401 },
        ),
      ),
    );
    render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).not.toBeNull();
    });
    expect(screen.getByText(/登录已失效/)).not.toBeNull();
    // 重试
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(buildListResponse([])), { status: 200 }),
    );
    fireEvent.click(screen.getByText("重试"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it("不再展示队列版本号", async () => {
    mockList([{ id: "pi-1", text: "A", position: 1, etag: "p-1" }]);
    render(<PendingInputQueue threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("A")).not.toBeNull();
    });
    expect(screen.queryByLabelText("队列版本")).toBeNull();
    expect(screen.queryByText(/pq-1/)).toBeNull();
  });

  it("parentBusy=true 时禁用所有操作按钮", async () => {
    mockList([{ id: "pi-1", text: "内容", position: 1, etag: "p-1" }]);
    const onSteer = vi.fn().mockResolvedValue(true);
    render(<PendingInputQueue threadId="t1" onSteer={onSteer} parentBusy />);
    await waitFor(() => {
      expect(screen.getByText("内容")).not.toBeNull();
    });
    expect(screen.getByLabelText("升级为即时引导").getAttribute("disabled")).not.toBeNull();
    expect(screen.getByLabelText("删除").getAttribute("disabled")).not.toBeNull();
    expect(screen.getByLabelText("更多操作").getAttribute("disabled")).not.toBeNull();
  });
});
