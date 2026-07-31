import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEditResend } from "./use-edit-resend";

/**
 * 12-P1-1：useEditResend hook 测试。
 *
 * 验证：
 * - startEditResend 设置 replaceFromRef + 调 setMessages + 触发 sendMessage（经 effect）
 * - sendMessage 收到正确的 role/parts（user + text part）
 * - onSend 回调在 send 后被调
 * - replaceFromRef 在 startEditResend 后持有 replaceFromId（供 transport 读取）
 * - 外部传入 replaceFromRef 时复用（chat-panel 场景）
 */

describe("useEditResend", () => {
  it("startEditResend 设置 replaceFromRef + 调 setMessages + 触发 sendMessage", async () => {
    const setMessages = vi.fn();
    const sendMessage = vi.fn();
    const onSend = vi.fn();

    const { result } = renderHook(() => useEditResend({ setMessages, sendMessage, onSend }));

    const truncated = [{ id: "m1", role: "user" }];
    await act(async () => {
      result.current.startEditResend({
        replaceFromId: "m2",
        truncatedMessages: truncated,
        newText: "编辑后内容",
      });
    });

    // setMessages 被调（截断）
    expect(setMessages).toHaveBeenCalledWith(truncated);
    // replaceFromRef 持有 replaceFromId
    expect(result.current.replaceFromRef.current).toBe("m2");
    // effect 触发 sendMessage，收到 user + text part
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      role: "user",
      parts: [{ type: "text", text: "编辑后内容" }],
    });
    // onSend 回调被调
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("isPending 在 send 后回到 false", async () => {
    const setMessages = vi.fn();
    const sendMessage = vi.fn();

    const { result } = renderHook(() => useEditResend({ setMessages, sendMessage }));

    expect(result.current.isPending).toBe(false);
    await act(async () => {
      result.current.startEditResend({
        replaceFromId: "m1",
        truncatedMessages: [],
        newText: "x",
      });
    });
    // effect 已执行完，pending 清空
    expect(result.current.isPending).toBe(false);
  });

  it("外部传入 replaceFromRef 时复用同一 ref", async () => {
    const externalRef: React.MutableRefObject<string | null> = { current: null };
    const setMessages = vi.fn();
    const sendMessage = vi.fn();

    const { result } = renderHook(() =>
      useEditResend({ setMessages, sendMessage, replaceFromRef: externalRef }),
    );

    // hook 返回的 ref 应是外部传入的同一对象
    expect(result.current.replaceFromRef).toBe(externalRef);

    await act(async () => {
      result.current.startEditResend({
        replaceFromId: "edit-id",
        truncatedMessages: [],
        newText: "y",
      });
    });

    // 外部 ref 被写入
    expect(externalRef.current).toBe("edit-id");
  });

  it("多次 startEditResend 各自触发 send", async () => {
    const setMessages = vi.fn();
    const sendMessage = vi.fn();

    const { result } = renderHook(() => useEditResend({ setMessages, sendMessage }));

    await act(async () => {
      result.current.startEditResend({
        replaceFromId: "a",
        truncatedMessages: [],
        newText: "first",
      });
    });
    await act(async () => {
      result.current.startEditResend({
        replaceFromId: "b",
        truncatedMessages: [],
        newText: "second",
      });
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      role: "user",
      parts: [{ type: "text", text: "first" }],
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      role: "user",
      parts: [{ type: "text", text: "second" }],
    });
    // replaceFromRef 持有最后一次的 id
    expect(result.current.replaceFromRef.current).toBe("b");
  });
});
