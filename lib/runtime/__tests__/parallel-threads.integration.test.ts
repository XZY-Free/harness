import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Phase 5 Stage E：多 thread 并行 integration 测试（真实 docker）。
 *
 * 验证蓝图 §0.1 done 线：多个 thread 的预览并行，各自独立容器 + 独立端口，互不串数据。
 *
 * 默认 skip——需 docker 可用且显式 `SNOW_RUN_DOCKER_TESTS=1` + `RUNTIME_DEFAULT=container` +
 * `pnpm build:runtime` 预构建镜像。CI 无 docker 时跳过，不 fail fast（plan §5 风险表）。
 */

const RUN = process.env.SNOW_RUN_DOCKER_TESTS === "1";
const origRoot = process.env.SNOW_WORKSPACES_DIR;
const TEST_ROOT = resolve(".test-workspaces-parallel");

beforeEach(async () => {
  if (!RUN) return;
  process.env.SNOW_WORKSPACES_DIR = TEST_ROOT;
  await mkdir(join(TEST_ROOT, "threadA"), { recursive: true });
  await mkdir(join(TEST_ROOT, "threadB"), { recursive: true });
});

afterEach(async () => {
  if (!RUN) return;
  const { stopContainerById } = await import("@/lib/runtime/container/manager");
  await Promise.all([stopContainerById("threadA"), stopContainerById("threadB")]).catch(() => {});
  process.env.SNOW_WORKSPACES_DIR = origRoot;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe.skipIf(!RUN)("parallel threads integration (docker)", () => {
  it("2 thread 各自独立容器 + 不同端口 + 文件隔离", async () => {
    const { startContainer, getContainer } = await import("@/lib/runtime/container/manager");
    const { execInContainer } = await import("@/lib/runtime/container/docker-cli");

    // 各 thread workspace 写入不同标识文件
    await writeFile(join(TEST_ROOT, "threadA", "marker.txt"), "A", "utf8");
    await writeFile(join(TEST_ROOT, "threadB", "marker.txt"), "B", "utf8");

    const [a, b] = await Promise.all([startContainer("threadA"), startContainer("threadB")]);

    // 容器名不同
    expect(a.containerName).not.toBe(b.containerName);
    // 端口不同
    expect(a.port).not.toBe(b.port);
    // 各自经 docker exec 读到自己的 marker（文件隔离）
    const aOut = await execInContainer(a.containerName, "cat /workspace/marker.txt");
    const bOut = await execInContainer(b.containerName, "cat /workspace/marker.txt");
    expect(aOut.stdout.trim()).toBe("A");
    expect(bOut.stdout.trim()).toBe("B");
    // 容器内 cwd = /workspace
    const pwd = await execInContainer(a.containerName, "pwd");
    expect(pwd.stdout.trim()).toBe("/workspace");
    // registry 各自登记
    expect(getContainer("threadA")?.containerId).toBe(a.containerId);
    expect(getContainer("threadB")?.containerId).toBe(b.containerId);
  });
});
