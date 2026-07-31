import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 5 Stage B：容器生命周期 manager 单测（mock docker-cli + image seam）。
 * 验证 startContainer 惰性拉起 / 复用、stopContainerById 回收、closeAllContainers 清理。
 */

const cli = vi.hoisted(() => ({
  runContainer: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
  listContainersByLabel: vi.fn(),
  imageExists: vi.fn(),
  buildImage: vi.fn(),
  dockerInfo: vi.fn(),
  execInContainer: vi.fn(),
}));
const image = vi.hoisted(() => ({
  ensureRuntimeImage: vi.fn(),
}));

vi.mock("@/lib/runtime/container/docker-cli", () => cli);
vi.mock("@/lib/runtime/container/image", () => image);

import {
  __clearContainerRegistryForTest,
  closeAllContainers,
  getContainer,
  startContainer,
  stopContainerById,
  touchActivity,
} from "@/lib/runtime/container/manager";
import { clearPorts, getPort } from "@/lib/runtime/container/ports";

const TID = "thread-b-test";
const origWorkspaces = process.env.SNOW_WORKSPACES_DIR;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SNOW_WORKSPACES_DIR = resolve(".test-workspaces-container-mgr");
  __clearContainerRegistryForTest();
  clearPorts();
  image.ensureRuntimeImage.mockResolvedValue(undefined);
  cli.removeContainer.mockResolvedValue(undefined);
  cli.stopContainer.mockResolvedValue(undefined);
  cli.runContainer.mockResolvedValue("container-id-abc");
});

afterEach(() => {
  process.env.SNOW_WORKSPACES_DIR = origWorkspaces;
  __clearContainerRegistryForTest();
  clearPorts();
});

describe("container manager", () => {
  it("startContainer 首次 → ensureRuntimeImage + 清理同名 + runContainer，分配端口", async () => {
    const entry = await startContainer(TID);

    expect(image.ensureRuntimeImage).toHaveBeenCalledTimes(1);
    // 惰性重拉：run 前先清理同名旧容器
    expect(cli.removeContainer).toHaveBeenCalledWith(`snow-thread-${TID}`);
    expect(cli.runContainer).toHaveBeenCalledTimes(1);
    const opts = cli.runContainer.mock.calls[0]?.[0];
    expect(opts).toMatchObject({
      name: `snow-thread-${TID}`,
      image: "snow-harness-runtime:node22",
      threadId: TID,
      memory: "1g",
      cpus: "1.0",
    });
    expect(opts.env).toEqual([`PORT=${entry.port}`]);
    expect(entry.containerId).toBe("container-id-abc");
    expect(entry.state).toBe("running");
    expect(getPort(TID)).toBe(entry.port);
  });

  it("startContainer 已 running → 复用，不再 runContainer", async () => {
    const first = await startContainer(TID);
    cli.runContainer.mockClear();
    const second = await startContainer(TID);

    expect(second).toBe(first);
    expect(cli.runContainer).not.toHaveBeenCalled();
  });

  it("startContainer 在 docker run 失败时释放已分配端口", async () => {
    cli.runContainer.mockRejectedValue(new Error("port is already allocated"));

    await expect(startContainer(TID)).rejects.toThrow("port is already allocated");

    expect(getContainer(TID)).toBeNull();
    expect(getPort(TID)).toBeUndefined();
  });

  it("getContainer 未启动 → null", () => {
    expect(getContainer("nope")).toBeNull();
  });

  it("touchActivity 更新 lastActivityAt", async () => {
    const entry = await startContainer(TID);
    const before = entry.lastActivityAt;
    // 强制时间推进（touchActivity 用 Date.now()）
    await new Promise((r) => setTimeout(r, 5));
    touchActivity(TID);
    expect(entry.lastActivityAt).toBeGreaterThanOrEqual(before);
  });

  it("stopContainerById → stop + rm + 释放端口 + 移除 entry", async () => {
    const entry = await startContainer(TID);
    await stopContainerById(TID);

    expect(cli.stopContainer).toHaveBeenCalledWith(entry.containerName);
    expect(cli.removeContainer).toHaveBeenCalledWith(entry.containerName);
    expect(getContainer(TID)).toBeNull();
    expect(getPort(TID)).toBeUndefined();
  });

  it("closeAllContainers → 停删所有已登记容器", async () => {
    cli.runContainer.mockResolvedValueOnce("id-a").mockResolvedValueOnce("id-b");
    await startContainer("ta");
    await startContainer("tb");
    await closeAllContainers();

    expect(cli.stopContainer).toHaveBeenCalledTimes(2);
    expect(cli.removeContainer).toHaveBeenCalledTimes(2 + 2); // start 时各清理 1 次 + close 时各 1 次
    expect(getContainer("ta")).toBeNull();
    expect(getContainer("tb")).toBeNull();
  });
});
