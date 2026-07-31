// @vitest-environment happy-dom
/**
 * S10-W06：useDesktopOperations Hook 测试。
 *
 * 覆盖：
 * - 非 Desktop 环境（globalThis.snowDesktop 不存在）→ isDesktop=false，所有操作返回 null + NOT_DESKTOP。
 * - Desktop 环境 + 命名空间缺失 → NAMESPACE_UNAVAILABLE。
 * - Desktop 环境 + 命名空间存在 → IPC 调用成功，lastResult 设置。
 * - IPC 调用抛异常 → IPC_ERROR。
 * - running 状态正确切换。
 * - capabilities 列表正确反映 enabled 状态。
 * - clear 清除 lastResult 和 lastError。
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDesktopOperations } from "./use-desktop-operations";

/** 构造一个最小的 capability 对象。 */
function makeCapabilities() {
  return {
    version: 1 as const,
    serverOrigin: "https://snow.example.com",
    appVersion: "1.0.0-test",
    ipcChannels: [
      "desktop:getCapabilities",
      "desktop:shell:exec",
      "desktop:file:read",
      "desktop:file:write",
      "desktop:file:list",
      "desktop:git:status",
      "desktop:git:diff",
      "desktop:git:log",
      "desktop:app:open",
      "desktop:build:run",
      "desktop:test:run",
    ],
    deviceId: "device-001",
  };
}

/** 构造一个完整的 bridge（含所有操作命名空间）。 */
function makeFullBridge() {
  const caps = makeCapabilities();
  return {
    capabilities: caps,
    getCapabilities: vi.fn().mockResolvedValue(caps),
    openExternal: vi.fn().mockResolvedValue(undefined),
    isFocused: vi.fn().mockResolvedValue(true),
    device: { getRegistration: vi.fn().mockResolvedValue({}) },
    bridge: {
      getState: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      onStateChange: vi.fn(),
    },
    browser: {
      createTab: vi.fn(),
      closeTab: vi.fn(),
      switchTab: vi.fn(),
      reorderTabs: vi.fn(),
      navigate: vi.fn(),
      setBounds: vi.fn(),
      getTabs: vi.fn(),
      getActiveTab: vi.fn(),
      hideViews: vi.fn(),
      subscribe: vi.fn(),
      restoreTabs: vi.fn(),
      getLockState: vi.fn(),
      cancelAi: vi.fn(),
      onLockStateChange: vi.fn(),
      onTabUpdate: vi.fn(),
    },
    shell: { exec: vi.fn() },
    file: { read: vi.fn(), write: vi.fn(), list: vi.fn() },
    git: { status: vi.fn(), diff: vi.fn(), log: vi.fn() },
    app: { open: vi.fn() },
    build: { run: vi.fn() },
    test: { run: vi.fn() },
  };
}

beforeEach(() => {
  // 清理 globalThis.snowDesktop
  (globalThis as Record<string, unknown>).snowDesktop = undefined;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).snowDesktop = undefined;
  cleanup();
});

