// @vitest-environment happy-dom
/**
 * S10-W05：useV11UserAction Hook 测试。
 *
 * 覆盖：
 * - resolve(approve/deny/submit/cancel) 4 种 resolution 成功路径。
 * - input 类型 submit 时正确传递 response_redacted。
 * - 409 OPERATION_PAYLOAD_CONFLICT 错误转化。
 * - 422 BUSINESS_CONSTRAINT_VIOLATION 错误转化。
 * - 网络异常转化为 NETWORK_ERROR。
 * - busy 状态正确切换。
 * - 空 requestId 触发参数错误（不发请求）。
 * - busy=true 时重复调用被拒绝。
 * - clearError 清空错误。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { useV11UserAction } from "./use-v11-user-action";

afterEach(() => {
  fetchMock.mockReset();
});

beforeEach(() => {
  fetchMock.mockReset();
});

function buildResolveResponse(
  resolution: "approve" | "deny" | "submit" | "cancel",
  overrides: Partial<{
    request_type: "confirmation" | "auth" | "grant" | "input";
    purpose: string | null;
    grant_id: string;
  }> = {},
): Response {
  return new Response(
    JSON.stringify({
      thread_id: "t1",
      request_id: "ua_001",
      request_type: overrides.request_type ?? "confirmation",
      purpose: overrides.purpose ?? "确认操作",
      resolution,
      request_state: "resolved",
      invocation_id: "inv_1",
      invocation_state: "running",
      resume_command_id: "cmd_1",
      resume_command_state: "queued",
      ...(overrides.grant_id ? { grant_id: overrides.grant_id } : {}),
      event_ids: ["e1", "e2"],
    }),
    { status: 200 },
  );
}

describe("useV11UserAction", () => {
  it("resolve(approve) 成功路径（confirmation 类型）", async () => {
    fetchMock.mockResolvedValueOnce(buildResolveResponse("approve"));

    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    expect(result.current.busy).toBe(false);

    let ok = false;
    await act(async () => {
      ok = await result.current.resolve("ua_001", "approve");
    });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/threads/t1/user-actions/ua_001:resolve");
    expect(init?.method).toBe("POST");
    expect(init?.headers?.["idempotency-key"]).toBeTruthy();
    expect(JSON.parse(init?.body as string)).toEqual({ resolution: "approve" });
    expect(result.current.lastResolve?.resolution).toBe("approve");
    expect(result.current.lastResolve?.request_type).toBe("confirmation");
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("resolve(deny) 成功路径", async () => {
    fetchMock.mockResolvedValueOnce(buildResolveResponse("deny"));

    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    await act(async () => {
      const ok = await result.current.resolve("ua_001", "deny");
      expect(ok).toBe(true);
    });

    expect(result.current.lastResolve?.resolution).toBe("deny");
  });

  it("resolve(submit) + responseRedactedJson → body 含 response_redacted", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResolveResponse("submit", { request_type: "input", purpose: "input" }),
    );

    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    await act(async () => {
      const ok = await result.current.resolve("ua_001", "submit", {
        responseRedactedJson: { name: "张三", age: 30 },
      });
      expect(ok).toBe(true);
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toEqual({
      resolution: "submit",
      response_redacted: { name: "张三", age: 30 },
    });
    expect(result.current.lastResolve?.request_type).toBe("input");
  });

  it("resolve(cancel) 成功路径", async () => {
    fetchMock.mockResolvedValueOnce(buildResolveResponse("cancel"));

    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    await act(async () => {
      const ok = await result.current.resolve("ua_001", "cancel");
      expect(ok).toBe(true);
    });

    expect(result.current.lastResolve?.resolution).toBe("cancel");
  });

  it("grant + approve 响应携带 grant_id", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResolveResponse("approve", {
        request_type: "grant",
        purpose: "grant",
        grant_id: "g_001",
      }),
    );

    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    await act(async () => {
      const ok = await result.current.resolve("ua_001", "approve");
      expect(ok).toBe(true);
    });

    expect(result.current.lastResolve?.grant_id).toBe("g_001");
    expect(result.current.lastResolve?.request_type).toBe("grant");
  });

  it("409 OPERATION_PAYLOAD_CONFLICT 转化为可见错误", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "OPERATION_PAYLOAD_CONFLICT",
            message: "UserActionRequest 已解析",
            request_id: "r1",
            retryable: false,
            details: { request_id: "ua_001", current_state: "resolved" },
          },
        }),
        { status: 409 },
      ),
    );

    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    let ok = true;
    await act(async () => {
      ok = await result.current.resolve("ua_001", "approve");
    });

    expect(ok).toBe(false);
    expect(result.current.error?.code).toBe("OPERATION_PAYLOAD_CONFLICT");
    expect(result.current.lastResolve).toBeNull();
  });

  it("422 BUSINESS_CONSTRAINT_VIOLATION 转化为可见错误", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "BUSINESS_CONSTRAINT_VIOLATION",
            message: "resolution 不适用于该 request_type",
            request_id: "r2",
            retryable: false,
            details: { request_type: "confirmation", resolution: "submit" },
          },
        }),
        { status: 422 },
      ),
    );

    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    let ok = true;
    await act(async () => {
      ok = await result.current.resolve("ua_001", "submit");
    });

    expect(ok).toBe(false);
    expect(result.current.error?.code).toBe("BUSINESS_CONSTRAINT_VIOLATION");
  });

  it("网络异常转化为 NETWORK_ERROR", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    let ok = true;
    await act(async () => {
      ok = await result.current.resolve("ua_001", "approve");
    });

    expect(ok).toBe(false);
    expect(result.current.error?.code).toBe("NETWORK_ERROR");
  });

  it("空 requestId 触发参数错误（不发请求）", async () => {
    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    let ok = true;
    await act(async () => {
      ok = await result.current.resolve("", "approve");
    });

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.error?.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("busy 状态在请求期间为 true", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    act(() => {
      void result.current.resolve("ua_001", "approve");
    });

    await waitFor(() => {
      expect(result.current.busy).toBe(true);
    });

    resolveFetch(buildResolveResponse("approve"));

    await waitFor(() => {
      expect(result.current.busy).toBe(false);
    });
  });

  it("busy=true 时重复调用被拒绝", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    act(() => {
      void result.current.resolve("ua_001", "approve");
    });

    await waitFor(() => {
      expect(result.current.busy).toBe(true);
    });

    // 在 busy 期间再次调用
    let secondOk = true;
    await act(async () => {
      secondOk = await result.current.resolve("ua_002", "deny");
    });
    expect(secondOk).toBe(false);
    expect(result.current.error?.code).toBe("REQUEST_SCHEMA_INVALID");
    // fetch 仅被调用一次（第二次被 busy 拦截）
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(buildResolveResponse("approve"));
    await waitFor(() => {
      expect(result.current.busy).toBe(false);
    });
  });

  it("clearError 清空错误", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useV11UserAction({ threadId: "t1" }));

    await act(async () => {
      await result.current.resolve("ua_001", "approve");
    });

    expect(result.current.error).not.toBeNull();
    await act(async () => {
      result.current.clearError();
    });
    expect(result.current.error).toBeNull();
  });
});
