import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1（02-P2-7）：directChildren 三级回退专项测试。
 *
 * 原 directChildren 是 execution-runtime.ts 私有函数,无测试覆盖回退路径(回归风险:
 * 某级回退被破坏不会被发现)。抽到 process-tree.ts 后,隔离 mock execa + fs 验证三级回退。
 *
 * 三级:pgrep -P(主) → Linux /proc/{pid}/task/{pid}/children → ps -o pid= -P(兜底)。
 */

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: execaMock,
}));

// node:fs/promises 的 readFile mock(linux /proc 回退路径用)
const fsMock = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: fsMock.readFile }));

import { directChildren, isAlive } from "./process-tree";

beforeEach(() => {
  execaMock.mockReset();
  fsMock.readFile.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("directChildren 三级回退（02-P2-7）", () => {
  it("1. pgrep -P 成功 → 返回子进程列表(不走回退)", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "100\n200\n", stderr: "" });
    const children = await directChildren(1);
    expect(children).toEqual([100, 200]);
    // 只调 pgrep,不调 ps
    const calls = execaMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("pgrep");
    expect(calls).not.toContain("ps");
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("pgrep 输出含空行/非数字 → 过滤掉(只留有效 pid)", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "\n100\n\n  \n200\n", stderr: "" });
    const children = await directChildren(1);
    expect(children).toEqual([100, 200]);
  });

  it("2. pgrep 失败(exitCode!=0) → 非平台跳过 /proc 走 ps 回退", async () => {
    // 非 linux 平台:pgrep 失败 → 直接走 ps
    execaMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "not found" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "300\n", stderr: "" });
    const children = await directChildren(1);
    // ps 回退返回 300
    expect(children).toEqual([300]);
    const calls = execaMock.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["pgrep", "ps"]);
  });

  it("3. pgrep 抛错(命令不存在) → 走 ps 回退", async () => {
    execaMock
      .mockRejectedValueOnce(new Error("spawn pgrep ENOENT"))
      .mockResolvedValueOnce({ exitCode: 0, stdout: "400\n", stderr: "" });
    const children = await directChildren(1);
    expect(children).toEqual([400]);
  });

  it("全部回退失败 → 返回空(best-effort,不抛错)", async () => {
    execaMock.mockRejectedValue(new Error("no shell tools"));
    const children = await directChildren(1);
    expect(children).toEqual([]);
  });

  it("ps 兜底成功但输出空 → 返回空数组", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const children = await directChildren(1);
    expect(children).toEqual([]);
  });

  it("Linux 平台:pgrep 失败 → 走 /proc/{pid}/task/{pid}/children 回退", async () => {
    // 临时覆盖 process.platform 为 linux,触发 /proc 回退分支
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      execaMock.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });
      fsMock.readFile.mockResolvedValue("500 600\n");
      const children = await directChildren(1);
      expect(children).toEqual([500, 600]);
      // /proc 被读
      expect(fsMock.readFile).toHaveBeenCalledWith("/proc/1/task/1/children", "utf8");
      // pgrep 失败后未走 ps(/proc 成功)
      const calls = execaMock.mock.calls.map((c) => c[0]);
      expect(calls).toEqual(["pgrep"]);
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    }
  });

  it("Linux 平台:pgrep + /proc 都失败 → 走 ps 兜底", async () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      execaMock
        .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "700\n", stderr: "" });
      fsMock.readFile.mockRejectedValue(new Error("ENOENT"));
      const children = await directChildren(1);
      expect(children).toEqual([700]);
      const calls = execaMock.mock.calls.map((c) => c[0]);
      expect(calls).toEqual(["pgrep", "ps"]);
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    }
  });
});

describe("isAlive（02-P2-7 辅助）", () => {
  it("当前进程 pid → 存活", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("不存在的 pid → 不存活", () => {
    // pid 0xFFFFFFFF 几乎必然不存在
    expect(isAlive(0xffffffff)).toBe(false);
  });
});
