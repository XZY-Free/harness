import type { ClientGoal, ClientItem, ClientTurn } from "@/lib/client/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/workspace-panel/file-tree", () => ({
  FileTree: ({ onSelectPath }: { onSelectPath: (path: string) => void }) => (
    <button type="button" onClick={() => onSelectPath("notes/plan.md")}>
      打开 plan.md
    </button>
  ),
}));

vi.mock("@/components/workspace-panel/file-editor", () => ({
  FileEditor: ({ path }: { path: string }) => <output>编辑：{path}</output>,
}));

vi.mock("@/components/desktop/desktop-browser-surface", () => ({
  DesktopBrowserSurface: ({
    userId,
    suspendNativeView,
  }: {
    userId: string;
    suspendNativeView?: boolean;
  }) => (
    <output>
      浏览器用户：{userId}；浏览器暂停：{suspendNativeView ? "是" : "否"}
    </output>
  ),
}));

import { DesktopWorkbench } from "./desktop-workbench";

const goal: ClientGoal = {
  id: "goal-1",
  thread_id: "thread-1",
  objective: "整理本周产品方案",
  success_criteria: null,
  constraints: null,
  current_state: null,
  goal_state: "active",
  created_at: "2026-07-29T10:00:00.000Z",
  completed_at: null,
};

const latestTurn: ClientTurn = {
  controls: {
    cancel_supported: true,
    resume_supported: false,
    steer_supported: true,
  },
  id: "turn-1",
  requested_agent_id: null,
  turn_sequence: 1,
  trigger_type: "message",
  trigger_ref: null,
  trigger_item_id: null,
  turn_state: "waiting_user",
  active_invocation_id: null,
  latest_invocation_id: null,
  adopted_invocation_id: null,
  final_item_id: null,
  error_code: null,
  regeneration_no: 0,
  accepted_at: "2026-07-29T10:00:00.000Z",
  started_at: "2026-07-29T10:00:01.000Z",
  waiting_at: "2026-07-29T10:00:02.000Z",
  finished_at: null,
};

const items: readonly ClientItem[] = [
  {
    id: "action-1",
    turn_id: "turn-1",
    item_sequence: 1,
    item_type: "user_action",
    item_state: "pending",
    content: {
      request_type: "confirmation",
      title: "确认发布方案",
      summary: "发布前请检查变更",
      target_path: "docs/plan.md",
      diff: "- 旧内容\n+ 新内容",
    },
    created_at: "2026-07-29T10:00:03.000Z",
  },
  {
    id: "artifact-1",
    turn_id: "turn-1",
    item_sequence: 2,
    item_type: "artifact",
    item_state: "completed",
    content: { artifact_id: "artifact-1", display_name: "产品方案.md", artifact_type: "file" },
    created_at: "2026-07-29T10:00:04.000Z",
  },
];

