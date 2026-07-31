/**
 * V10 Phase 5：BridgeStatus 组件测试。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeStatus } from "./bridge-status";

// 模拟 getDesktopCapabilities
vi.mock("@/lib/desktop/capabilities", () => ({
  getDesktopCapabilities: vi.fn(),
}));

import { getDesktopCapabilities } from "@/lib/desktop/capabilities";

// 模拟 window.snowDesktop
interface MockSnowDesktop {
  snowDesktop?: {
    bridge?: {
      getState: () => Promise<unknown>;
      onStateChange: (cb: (state: unknown) => void) => () => void;
    };
  };
}

function setSnowDesktop(bridge?: MockSnowDesktop["snowDesktop"]): void {
  const w = window as unknown as MockSnowDesktop;
  w.snowDesktop = bridge;
}

function clearSnowDesktop(): void {
  const w = window as unknown as MockSnowDesktop;
  w.snowDesktop = undefined;
}

const MOCK_CAPS = {
  version: 1,
  serverOrigin: "http://localhost:3001",
  appVersion: "1.0.0",
  ipcChannels: [],
  deviceId: "device-1",
} as const;

describe("BridgeStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSnowDesktop();
  });

  afterEach(() => {
    cleanup();
    clearSnowDesktop();
  });

  it("非 Desktop 环境不渲染", () => {
    vi.mocked(getDesktopCapabilities).mockReturnValue(null);
    const { container } = render(<BridgeStatus />);
    expect(container.firstChild).toBeNull();
  });

  it("Desktop 环境渲染状态指示器", async () => {
    vi.mocked(getDesktopCapabilities).mockReturnValue(MOCK_CAPS);

    setSnowDesktop({
      bridge: {
        getState: vi.fn().mockResolvedValue("authenticated"),
        onStateChange: vi.fn().mockReturnValue(() => {}),
      },
    });

    render(<BridgeStatus />);
    const status = await screen.findByTestId("bridge-status");
    expect(status).not.toBeNull();
  });

  it("disconnected 状态显示正确", async () => {
    vi.mocked(getDesktopCapabilities).mockReturnValue(MOCK_CAPS);

    setSnowDesktop({
      bridge: {
        getState: vi.fn().mockResolvedValue("disconnected"),
        onStateChange: vi.fn().mockReturnValue(() => {}),
      },
    });

    render(<BridgeStatus />);
    const status = await screen.findByTestId("bridge-status");
    expect(status.getAttribute("data-state")).toBe("disconnected");
  });

  it("authenticated 状态显示正确", async () => {
    vi.mocked(getDesktopCapabilities).mockReturnValue(MOCK_CAPS);

    setSnowDesktop({
      bridge: {
        getState: vi.fn().mockResolvedValue("authenticated"),
        onStateChange: vi.fn().mockReturnValue(() => {}),
      },
    });

    render(<BridgeStatus />);
    const status = await screen.findByTestId("bridge-status");
    expect(status.getAttribute("data-state")).toBe("authenticated");
  });

  it("protocol_mismatch 状态显示正确", async () => {
    vi.mocked(getDesktopCapabilities).mockReturnValue(MOCK_CAPS);

    setSnowDesktop({
      bridge: {
        getState: vi.fn().mockResolvedValue("protocol_mismatch"),
        onStateChange: vi.fn().mockReturnValue(() => {}),
      },
    });

    render(<BridgeStatus />);
    const status = await screen.findByTestId("bridge-status");
    expect(status.getAttribute("data-state")).toBe("protocol_mismatch");
  });

  it("snowDesktop.bridge 不存在时显示 disconnected 状态", async () => {
    vi.mocked(getDesktopCapabilities).mockReturnValue(MOCK_CAPS);

    // 不设置 snowDesktop
    render(<BridgeStatus />);
    const status = await screen.findByTestId("bridge-status");
    expect(status.getAttribute("data-state")).toBe("disconnected");
  });

  it("状态变化时更新显示", async () => {
    vi.mocked(getDesktopCapabilities).mockReturnValue(MOCK_CAPS);

    let stateCallback: ((state: unknown) => void) | null = null;
    setSnowDesktop({
      bridge: {
        getState: vi.fn().mockResolvedValue("connecting"),
        onStateChange: vi.fn().mockImplementation((cb: (state: unknown) => void) => {
          stateCallback = cb;
          return () => {
            stateCallback = null;
          };
        }),
      },
    });

    render(<BridgeStatus />);
    const status = await screen.findByTestId("bridge-status");
    expect(status.getAttribute("data-state")).toBe("connecting");

    // 模拟状态变化
    await act(async () => {
      if (stateCallback) {
        stateCallback("authenticated");
      }
    });

    expect(status.getAttribute("data-state")).toBe("authenticated");
  });
});
