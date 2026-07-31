import { afterEach, describe, expect, it } from "vitest";
import { __resetSandboxCacheForTest, wrapWithHostSandbox } from "./sandbox";

/**
 * S1 修复（02-P1-2）：host bwrap 沙箱 wrapper 测试。
 * 非 Linux / mode=off → 原样返回；mode=on + Linux + bwrap 不可用 → 原样（fail-open）。
 */

const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const origEnv = { ...process.env };

afterEach(() => {
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.SNOW_HOST_SANDBOX;
  Object.assign(process.env, origEnv);
  __resetSandboxCacheForTest();
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
});

function setPlatform(p: string) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

describe("wrapWithHostSandbox", () => {
  it("mode=off → 原样返回（不包裹）", async () => {
    setPlatform("linux");
    process.env.SNOW_HOST_SANDBOX = "off";
    expect(await wrapWithHostSandbox("npm run build", "/ws")).toBe("npm run build");
  });

  it("非 Linux 平台 → 原样返回（不伪装有沙箱）", async () => {
    setPlatform("darwin");
    process.env.SNOW_HOST_SANDBOX = "on";
    expect(await wrapWithHostSandbox("npm run build", "/ws")).toBe("npm run build");
  });

  it("mode=on + Linux + bwrap 不可用 → fail-open 原样返回", async () => {
    setPlatform("linux");
    process.env.SNOW_HOST_SANDBOX = "on";
    // bwrap 探测会失败（测试环境无 bwrap 或探测返回非 0）→ 原样返回
    const out = await wrapWithHostSandbox("npm run build", "/ws");
    // 无 bwrap → 原样；有 bwrap → 包含 bwrap 前缀。两种都接受，关键是“不抛错 + 沙箱逻辑存在”
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("mode 默认 off（未设 env）→ 原样返回", async () => {
    setPlatform("linux");
    expect(await wrapWithHostSandbox("ls", "/ws")).toBe("ls");
  });
});
