import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 阶段十一：许可证扫描脚本集成测试。
 *
 * 策略：构造临时 node_modules 目录（含禁用/合法/未知/白名单包），
 * 以子进程运行 check-licenses.mjs，断言 stdout 与 exit code。
 * 不 import 脚本本身（顶层 process.exit 会中断 vitest）。
 */

const SCRIPT_PATH = resolve(process.cwd(), "scripts/check-licenses.mjs");

interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runScript(nodeModulesPath: string, extraArgs: string[] = []): ScriptResult {
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--path", nodeModulesPath, ...extraArgs],
    {
      encoding: "utf-8",
      timeout: 15000,
    },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  };
}

async function makePkg(
  dir: string,
  name: string,
  version: string,
  license: string | Array<{ type: string; url?: string }>,
): Promise<void> {
  const pkgDir = join(dir, name);
  await mkdir(pkgDir, { recursive: true });
  const pkgJson =
    typeof license === "string" ? { name, version, license } : { name, version, licenses: license };
  await writeFile(join(pkgDir, "package.json"), JSON.stringify(pkgJson));
}

describe("check-licenses.mjs 许可证扫描", () => {
  let tempRoot: string;
  let nodeModulesDir: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "snow-license-test-"));
    nodeModulesDir = join(tempRoot, "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });

    // 合法许可证包
    await makePkg(nodeModulesDir, "mit-pkg", "1.0.0", "MIT");
    await makePkg(nodeModulesDir, "apache-pkg", "2.0.0", "Apache-2.0");
    await makePkg(nodeModulesDir, "bsd-pkg", "3.0.0", "BSD-3-Clause");
    await makePkg(nodeModulesDir, "isc-pkg", "1.2.0", "ISC");

    // 禁用许可证包
    await makePkg(nodeModulesDir, "gpl-pkg", "1.0.0", "GPL-3.0");
    await makePkg(nodeModulesDir, "agpl-pkg", "0.5.0", "AGPL-3.0");
    await makePkg(nodeModulesDir, "lgpl-pkg", "2.1.0", "LGPL-3.0-or-later");

    // 未知许可证包（无 license 字段）
    const unknownDir = join(nodeModulesDir, "unknown-pkg");
    await mkdir(unknownDir, { recursive: true });
    await writeFile(
      join(unknownDir, "package.json"),
      JSON.stringify({ name: "unknown-pkg", version: "0.1.0" }),
    );
  });

  afterAll(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("发现禁用许可证时 exit code = 1，并列出违规包", () => {
    const result = runScript(nodeModulesDir);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("gpl-pkg@1.0.0 → GPL-3.0");
    expect(result.stdout).toContain("agpl-pkg@0.5.0 → AGPL-3.0");
    expect(result.stdout).toContain("lgpl-pkg@2.1.0 → LGPL-3.0-or-later");
  });

  it("合法许可证包不出现在违规列表", () => {
    const result = runScript(nodeModulesDir);
    expect(result.stdout).not.toContain("mit-pkg@1.0.0 → MIT");
    expect(result.stdout).not.toContain("apache-pkg");
    expect(result.stdout).not.toContain("bsd-pkg");
    expect(result.stdout).not.toContain("isc-pkg");
  });

  it("未知许可证包列在未知区段", () => {
    const result = runScript(nodeModulesDir);
    expect(result.stdout).toContain("未知许可证");
    expect(result.stdout).toContain("unknown-pkg@0.1.0");
  });

  it("--json 输出合法 JSON，含 forbidden/unknown 字段", () => {
    const result = runScript(nodeModulesDir, ["--json"]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.total).toBe(8);
    expect(parsed.forbidden).toBe(3);
    expect(parsed.forbiddenPackages.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(["gpl-pkg", "agpl-pkg", "lgpl-pkg"]),
    );
    expect(parsed.unknown).toBe(1);
    expect(parsed.unknownPackages[0].name).toBe("unknown-pkg");
  });

  it("白名单文件覆盖禁用包 → 违规包移至白名单区段", async () => {
    const whitelistPath = join(tempRoot, "whitelist.json");
    await writeFile(
      whitelistPath,
      JSON.stringify([
        {
          name: "lgpl-pkg",
          license: "LGPL-3.0-or-later",
          reason: "测试白名单：动态链接例外",
        },
      ]),
    );

    const result = runScript(nodeModulesDir, ["--whitelist", whitelistPath]);
    expect(result.exitCode).toBe(1); // 仍有 gpl/agpl
    expect(result.stdout).toContain("白名单命中: 1");
    expect(result.stdout).toContain("lgpl-pkg@2.1.0 → LGPL-3.0-or-later");
    expect(result.stdout).toContain("测试白名单：动态链接例外");
    // lgpl-pkg 不再出现在违规区段
    const forbiddenSection = result.stdout.split("发现禁用许可证")[1] ?? "";
    expect(forbiddenSection).not.toContain("lgpl-pkg");
  });

  it("白名单覆盖全部禁用包 → exit code = 0", async () => {
    const whitelistPath = join(tempRoot, "whitelist-all.json");
    await writeFile(
      whitelistPath,
      JSON.stringify([
        { name: "gpl-pkg", license: "GPL-3.0", reason: "测试" },
        { name: "agpl-pkg", license: "AGPL-3.0", reason: "测试" },
        { name: "lgpl-pkg", license: "LGPL-3.0-or-later", reason: "测试" },
      ]),
    );

    const result = runScript(nodeModulesDir, ["--whitelist", whitelistPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("白名单命中: 3");
    expect(result.stdout).toContain("禁用许可证: 0");
  });

  it("白名单文件不存在 → 按无白名单处理（不报错）", () => {
    const result = runScript(nodeModulesDir, ["--whitelist", join(tempRoot, "nonexistent.json")]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("白名单命中: 0");
  });

  it("白名单文件格式非法 → exit code = 2", async () => {
    const badPath = join(tempRoot, "bad-whitelist.json");
    await writeFile(badPath, "{ not valid json");
    const result = runScript(nodeModulesDir, ["--whitelist", badPath]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("白名单文件解析失败");
  });

  it("仅含合法许可证 → exit code = 0", async () => {
    const cleanDir = join(tempRoot, "clean-node-modules");
    await mkdir(cleanDir, { recursive: true });
    await makePkg(cleanDir, "only-mit", "1.0.0", "MIT");
    await makePkg(cleanDir, "only-apache", "2.0.0", "Apache-2.0");

    const result = runScript(cleanDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("禁用许可证: 0");
  });

  it("licenses 数组字段含 GPL → 被标记为禁用", async () => {
    const multiDir = join(tempRoot, "multi-license-modules");
    await mkdir(multiDir, { recursive: true });
    await makePkg(multiDir, "multi-pkg", "1.0.0", [
      { type: "MIT", url: "https://example.com" },
      { type: "GPL-3.0", url: "https://example.com" },
    ]);

    const result = runScript(multiDir);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("multi-pkg@1.0.0");
  });
});
