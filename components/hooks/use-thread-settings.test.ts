// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S10-W04：useV11ThreadSettings Hook 测试。
 *
 * 覆盖：
 * - 成功 PATCH（200）返回 true 且不设置 error。
 * - 412 ETAG_MISMATCH → error.code = ETAG_MISMATCH。
 * - 400 REQUEST_SCHEMA_INVALID → error.code = REQUEST_SCHEMA_INVALID。
 * - 网络异常 → error.code = NETWORK_ERROR。
 * - 空更新（无字段）→ 返回 false + 参数错误。
 * - busy=true 时拒绝重复触发。
 * - clearError 清空错误。
 * - If-Match 头格式 = "thread-settings-{versionNo}"。
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { useThreadSettings } from "./use-thread-settings";

afterEach(() => {
  fetchMock.mockReset();
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe("useThreadSettings", () => {
  it("PATCH 成功返回 true 且无 error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ thread_id: "t1", etag: "thread-settings-2" }), {
        status: 200,
      }),
    );
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    let ok = false;
    await act(async () => {
      ok = await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: "model-2" },
      });
    });
    expect(ok).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
    // 校验请求
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/threads/t1/settings");
    expect(init?.method).toBe("PATCH");
    expect((init?.headers as Record<string, string>)?.["if-match"]).toBe('"thread-settings-1"');
  });

  it("412 ETAG_MISMATCH 转化为可见错误", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "ETAG_MISMATCH",
            message: "版本冲突",
            request_id: "r1",
            retryable: true,
          },
        }),
        { status: 412 },
      ),
    );
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    let ok = true;
    await act(async () => {
      ok = await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_environment_definition_id: "env-2" },
      });
    });
    expect(ok).toBe(false);
    expect(result.current.error?.code).toBe("ETAG_MISMATCH");
  });

  it("400 REQUEST_SCHEMA_INVALID 转化为可见错误", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "REQUEST_SCHEMA_INVALID",
            message: "字段非法",
            request_id: "r1",
            retryable: false,
          },
        }),
        { status: 400 },
      ),
    );
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    await act(async () => {
      await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: null },
      });
    });
    expect(result.current.error?.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("网络异常转化为 NETWORK_ERROR", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    let ok = true;
    await act(async () => {
      ok = await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: "m1" },
      });
    });
    expect(ok).toBe(false);
    expect(result.current.error?.code).toBe("NETWORK_ERROR");
  });

  it("空更新（无字段）返回 false 并设置参数错误", async () => {
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    let ok = true;
    await act(async () => {
      ok = await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: {},
      });
    });
    expect(ok).toBe(false);
    expect(result.current.error?.code).toBe("REQUEST_SCHEMA_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("busy=true 时拒绝重复触发", async () => {
    // 第一次请求不立即 resolve，模拟进行中
    let resolveFirst: ((resp: Response) => void) | null = null;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    // 发起第一次 PATCH（不等待完成）
    let firstOk: boolean | null = null;
    act(() => {
      void result.current
        .patchSettings({
          expectedVersionNo: 1,
          updates: { default_model_ref: "m1" },
        })
        .then((ok) => {
          firstOk = ok;
        });
    });
    // 等待 busy=true 生效（patchSettings 闭包刷新）
    await waitFor(() => {
      expect(result.current.busy).toBe(true);
    });
    // busy 期间再次调用：应被拒绝
    let secondOk: boolean | null = null;
    await act(async () => {
      secondOk = await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: "m2" },
      });
    });
    expect(secondOk).toBe(false);
    // 完成第一次请求
    await act(async () => {
      resolveFirst?.(
        new Response(JSON.stringify({ thread_id: "t1", etag: "thread-settings-2" }), {
          status: 200,
        }),
      );
    });
    await waitFor(() => {
      expect(firstOk).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clearError 清空错误", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    await act(async () => {
      await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: "m1" },
      });
    });
    expect(result.current.error).not.toBeNull();
    await act(async () => {
      result.current.clearError();
    });
    expect(result.current.error).toBeNull();
  });

  it("If-Match 头格式正确（带引号 + 前缀 + versionNo）", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ thread_id: "t1", etag: "thread-settings-42" }), {
        status: 200,
      }),
    );
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    await act(async () => {
      await result.current.patchSettings({
        expectedVersionNo: 41,
        updates: { default_environment_definition_id: "env-9" },
      });
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)?.["if-match"]).toBe('"thread-settings-41"');
  });
});
