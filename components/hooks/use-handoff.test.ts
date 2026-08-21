// @vitest-environment happy-dom
/**
 * S10-W04：useHandoff Hook 测试。
 *
 * 覆盖：
 * - resolve(approve) 成功路径：fetch 调用 + lastResolve 更新。
 * - resolve(deny) 成功路径。
 * - 错误响应（409 OPERATION_PAYLOAD_CONFLICT）转化。
 * - 网络异常转化。
 * - busy 状态正确切换。
 * - 空 handoffId 触发参数错误。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { useHandoff } from "./use-handoff";

afterEach(() => {
  fetchMock.mockReset();
});

beforeEach(() => {
  fetchMock.mockReset();
});

function buildResolveResponse(resolution: "approve" | "deny") {
  return new Response(
    JSON.stringify({
      thread_id: "t1",
      request_id: "h1",
      resolution,
      request_state: "resolved",
      handed_off: resolution === "approve",
      previous_agent_id: "agent-001",
      primary_agent_id: resolution === "approve" ? "agent-002" : "agent-001",
      invocation_id: "inv-1",
      invocation_state: "running",
      resume_command_id: "cmd-1",
      resume_command_state: "queued",
      event_ids: ["e1", "e2"],
    }),
    { status: 200 },
  );
}

describe("useHandoff", () => {
  it("resolve(approve) 成功路径", async () => {
    fetchMock.mockResolvedValueOnce(buildResolveResponse("approve"));

    const { result } = renderHook(() => useHandoff({ threadId: "t1" }));

    expect(result.current.busy).toBe(false);

    let ok = false;
    await act(async () => {
      ok = await result.current.resolve("h1", "approve");
    });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/threads/t1/handoffs/h1/resolve");
    expect(init?.method).toBe("POST");
    expect(init?.headers?.["idempotency-key"]).toBeTruthy();
    expect(JSON.parse(init?.body as string)).toEqual({ resolution: "approve" });
    expect(result.current.lastResolve?.resolution).toBe("approve");
    expect(result.current.lastResolve?.handed_off).toBe(true);
    expect(result.current.busy).toBe(false);
  });

  it("resolve(deny) 成功路径", async () => {
    fetchMock.mockResolvedValueOnce(buildResolveResponse("deny"));

    const { result } = renderHook(() => useHandoff({ threadId: "t1" }));

    await act(async () => {
      const ok = await result.current.resolve("h1", "deny");
      expect(ok).toBe(true);
    });

    expect(result.current.lastResolve?.resolution).toBe("deny");
    expect(result.current.lastResolve?.handed_off).toBe(false);
  });

  it("409 OPERATION_PAYLOAD_CONFLICT 转化为可见错误", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "OPERATION_PAYLOAD_CONFLICT",
            message: "已解析",
            request_id: "r1",
            retryable: false,
            details: { request_id: "h1", current_state: "resolved" },
          },
        }),
        { status: 409 },
      ),
    );

    const { result } = renderHook(() => useHandoff({ threadId: "t1" }));

    let ok = true;
    await act(async () => {
      ok = await result.current.resolve("h1", "approve");
    });

    expect(ok).toBe(false);
    expect(result.current.error?.code).toBe("OPERATION_PAYLOAD_CONFLICT");
    expect(result.current.lastResolve).toBeNull();
  });

  it("网络异常转化为 NETWORK_ERROR", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useHandoff({ threadId: "t1" }));

    let ok = true;
    await act(async () => {
      ok = await result.current.resolve("h1", "approve");
    });

    expect(ok).toBe(false);
    expect(result.current.error?.code).toBe("NETWORK_ERROR");
  });

  it("空 handoffId 触发参数错误（不发请求）", async () => {
    const { result } = renderHook(() => useHandoff({ threadId: "t1" }));

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

    const { result } = renderHook(() => useHandoff({ threadId: "t1" }));

    act(() => {
      void result.current.resolve("h1", "approve");
    });

    await waitFor(() => {
      expect(result.current.busy).toBe(true);
    });

    resolveFetch(buildResolveResponse("approve"));

    await waitFor(() => {
      expect(result.current.busy).toBe(false);
    });
  });

  it("clearError 清空错误", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useHandoff({ threadId: "t1" }));

    await act(async () => {
      await result.current.resolve("h1", "approve");
    });

    expect(result.current.error).not.toBeNull();
    await act(async () => {
      result.current.clearError();
    });
    expect(result.current.error).toBeNull();
  });
});
