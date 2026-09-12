import type { ClientItem } from "@/lib/client/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageLocator } from "./message-locator";

afterEach(cleanup);

/** 会话位置导航 v7 合同测试：回合 1:1、固定步长整簇居中、槽位吸附、仅聚焦变黑、
 * 左缘右向生长、在轴无过渡（离轴收拢）、预览卡常显聚焦回合、窄 pane 自动隐藏。 */

const NAV_FALLBACK_HEIGHT = 320;
const FIXED_STEP = 12;

function userItem(text: string, id: string, turnId: string): ClientItem {
  return {
    id,
    turn_id: turnId,
    item_sequence: 1,
    item_type: "user_message",
    item_state: "completed",
    content: { text },
    created_at: "2026-09-01T00:00:00.000Z",
  };
}

function agentItem(text: string, id: string, turnId: string): ClientItem {
  return {
    id,
    turn_id: turnId,
    item_sequence: 2,
    item_type: "assistant_message",
    item_state: "completed",
    content: { text },
    created_at: "2026-09-01T00:01:00.000Z",
  };
}

function toolItem(id: string, turnId: string): ClientItem {
  return {
    id,
    turn_id: turnId,
    item_sequence: 3,
    item_type: "tool_call",
    item_state: "completed",
    content: { tool: "shell", summary: "已运行 pnpm lint" },
    created_at: "2026-09-01T00:02:00.000Z",
  };
}

/** 三回合：turn-2 含过程折叠，证明刻度不随消息条数膨胀。 */
function threeTurnItems(): ClientItem[] {
  return [
    userItem("部署前核一下数据库迁移", "u-1", "turn-1"),
    agentItem("核对完成：重建空测试库。", "a-1", "turn-1"),
    userItem("右侧面板默认隐藏", "u-2", "turn-2"),
    toolItem("t-2", "turn-2"),
    agentItem("已改完并推送。", "a-2", "turn-2"),
    userItem("把定位轴找回来", "u-3", "turn-3"),
    agentItem("组件仍在仓库。", "a-3", "turn-3"),
  ];
}

function Harness({ items }: { readonly items: readonly ClientItem[] }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={scrollContainerRef} role="log" aria-label="对话时间线">
        <div ref={contentRef} className="message-track" />
      </div>
      <MessageLocator items={items} scrollContainerRef={scrollContainerRef} />
    </div>
  );
}

function ticks(): HTMLElement[] {
  const nav = screen.getByRole("navigation", { name: "会话位置导航" });
  return Array.from(nav.querySelectorAll("button"));
}

function tickLines(): HTMLElement[] {
  const nav = screen.getByRole("navigation", { name: "会话位置导航" });
  return Array.from(nav.querySelectorAll("button > span[aria-hidden='true']"));
}

describe("MessageLocator 回合粒度", () => {
  it("刻度数 = 用户回合数（1:1），过程折叠不产生刻度", () => {
    render(<Harness items={threeTurnItems()} />);
    expect(ticks()).toHaveLength(3);
  });

  it("刻度可访问名包含该回合用户提问原文", () => {
    render(<Harness items={threeTurnItems()} />);
    expect(screen.getByRole("button", { name: /部署前核一下数据库迁移/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /右侧面板默认隐藏/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /把定位轴找回来/ })).toBeTruthy();
  });

  it("空会话保留导航轨道（data-empty=true）且不渲染刻度", () => {
    render(<Harness items={[]} />);
    const nav = screen.getByRole("navigation", { name: "会话位置导航" });
    expect(nav.getAttribute("data-empty")).toBe("true");
    expect(ticks()).toHaveLength(0);
  });
});

describe("MessageLocator 固定步长与整簇居中", () => {
  it("happy-dom 无布局时回退 320px 轴高：3 回合 step=12 且整簇垂直居中", () => {
    render(<Harness items={threeTurnItems()} />);
    const clusterTop = (NAV_FALLBACK_HEIGHT - 2 * FIXED_STEP) / 2;
    const tops = ticks().map((tick) => tick.style.top);
    expect(tops).toEqual([
      `${clusterTop}px`,
      `${clusterTop + FIXED_STEP}px`,
      `${clusterTop + 2 * FIXED_STEP}px`,
    ]);
  });
});

