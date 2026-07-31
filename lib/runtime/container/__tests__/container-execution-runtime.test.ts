import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 5 Stage B：ContainerExecutionRuntime 单测。
 * mock startContainer（manager）+ execInContainer（docker-cli），验证 exec 调用序列与异常兜底。
 */

const mgr = vi.hoisted(() => ({
  startContainer: vi.fn(),
  touchActivity: vi.fn(),
}));
const cli = vi.hoisted(() => ({
  execInContainer: vi.fn(),
}));

vi.mock("@/lib/runtime/container/manager", () => mgr);
vi.mock("@/lib/runtime/container/docker-cli", () => cli);

import { ContainerExecutionRuntime } from "@/lib/runtime/execution-runtime";

const TID = "thread-b-exec";
const ENTRY = {
  containerName: `snow-thread-${TID}`,
  containerId: "id",
  port: 41000,
  state: "running" as const,
  lastActivityAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ContainerExecutionRuntime", () => {
  it("exec → startContainer + execInContainer(容器内) + touchActivity", async () => {
    mgr.startContainer.mockResolvedValue(ENTRY);
    cli.execInContainer.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      command: "echo hi",
    });

    const rt = new ContainerExecutionRuntime(TID);
    const result = await rt.exec("echo hi", { timeoutMs: 30_000 });

    expect(mgr.startContainer).toHaveBeenCalledWith(
      TID,
      expect.objectContaining({
        quota: undefined,
        networkPolicy: undefined,
        secretEnvFile: undefined,
      }),
    );
    // execInContainer 内部会拼 `cd /workspace && {command}`，这里只校验透传的容器名与原命令
    expect(cli.execInContainer).toHaveBeenCalledWith(ENTRY.containerName, "echo hi", {
      timeoutMs: 30_000,
    });
    expect(mgr.touchActivity).toHaveBeenCalledWith(TID);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("hi");
  });

  it("exec 默认不传 timeoutMs → opts 透传 undefined（docker-cli 默认 30s）", async () => {
    mgr.startContainer.mockResolvedValue(ENTRY);
    cli.execInContainer.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      command: "ls",
    });

    const rt = new ContainerExecutionRuntime(TID);
    await rt.exec("ls");

    expect(cli.execInContainer).toHaveBeenCalledWith(ENTRY.containerName, "ls", undefined);
  });

  it("startContainer 抛 → catch 兜底 ok:false + exitCode:-1，不向上抛", async () => {
    mgr.startContainer.mockRejectedValue(new Error("docker run boom"));
    cli.execInContainer.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      command: "x",
    });

    const rt = new ContainerExecutionRuntime(TID);
    const result = await rt.exec("echo hi");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("docker run boom");
    expect(cli.execInContainer).not.toHaveBeenCalled();
  });
});
