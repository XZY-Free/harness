import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 长消息列表回归测试。
 *
 * 之前这里走虚拟滚动；现在为了修复预览阶段的循环更新，改回普通列表。
 * 这里保留长列表场景，确保大量消息渲染与空态分支都正常。
 */

const chatState = {
  status: "ready" as string,
  messages: [] as Array<{
    id: string;
    role: string;
    parts: Array<{ type: string; text?: string }>;
    createdAt?: string | Date;
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

function makeMessages(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `消息 ${i}` }],
    createdAt: new Date(Date.now() + i * 1000),
  }));
}

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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChatPanel 长列表渲染", () => {
  it("200+ 消息渲染不崩溃", () => {
    chatState.messages = makeMessages(250);
    const { container } = render(<ChatPanel {...baseProps} onStatusChange={vi.fn()} />);
    expect(container).toBeTruthy();
  });

  it("长消息列表完整渲染，不再依赖虚拟滚动节点", () => {
    chatState.messages = makeMessages(250);
    const { container } = render(<ChatPanel {...baseProps} onStatusChange={vi.fn()} />);

    expect(container.textContent).toContain("消息 0");
    expect(container.textContent).toContain("消息 249");
    expect(container.querySelectorAll("[data-index]")).toHaveLength(0);
  });

  it("空消息列表走 empty 分支", () => {
    chatState.messages = [];
    const { container } = render(<ChatPanel {...baseProps} onStatusChange={vi.fn()} />);
    expect(screen.getByText("想做点什么？")).toBeTruthy();
    expect(container.querySelectorAll("[data-index]")).toHaveLength(0);
  });
});
