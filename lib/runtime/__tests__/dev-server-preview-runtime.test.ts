import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 5 Stage C：DevServerPreviewRuntime 单测。
 * mock docker-cli(execDetached)+ manager(startContainer/stopContainerById)+
 * preview-probe(probePreviewUrl)+ workspace(readWorkspaceFile)，覆盖：
 * 无 dev script 委托 static / 有 dev script ready / 超时 failed / 复用 / stop 委托。
 */

const cli = vi.hoisted(() => ({ execDetached: vi.fn() }));
const mgr = vi.hoisted(() => ({
  startContainer: vi.fn(),
  stopContainerById: vi.fn(),
}));
const probe = vi.hoisted(() => ({ probePreviewUrl: vi.fn() }));
const ws = vi.hoisted(() => ({ readWorkspaceFile: vi.fn() }));
const startOptions = vi.hoisted(() => ({
  prepareContainerStartOptions: vi.fn(),
}));

vi.mock("@/lib/runtime/container/docker-cli", () => cli);
vi.mock("@/lib/runtime/container/manager", () => mgr);
vi.mock("@/lib/runtime/container/start-options", () => startOptions);
vi.mock("@/lib/runtime/preview-probe", () => probe);
vi.mock("@/lib/workspace", () => ({
  ...ws,
  workspaceRoot: (id: string) => `/tmp/ws-${id}`,
}));

import {
  DevServerPreviewRuntime,
  __clearDevServerRegistryForTest,
  staticPreviewRuntime,
} from "@/lib/runtime/preview-runtime";

// S1（02-P2-1）：单例已删，测试用本地实例（devServers Map 模块级共享，行为一致）
const devServerPreviewRuntime = new DevServerPreviewRuntime();

const TID = "thread-c-dev";
const ENTRY = {
  containerName: `snow-thread-${TID}`,
  containerId: "id",
  port: 41000,
  state: "running" as const,
  lastActivityAt: 0,
};
const origTimeout = process.env.SNOW_PREVIEW_READY_TIMEOUT_MS;

