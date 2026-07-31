import {
  DESKTOP_CAPABILITY_VERSION,
  DESKTOP_IPC_CHANNELS,
  type DesktopCapabilities,
  type DesktopIpcChannel,
  getDesktopCapabilities,
  isAllowedOrigin,
  isDesktop,
  isValidDesktopCapabilities,
} from "@/lib/desktop/capabilities";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const VALID_CAP: DesktopCapabilities = {
  version: DESKTOP_CAPABILITY_VERSION,
  serverOrigin: "https://snow.example.com",
  appVersion: "0.1.0",
  ipcChannels: DESKTOP_IPC_CHANNELS,
  deviceId: null,
};

beforeEach(() => {
  (globalThis as unknown as { snowDesktop?: unknown }).snowDesktop = undefined;
});

afterEach(() => {
  (globalThis as unknown as { snowDesktop?: unknown }).snowDesktop = undefined;
});

describe("DESKTOP_CAPABILITY_VERSION", () => {
  it("版本为 1", () => {
    expect(DESKTOP_CAPABILITY_VERSION).toBe(1);
  });
});

describe("DESKTOP_IPC_CHANNELS", () => {
  it("包含 Phase 3 最小 channel 集", () => {
    expect(DESKTOP_IPC_CHANNELS).toContain("desktop:getCapabilities");
    expect(DESKTOP_IPC_CHANNELS).toContain("desktop:getInfo");
    expect(DESKTOP_IPC_CHANNELS).toContain("desktop:openExternal");
    expect(DESKTOP_IPC_CHANNELS).toContain("desktop:isFocused");
    expect(DESKTOP_IPC_CHANNELS).toContain("desktop:window:getFrameState");
  });

  it("所有 channel 为非空字符串", () => {
    for (const ch of DESKTOP_IPC_CHANNELS) {
      expect(typeof ch).toBe("string");
      expect(ch.length).toBeGreaterThan(0);
    }
  });

  it("channel 不重复", () => {
    const set = new Set<string>(DESKTOP_IPC_CHANNELS);
    expect(set.size).toBe(DESKTOP_IPC_CHANNELS.length);
  });
});

describe("isAllowedOrigin()", () => {
  it("https 始终允许", () => {
    expect(isAllowedOrigin("https://snow.example.com")).toBe(true);
    expect(isAllowedOrigin("https://localhost")).toBe(true);
  });

  it("http://localhost 允许", () => {
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin("http://localhost")).toBe(true);
  });

  it("http://127.0.0.1 允许", () => {
    expect(isAllowedOrigin("http://127.0.0.1:3000")).toBe(true);
  });

  it("http://evil.com 拒绝", () => {
    expect(isAllowedOrigin("http://evil.com")).toBe(false);
  });

  it("file:// 拒绝", () => {
    expect(isAllowedOrigin("file:///etc/passwd")).toBe(false);
  });

  it("data: 拒绝", () => {
    expect(isAllowedOrigin("data:text/html,<script>x</script>")).toBe(false);
  });

  it("blob: 拒绝", () => {
    expect(isAllowedOrigin("blob:https://example.com/uuid")).toBe(false);
  });

  it("空字符串拒绝", () => {
    expect(isAllowedOrigin("")).toBe(false);
  });

  it("非 URL 字符串拒绝", () => {
    expect(isAllowedOrigin("not a url")).toBe(false);
  });
});

describe("isValidDesktopCapabilities()", () => {
  it("合法 capability 通过", () => {
    expect(isValidDesktopCapabilities(VALID_CAP)).toBe(true);
  });

  it("带 deviceId 的 capability 通过", () => {
    expect(isValidDesktopCapabilities({ ...VALID_CAP, deviceId: "dev-1" })).toBe(true);
  });

  it("version 不匹配拒绝", () => {
    expect(isValidDesktopCapabilities({ ...VALID_CAP, version: 999 })).toBe(false);
  });

  it("serverOrigin 为 http://evil.com 拒绝", () => {
    expect(isValidDesktopCapabilities({ ...VALID_CAP, serverOrigin: "http://evil.com" })).toBe(
      false,
    );
  });

  it("appVersion 为空字符串拒绝", () => {
    expect(isValidDesktopCapabilities({ ...VALID_CAP, appVersion: "" })).toBe(false);
  });

  it("ipcChannels 包含白名单外 channel 拒绝", () => {
    expect(
      isValidDesktopCapabilities({
        ...VALID_CAP,
        ipcChannels: [...DESKTOP_IPC_CHANNELS, "evil:channel" as DesktopIpcChannel],
      }),
    ).toBe(false);
  });

  it("ipcChannels 不是数组拒绝", () => {
    expect(isValidDesktopCapabilities({ ...VALID_CAP, ipcChannels: "not-array" })).toBe(false);
  });

  it("deviceId 为数字拒绝", () => {
    expect(isValidDesktopCapabilities({ ...VALID_CAP, deviceId: 123 })).toBe(false);
  });

  it("null 拒绝", () => {
    expect(isValidDesktopCapabilities(null)).toBe(false);
  });

  it("undefined 拒绝", () => {
    expect(isValidDesktopCapabilities(undefined)).toBe(false);
  });

  it("字符串拒绝", () => {
    expect(isValidDesktopCapabilities("desktop")).toBe(false);
  });
});

describe("getDesktopCapabilities()", () => {
  it("无注入时返回 null", () => {
    expect(getDesktopCapabilities()).toBeNull();
  });

  it("有合法注入时返回 capability", () => {
    (globalThis as unknown as { snowDesktop: unknown }).snowDesktop = {
      capabilities: VALID_CAP,
    };
    expect(getDesktopCapabilities()).toEqual(VALID_CAP);
  });

  it("有非法注入时返回 null", () => {
    (globalThis as unknown as { snowDesktop: unknown }).snowDesktop = {
      capabilities: { bad: true },
    };
    expect(getDesktopCapabilities()).toBeNull();
  });

  it("注入 null 时返回 null", () => {
    (globalThis as unknown as { snowDesktop: unknown }).snowDesktop = { capabilities: null };
    expect(getDesktopCapabilities()).toBeNull();
  });
});

describe("isDesktop()", () => {
  it("无注入时返回 false", () => {
    expect(isDesktop()).toBe(false);
  });

  it("有合法注入时返回 true", () => {
    (globalThis as unknown as { snowDesktop: unknown }).snowDesktop = {
      capabilities: VALID_CAP,
    };
    expect(isDesktop()).toBe(true);
  });
});
