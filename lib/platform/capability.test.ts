import { afterEach, describe, expect, it } from "vitest";
import { getPlatformCapability, isDesktopBrowser, isWebPreview } from "./capability";

afterEach(() => {
  (globalThis as unknown as { __SNOW_PLATFORM__?: string }).__SNOW_PLATFORM__ = undefined;
});

describe("platform capability (V10 Phase 1)", () => {
  it("无 preload 注入时默认返回 web-preview", () => {
    expect(getPlatformCapability()).toBe("web-preview");
  });

  it("isWebPreview 在默认 Web 环境返回 true", () => {
    expect(isWebPreview()).toBe(true);
  });

  it("isDesktopBrowser 在默认 Web 环境返回 false", () => {
    expect(isDesktopBrowser()).toBe(false);
  });

  it("preload 注入 desktop-browser 后返回 desktop-browser", () => {
    (globalThis as unknown as { __SNOW_PLATFORM__?: string }).__SNOW_PLATFORM__ = "desktop-browser";
    expect(getPlatformCapability()).toBe("desktop-browser");
    expect(isDesktopBrowser()).toBe(true);
    expect(isWebPreview()).toBe(false);
  });
});
