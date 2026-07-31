import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HostExecutionRuntime } from "@/lib/runtime/execution-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Phase 5 Stage A：HostExecutionRuntime 单测——覆盖 exec 成功 / 超时 / buffer 截断。
 * 真实起 execa（shell:true），验证从 tools.ts 抽出的执行逻辑零行为变更。
 */

const TEST_ROOT = resolve(".test-workspaces-host-exec");
const TID = "test-host-exec";
const orig = process.env.SNOW_WORKSPACES_DIR;

beforeEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = TEST_ROOT;
  await mkdir(join(TEST_ROOT, TID), { recursive: true });
});

afterEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = orig;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("HostExecutionRuntime", () => {
  it("exec 成功返回 ok:true + exitCode:0 + stdout", async () => {
    const runtime = new HostExecutionRuntime(TID);
    const result = await runtime.exec("echo hi", { timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hi");
    expect(result.command).toBe("echo hi");
  });

  it("exec 非零退出 → ok:false + 透传 exitCode", async () => {
    const runtime = new HostExecutionRuntime(TID);
    const result = await runtime.exec("exit 7", { timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  it("exec 超时 → ok:false（spawn 级兜底）", async () => {
    const runtime = new HostExecutionRuntime(TID);
    const result = await runtime.exec("sleep 5", { timeoutMs: 200 });
    expect(result.ok).toBe(false);
    // execa timeout：reject:false 下 timedOut，exitCode 非 0（null 或被 catch 成 -1）
    expect(result.exitCode === null || result.exitCode === -1).toBe(true);
  });

  it("exec stdout 超过 10000 字符被截断", async () => {
    const runtime = new HostExecutionRuntime(TID);
    // 输出 20000 个 'a'，超过 MAX_OUTPUT(10000) 截断上限，但远低于 maxBuffer(1MB)
    const result = await runtime.exec(`node -e "process.stdout.write('a'.repeat(20000))"`, {
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBe(10_000);
  });

  it("exec 默认 timeoutMs=30000（不传 opts）", async () => {
    const runtime = new HostExecutionRuntime(TID);
    // 快速命令不受默认超时影响
    const result = await runtime.exec("echo ok");
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("ok");
  });
});
