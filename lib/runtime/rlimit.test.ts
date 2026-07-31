import { describe, expect, it } from "vitest";
import { dockerResourceArgs, wrapWithHostRlimits } from "./rlimit";

/**
 * S1（04-G2）：rlimit / docker ulimit 封装测试。
 */

describe("wrapWithHostRlimits", () => {
  it("Linux + 限额 → prlimit 包裹 sh -c", () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const out = wrapWithHostRlimits("npm run build && echo done", {
        openFilesLimit: 1024,
        pidsLimit: 256,
      });
      expect(out).toContain("prlimit --nofile=1024 --nproc=256 -- sh -c ");
      // 原命令经单引号转义传入内层 sh -c，保留 && 语义
      expect(out).toContain("npm run build && echo done");
    } finally {
      Object.defineProperty(process, "platform", { value: orig, configurable: true });
    }
  });

  it("仅 nofile → 只加 --nofile", () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const out = wrapWithHostRlimits("ls", { openFilesLimit: 512 });
      expect(out).toBe("prlimit --nofile=512 -- sh -c 'ls'");
    } finally {
      Object.defineProperty(process, "platform", { value: orig, configurable: true });
    }
  });

  it("非 Linux 平台 → 原样返回（诚实 no-op，不伪装）", () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const out = wrapWithHostRlimits("npm run dev", {
        openFilesLimit: 1024,
        pidsLimit: 256,
      });
      expect(out).toBe("npm run dev");
    } finally {
      Object.defineProperty(process, "platform", { value: orig, configurable: true });
    }
  });

  it("无限额 → 原样返回", () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      expect(wrapWithHostRlimits("ls", {})).toBe("ls");
      expect(wrapWithHostRlimits("ls", { openFilesLimit: 0, pidsLimit: 0 })).toBe("ls");
    } finally {
      Object.defineProperty(process, "platform", { value: orig, configurable: true });
    }
  });

  it("命令含单引号 → 正确转义不破坏 sh -c", () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const out = wrapWithHostRlimits("echo 'it is done'", { pidsLimit: 8 });
      // 单引号转义为 '\''，sh -c 仍能正确解析
      expect(out).toContain("sh -c 'echo '\\''it is done'\\'''");
    } finally {
      Object.defineProperty(process, "platform", { value: orig, configurable: true });
    }
  });
});

describe("dockerResourceArgs", () => {
  it("pids + nofile → --pids-limit 与 --ulimit nofile", () => {
    const args = dockerResourceArgs({ pidsLimit: 256, openFilesLimit: 1024 });
    expect(args).toEqual(["--pids-limit", "256", "--ulimit", "nofile=1024:1024"]);
  });

  it("仅 pids", () => {
    expect(dockerResourceArgs({ pidsLimit: 128 })).toEqual(["--pids-limit", "128"]);
  });

  it("无限额 → 空数组", () => {
    expect(dockerResourceArgs({})).toEqual([]);
    expect(dockerResourceArgs({ pidsLimit: 0, openFilesLimit: 0 })).toEqual([]);
    expect(dockerResourceArgs(undefined)).toEqual([]);
  });
});
