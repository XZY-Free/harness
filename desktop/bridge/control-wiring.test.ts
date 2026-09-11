import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchControlEvent,
  registerBrandInvalidatedHandler,
  resetControlHandlersForTest,
} from "./control-handlers";
import { attachDesktopControlPlane } from "./control-wiring";

afterEach(() => {
  resetControlHandlersForTest();
});

describe("Desktop Control Plane 装配", () => {
  it("客户端收到品牌事件驱动 applier 重设", async () => {
    const fetchBrand = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            brand: {
              schemaVersion: 1,
              revision: 2,
              name: "Nex",
              tagline: null,
              logo: { light: null, dark: null },
              icon: null,
              packaging: { productName: "Nex", appId: "x", dockLabel: "Nex" },
              updatedAt: null,
              updatedBy: null,
            },
          }),
          { status: 200, headers: { etag: '"2:0"' } },
        ),
    );
    const setAppName = vi.fn();
    attachDesktopControlPlane({
      baseUrl: "http://127.0.0.1:3100",
      fetchBrand,
      setAppName,
      setAllWindowTitles: vi.fn(),
      checkForUpdates: vi.fn(),
    });

    dispatchControlEvent({
      type: "control_brand_invalidated",
      revision: 2,
      etag: '"2:0"',
      occurredAt: 1,
    });
    await vi.waitFor(() => expect(setAppName).toHaveBeenCalledWith("Nex"));
  });

  it("升级 hint 触发检查且冷却内去重", async () => {
    const checkForUpdates = vi.fn(async () => null);
    let nowMs = 1_000_000;
    attachDesktopControlPlane({
      baseUrl: "http://127.0.0.1:3100",
      setAppName: vi.fn(),
      setAllWindowTitles: vi.fn(),
      checkForUpdates,
      hintCooldownMs: 60_000,
      now: () => nowMs,
    });

    dispatchControlEvent({ type: "control_update_hint", latestVersion: "9.9.9", occurredAt: 1 });
    dispatchControlEvent({ type: "control_update_hint", latestVersion: "9.9.9", occurredAt: 2 });
    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));

    nowMs += 61_000;
    dispatchControlEvent({ type: "control_update_hint", latestVersion: "9.9.9", occurredAt: 3 });
    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(2));
  });

  it("未注册 handler 时 dispatch 返回 false 且不抛错", () => {
    expect(
      dispatchControlEvent({
        type: "control_brand_invalidated",
        revision: 1,
        etag: '"1:0"',
        occurredAt: 1,
      }),
    ).toBe(false);
  });

  it("registerBrandInvalidatedHandler 返回的句柄可取消", async () => {
    const handler = vi.fn();
    const off = registerBrandInvalidatedHandler(handler);
    off();
    dispatchControlEvent({
      type: "control_brand_invalidated",
      revision: 1,
      etag: '"1:0"',
      occurredAt: 1,
    });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });
});
