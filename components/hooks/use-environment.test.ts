// @vitest-environment happy-dom
/**
 * S10-W06：useV11Environment Hook 测试。
 *
 * 覆盖：
 * - 成功加载 Environment 状态。
 * - 404 错误转化为可见错误。
 * - 网络异常转化为 NETWORK_ERROR。
 * - refresh 手动刷新。
 * - AbortController 防竞态（快速多次 refresh 只保留最后一次结果）。
 * - 组件卸载后不写入 state（unmounted 守卫）。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { useV11Environment } from "./use-environment";

afterEach(() => {
  fetchMock.mockReset();
});

beforeEach(() => {
  fetchMock.mockReset();
});

function buildStatusResponse(
  overrides: Partial<{
    thread_id: string;
    environment_definition: unknown;
    active_lease: unknown;
    active_ownership: unknown;
    availability: string;
    active_invocation_id: string | null;
  }> = {},
): Response {
  return new Response(
    JSON.stringify({
      thread_id: "t1",
      environment_definition: {
        id: "def-1",
        environment_key: "desktop-default",
        display_name: "Desktop 默认",
        description: null,
        environment_type: "desktop",
        lifecycle_state: "active",
      },
      active_lease: null,
      active_ownership: null,
      availability: "offline_desktop",
      active_invocation_id: null,
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("useV11Environment", () => {
  it("成功加载 Environment 状态", async () => {
    fetchMock.mockResolvedValueOnce(buildStatusResponse({ availability: "online_desktop" }));

    const { result } = renderHook(() => useV11Environment("t1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.status?.availability).toBe("online_desktop");
    expect(result.current.status?.environment_definition?.environment_type).toBe("desktop");
    expect(result.current.error).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/threads/t1/environment");
    expect(init?.credentials).toBe("include");
  });

  it("404 错误转化为 RESOURCE_NOT_FOUND", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Thread 不存在",
            request_id: "req-1",
            retryable: false,
          },
        }),
        { status: 404 },
      ),
    );

    const { result } = renderHook(() => useV11Environment("t-missing"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.status).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("网络异常转化为 NETWORK_ERROR", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { result } = renderHook(() => useV11Environment("t1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.status).toBeNull();
    expect(result.current.error?.code).toBe("NETWORK_ERROR");
    expect(result.current.error?.retryable).toBe(true);
  });

  it("refresh 触发重新加载", async () => {
    fetchMock.mockResolvedValueOnce(buildStatusResponse({ availability: "offline_desktop" }));

    const { result } = renderHook(() => useV11Environment("t1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.status?.availability).toBe("offline_desktop");

    fetchMock.mockResolvedValueOnce(buildStatusResponse({ availability: "online_desktop" }));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.status?.availability).toBe("online_desktop");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("快速连续 refresh 只保留最后一次结果（AbortController 防竞态）", async () => {
    // 第一次请求：延迟返回 offline_desktop
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(buildStatusResponse({ availability: "offline_desktop" })), 50);
        }),
    );
    // 第二次请求：立即返回 online_desktop
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(buildStatusResponse({ availability: "online_desktop" })),
    );

    const { result } = renderHook(() => useV11Environment("t1"));

    // 等待初始加载完成
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // 同时发起两次 refresh
    await act(async () => {
      void result.current.refresh();
      // 略等一下让第一次请求开始
      await new Promise((r) => setTimeout(r, 10));
      await result.current.refresh();
    });

    // 等待所有请求完成
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // 最终状态应该是第二次的 online_desktop（第一次被 abort）
    expect(result.current.status?.availability).toBe("online_desktop");
  });

  it("组件卸载后不写入 state（unmounted 守卫）", async () => {
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(buildStatusResponse()), 50);
        }),
    );

    const { result, unmount } = renderHook(() => useV11Environment("t1"));

    // 立即卸载，请求仍在 pending
    unmount();

    // 等待请求完成（不应触发 React 警告）
    await new Promise((r) => setTimeout(r, 100));

    // result.current 仍是初始状态
    expect(result.current.status).toBeNull();
  });
});
