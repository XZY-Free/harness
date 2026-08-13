import type { ClientTakeoverResponse } from "@/lib/client/types";
// @vitest-environment happy-dom
/**
 * S10-W07：useEnvironmentTakeover Hook 测试。
 *
 * 覆盖：
 * - 成功接管返回 lastTakeover。
 * - 422 BUSINESS_CONSTRAINT_VIOLATION 错误含 blocking_reasons。
 * - 409 IDEMPOTENCY_CONFLICT 错误转化。
 * - 网络异常转化为 NETWORK_ERROR。
 * - busy 期间拒绝重复触发。
 * - clearError 清除错误。
 * - 组件卸载后不写入 state（unmounted 守卫）。
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { useEnvironmentTakeover } from "./use-environment-takeover";

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  fetchMock.mockReset();
  cleanup();
});

function buildTakeoverResponse(
  overrides: Partial<{
    thread_id: string;
    ownership_id: string;
    lease_id: string | null;
    revoked_lock_ids: readonly string[];
    event_id: string;
    previous_lease_epoch: number;
    reason_code: string;
  }> = {},
): Response {
  return new Response(
    JSON.stringify({
      thread_id: "t1",
      ownership_id: "own-1",
      lease_id: "lease-1",
      revoked_lock_ids: [],
      event_id: "evt-1",
      previous_lease_epoch: 3,
      reason_code: "user_takeover",
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function buildErrorResponse(
  status: number,
  code: string,
  details?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: "接管失败",
        request_id: "req-1",
        retryable: false,
        ...(details ? { details } : {}),
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

describe("useEnvironmentTakeover", () => {
  it("初始状态：busy=false, error=null, lastTakeover=null", () => {
    const { result } = renderHook(() => useEnvironmentTakeover());
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastTakeover).toBeNull();
  });

  it("成功接管返回 lastTakeover", async () => {
    fetchMock.mockResolvedValueOnce(buildTakeoverResponse({ previous_lease_epoch: 5 }));

    const { result } = renderHook(() => useEnvironmentTakeover());

    let takeoverResult: ClientTakeoverResponse | null = null;
    await act(async () => {
      takeoverResult = await result.current.requestTakeover("t1");
    });

    expect(takeoverResult).not.toBeNull();
    // act 闭包赋值后 TS 仍将 takeoverResult 收窄为 null，需经 unknown 中转断言
    expect((takeoverResult as unknown as ClientTakeoverResponse).previous_lease_epoch).toBe(5);
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastTakeover?.ownership_id).toBe("own-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/threads/t1/environment:takeover");
    expect(init?.method).toBe("POST");
    expect(init?.headers?.["Idempotency-Key"]).toBeTruthy();
  });

  it("422 BUSINESS_CONSTRAINT_VIOLATION 含 blocking_reasons", async () => {
    fetchMock.mockResolvedValueOnce(
      buildErrorResponse(422, "BUSINESS_CONSTRAINT_VIOLATION", {
        blocking_reasons: ["有 2 个未完成 ToolCall", "有 1 个 unknown_effect 待核对"],
        pending_tool_calls: 2,
        unknown_effects: 1,
      }),
    );

    const { result } = renderHook(() => useEnvironmentTakeover());

    let takeoverResult: unknown = "non-null";
    await act(async () => {
      takeoverResult = await result.current.requestTakeover("t1");
    });

    expect(takeoverResult).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.code).toBe("BUSINESS_CONSTRAINT_VIOLATION");
    expect(result.current.error?.blocking_reasons).toEqual([
      "有 2 个未完成 ToolCall",
      "有 1 个 unknown_effect 待核对",
    ]);
    expect(result.current.lastTakeover).toBeNull();
  });

  it("409 IDEMPOTENCY_CONFLICT 错误转化", async () => {
    fetchMock.mockResolvedValueOnce(buildErrorResponse(409, "IDEMPOTENCY_CONFLICT"));

    const { result } = renderHook(() => useEnvironmentTakeover());

    await act(async () => {
      await result.current.requestTakeover("t1");
    });

    expect(result.current.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(result.current.error?.blocking_reasons).toBeUndefined();
  });

  it("网络异常转化为 NETWORK_ERROR", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { result } = renderHook(() => useEnvironmentTakeover());

    await act(async () => {
      await result.current.requestTakeover("t1");
    });

    expect(result.current.error?.code).toBe("NETWORK_ERROR");
    expect(result.current.error?.retryable).toBe(true);
    expect(result.current.busy).toBe(false);
  });

  it("busy 期间拒绝重复触发", async () => {
    // 第一次请求延迟返回
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(buildTakeoverResponse()), 50);
        }),
    );

    const { result } = renderHook(() => useEnvironmentTakeover());

    let firstResult: unknown = "initial";
    let secondResult: unknown = "initial";

    // 同时发起两次 requestTakeover
    await act(async () => {
      const p1 = result.current.requestTakeover("t1");
      // 刷新微任务让 busyRef 设置为 true
      await Promise.resolve();
      const p2 = result.current.requestTakeover("t1");
      firstResult = await p1;
      secondResult = await p2;
    });

    // 第一次成功
    expect(firstResult).not.toBeNull();
    // 第二次被拒绝（返回 null）
    expect(secondResult).toBeNull();
    // 只调用了一次 fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clearError 清除错误", async () => {
    fetchMock.mockResolvedValueOnce(buildErrorResponse(422, "BUSINESS_CONSTRAINT_VIOLATION"));

    const { result } = renderHook(() => useEnvironmentTakeover());

    await act(async () => {
      await result.current.requestTakeover("t1");
    });

    expect(result.current.error).not.toBeNull();

    await act(async () => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });

  it("reason_code 传入请求体", async () => {
    fetchMock.mockResolvedValueOnce(
      buildTakeoverResponse({ reason_code: "device_heartbeat_timeout" }),
    );

    const { result } = renderHook(() => useEnvironmentTakeover());

    await act(async () => {
      await result.current.requestTakeover("t1", "device_heartbeat_timeout");
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string) as { reason_code?: string };
    expect(body.reason_code).toBe("device_heartbeat_timeout");
  });

  it("组件卸载后不写入 state（unmounted 守卫）", async () => {
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(buildTakeoverResponse()), 50);
        }),
    );

    const { result, unmount } = renderHook(() => useEnvironmentTakeover());

    let takeoverResult: unknown = "initial";
    await act(async () => {
      const p = result.current.requestTakeover("t1");
      unmount();
      takeoverResult = await p;
    });

    // 接管仍完成（busyRef 已重置），但 state 不写入
    expect(takeoverResult).not.toBeNull();
    // result.current 仍是初始状态
    expect(result.current.lastTakeover).toBeNull();
  });
});
