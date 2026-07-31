import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V4 Phase A-1：ChatPanel 停止/中断按钮单测。
 * 验收：busy 状态渲染停止按钮；点击 → stop() + POST /cancel + onStatusChange("idle")；
 * idle 状态渲染发送按钮（无停止按钮）。
 *
 * useChat / toast / icons / markdown / model-selector / sse-transport 全 mock，
 * 聚焦停止按钮行为，不验证 LLM 调用与流式。
 */

// 可变 useChat 返回值（每个测试设置不同 status）
const chatState = {
  status: "ready" as string,
  messages: [] as Array<{
    id: string;
    role: string;
    parts: Array<{ type: string; text?: string }>;
  }>,
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  stop: vi.fn(),
  regenerate: vi.fn(),
  error: undefined as undefined | { message: string },
};

vi.mock("@ai-sdk/react", () => ({
  useChat: () => chatState,
}));
vi.mock("@/lib/chat/sse-transport", () => ({
  SseChatTransport: class {},
}));
vi.mock("@/lib/chat/attachments", () => ({
  isAttachmentDataPart: () => false,
  isAttachmentTextPart: () => false,
}));
vi.mock("./toast", () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));
// Icon 用 Proxy：任意图标访问返回空组件
vi.mock("./icons", () => ({
  Icon: new Proxy(
    {},
    {
      get: () => () => null,
    },
  ),
  TOOL_ICON: {},
}));
vi.mock("./markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => children ?? null,
}));
vi.mock("./model-selector", () => ({
  ModelSelector: () => null,
}));

import { ChatPanel } from "./chat-panel";

const baseProps = {
  threadId: "t1",
  initialMessages: [],
  models: [{ id: "m1", name: "M1" }],
  selectedModel: "m1",
  onModelChange: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  // happy-dom localStorage 兜底（确保 getItem/setItem 存在）
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  });
  chatState.status = "ready";
  chatState.messages = [];
  chatState.error = undefined;
  chatState.stop.mockReset();
  chatState.sendMessage.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals(); // 清 localStorage stub，防泄漏到同 worker 其他测试文件
});

describe("A-1: ChatPanel 停止/中断按钮", () => {
  it("busy(streaming)状态渲染停止按钮，点击调 stop + POST /cancel + onStatusChange(idle)", () => {
    chatState.status = "streaming";
    const onStatusChange = vi.fn();
    render(<ChatPanel {...baseProps} onStatusChange={onStatusChange} />);

    const stopBtn = screen.getByTitle("停止生成");
    fireEvent.click(stopBtn);

    expect(chatState.stop).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("/api/threads/t1/cancel", { method: "POST" });
    expect(onStatusChange).toHaveBeenCalledWith("t1", "idle");
  });

  it("busy(submitted)状态也渲染停止按钮", () => {
    chatState.status = "submitted";
    render(<ChatPanel {...baseProps} onStatusChange={vi.fn()} />);
    expect(screen.getByTitle("停止生成")).toBeTruthy();
  });

  it("idle(ready)状态不渲染停止按钮（渲染发送按钮）", () => {
    chatState.status = "ready";
    render(<ChatPanel {...baseProps} onStatusChange={vi.fn()} />);
    expect(screen.queryByTitle("停止生成")).toBeNull();
    // 发送按钮是 type=submit
    const sendBtn = screen.getByRole("button", { name: "" });
    expect(sendBtn.getAttribute("type")).toBe("submit");
  });

  it("messages 引用变化但统计值不变时，不重复上抛 stats", () => {
    chatState.messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    const onStatsChange = vi.fn();
    const { rerender } = render(<ChatPanel {...baseProps} onStatsChange={onStatsChange} />);

    expect(onStatsChange).toHaveBeenCalledTimes(1);
    expect(onStatsChange).toHaveBeenLastCalledWith("t1", {
      messages: 1,
      toolCalls: 0,
      elapsedSec: null,
      running: false,
    });

    chatState.messages = [...chatState.messages];
    rerender(<ChatPanel {...baseProps} onStatsChange={onStatsChange} />);
    expect(onStatsChange).toHaveBeenCalledTimes(1);

    chatState.messages = [
      ...chatState.messages,
      { id: "m2", role: "assistant", parts: [{ type: "tool-readFile" }] },
    ];
    rerender(<ChatPanel {...baseProps} onStatsChange={onStatsChange} />);
    expect(onStatsChange).toHaveBeenCalledTimes(2);
    expect(onStatsChange).toHaveBeenLastCalledWith("t1", {
      messages: 2,
      toolCalls: 1,
      elapsedSec: null,
      running: false,
    });
  });

  it("消息列表和输入框随聊天主栏宽度伸缩，不设置固定最大宽度", () => {
    chatState.messages = [
      { id: "m1", role: "assistant", parts: [{ type: "text", text: "你好" }] },
      { id: "m2", role: "user", parts: [{ type: "text", text: "我要测试 thread 流程" }] },
    ];
    const { container } = render(<ChatPanel {...baseProps} onStatusChange={vi.fn()} />);

    const messageColumn = container.querySelector('[data-testid="chat-message-column"]');
    const inputColumn = container.querySelector('[data-testid="chat-input-column"]');

    expect(messageColumn).not.toBeNull();
    expect(inputColumn).not.toBeNull();
    expect(messageColumn?.className).toContain("w-full");
    expect(messageColumn?.className).not.toContain("max-w-");
    expect(inputColumn?.className).toContain("w-full");
    expect(inputColumn?.className).not.toContain("max-w-");
  });
});