describe("MessageLocator 槽位吸附与颜色模型", () => {
  it("指针在轴上时聚焦刻度变黑且最宽，周边只变长不变黑", () => {
    render(<Harness items={threeTurnItems()} />);
    const nav = screen.getByRole("navigation", { name: "会话位置导航" });
    const clusterTop = (NAV_FALLBACK_HEIGHT - 2 * FIXED_STEP) / 2;

    // 光标落在第 2 回合槽内（center=1）
    fireEvent.pointerMove(nav, { clientY: clusterTop + FIXED_STEP });

    const lines = tickLines();
    expect(lines[1]?.style.opacity).toBe("1");
    expect(lines[1]?.style.width).toBe("30px");
    // 相邻刻度：宽度连带增长，但透明度保持静止灰
    expect(Number.parseFloat(lines[0]?.style.width ?? "0")).toBeGreaterThan(10);
    expect(lines[0]?.style.opacity).toBe("0.35");
    expect(Number.parseFloat(lines[2]?.style.width ?? "0")).toBeGreaterThan(10);
    expect(lines[2]?.style.opacity).toBe("0.35");
  });

  it("预览卡常显聚焦回合（指针在轴上即显示，无需命中刻度）", () => {
    render(<Harness items={threeTurnItems()} />);
    const nav = screen.getByRole("navigation", { name: "会话位置导航" });
    const clusterTop = (NAV_FALLBACK_HEIGHT - 2 * FIXED_STEP) / 2;
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerMove(nav, { clientY: clusterTop + 2 * FIXED_STEP });

    const card = screen.getByRole("tooltip");
    expect(card.textContent).toContain("把定位轴找回来");
    expect(card.textContent).toContain("组件仍在仓库。");
  });

  it("键盘聚焦刻度同样显示该回合预览", () => {
    render(<Harness items={threeTurnItems()} />);
    fireEvent.focus(screen.getByRole("button", { name: /右侧面板默认隐藏/ }));
    const card = screen.getByRole("tooltip");
    expect(card.textContent).toContain("右侧面板默认隐藏");
    expect(card.textContent).toContain("已改完并推送。");
  });

  it("过槽中点才换焦：槽内移动不改变聚焦回合", () => {
    render(<Harness items={threeTurnItems()} />);
    const nav = screen.getByRole("navigation", { name: "会话位置导航" });
    const clusterTop = (NAV_FALLBACK_HEIGHT - 2 * FIXED_STEP) / 2;

    fireEvent.pointerMove(nav, { clientY: clusterTop + FIXED_STEP - 5 });
    expect(tickLines()[1]?.style.opacity).toBe("1");
    fireEvent.pointerMove(nav, { clientY: clusterTop + FIXED_STEP + 5 });
    expect(tickLines()[1]?.style.opacity).toBe("1");
    expect(tickLines()[0]?.style.opacity).toBe("0.35");
  });
});

describe("MessageLocator 形变方向与过渡合同", () => {
  it("刻度左缘对齐、仅向右生长（origin-left 且无水平位移）", () => {
    render(<Harness items={threeTurnItems()} />);
    for (const line of tickLines()) {
      expect(line.className).toContain("origin-left");
      expect(line.style.transform).toBe("");
    }
  });

  it("在轴上零过渡直跟，离开轴才挂 140ms 收拢", () => {
    render(<Harness items={threeTurnItems()} />);
    const nav = screen.getByRole("navigation", { name: "会话位置导航" });
    const clusterTop = (NAV_FALLBACK_HEIGHT - 2 * FIXED_STEP) / 2;

    fireEvent.pointerMove(nav, { clientY: clusterTop });
    expect(nav.className).not.toContain("settling");
    for (const line of tickLines()) {
      expect(line.className).not.toContain("duration-[140ms]");
    }

    fireEvent.pointerLeave(nav);
    expect(nav.className).toContain("settling");
    for (const line of tickLines()) {
      expect(line.className).toContain("duration-[140ms]");
    }
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("MessageLocator 窄 pane 自动隐藏", () => {
  it("可测量且左侧自由边距 < 32px 时隐藏导航", () => {
    const view = render(<Harness items={threeTurnItems()} />);
    const scroller = view.container.querySelector("[role='log']") as HTMLElement;
    const track = view.container.querySelector(".message-track") as HTMLElement;
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 500 });
    Object.defineProperty(track, "offsetWidth", { configurable: true, value: 500 });
    track.style.paddingLeft = "24px";

    fireEvent.scroll(scroller);

    const nav = screen.getByRole("navigation", { name: "会话位置导航" });
    expect(nav.className).toContain("message-locator-hidden");
  });

  it("布局不可测量（宽度 0）时不隐藏，避免测试/首帧误判", () => {
    render(<Harness items={threeTurnItems()} />);
    const nav = screen.getByRole("navigation", { name: "会话位置导航" });
    expect(nav.className).not.toContain("message-locator-hidden");
  });
});
