import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider, useSidebar } from "./sidebar-context";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 可控 matchMedia mock：暴露 dispatch 来模拟窗口跨断点缩放。 */
function createMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialMatches,
    media: "(max-width: 1179px)",
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    dispatch: (matches: boolean) => {
      mql.matches = matches;
      for (const cb of listeners) cb({ matches } as MediaQueryListEvent);
    },
  };
  return mql;
}

function Harness() {
  const { collapsed, isNarrow, toggle } = useSidebar();
  return (
    <div>
      <output data-testid="collapsed">{String(collapsed)}</output>
      <output data-testid="narrow">{String(isNarrow)}</output>
      <button type="button" onClick={toggle}>
        toggle
      </button>
    </div>
  );
}

describe("SidebarProvider 响应式状态机", () => {
  it("低于 1180px 断点自动收起；跨断点缩放时状态跟随 matchMedia", () => {
    const mql = createMatchMedia(true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mql),
    );
    const { unmount } = render(
      <SidebarProvider>
        <Harness />
      </SidebarProvider>,
    );
    // 窄屏初始：收起且为 overlay 断点
    expect(screen.getByTestId("collapsed").textContent).toBe("true");
    expect(screen.getByTestId("narrow").textContent).toBe("true");

    // 放大到 ≥1180px：展开且退出 overlay 断点
    act(() => mql.dispatch(false));
    expect(screen.getByTestId("collapsed").textContent).toBe("false");
    expect(screen.getByTestId("narrow").textContent).toBe("false");

    // 再缩回窄屏：再次收起
    act(() => mql.dispatch(true));
    expect(screen.getByTestId("collapsed").textContent).toBe("true");

    unmount();
  });

  it("手动 toggle 翻转收起状态，且不会越权改动断点来源", () => {
    const mql = createMatchMedia(true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mql),
    );
    render(
      <SidebarProvider>
        <Harness />
      </SidebarProvider>,
    );
    // 窄屏初始收起 → toggle 展开（overlay drawer 打开）
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.getByTestId("collapsed").textContent).toBe("false");
    expect(screen.getByTestId("narrow").textContent).toBe("true"); // 仍是窄屏断点
  });
});
