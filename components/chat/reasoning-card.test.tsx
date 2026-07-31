import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 12-P2-1：ReasoningCard 组件测试。
 *
 * 从 chat-panel 抽出的独立组件，验证：
 * - 流式中默认展开，含内容渲染 + 光标动画
 * - 流式结束后自动折叠（延迟）
 * - 点击标题栏切换展开/收起
 * - 空内容不渲染
 */

vi.mock("@/components/icons", () => ({
  Icon: new Proxy(
    {},
    {
      get: () => () => null,
    },
  ),
}));
vi.mock("@/components/markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ReasoningCard } from "./reasoning-card";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ReasoningCard 12-P2-1", () => {
  it("空内容不渲染", () => {
    const { container } = render(<ReasoningCard text="" isStreaming={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("流式中默认展开，渲染内容", () => {
    render(<ReasoningCard text="正在思考..." isStreaming={true} />);
    expect(screen.getByText("正在思考...")).toBeTruthy();
    expect(screen.getByText("思考")).toBeTruthy();
    const content = screen.getByTestId("reasoning-content");
    expect(content.className).not.toContain("max-h-");
    expect(content.className).not.toContain("overflow-y-auto");
  });

  it("非流式且有内容：默认折叠，显示摘要", () => {
    render(<ReasoningCard text="第一行思考内容很长很长" isStreaming={false} />);
    // 折叠态：标题栏可见，内容区不渲染
    expect(screen.getByText("思考")).toBeTruthy();
    // 摘要显示在 code 标签
    expect(screen.getByText("第一行思考内容很长很长")).toBeTruthy();
  });

  it("点击标题栏切换展开/收起", () => {
    render(<ReasoningCard text="详细思考内容示例" isStreaming={false} />);
    // 默认折叠：摘要 code 可见，但 Markdown 内容区不渲染
    const toggle = screen.getByRole("button");
    fireEvent.click(toggle);
    // 展开后内容可见（Markdown mock 渲染 div 含 children）
    expect(screen.getByText("详细思考内容示例")).toBeTruthy();
    fireEvent.click(toggle);
    // 收起后内容区消失（code 摘要仍在，但内容 div 不在）
    const contentDivs = screen.queryAllByText("详细思考内容示例");
    // 折叠态只剩 code 摘要（1 个），内容 div 消失
    expect(contentDivs.length).toBe(1);
  });

  it("流式结束(true→false)延迟自动折叠", () => {
    const { rerender } = render(<ReasoningCard text="流式思考内容示例" isStreaming={true} />);
    // 流式中展开：内容 div 可见
    expect(screen.getByText("流式思考内容示例")).toBeTruthy();
    // 切到非流式
    rerender(<ReasoningCard text="流式思考内容示例" isStreaming={false} />);
    // 延迟 600ms 后自动折叠
    vi.advanceTimersByTime(700);
    // 折叠后内容区消失，只剩 code 摘要
    const remaining = screen.queryAllByText("流式思考内容示例");
    expect(remaining.length).toBe(1);
  });
});
