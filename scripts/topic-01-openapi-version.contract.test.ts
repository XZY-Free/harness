import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Topic01 OpenAPI API 版本单一来源契约。
 *
 * 唯一权威：docs/contracts/contract-manifest.json 顶层 api_version。
 * - 生成器 generate_openapi.py 必须读取该字段作为 openapi.info.version 的来源，
 *   不得再硬编码 API 版本号。
 * - 生成产物 docs/contracts/openapi.json 的 info.version 必须与该来源相等且为 "1.0.0"。
 *
 * 本契约不触碰 error-codes.json / event-catalog.json 的 contract_version —— 它们
 * 是独立切片，不属于本测试范围。
 */

const MANIFEST_PATH = join(process.cwd(), "docs/contracts/contract-manifest.json");
const OPENAPI_PATH = join(process.cwd(), "docs/contracts/openapi.json");
const GENERATOR_PATH = join(process.cwd(), "docs/contracts/scripts/generate_openapi.py");

const API_VERSION = "1.0.0";

/** 去除全部空白，使排版/缩进差异不影响语义判断，不依赖行号。 */
function normalize(source: string): string {
  return source.replace(/\s+/g, "");
}

describe("Topic01 OpenAPI API 版本单一来源契约", () => {
  it("contract-manifest.json 顶层 api_version 精确为 1.0.0", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
    expect(manifest, "manifest 必须声明顶层 api_version").toHaveProperty("api_version");
    expect(manifest.api_version).toBe(API_VERSION);
  });

  it("openapi.json info.version 与 manifest.api_version 相等且精确为 1.0.0", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { api_version?: string };
    const openapi = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as {
      info?: { version?: string };
    };
    expect(openapi.info?.version).toBeDefined();
    expect(openapi.info!.version).toBe(manifest.api_version);
    expect(openapi.info!.version).toBe(API_VERSION);
  });

  it("generate_openapi.py 以 contract-manifest.json/api_version 为唯一 API 版本来源，无硬编码 11.0.0", () => {
    const source = readFileSync(GENERATOR_PATH, "utf8");
    const normalized = normalize(source);

    // 必须把 manifest 的 api_version 作为 info.version 的生成来源。
    expect(
      normalized,
      "生成器必须读取 contract-manifest.json 的 api_version 作为 API 版本来源",
    ).toContain("api_version");
    expect(normalized).toContain("contract-manifest.json");
    expect(
      normalized,
      "生成器必须把 manifest 的 api_version 写入 info.version（版本来自单一来源）",
    ).toMatch(/["']api_version["']/);

    // 不得出现 API 版本硬编码 "11.0.0"。
    expect(source, "生成器不得硬编码 API 版本号 11.0.0").not.toContain("11.0.0");

    // 版本值必须取自 manifest 而非字面量常量。
    expect(
      normalized,
      "info.version 的取值必须来自 manifest 字段，而非独立硬编码版本字面量",
    ).not.toMatch(/["']1\.0\.0["']/);
  });

  it("运行生成器 --check 成功，证明产物与唯一来源一致", () => {
    // 真实运行生成器子进程，不 mock 文件系统/子进程。
    expect(() => {
      execFileSync("python3", [GENERATOR_PATH, "--check"], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
      });
    }).not.toThrow();
  });
});
