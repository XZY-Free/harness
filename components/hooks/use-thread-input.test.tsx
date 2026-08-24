import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadInput } from "./use-thread-input";

/**
 * 专题01：useThreadInput 的假 Thread 身份 fail-closed 测试。
 *
 * 业务不变量：
 * - threadId=null（新建页）时 route 必须为 'none'，send 绝不拼接 API URL（fetch 0 次），
 *   返回 false 并设置明确错误。
 * - threadId 非空（既有 Thread）+ latestTurn=null 时保持既有正式路径：走
 *   POST /api/v1/threads/{threadId}/turns。
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useThreadInput fail-closed（threadId=null）", () => {
  it("threadId=null 时 route='none'，send 非空文本返回 false 且绝不调用 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useThreadInput({ threadId: null, latestTurn: null }));

    expect(result.current.route).toBe("none");

    let ok = true;
    await act(async () => {
      ok = await result.current.send("你好");
    });

    expect(ok).toBe(false);
    expect(result.current.lastRoute).toBe("none");
    expect(result.current.error).toEqual(
      expect.objectContaining({
        title: "无法发送",
        description: "尚未创建正式 Thread，无法直接发送消息。",
      }),
    );
    // 绝不拼 API URL：fetch 必须为 0 次。
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useThreadInput 既有 Thread 正式路径", () => {
  it("threadId='thread-1' 且 latestTurn=null 时 send 走 /turns 并成功返回 true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useThreadInput({ threadId: "thread-1", latestTurn: null }));

    expect(result.current.route).toBe("turn");

    let ok = false;
    await act(async () => {
      ok = await result.current.send("你好");
    });

    expect(ok).toBe(true);
    expect(result.current.lastRoute).toBe("turn");
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/threads/thread-1/turns",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
