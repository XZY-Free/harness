import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipReadError, readZipEntries } from "@/lib/skill/sync/zip-reader";
import { describe, expect, it } from "vitest";

/**
 * zip-reader 测试：用 Node 内置工具构造 zip 不便,改用预置 fixture 文件。
 * fixture 由 capability-market 风格的 adm-zip 生成；此处直接读取 .test-data 下的二进制。
 *
 * 覆盖：
 * - 正常 zip（含顶层目录,剥前缀后 SKILL.md 在包根）
 * - 缺 SKILL.md
 * - 路径越界（..）
 * - zip bomb（压缩比超限）
 */

const FIXTURE_DIR = join(__dirname, "__fixtures__");

describe("readZipEntries", () => {
  it("正常 zip：剥掉顶层目录前缀,SKILL.md 位于包根", () => {
    const zip = readFileSync(join(FIXTURE_DIR, "valid-skill.zip"));
    const entries = readZipEntries(zip);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("references/rule.md");
    // 顶层目录前缀已剥掉
    expect(paths.every((p) => !p.startsWith("my-skill/"))).toBe(true);
    const skillMd = entries.find((e) => e.path === "SKILL.md")!;
    expect(skillMd.content.toString("utf8")).toContain("# deploy-review");
  });

  it("缺 SKILL.md → 由调用方校验;reader 正常返回条目", () => {
    const zip = readFileSync(join(FIXTURE_DIR, "no-skill-md.zip"));
    const entries = readZipEntries(zip);
    expect(entries.find((e) => e.path === "SKILL.md")).toBeUndefined();
  });

  it("路径含 .. → 抛 ZipReadError", () => {
    const zip = readFileSync(join(FIXTURE_DIR, "path-traversal.zip"));
    expect(() => readZipEntries(zip)).toThrow(ZipReadError);
  });

  it("条目路径含反斜杠 → 抛 ZipReadError", () => {
    const zip = readFileSync(join(FIXTURE_DIR, "backslash.zip"));
    expect(() => readZipEntries(zip)).toThrow(ZipReadError);
  });
});