describe("useDesktopOperations", () => {
  it("非 Desktop 环境 → isDesktop=false，execShell 返回 null + NOT_DESKTOP", async () => {
    const { result } = renderHook(() => useDesktopOperations());

    // 等待 useEffect 触发
    await waitFor(() => {
      expect(result.current.isDesktop).toBe(false);
    });

    expect(result.current.deviceId).toBeNull();
    expect(result.current.capabilities.length).toBeGreaterThan(0);
    for (const cap of result.current.capabilities) {
      expect(cap.enabled).toBe(false);
    }

    let res: unknown = "initial";
    await act(async () => {
      res = await result.current.execShell({ threadId: "t1", command: "ls" });
    });

    expect(res).toBeNull();
    expect(result.current.lastError?.code).toBe("NOT_DESKTOP");
    expect(result.current.lastError?.operation).toBe("shell.exec");
  });

  it("Desktop 环境 + 命名空间存在 → IPC 调用成功，lastResult 设置", async () => {
    const bridge = makeFullBridge();
    (globalThis as Record<string, unknown>).snowDesktop = bridge;

    const expectedResult = {
      category: "shell" as const,
      operation: "shell.exec",
      device_id: "device-001",
      cwd: "/tmp",
      exit_code: 0,
      stdout: "file1\nfile2",
      stderr: "",
      duration_ms: 42,
      requires_confirmation: false,
      user_action_request_id: null,
      completed_at: "2026-07-21T00:00:00.000Z",
    };
    bridge.shell.exec.mockResolvedValueOnce(expectedResult);

    const { result } = renderHook(() => useDesktopOperations());

    await waitFor(() => {
      expect(result.current.isDesktop).toBe(true);
    });

    expect(result.current.deviceId).toBe("device-001");
    // capabilities 中 shell.exec 应 enabled=true
    const shellCap = result.current.capabilities.find((c) => c.operation === "shell.exec");
    expect(shellCap?.enabled).toBe(true);

    let res: unknown = null;
    await act(async () => {
      res = await result.current.execShell({ threadId: "t1", command: "ls", cwd: "/tmp" });
    });

    expect(res).toEqual(expectedResult);
    expect(result.current.lastResult).toEqual(expectedResult);
    expect(result.current.lastError).toBeNull();
    expect(result.current.running).toBe(false);
    expect(bridge.shell.exec).toHaveBeenCalledWith({ threadId: "t1", command: "ls", cwd: "/tmp" });
  });

  it("Desktop 环境 + 命名空间缺失 → NAMESPACE_UNAVAILABLE", async () => {
    // 构造不含 shell 命名空间的 bridge
    const bridge = makeFullBridge();
    (bridge as { shell?: unknown }).shell = undefined;
    (globalThis as Record<string, unknown>).snowDesktop = bridge;

    const { result } = renderHook(() => useDesktopOperations());

    await waitFor(() => {
      expect(result.current.isDesktop).toBe(true);
    });

    const shellCap = result.current.capabilities.find((c) => c.operation === "shell.exec");
    expect(shellCap?.enabled).toBe(false);

    let res: unknown = "initial";
    await act(async () => {
      res = await result.current.execShell({ threadId: "t1", command: "ls" });
    });

    expect(res).toBeNull();
    expect(result.current.lastError?.code).toBe("NAMESPACE_UNAVAILABLE");
    expect(result.current.lastError?.operation).toBe("shell.exec");
  });

  it("IPC 调用抛异常 → IPC_ERROR", async () => {
    const bridge = makeFullBridge();
    (globalThis as Record<string, unknown>).snowDesktop = bridge;
    bridge.shell.exec.mockRejectedValueOnce(new Error("IPC channel closed"));

    const { result } = renderHook(() => useDesktopOperations());

    await waitFor(() => {
      expect(result.current.isDesktop).toBe(true);
    });

    let res: unknown = "initial";
    await act(async () => {
      res = await result.current.execShell({ threadId: "t1", command: "ls" });
    });

    expect(res).toBeNull();
    expect(result.current.lastError?.code).toBe("IPC_ERROR");
    expect(result.current.lastError?.message).toContain("IPC channel closed");
    expect(result.current.lastResult).toBeNull();
    expect(result.current.running).toBe(false);
  });

  it("running 状态在调用期间为 true", async () => {
    const bridge = makeFullBridge();
    (globalThis as Record<string, unknown>).snowDesktop = bridge;

    let resolveExec: ((v: unknown) => void) | null = null;
    bridge.shell.exec.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveExec = resolve;
        }),
    );

    const { result } = renderHook(() => useDesktopOperations());

    await waitFor(() => {
      expect(result.current.isDesktop).toBe(true);
    });

    expect(result.current.running).toBe(false);

    // 触发 execShell 但不 await（mock 返回未解决 promise）
    const execPromise = result.current.execShell({ threadId: "t1", command: "ls" });

    // 刷新微任务让 setRunning(true) 生效
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.running).toBe(true);

    // 解决 mock promise
    await act(async () => {
      resolveExec?.({
        category: "shell",
        operation: "shell.exec",
        device_id: "device-001",
        cwd: null,
        exit_code: 0,
        stdout: "",
        stderr: "",
        duration_ms: 1,
        requires_confirmation: false,
        user_action_request_id: null,
        completed_at: "2026-07-21T00:00:00.000Z",
      });
      await execPromise;
    });

    expect(result.current.running).toBe(false);
  });

  it("clear 清除 lastResult 和 lastError", async () => {
    const bridge = makeFullBridge();
    (globalThis as Record<string, unknown>).snowDesktop = bridge;
    bridge.git.status.mockResolvedValueOnce({
      category: "git",
      operation: "git.status",
      device_id: "device-001",
      cwd: "/tmp",
      exit_code: 0,
      stdout: "## main",
      stderr: "",
      duration_ms: 10,
      requires_confirmation: false,
      user_action_request_id: null,
      completed_at: "2026-07-21T00:00:00.000Z",
    });

    const { result } = renderHook(() => useDesktopOperations());

    await waitFor(() => {
      expect(result.current.isDesktop).toBe(true);
    });

    await act(async () => {
      await result.current.gitStatus({ threadId: "t1", cwd: "/tmp" });
    });

    expect(result.current.lastResult).not.toBeNull();

    act(() => {
      result.current.clear();
    });

    expect(result.current.lastResult).toBeNull();
    expect(result.current.lastError).toBeNull();
  });

  it("各操作方法都能正确路由到对应命名空间", async () => {
    const bridge = makeFullBridge();
    (globalThis as Record<string, unknown>).snowDesktop = bridge;

    const mockResult = {
      category: "file" as const,
      operation: "file.read",
      device_id: "device-001",
      cwd: null,
      exit_code: 0,
      stdout: "content",
      stderr: "",
      duration_ms: 5,
      requires_confirmation: false,
      user_action_request_id: null,
      completed_at: "2026-07-21T00:00:00.000Z",
    };
    bridge.file.read.mockResolvedValueOnce(mockResult);
    bridge.git.diff.mockResolvedValueOnce({ ...mockResult, operation: "git.diff" });
    bridge.app.open.mockResolvedValueOnce({ ...mockResult, operation: "app.open" });
    bridge.build.run.mockResolvedValueOnce({ ...mockResult, operation: "build.run" });
    bridge.test.run.mockResolvedValueOnce({ ...mockResult, operation: "test.run" });

    const { result } = renderHook(() => useDesktopOperations());

    await waitFor(() => {
      expect(result.current.isDesktop).toBe(true);
    });

    await act(async () => {
      await result.current.readFile({ threadId: "t1", path: "/tmp/a.txt" });
    });
    expect(bridge.file.read).toHaveBeenCalledWith({ threadId: "t1", path: "/tmp/a.txt" });

    await act(async () => {
      await result.current.gitDiff({ threadId: "t1", cwd: "/tmp", staged: true });
    });
    expect(bridge.git.diff).toHaveBeenCalledWith({ threadId: "t1", cwd: "/tmp", staged: true });

    await act(async () => {
      await result.current.openApp({ threadId: "t1", target: "com.example.app" });
    });
    expect(bridge.app.open).toHaveBeenCalledWith({ threadId: "t1", target: "com.example.app" });

    await act(async () => {
      await result.current.runBuild({ threadId: "t1", cwd: "/tmp", command: "make" });
    });
    expect(bridge.build.run).toHaveBeenCalledWith({ threadId: "t1", cwd: "/tmp", command: "make" });

    await act(async () => {
      await result.current.runTest({ threadId: "t1", cwd: "/tmp", command: "pytest" });
    });
    expect(bridge.test.run).toHaveBeenCalledWith({
      threadId: "t1",
      cwd: "/tmp",
      command: "pytest",
    });
  });
});