beforeEach(() => {
  vi.clearAllMocks();
  __clearDevServerRegistryForTest();
  // 缩短超时，让 failed 路径快测
  process.env.SNOW_PREVIEW_READY_TIMEOUT_MS = "100";
  mgr.startContainer.mockResolvedValue(ENTRY);
  mgr.stopContainerById.mockResolvedValue(undefined);
  cli.execDetached.mockResolvedValue(undefined);
  startOptions.prepareContainerStartOptions.mockResolvedValue({
    startOptions: {
      quota: { memory: "256m" },
      networkPolicy: { mode: "disabled" },
      secretEnvFile: "/tmp/preview-secret.env",
    },
    secretsCache: { API_KEY: "secret" },
    cleanup: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  __clearDevServerRegistryForTest();
  // 恢复 env（未设过则回默认 30000，避免 delete operator）
  process.env.SNOW_PREVIEW_READY_TIMEOUT_MS = origTimeout ?? "30000";
});

describe("DevServerPreviewRuntime", () => {
  it("无 dev script → 委托 staticPreviewRuntime，不起容器", async () => {
    ws.readWorkspaceFile.mockResolvedValue('{"scripts":{"build":"tsc"}}');
    const spy = vi.spyOn(staticPreviewRuntime, "start").mockResolvedValue({
      url: "http://localhost:1/",
      port: 1,
      kind: "static",
    });

    const handle = await devServerPreviewRuntime.start(TID);

    expect(handle.kind).toBe("static");
    expect(spy).toHaveBeenCalledWith(TID);
    expect(mgr.startContainer).not.toHaveBeenCalled();
    expect(cli.execDetached).not.toHaveBeenCalled();
  });

  it("有 dev script + 探活成功 → ready，kind=dev-server", async () => {
    ws.readWorkspaceFile.mockResolvedValue('{"scripts":{"dev":"vite"}}');
    probe.probePreviewUrl.mockResolvedValue({ ok: true });

    const handle = await devServerPreviewRuntime.start(TID);

    expect(startOptions.prepareContainerStartOptions).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: TID }),
    );
    expect(mgr.startContainer).toHaveBeenCalledWith(
      TID,
      expect.objectContaining({
        quota: expect.objectContaining({ memory: "256m" }),
        networkPolicy: expect.objectContaining({ mode: "disabled" }),
        secretEnvFile: "/tmp/preview-secret.env",
      }),
    );
    // S1（05-P1-6）：dev server 输出重定向到 bind mount 日志文件
    expect(cli.execDetached).toHaveBeenCalledWith(
      ENTRY.containerName,
      expect.stringContaining(`PORT=${ENTRY.port} HOST=0.0.0.0 npm run dev >`),
    );
    expect(cli.execDetached).toHaveBeenCalledWith(
      ENTRY.containerName,
      expect.stringContaining("devserver.log"),
    );
    expect(handle).toMatchObject({ port: ENTRY.port, kind: "dev-server" });
    expect(devServerPreviewRuntime.status(TID)?.state).toBe("ready");
  });

  it("有 dev script + 探活超时 → throw + 回收容器 + 清 entry", async () => {
    ws.readWorkspaceFile.mockResolvedValue('{"scripts":{"dev":"vite"}}');
    probe.probePreviewUrl.mockResolvedValue({ ok: false, error: "探活失败:连接拒绝" });

    await expect(devServerPreviewRuntime.start(TID)).rejects.toThrow(/dev server 启动超时/);
    // P2-12: pollReady 失败回收容器 + 清 devServers entry,防残留 failed entry 占端口/内存
    expect(mgr.stopContainerById).toHaveBeenCalledWith(TID);
    expect(devServerPreviewRuntime.status(TID)).toBeNull();
  });

  it("已 ready → 复用，不再 startContainer / execDetached", async () => {
    ws.readWorkspaceFile.mockResolvedValue('{"scripts":{"dev":"vite"}}');
    probe.probePreviewUrl.mockResolvedValue({ ok: true });

    await devServerPreviewRuntime.start(TID);
    mgr.startContainer.mockClear();
    cli.execDetached.mockClear();

    const handle = await devServerPreviewRuntime.start(TID);
    expect(handle.kind).toBe("dev-server");
    expect(mgr.startContainer).not.toHaveBeenCalled();
    expect(cli.execDetached).not.toHaveBeenCalled();
  });

  it("stop 有 entry → stopContainerById + 清 entry", async () => {
    ws.readWorkspaceFile.mockResolvedValue('{"scripts":{"dev":"vite"}}');
    probe.probePreviewUrl.mockResolvedValue({ ok: true });
    await devServerPreviewRuntime.start(TID);

    await devServerPreviewRuntime.stop(TID);

    expect(mgr.stopContainerById).toHaveBeenCalledWith(TID);
    expect(devServerPreviewRuntime.status(TID)).toBeNull();
  });

  it("stop 无 entry → 委托 staticPreviewRuntime.stop", async () => {
    const spy = vi.spyOn(staticPreviewRuntime, "stop").mockResolvedValue(undefined);
    await devServerPreviewRuntime.stop(TID);
    expect(spy).toHaveBeenCalledWith(TID);
    expect(mgr.stopContainerById).not.toHaveBeenCalled();
  });

  it("secret 解析失败 → start 直接失败，不启动容器", async () => {
    ws.readWorkspaceFile.mockResolvedValue('{"scripts":{"dev":"vite"}}');
    startOptions.prepareContainerStartOptions.mockRejectedValueOnce(new Error("secret boom"));
    await expect(devServerPreviewRuntime.start(TID)).rejects.toThrow("secret boom");
    expect(mgr.startContainer).not.toHaveBeenCalled();
  });
});
