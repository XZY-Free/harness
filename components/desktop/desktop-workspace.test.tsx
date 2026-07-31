import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/desktop/capabilities", () => ({
  getDesktopCapabilities: vi.fn(),
  getDesktopBridge: vi.fn(),
}));
vi.mock("@/components/workspace", () => ({
  Workspace: (props: Record<string, unknown>) => (
    <div
      data-testid="workspace"
      data-platform={String(props.platform)}
      data-user-id={String(props.userId)}
      data-thread-id={String(props.threadId)}
    />
  ),
}));

import { getDesktopBridge, getDesktopCapabilities } from "@/lib/desktop/capabilities";
import { DesktopWorkspace } from "./desktop-workspace";

const mockedGetDesktopCapabilities = vi.mocked(getDesktopCapabilities);
const mockedGetDesktopBridge = vi.mocked(getDesktopBridge);
const connect = vi.fn();
const getRegistration = vi.fn();
const baseProps = {
  userId: "user-1",
  threadId: "thread-1",
  initialMessages: [],
  initialStatus: "idle" as const,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("DesktopWorkspace", () => {
  it("普通浏览器访问时显示 Desktop 提示，不挂载工作台", () => {
    mockedGetDesktopCapabilities.mockReturnValue(null);
    render(<DesktopWorkspace {...baseProps} />);
    expect(screen.getByText("需要 SnowHarness Desktop")).toBeTruthy();
    expect(screen.queryByTestId("workspace")).toBeNull();
  });

  it("可信 preload 存在时挂载工作台，绑定设备后连接 Bridge", async () => {
    mockedGetDesktopCapabilities.mockReturnValue({
      version: 1,
      serverOrigin: "http://localhost:3000",
      appVersion: "0.1.0",
      ipcChannels: [],
      deviceId: "device-1",
    });
    mockedGetDesktopBridge.mockReturnValue({
      device: { getRegistration },
      bridge: { connect },
    } as never);
    getRegistration.mockResolvedValue({
      deviceId: "device-1",
      publicKey: "public-key",
      name: "MacBook Pro",
      version: "0.1.0",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    render(<DesktopWorkspace {...baseProps} />);
    expect(screen.getByTestId("workspace").getAttribute("data-platform")).toBe("desktop");
    expect(screen.getByTestId("workspace").getAttribute("data-user-id")).toBe("user-1");
    expect(screen.getByTestId("workspace").getAttribute("data-thread-id")).toBe("thread-1");
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/desktop/devices/register",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("设备绑定失败时保留本地工作台并明确提示 AI 浏览器不可用", async () => {
    mockedGetDesktopCapabilities.mockReturnValue({
      version: 1,
      serverOrigin: "http://localhost:3000",
      appVersion: "0.1.0",
      ipcChannels: [],
      deviceId: "device-1",
    });
    mockedGetDesktopBridge.mockReturnValue({
      device: { getRegistration },
      bridge: { connect },
    } as never);
    getRegistration.mockResolvedValue({
      deviceId: "device-1",
      publicKey: "public-key",
      name: "MacBook Pro",
      version: "0.1.0",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 409 })));

    render(<DesktopWorkspace {...baseProps} />);

    expect(screen.getByTestId("workspace")).toBeTruthy();
    expect(await screen.findByText("AI 浏览器连接失败，本地浏览不受影响")).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
  });
});
