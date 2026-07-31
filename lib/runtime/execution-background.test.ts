import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.2 Stage B：ExecutionRuntime 后台能力单测。
 * - host：真实 spawn detached 进程，验证 unref 独立存活、tree-kill 回收整组无孤儿、exit→markStopped。
 * - container：mock docker-cli / manager，验证 execDetached 复用容器 + pkill best-effort 停止。
 * - closeAllContainers 先调 closeAllBackgroundTasks。
 */

const registry = vi.hoisted(() => ({
  attachStopHandle: vi.fn(),
  markStopped: vi.fn().mockResolvedValue(null),
  closeAllBackgroundTasks: vi.fn().mockResolvedValue(undefined),
  sweepIdleBackgroundTasks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/runtime/background-task-registry", () => ({
  attachStopHandle: registry.attachStopHandle,
  markStopped: registry.markStopped,
  closeAllBackgroundTasks: registry.closeAllBackgroundTasks,
  sweepIdleBackgroundTasks: registry.sweepIdleBackgroundTasks,
}));

const docker = vi.hoisted(() => ({
  execDetached: vi.fn().mockResolvedValue(undefined),
  execDetachedWithPid: vi.fn((_containerName: string, taskId: string) =>
    Promise.resolve({
      pidFile: `/workspace/.snow/runtime/tasks/${taskId}.pid`,
      logPath: `/workspace/.snow/runtime/tasks/${taskId}.log`,
    }),
  ),
  execInContainer: vi
    .fn()
    .mockResolvedValue({ ok: true, exitCode: 0, stdout: "", stderr: "", command: "" }),
}));
vi.mock("@/lib/runtime/container/docker-cli", () => ({
  execDetached: docker.execDetached,
  execDetachedWithPid: docker.execDetachedWithPid,
  execInContainer: docker.execInContainer,
}));

const manager = vi.hoisted(() => ({
  startContainer: vi.fn(),
  touchActivity: vi.fn(),
  stopContainerById: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/runtime/container/manager", () => ({
  startContainer: manager.startContainer,
  touchActivity: manager.touchActivity,
  stopContainerById: manager.stopContainerById,
  closeAllContainers: vi.fn(), // 避免退出 hook 真跑
  startIdleSweep: vi.fn(),
}));

const workspace = vi.hoisted(() => ({ workspaceRoot: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ workspaceRoot: workspace.workspaceRoot }));
const secrets = vi.hoisted(() => ({
  prepareContainerStartOptions: vi.fn(),
}));
vi.mock("@/lib/runtime/container/start-options", () => ({
  prepareContainerStartOptions: secrets.prepareContainerStartOptions,
}));

import { ContainerExecutionRuntime, HostExecutionRuntime } from "./execution-runtime";

let dir: string;
const origHostLogDir = process.env.SNOW_BG_TASK_HOST_LOG_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "snow-bg-exec-"));
  process.env.SNOW_BG_TASK_HOST_LOG_DIR = dir;
  registry.attachStopHandle.mockReset();
  registry.markStopped.mockReset().mockResolvedValue(null);
  registry.closeAllBackgroundTasks.mockReset().mockResolvedValue(undefined);
  registry.sweepIdleBackgroundTasks.mockReset().mockResolvedValue(undefined);
  docker.execDetached.mockReset().mockResolvedValue(undefined);
  docker.execDetachedWithPid
    .mockReset()
    .mockImplementation((_containerName: string, taskId: string) =>
      Promise.resolve({
        pidFile: `/workspace/.snow/runtime/tasks/${taskId}.pid`,
        logPath: `/workspace/.snow/runtime/tasks/${taskId}.log`,
      }),
    );
  docker.execInContainer.mockReset().mockResolvedValue({
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    command: "",
  });
  manager.startContainer.mockReset();
  manager.touchActivity.mockReset();
  manager.stopContainerById.mockReset().mockResolvedValue(undefined);
  workspace.workspaceRoot.mockReset().mockReturnValue(dir);
  secrets.prepareContainerStartOptions.mockReset().mockResolvedValue({
    startOptions: {
      quota: { memory: "512m" },
      networkPolicy: { mode: "disabled" },
      secretEnvFile: "/tmp/secret.env",
    },
    secretsCache: { API_KEY: "secret" },
    cleanup: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  if (origHostLogDir === undefined) delete process.env.SNOW_BG_TASK_HOST_LOG_DIR;
  else process.env.SNOW_BG_TASK_HOST_LOG_DIR = origHostLogDir;
});

