import { access, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ProviderExecutionInput,
  createProductionProviderExecutorRegistry,
} from "@/lib/capability/provider-executor";
import { HostExecutionRuntime } from "@/lib/runtime/execution-runtime";
import { resolveToolExecutionTarget } from "@/lib/runtime/resolve-tool-execution-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  vi.unstubAllEnvs();
  process.env.SNOW_WORKSPACES_DIR = orig;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("HostExecutionRuntime", () => {
  it("取消时终止派生进程，不能在取消后继续写文件", async () => {
    const controller = new AbortController();
    const runtime = new HostExecutionRuntime(TID);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = runtime.exec(
      `node -e "console.log('ready'); setTimeout(() => require('fs').writeFileSync('late-write', 'unexpected'), 400)" & wait`,
      {
        signal: controller.signal,
        timeoutMs: 5000,
        onChunk: (_stream, chunk) => {
          if (chunk.includes("ready")) started();
        },
      },
    );
    await ready;
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(access(join(TEST_ROOT, TID, "late-write"))).rejects.toThrow();
  });
  it("内置命令使用冻结的宿主目标，返回真实时间、目录和退出码；桌面目标不降级", async () => {
    vi.stubEnv("RUNTIME_DEFAULT", "host");
    const target = await resolveToolExecutionTarget({
      tenantId: "tenant",
      threadId: TID,
      ownerUserId: "owner",
      workspaceBindingId: null,
    });
    expect(target?.kind).toBe("host");
    const executor = createProductionProviderExecutorRegistry().get("builtin", "builtin.shell");
    const input: ProviderExecutionInput = {
      endpoint: "",
      threadId: TID,
      executionTarget: target!,
      arguments: { command: 'node -p "new Date().toISOString()"' },
      executionSubject: { tenantId: "tenant", subjectType: "user", subjectId: "owner" },
      invocationId: "inv",
      toolCallId: "call",
      traceId: "trace",
      externalIdempotencyKey: null,
      sideEffectMode: "write",
      timeoutMs: 5000,
      responseMaxBytes: 8192,
      credential: null,
    };
    // 后续配置变化不得让既有任务切换执行环境。
    vi.stubEnv("RUNTIME_DEFAULT", "container");
    const result = await executor.execute(input);
    expect(result.result).toMatchObject({
      ok: true,
      exitCode: 0,
      executionEnvironment: "host",
      workingDirectory: join(TEST_ROOT, TID),
      stdout: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    await expect(
      executor.execute({
        ...input,
        executionTarget: {
          kind: "desktop",
          threadId: TID,
          workspaceBindingId: "binding",
          deviceId: "device",
          ownerUserId: "owner",
          bindingVersion: "version",
        },
      }),
    ).rejects.toMatchObject({ code: "DESKTOP_EXECUTION_UNAVAILABLE", dispatched: false });
    vi.stubEnv("SNOW_WORKSPACES_DIR", `${TEST_ROOT}-moved`);
    await expect(executor.execute(input)).rejects.toMatchObject({
      code: "WORKSPACE_LOCATION_CHANGED",
      dispatched: false,
    });
  });
  it("真实子进程不继承平台秘密，只接收显式授权的注入", async () => {
    vi.stubEnv("SNOW_EXECUTION_TEST_SECRET", "test-only-marker");
    const runtime = new HostExecutionRuntime(TID);
    const result = await runtime.exec(
      "node -e \"process.stdout.write(process.env.SNOW_EXECUTION_TEST_SECRET ? 'leaked' : 'absent')\"",
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("absent");
    const injected = new HostExecutionRuntime(TID, undefined, async () => ({
      SNOW_EXECUTION_TEST_SECRET: "explicit",
    }));
    const allowed = await injected.exec(
      "node -e \"process.stdout.write(process.env.SNOW_EXECUTION_TEST_SECRET || 'absent')\"",
    );
    expect(allowed.stdout).toBe("explicit");
  });
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
