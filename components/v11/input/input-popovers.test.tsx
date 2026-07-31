import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const catalogState = vi.hoisted(() => ({
  items: [
    { resource_id: "agent-report", display_name: "报表助手" },
    { resource_id: "agent-ops", display_name: "运维助手" },
  ],
  loading: false,
  error: null,
}));

const modelState = vi.hoisted(() => ({
  models: [{ id: "MiniMax-M2.5" }, { id: "ZHIPU/GLM-5.2" }],
  defaultModel: "ZHIPU/GLM-5.2",
  loading: false,
  error: null,
}));

vi.mock("@/components/hooks/use-v11-catalog", () => ({
  useV11Catalog: () => catalogState,
}));

vi.mock("@/components/hooks/use-available-models", () => ({
  useAvailableModels: () => modelState,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  PopoverContent: ({
    children,
    align,
    side,
    sideOffset: _sideOffset,
    ...props
  }: ComponentProps<"div"> & { align?: string; side?: string; sideOffset?: number }) => (
    <div data-align={align} data-side={side} {...props}>
      {children}
    </div>
  ),
  PopoverTitle: ({ children, ...props }: ComponentProps<"h2">) => <h2 {...props}>{children}</h2>,
}));

import { AgentSelectorPopover, ModelSelectorPopover } from "./input-popovers";

afterEach(() => {
  cleanup();
  catalogState.loading = false;
});

describe("AgentSelectorPopover", () => {
  it("提供桌面端空助手列表时，不等待空目录接口", () => {
    catalogState.loading = true;
    render(<AgentSelectorPopover currentAgentId="agent-default" agentOptions={[]} />);

    expect(screen.getByRole("button", { name: "助手" })).not.toBeNull();
    expect(screen.getByText("暂无可用助手")).not.toBeNull();
    expect(screen.queryByText("加载中…")).toBeNull();
  });

  it("未选择助手时使用与加号等高且带图标的轻量触发器", () => {
    render(<AgentSelectorPopover currentAgentId={null} />);

    const [trigger] = screen.getAllByRole("button", { name: "助手" });
    if (!trigger) throw new Error("未找到助手触发器");
    const surface = trigger.firstElementChild;

    expect(surface?.getAttribute("data-variant")).toBe("agent-pill");
    expect(surface?.classList.contains("rounded-full")).toBe(true);
    expect(surface?.classList.contains("h-[30px]")).toBe(true);
    expect(surface?.classList.contains("shadow-none")).toBe(true);
    expect(surface?.classList.contains("border")).toBe(true);
    expect(surface?.querySelector('[data-slot="agent-mark"]')).not.toBeNull();
    expect(surface?.querySelector('[data-slot="agent-label"]')?.textContent).toBe("助手");
  });

  it("先显示搜索框，再显示助手分组标题和已有助手", () => {
    render(<AgentSelectorPopover currentAgentId={null} />);

    const heading = screen.getByRole("heading", { name: "助手" });
    const search = screen.getByRole("searchbox", { name: "搜索助手" });
    expect(search.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("报表助手")).not.toBeNull();
    expect(screen.getByText("运维助手")).not.toBeNull();
  });

  it("按名称筛选助手并显示空结果", () => {
    render(<AgentSelectorPopover currentAgentId={null} />);
    const search = screen.getByRole("searchbox", { name: "搜索助手" });

    fireEvent.change(search, { target: { value: "运维" } });
    expect(screen.queryByText("报表助手")).toBeNull();
    expect(screen.getByText("运维助手")).not.toBeNull();

    fireEvent.change(search, { target: { value: "不存在" } });
    expect(screen.getByText("无匹配助手")).not.toBeNull();
  });

  it("没有匹配的助手时保持未选择状态，不虚构默认助手", () => {
    render(<AgentSelectorPopover currentAgentId="agent-default" />);

    expect(screen.getByRole("button", { name: "助手" })).not.toBeNull();
    expect(screen.queryByText("默认助手")).toBeNull();
  });

  it("向辅助技术标记当前选中的助手", () => {
    render(<AgentSelectorPopover currentAgentId="agent-ops" />);

    const currentOption = screen
      .getAllByRole("button", { name: "运维助手" })
      .find((element) => element.getAttribute("aria-current") === "true");
    expect(currentOption).not.toBeUndefined();
    expect(
      screen.getByRole("button", { name: "报表助手" }).getAttribute("aria-current"),
    ).toBeNull();
  });
});

describe("ModelSelectorPopover", () => {
  it("使用与加号等高且不过分突出的模型触发器", () => {
    render(<ModelSelectorPopover currentModelRef="MiniMax-M2.5" />);

    const [trigger] = screen.getAllByRole("button", { name: "MiniMax-M2.5" });
    if (!trigger) throw new Error("未找到模型触发器");
    const surface = trigger.firstElementChild;

    expect(surface?.getAttribute("data-variant")).toBe("model-pill");
    expect(surface?.classList.contains("rounded-full")).toBe(true);
    expect(surface?.classList.contains("h-[30px]")).toBe(true);
    expect(surface?.classList.contains("shadow-none")).toBe(true);
    expect(surface?.classList.contains("border")).toBe(true);
    expect(surface?.querySelector('[data-slot="model-mark"]')).not.toBeNull();
  });

  it("先显示搜索框，再显示模型分组标题和已有模型", () => {
    render(<ModelSelectorPopover currentModelRef={null} />);

    const heading = screen.getByRole("heading", { name: "模型" });
    const search = screen.getByRole("searchbox", { name: "搜索模型" });
    expect(search.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("MiniMax-M2.5")).not.toBeNull();
    expect(screen.getAllByText("ZHIPU/GLM-5.2")).toHaveLength(2);
  });

  it("按名称筛选模型并显示空结果", () => {
    render(<ModelSelectorPopover currentModelRef={null} />);
    const search = screen.getByRole("searchbox", { name: "搜索模型" });

    fireEvent.change(search, { target: { value: "minimax" } });
    expect(screen.getByText("MiniMax-M2.5")).not.toBeNull();
    expect(screen.queryAllByText("ZHIPU/GLM-5.2")).toHaveLength(1);

    fireEvent.change(search, { target: { value: "不存在" } });
    expect(screen.getByText("无匹配模型")).not.toBeNull();
  });

  it("从触发器右上方展开", () => {
    render(<ModelSelectorPopover currentModelRef={null} />);
    const popover = screen.getByTestId("model-selector-popover");

    expect(popover.getAttribute("data-side")).toBe("top");
    expect(popover.getAttribute("data-align")).toBe("start");
  });

  it("向辅助技术标记当前选中的模型", () => {
    render(<ModelSelectorPopover currentModelRef="MiniMax-M2.5" />);

    const currentOption = screen
      .getAllByRole("button", { name: "MiniMax-M2.5" })
      .find((element) => element.getAttribute("aria-current") === "true");
    expect(currentOption).not.toBeUndefined();
    expect(
      screen.getByRole("button", { name: "ZHIPU/GLM-5.2" }).getAttribute("aria-current"),
    ).toBeNull();
  });
});
