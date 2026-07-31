import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  WebContentsView: class {},
  session: {},
}));

import { BrowserController } from "./browser-controller";
import { ViewRegistry } from "./view-registry";

describe("BrowserController view visibility", () => {
  let controller: BrowserController;

  beforeEach(() => {
    controller = new BrowserController({
      serverOrigins: ["http://localhost:3000"],
      windowConstraints: { windowWidth: 1600, windowHeight: 1000 },
    });
  });

  it("隐藏后用相同 bounds 恢复时仍重新显示 native view", () => {
    const view = { setBounds: vi.fn() };
    const registry = new ViewRegistry<typeof view>();
    registry.set("thread-1", "tab-1", view, true);
    (
      controller as unknown as {
        viewRegistry: ViewRegistry<typeof view>;
      }
    ).viewRegistry = registry;

    const visibleBounds = { x: 700, y: 120, width: 800, height: 700 };
    expect(controller.setBounds("thread-1", "tab-1", visibleBounds, 1)).toBe(true);
    controller.hideThreadViews("thread-1");
    expect(controller.setBounds("thread-1", "tab-1", visibleBounds, 1)).toBe(true);

    expect(view.setBounds).toHaveBeenLastCalledWith(visibleBounds);
    expect(view.setBounds).toHaveBeenCalledTimes(3);
  });
});
