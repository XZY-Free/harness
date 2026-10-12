import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Topic01 Artifact Attestation 持久化入口所有权契约（docs/V12/01 §21 / §29 H）。
 *
 * 不变式：Artifact Attestation 有且只有两个显式持久化入口，且不留兼容壳。
 * - 规范只读模块 artifact-attestation-reader.ts 拥有全部读导出；
 * - 规范写入模块 artifact-attestation-writer.ts 拥有写入/验证/门禁/撤销导出；
 * - 废弃的 artifact-attestation-queries.ts 必须物理删除，且任何调用方都不得再 import 旧路径。
 *
 * 语义化检查，避免对排版/行号脆弱：去空白后对比符号与模块说明符。
 */

const ROOT = process.cwd();
const PERSISTENCE_DIR = join(ROOT, "lib/artifacts/persistence");
const THIS_FILE = relative(ROOT, __filename);

const READER_SPECIFIER = "@/lib/artifacts/persistence/artifact-attestation-reader";
const WRITER_SPECIFIER = "@/lib/artifacts/persistence/artifact-attestation-writer";
const QUERIES_SPECIFIER = "@/lib/artifacts/persistence/artifact-attestation-queries";

/** 规范只读模块应导出的五个读函数（既有行为，冻结）。 */
const READER_OPS = [
  "getAttestationById",
  "listAttestationsByRevision",
  "listAttestationsByDigest",
  "listAttestations",
  "getVerifiedAttestationForRevision",
] as const;

/** 规范写入模块应导出的四个操作函数（冻结设计）。 */
const WRITER_OPS = [
  "insertAttestation",
  "verifyAndPersistAttestation",
  "assertAttestationGate",
  "revokeAttestation",
] as const;

/** 只读模块导出的结果类型/选项类型（writer 不得复导出）。 */
const READER_TYPES = ["ArtifactAttestationWithRevocation", "ListAttestationsOptions"] as const;

/** 去除全部空白，使排版差异不影响语义判断。 */
function normalize(source: string): string {
  return source.replace(/\s+/g, "");
}

/** 读取模块源；文件不存在返回 null（用于不崩溃地断言缺失的规范写入模块）。 */
function readModule(rel: string): string | null {
  const path = join(PERSISTENCE_DIR, rel);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** 递归列出 .ts/.tsx 文件（跳过构建产物目录）。 */
function listTsFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (!statSync(root).isFile()) {
    return readdirSync(root).flatMap((entry) => {
      if (["node_modules", ".git", ".next", "build", "dist", "__pycache__"].includes(entry)) {
        return [];
      }
      return listTsFiles(join(root, entry));
    });
  }
  return root.endsWith(".ts") || root.endsWith(".tsx") ? [root] : [];
}

describe("Topic01 artifact attestation persistence ownership contract", () => {
  it("canonical writer module exists and exports exactly the four write operations", async () => {
    // 动态 import：写入模块缺失时收集失败断言，而非仅在静态解析阶段崩溃。
    const mod = (await import(WRITER_SPECIFIER).catch(() => null)) as Record<
      string,
      unknown
    > | null;
    expect(mod, `规范写入模块 ${WRITER_SPECIFIER} 必须存在`).not.toBeNull();
    if (!mod) return;
    for (const op of WRITER_OPS) {
      expect(typeof mod[op], `${op} 应为 writer 导出的函数`).toBe("function");
    }
    expect(Object.keys(mod).sort(), "writer 不得导出四个写操作以外的兼容符号").toEqual(
      [...WRITER_OPS].sort(),
    );
  });

  it("canonical writer re-exports no reader operations or result types", () => {
    const src = readModule("artifact-attestation-writer.ts");
    expect(src, "writer 源必须存在以检查复导出").not.toBeNull();
    if (!src) return;
    const normalized = normalize(src);
    // 值复导出：export { <readerOp> ... }
    for (const op of READER_OPS) {
      expect(normalized, `writer 不得复导出只读操作 ${op}`).not.toContain(`export{${op}`);
    }
    // 类型复导出：export type { <readerType> ... }
    for (const typeName of READER_TYPES) {
      expect(normalized, `writer 不得复导出只读结果类型 ${typeName}`).not.toContain(
        `exporttype{${typeName}`,
      );
    }
    // 也不得从 reader / 旧 queries 整块复导出（export *）。
    expect(normalized, "writer 不得 export * 复导出只读模块").not.toContain(`export*from"@/lib`);
  });

  it("reader still exports the five existing read functions and does not import writer", async () => {
    const mod = (await import(READER_SPECIFIER)) as Record<string, unknown>;
    for (const op of READER_OPS) {
      expect(typeof mod[op], `reader 应保留读函数 ${op}`).toBe("function");
    }
    const src = readModule("artifact-attestation-reader.ts");
    expect(src).not.toBeNull();
    if (src) {
      expect(src, "reader 不得 import writer").not.toContain(WRITER_SPECIFIER);
    }
  });

  it("obsolete queries shell file is physically removed", () => {
    expect(
      existsSync(join(PERSISTENCE_DIR, "artifact-attestation-queries.ts")),
      "artifact-attestation-queries.ts 必须物理删除（无兼容壳）",
    ).toBe(false);
  });

  it("no repo TS/TSX caller imports the obsolete queries path", () => {
    const violations: string[] = [];
    for (const root of ["app", "components", "desktop", "lib", "scripts", "tests", "e2e"]) {
      for (const file of listTsFiles(join(ROOT, root))) {
        const path = relative(ROOT, file);
        if (path === THIS_FILE) continue; // 本契约自身的字符串除外
        const source = readFileSync(file, "utf8");
        if (source.includes(QUERIES_SPECIFIER)) {
          violations.push(path);
        }
      }
    }
    expect(
      violations,
      "调用方必须改从 reader/writer 导入，不得再 import artifact-attestation-queries",
    ).toEqual([]);
  });
});
