import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Topic01 Agent Lifecycle True E2E 不变量（docs/V12/01 最终收口方案 §24.2 / §24.4 / §24.5）。
 *
 * 不变式：Agent 生命周期 Create→AgentRevision→Artifact→Attestation→Publication→Route/Deployment
 * 的 Artifact 绑定必须走正式 Command/API（record-artifact-attestation 的 verifyAndPersistAttestation
 * 在 verified 时通过 mysql store 原子 bindRevisionArtifact）。测试辅助代码不得用
 * `db.update(agentRevisionTable).set({ artifactId, artifactDigest })` 直接写正式数据库结论。
 *
 * 本契约静态扫描两个允许区域：
 *   - lib/control-plane/end-to-end-acceptance.test.ts
 *   - lib/test-support 目录下全部 TS 源码
 * 一旦发现直接 Drizzle update + set artifactId/artifactDigest 绑定 Agent Artifact 即失败。
 *
 * 语义化检查（非行号）：去注释/字符串后按“同一 update 语句同时 set 两个 key”匹配，
 * 不会因注释、普通读取、排版差异误触发。
 */

const ROOT = process.cwd();
const THIS_FILE = relative(ROOT, __filename);

const CONTROL_PLANE_E2E = join(ROOT, "lib/control-plane/end-to-end-acceptance.test.ts");
const TEST_SUPPORT_DIR = join(ROOT, "lib/test-support");

/** 匹配一次对 agentRevisionTable 的 update 调用起点。 */
const AGENT_REVISION_UPDATE_RE = /\.update\s*\(\s*agentRevisionTable\s*\)/g;
/**
 * 匹配一个 `.set({...})` 对象字面量同时出现 artifactId 与 artifactDigest 两个 key。
 * 对象键作为裸标识符（非字符串），字符串剥离后仍可命中。
 */
const SET_BOTH_ARTIFACT_RE =
  /\.set\s*\(\s*\{[\s\S]*?\bartifactId\b[\s\S]*?\bartifactDigest\b[\s\S]*?\}/;

/** 去除 // 行注释、/* 块注释 *​/ 以及字符串字面量，避免误命中。 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const QUOTE = `"'`;
  while (i < n) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";
    // 块注释 /* ... */
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // 行注释 //
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // 字符串 '...' "..."（含转义；模板串按裸内容近似处理，避免引入伪命中）
    if (QUOTE.includes(ch)) {
      const quote = ch;
      let j = i + 1;
      while (j < n && source[j] !== quote) {
        if (source[j] === "\\") j += 2;
        else j += 1;
      }
      const end = j >= n ? n : j + 1;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 找出“直接 DB 绑定 Agent Artifact”的违规 update 语句。
 * 返回每条违规语句（去空白、截断）用于诊断。
 */
function findDirectAgentArtifactBindings(source: string): string[] {
  const clean = stripCommentsAndStrings(source);
  const hits: string[] = [];
  AGENT_REVISION_UPDATE_RE.lastIndex = 0;
  for (
    let match: RegExpExecArray | null = AGENT_REVISION_UPDATE_RE.exec(clean);
    match !== null;
    match = AGENT_REVISION_UPDATE_RE.exec(clean)
  ) {
    const from = match.index;
    const tailStart = from + match[0].length;
    const stmtEnd = clean.indexOf(";", tailStart);
    const tail = stmtEnd === -1 ? clean.slice(from) : clean.slice(from, stmtEnd + 1);
    if (SET_BOTH_ARTIFACT_RE.test(tail)) {
      hits.push(tail.replace(/\s+/g, " ").slice(0, 180));
    }
  }
  return hits;
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

/** 汇总扫描区域的全部违规。 */
function collectViolations(): string[] {
  const targets = new Set<string>([
    ...(existsSync(CONTROL_PLANE_E2E) ? [CONTROL_PLANE_E2E] : []),
    ...listTsFiles(TEST_SUPPORT_DIR),
  ]);
  const violations: string[] = [];
  for (const file of targets) {
    const path = relative(ROOT, file);
    if (path === THIS_FILE) continue;
    const source = readFileSync(file, "utf8");
    for (const hit of findDirectAgentArtifactBindings(source)) {
      violations.push(`${path}: ${hit}`);
    }
  }
  return violations.sort();
}

describe("Topic01 Agent Lifecycle E2E：测试辅助不得直接 DB 绑定 Agent Artifact", () => {
  it("扫描区域不允许 db.update(agentRevisionTable).set({ artifactId, artifactDigest }) 直接写结论", () => {
    const violations = collectViolations();
    expect(
      violations,
      "测试代码不得用 Drizzle update+set artifactId/artifactDigest 直接绑定 Agent Artifact；" +
        "Artifact 绑定必须走正式 record-artifact-attestation 应用服务",
    ).toEqual([]);
  });

  it("matcher 能命中真实直接绑定样例（正样例）", () => {
    const sample = [
      "await db",
      "  .update(agentRevisionTable)",
      "  .set({ artifactId: attestation.artifactId, artifactDigest: attestation.artifactDigest })",
      "  .where(eq(agentRevisionTable.id, revision.id));",
    ].join("\n");
    expect(findDirectAgentArtifactBindings(sample)).toHaveLength(1);
  });

  it("matcher 忽略注释与普通读取（负样例）", () => {
    const sample = [
      "// db.update(agentRevisionTable).set({ artifactId: 'x', artifactDigest: 'y' })",
      "/* db.update(agentRevisionTable).set({ artifactId: 'x', artifactDigest: 'y' }) */",
      'const ref = "db.update(agentRevisionTable).set({ artifactId, artifactDigest })";',
      "const digest = await db",
      "  .select()",
      "  .from(agentRevisionTable)",
      "  .where(eq(agentRevisionTable.artifactId, 'z'));",
    ].join("\n");
    expect(findDirectAgentArtifactBindings(sample)).toHaveLength(0);
  });
});