function openWorkbenchTab(name: "文件" | "审阅" | "浏览器") {
  fireEvent.click(screen.getByRole("button", { name: "打开工作台功能" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

describe("DesktopWorkbench", () => {
  afterEach(cleanup);

  it("以真实 Goal、Turn、确认项和产物作为任务概览", () => {
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={items}
        onLocateItem={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "任务" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("整理本周产品方案")).not.toBeNull();
    expect(screen.getByText("等待确认")).not.toBeNull();
    expect(screen.getByText("确认发布方案")).not.toBeNull();
    expect(screen.getByText("产品方案.md")).not.toBeNull();
  });

  it("从加号打开文件，并使用真实文件树选择文件", () => {
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={items}
        onLocateItem={vi.fn()}
      />,
    );

    openWorkbenchTab("文件");
    expect(screen.getByRole("tab", { name: "文件" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "打开 plan.md" }));
    expect(screen.getByText("编辑：notes/plan.md")).not.toBeNull();
  });

  it("审阅显示真实差异，并将确认操作定位回对话时间线", () => {
    const onLocateItem = vi.fn();
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={items}
        onLocateItem={onLocateItem}
      />,
    );

    openWorkbenchTab("审阅");
    expect(screen.getByText(/旧内容/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "回到对话确认" }));
    expect(onLocateItem).toHaveBeenCalledWith("action-1");
  });

  it("只在打开浏览器页签后挂载原生浏览器", () => {
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={items}
        onLocateItem={vi.fn()}
      />,
    );

    expect(screen.queryByText(/浏览器用户：user-1/)).toBeNull();
    openWorkbenchTab("浏览器");
    expect(screen.getByText(/浏览器用户：user-1/)).not.toBeNull();
  });

  it("浏览器置于可分配高度的 flex 容器中，供原生视图计算准确边界", () => {
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={items}
        onLocateItem={vi.fn()}
      />,
    );

    openWorkbenchTab("浏览器");
    const browserWrapper = screen.getByText(/浏览器用户：user-1/).parentElement;
    expect(browserWrapper?.className).toContain("flex");
    expect(browserWrapper?.className).toContain("flex-1");
    expect(browserWrapper?.className).toContain("min-h-0");
  });

  it("浏览器为分隔线预留原生视图不可覆盖的左侧热区", () => {
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={items}
        onLocateItem={vi.fn()}
      />,
    );

    openWorkbenchTab("浏览器");
    const browserWrapper = screen.getByText(/浏览器用户：user-1/).parentElement;
    expect(browserWrapper?.className).toContain("pl-2");
  });

  it("拖动分隔线会调整工作台宽度", () => {
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={items}
        onLocateItem={vi.fn()}
      />,
    );

    const workbench = screen.getByLabelText("任务工作台");
    fireEvent.pointerDown(screen.getByRole("separator", { name: "调整工作台宽度" }), {
      clientX: 500,
    });
    fireEvent.pointerMove(window, { clientX: 450 });
    fireEvent.pointerUp(window);

    expect(workbench.getAttribute("style")).toContain("width: 418px");
  });

  it("根据聊天区实际宽度放宽向左拖拽范围", () => {
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={items}
        onLocateItem={vi.fn()}
      />,
    );

    const workbench = screen.getByLabelText("任务工作台");
    if (!workbench.parentElement) throw new Error("工作台缺少分栏容器");
    workbench.parentElement.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: 1400,
          height: 900,
          top: 0,
          right: 1400,
          bottom: 900,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );

    fireEvent.pointerDown(screen.getByRole("separator", { name: "调整工作台宽度" }), {
      clientX: 900,
    });
    fireEvent.pointerMove(window, { clientX: 400 });
    fireEvent.pointerUp(window);

    expect(workbench.getAttribute("style")).toContain("width: 868px");
  });

  it("拖拽期间暂停原生浏览器视图，避免它截获后续指针事件", () => {
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={items}
        onLocateItem={vi.fn()}
      />,
    );

    openWorkbenchTab("浏览器");
    const separator = screen.getByRole("separator", { name: "调整工作台宽度" });
    fireEvent.pointerDown(separator, { clientX: 500, pointerId: 1 });
    expect(screen.getByText(/浏览器暂停：是/)).not.toBeNull();
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(screen.getByText(/浏览器暂停：否/)).not.toBeNull();
  });

  it("已解析的确认不会作为待确认任务展示", () => {
    const resolvedItems = items.map((item) =>
      item.id === "action-1"
        ? { ...item, content: { ...(item.content as Record<string, unknown>), state: "resolved" } }
        : item,
    );
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={resolvedItems}
        onLocateItem={vi.fn()}
      />,
    );

    expect(screen.queryByText("确认发布方案")).toBeNull();
  });

  it("受控收起时将右侧工作台过渡到零宽度", () => {
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={[]}
        isOpen={false}
        onLocateItem={vi.fn()}
      />,
    );

    const workbench = screen.getByLabelText("任务工作台");
    expect(workbench.getAttribute("aria-hidden")).toBe("true");
    expect(workbench.getAttribute("style")).toContain("width: 0px");
    expect(workbench.className).toContain("transition-[width]");
  });

  it("空工作台以居中的轻量入口代替任务提示和底部固定按钮", () => {
    render(
      <DesktopWorkbench
        threadId="thread-1"
        viewerId="user-1"
        activeGoal={goal}
        latestTurn={latestTurn}
        items={[]}
        isOpen
        onLocateItem={vi.fn()}
      />,
    );

    expect(screen.queryByText("当前任务")).toBeNull();
    expect(screen.queryByText("当前没有需要确认的操作。")).toBeNull();
    expect(screen.queryByText("对话生成的文件会显示在这里。")).toBeNull();
    expect(screen.queryByRole("button", { name: "收起工作台" })).toBeNull();
    const shortcuts = screen.getByLabelText("空任务快捷入口");
    expect(shortcuts.className).toContain("items-center");
    expect(shortcuts.className).toContain("justify-center");

    fireEvent.click(screen.getByRole("button", { name: "打开文件" }));
    expect(screen.getByRole("tab", { name: "文件" }).getAttribute("aria-selected")).toBe("true");
  });
});