/** 进程是否存活（kill -0）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** pgrep -P 取直接子进程 pid 列表。 */
async function children(pid: number): Promise<number[]> {
  const { execa } = await import("execa");
  const r = await execa("pgrep", ["-P", String(pid)], { reject: false, timeout: 2_000 });
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

describe("HostExecutionRuntime.exec 流式回写（02-P1-8）", () => {
  it("onChunk 逐块接收 stdout", async () => {
    const host = new HostExecutionRuntime("t1");
    const chunks: string[] = [];
    const r = await host.exec("echo stream-test-output", {
      onChunk: (_stream, chunk) => chunks.push(chunk),
    });
    expect(r.ok).toBe(true);
    expect(chunks.join("")).toContain("stream-test-output");
  });

  it("不传 onChunk → 仍返回完整缓冲结果（零回归）", async () => {
    const host = new HostExecutionRuntime("t1");
    const r = await host.exec("echo no-stream");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("no-stream");
  });
});

describe("HostExecutionRuntime.startBackground / stopBackground", () => {
  it("返回 pid，进程独立存活（unref），不阻塞调用方", async () => {
    const host = new HostExecutionRuntime("t1");
    const handle = await host.startBackground("sleep 30", {
      taskId: "bt1",
      threadId: "t1",
      logRelPath: ".snow/runtime/t1/tasks/bt1.log",
    });
    expect(handle.pid).toBeGreaterThan(0);
    expect(alive(handle.pid as number)).toBe(true);
    // 清理
    await host.stopBackground(handle);
    expect(alive(handle.pid as number)).toBe(false);
  });

  it("stdout/stderr 重定向到日志文件", async () => {
    const host = new HostExecutionRuntime("t1");
    const handle = await host.startBackground("echo hello-bg", {
      taskId: "bt2",
      threadId: "t1",
      logRelPath: ".snow/runtime/t1/tasks/bt2.log",
    });
    // 等进程退出 + 日志落盘
    await new Promise((r) => setTimeout(r, 300));
    const { readFile } = await import("node:fs/promises");
    const log = await readFile(resolve(dir, ".snow/runtime/t1/tasks/bt2.log"), "utf8");
    expect(log).toContain("hello-bg");
    await host.stopBackground(handle);
  });

  it("attachStopHandle 被调用（注入 tree-kill 回调）", async () => {
    const host = new HostExecutionRuntime("t1");
    const handle = await host.startBackground("sleep 30", {
      taskId: "bt3",
      threadId: "t1",
      logRelPath: ".snow/runtime/t1/tasks/bt3.log",
    });
    expect(registry.attachStopHandle).toHaveBeenCalledWith("bt3", expect.any(Function), "t1");
    await host.stopBackground(handle);
  });

  it("进程自然退出 → markStopped(reason=crash) 被触发", async () => {
    const host = new HostExecutionRuntime("t1");
    const handle = await host.startBackground("sh -c 'exit 7'", {
      taskId: "bt4",
      threadId: "t1",
      logRelPath: ".snow/runtime/t1/tasks/bt4.log",
    });
    // 等退出事件
    await new Promise((r) => setTimeout(r, 400));
    expect(registry.markStopped).toHaveBeenCalledWith(
      "bt4",
      expect.objectContaining({ reason: "crash" }),
    );
    // exitCode 为 7（code）或 -1（signal 路径）；此处 sh -c 'exit 7' 正常退出 code=7
    const call = registry.markStopped.mock.calls[0]?.[1] as { exitCode: number };
    expect(call.exitCode).toBe(7);
    void handle;
  });

  it("tree-kill 回收整组：fork 子进程的命令无孤儿", async () => {
    const host = new HostExecutionRuntime("t1");
    // sh 启动一个 sleep 子进程并 wait——sh 存活，sleep 为子进程
    const handle = await host.startBackground("sh -c 'sleep 30 & wait'", {
      taskId: "bt5",
      threadId: "t1",
      logRelPath: ".snow/runtime/t1/tasks/bt5.log",
    });
    const pid = handle.pid as number;
    expect(alive(pid)).toBe(true);
    // 等子进程起来
    await new Promise((r) => setTimeout(r, 300));
    const kidsBefore = await children(pid);
    expect(kidsBefore.length).toBeGreaterThanOrEqual(1);

    await host.stopBackground(handle);

    // 父进程已死
    expect(alive(pid)).toBe(false);
    // 子进程被组杀，无孤儿（pgrep -P pid 为空；且原子 pid 也已死）
    const kidsAfter = await children(pid);
    expect(kidsAfter).toEqual([]);
    for (const kid of kidsBefore) {
      expect(alive(kid)).toBe(false);
    }
  });

  it("stopBackground 对无 pid 的 handle 不抛", async () => {
    const host = new HostExecutionRuntime("t1");
    await expect(host.stopBackground({ command: "x" })).resolves.toBeUndefined();
  });

  // P0 修复（02-P0-1）：host 后台任务必须继承 secret，与 exec 路径对齐。
  it("startBackground 懒加载 secretResolver 并把 secret 注入后台进程 env", async () => {
    const host = new HostExecutionRuntime("t1", undefined, () =>
      Promise.resolve({ SNOW_BG_TEST_TOKEN: "bg-secret-value" } as Record<string, string>),
    );
    const handle = await host.startBackground("printenv SNOW_BG_TEST_TOKEN", {
      taskId: "bt-secret",
      threadId: "t1",
      logRelPath: ".snow/runtime/t1/tasks/bt-secret.log",
    });
    // 等进程退出 + 日志落盘
    await new Promise((r) => setTimeout(r, 300));
    const { readFile } = await import("node:fs/promises");
    const log = await readFile(resolve(dir, ".snow/runtime/t1/tasks/bt-secret.log"), "utf8");
    expect(log).toContain("bg-secret-value");
    await host.stopBackground(handle);
  });

  it("startBackground secretResolver 失败 → 抛错（不返回残缺 handle 假装启动）", async () => {
    const host = new HostExecutionRuntime("t1", undefined, () =>
      Promise.reject(new Error("secret boom")),
    );
    await expect(
      host.startBackground("sleep 1", {
        taskId: "bt-secret-fail",
        threadId: "t1",
        logRelPath: ".snow/runtime/t1/tasks/bt-secret-fail.log",
      }),
    ).rejects.toThrow("secret boom");
  });
});

describe("ContainerExecutionRuntime.startBackground / stopBackground", () => {
  it("复用容器 + execDetached 重定向到 bind mount 日志", async () => {
    manager.startContainer.mockResolvedValue({
      containerName: "snow-thread-tC",
      containerId: "cid",
      port: 41000,
      state: "running",
      lastActivityAt: Date.now(),
    });
    const c = new ContainerExecutionRuntime("tC");
    const handle = await c.startBackground("npm run dev", {
      taskId: "btC1",
      threadId: "tC",
      logRelPath: ".snow/runtime/tC/tasks/btC1.log",
    });
    expect(handle.containerName).toBe("snow-thread-tC");
    expect(handle.taskId).toBe("btC1");
    expect(secrets.prepareContainerStartOptions).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "tC" }),
    );
    expect(manager.startContainer).toHaveBeenCalledWith(
      "tC",
      expect.objectContaining({
        quota: expect.objectContaining({ memory: "512m" }),
        networkPolicy: expect.objectContaining({ mode: "disabled" }),
        secretEnvFile: "/tmp/secret.env",
      }),
    );
    expect(docker.execDetachedWithPid).toHaveBeenCalledWith(
      "snow-thread-tC",
      "btC1",
      expect.stringContaining("npm run dev > /workspace/.snow/runtime/tC/tasks/btC1.log 2>&1"),
    );
    expect(registry.attachStopHandle).toHaveBeenCalledWith("btC1", expect.any(Function), "tC");
  });

  it("secret 解析失败 → exec fail-closed，不启动容器", async () => {
    secrets.prepareContainerStartOptions.mockRejectedValueOnce(new Error("secret boom"));
    const c = new ContainerExecutionRuntime("tC");
    const out = await c.exec("npm test");
    expect(out.ok).toBe(false);
    expect(out.stderr).toContain("secret boom");
    expect(manager.startContainer).not.toHaveBeenCalled();
  });

  it("stopBackground 读 PID 文件精确 kill；读不到时回退 pkill -f，失败不抛", async () => {
    docker.execInContainer.mockRejectedValue(new Error("cat fail"));
    const c = new ContainerExecutionRuntime("tC");
    await expect(
      c.stopBackground({ containerName: "snow-thread-tC", command: "npm run dev", taskId: "btC1" }),
    ).resolves.toBeUndefined();
    expect(docker.execInContainer).toHaveBeenCalledWith(
      "snow-thread-tC",
      expect.stringContaining("cat /workspace/.snow/runtime/tasks/btC1.pid"),
      expect.any(Object),
    );
    expect(docker.execInContainer).toHaveBeenCalledWith(
      "snow-thread-tC",
      expect.stringContaining("pkill -f"),
      expect.any(Object),
    );
  });

  it("attached stop 回调读 PID 文件并精确 kill", async () => {
    manager.startContainer.mockResolvedValue({
      containerName: "snow-thread-tC",
      containerId: "cid",
      port: 41000,
      state: "running",
      lastActivityAt: Date.now(),
    });
    docker.execInContainer.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "12345",
      stderr: "",
      command: "",
    });
    const c = new ContainerExecutionRuntime("tC");
    await c.startBackground("vite", {
      taskId: "btC2",
      threadId: "tC",
      logRelPath: ".snow/runtime/tC/tasks/btC2.log",
    });
    const stopFn = registry.attachStopHandle.mock.calls.at(-1)?.[1] as () => Promise<void>;
    await stopFn();
    expect(docker.execInContainer).toHaveBeenCalledWith(
      "snow-thread-tC",
      expect.stringContaining("cat /workspace/.snow/runtime/tasks/btC2.pid"),
      expect.any(Object),
    );
    expect(docker.execInContainer).toHaveBeenCalledWith(
      "snow-thread-tC",
      expect.stringContaining("kill -TERM 12345"),
      expect.any(Object),
    );
    expect(docker.execInContainer).toHaveBeenCalledWith(
      "snow-thread-tC",
      expect.stringContaining("kill -KILL 12345"),
      expect.any(Object),
    );
  });
});
