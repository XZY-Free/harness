import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadAppEnvFiles } from "./env-loader";

describe("env-loader P1-19 生产禁 .local 覆盖", () => {
  let cwd: string;
  const origCwd = process.cwd();
  const keys: string[] = [];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "env-"));
    process.chdir(cwd);
    keys.length = 0;
  });

  afterEach(() => {
    process.chdir(origCwd);
    for (const k of keys) delete process.env[k];
    rmSync(cwd, { recursive: true, force: true });
  });

  function track(key: string) {
    keys.push(key);
    delete process.env[key];
    return key;
  }

  it("dev: .local 覆盖平台注入", () => {
    const k = track("SNOW_TEST_DEV");
    process.env[k] = "platform";
    writeFileSync(join(cwd, ".env.development.local"), `${k}=local-override`);
    writeFileSync(join(cwd, ".env.development"), `${k}=base`);
    loadAppEnvFiles("development");
    expect(process.env[k]).toBe("local-override");
  });

  it("production: .local 不覆盖平台注入(覆盖被禁)", () => {
    const k = track("SNOW_TEST_PROD");
    process.env[k] = "platform-secret";
    // 生产不加载 .local 文件;即使存在也不读
    writeFileSync(join(cwd, ".env.production.local"), `${k}=attacker-override`);
    loadAppEnvFiles("production");
    expect(process.env[k]).toBe("platform-secret");
  });

  it("production: .env.production 仍填补空缺", () => {
    const k = track("SNOW_TEST_PROD_FILL");
    delete process.env[k];
    writeFileSync(join(cwd, ".env.production"), `${k}=base-value`);
    loadAppEnvFiles("production");
    expect(process.env[k]).toBe("base-value");
  });

  it("production: .env.production 不覆盖已有平台注入", () => {
    const k = track("SNOW_TEST_PROD_NOOVER");
    process.env[k] = "platform";
    writeFileSync(join(cwd, ".env.production"), `${k}=base-override-attempt`);
    loadAppEnvFiles("production");
    expect(process.env[k]).toBe("platform");
  });
});
