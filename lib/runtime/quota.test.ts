import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatMemory, parseCpu, parseMemory, resolveQuota, tightenQuota } from "./quota";
import type { ResourceQuota } from "./types";

/**
 * V3.8 Stage A：per-thread 资源配额解析测试。
 *
 * 覆盖：配额解析 / 覆盖只能收紧不能放宽 / CPU+memory 解析 / 截断。
 */

const origEnv = { ...process.env };

beforeEach(() => {
  // 全局默认配额
  process.env.RUNTIME_QUOTA_CPU = "2.0";
  process.env.RUNTIME_QUOTA_MEMORY = "2g";
  process.env.RUNTIME_QUOTA_TIMEOUT_MS = "60000";
  process.env.RUNTIME_QUOTA_LOG_CAP_BYTES = String(1024 * 1024);
});

afterEach(() => {
  // 恢复 env
  for (const k of [
    "RUNTIME_QUOTA_CPU",
    "RUNTIME_QUOTA_MEMORY",
    "RUNTIME_QUOTA_TIMEOUT_MS",
    "RUNTIME_QUOTA_LOG_CAP_BYTES",
    "RUNTIME_QUOTA_PIDS_LIMIT",
    "RUNTIME_QUOTA_OPEN_FILES_LIMIT",
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, origEnv);
});

describe("parseCpu", () => {
  it("解析 CPU 数值", () => {
    expect(parseCpu("1.0")).toBe(1.0);
    expect(parseCpu("0.5")).toBe(0.5);
    expect(parseCpu("2")).toBe(2);
  });

  it("非法值返回 0", () => {
    expect(parseCpu("abc")).toBe(0);
    expect(parseCpu("-1")).toBe(0);
    expect(parseCpu("")).toBe(0);
  });
});

describe("parseMemory", () => {
  it("解析内存字节数", () => {
    expect(parseMemory("1g")).toBe(1024 ** 3);
    expect(parseMemory("512m")).toBe(512 * 1024 ** 2);
    expect(parseMemory("1024")).toBe(1024);
    expect(parseMemory("2k")).toBe(2 * 1024);
  });

  it("非法值返回 0", () => {
    expect(parseMemory("abc")).toBe(0);
    expect(parseMemory("-1g")).toBe(0);
    expect(parseMemory("")).toBe(0);
  });
});

describe("formatMemory", () => {
  it("格式化字节数为可读字符串", () => {
    expect(formatMemory(1024 ** 3)).toBe("1g");
    expect(formatMemory(512 * 1024 ** 2)).toBe("512m");
    expect(formatMemory(2 * 1024)).toBe("2k");
    expect(formatMemory(100)).toBe("100");
  });
});

describe("tightenQuota", () => {
  const base: ResourceQuota = {
    cpu: "2.0",
    memory: "2g",
    timeoutMs: 60_000,
    logCapBytes: 1024 * 1024,
  };

  it("无覆盖 → 返回 base 原值", () => {
    expect(tightenQuota(base, {})).toEqual(base);
  });

  it("CPU 覆盖收紧（取更小值）", () => {
    const result = tightenQuota(base, { cpu: "1.0" });
    expect(result.cpu).toBe("1.0");
  });

  it("CPU 覆盖放宽 → 不生效（保持 base）", () => {
    const result = tightenQuota(base, { cpu: "4.0" });
    expect(result.cpu).toBe("2.0");
  });

  it("memory 覆盖收紧", () => {
    const result = tightenQuota(base, { memory: "512m" });
    expect(result.memory).toBe("512m");
  });

  it("memory 覆盖放宽 → 不生效", () => {
    const result = tightenQuota(base, { memory: "4g" });
    expect(result.memory).toBe("2g");
  });

  it("timeoutMs 覆盖收紧", () => {
    const result = tightenQuota(base, { timeoutMs: 30_000 });
    expect(result.timeoutMs).toBe(30_000);
  });

  it("timeoutMs 覆盖放宽 → 不生效", () => {
    const result = tightenQuota(base, { timeoutMs: 120_000 });
    expect(result.timeoutMs).toBe(60_000);
  });

  it("logCapBytes 覆盖收紧", () => {
    const result = tightenQuota(base, { logCapBytes: 50_000 });
    expect(result.logCapBytes).toBe(50_000);
  });

  it("logCapBytes 覆盖放宽 → 不生效", () => {
    const result = tightenQuota(base, { logCapBytes: 10 * 1024 * 1024 });
    expect(result.logCapBytes).toBe(1024 * 1024);
  });

  it("多字段同时收紧", () => {
    const result = tightenQuota(base, {
      cpu: "0.5",
      memory: "256m",
      timeoutMs: 10_000,
      logCapBytes: 10_000,
    });
    expect(result).toEqual({
      cpu: "0.5",
      memory: "256m",
      timeoutMs: 10_000,
      logCapBytes: 10_000,
    });
  });

  // S1（04-G2）：pidsLimit / openFilesLimit 只能收紧
  it("pidsLimit 覆盖收紧（取更小非零值）", () => {
    const result = tightenQuota({ pidsLimit: 256 }, { pidsLimit: 128 });
    expect(result.pidsLimit).toBe(128);
  });

  it("pidsLimit 覆盖放宽 → 不生效", () => {
    const result = tightenQuota({ pidsLimit: 128 }, { pidsLimit: 512 });
    expect(result.pidsLimit).toBe(128);
  });

  it("pidsLimit base=0（不限）→ 覆盖生效（0 视为无穷大）", () => {
    expect(tightenQuota({ pidsLimit: 0 }, { pidsLimit: 64 }).pidsLimit).toBe(64);
  });

  it("pidsLimit 覆盖=0（不限）→ 保持 base", () => {
    expect(tightenQuota({ pidsLimit: 128 }, { pidsLimit: 0 }).pidsLimit).toBe(128);
  });

  it("openFilesLimit 同 pidsLimit 收紧规则", () => {
    expect(tightenQuota({ openFilesLimit: 1024 }, { openFilesLimit: 512 }).openFilesLimit).toBe(
      512,
    );
    expect(tightenQuota({ openFilesLimit: 512 }, { openFilesLimit: 2048 }).openFilesLimit).toBe(
      512,
    );
  });

  // S1（02-P1-6）：diskQuotaBytes 只能收紧
  it("diskQuotaBytes 覆盖收紧（取更小非零值）", () => {
    expect(
      tightenQuota({ diskQuotaBytes: 1024 * 1024 * 1024 }, { diskQuotaBytes: 512 * 1024 * 1024 })
        .diskQuotaBytes,
    ).toBe(512 * 1024 * 1024);
    // base=0（不限）→ 覆盖生效
    expect(
      tightenQuota({ diskQuotaBytes: 0 }, { diskQuotaBytes: 256 * 1024 * 1024 }).diskQuotaBytes,
    ).toBe(256 * 1024 * 1024);
  });
});

describe("resolveQuota", () => {
  it("无 thread 覆盖 → 继承全局默认", () => {
    const q = resolveQuota();
    expect(q.cpu).toBe("2.0");
    expect(q.memory).toBe("2g");
    expect(q.timeoutMs).toBe(60_000);
    expect(q.logCapBytes).toBe(1024 * 1024);
  });

  it("thread 覆盖收紧 → 合并后更小", () => {
    const q = resolveQuota({ threadOverride: { cpu: "1.0", memory: "1g" } });
    expect(q.cpu).toBe("1.0");
    expect(q.memory).toBe("1g");
    expect(q.timeoutMs).toBe(60_000); // 未覆盖字段继承全局
  });

  it("thread 覆盖放宽 → 被忽略，继承全局", () => {
    const q = resolveQuota({ threadOverride: { cpu: "4.0", memory: "8g" } });
    expect(q.cpu).toBe("2.0");
    expect(q.memory).toBe("2g");
  });

  // S1（04-G2）：pidsLimit / openFilesLimit 继承全局默认 + 收紧
  it("无覆盖 → 继承全局 pidsLimit / openFilesLimit 默认", () => {
    process.env.RUNTIME_QUOTA_PIDS_LIMIT = "256";
    process.env.RUNTIME_QUOTA_OPEN_FILES_LIMIT = "1024";
    const q = resolveQuota();
    expect(q.pidsLimit).toBe(256);
    expect(q.openFilesLimit).toBe(1024);
  });

  it("thread 覆盖 pidsLimit 收紧", () => {
    process.env.RUNTIME_QUOTA_PIDS_LIMIT = "256";
    const q = resolveQuota({ threadOverride: { pidsLimit: 128 } });
    expect(q.pidsLimit).toBe(128);
  });
});
