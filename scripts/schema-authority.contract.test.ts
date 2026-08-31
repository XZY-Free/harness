import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const LEGACY_TABLES = [
  "User",
  "ToolRun",
  "AdminAuditLog",
  "ContextSnapshot",
  "ContextSummary",
  "ThreadPlan",
  "ThreadPlanItem",
  "GitCheckpoint",
  "McpServerConfig",
  "CustomTool",
  "SecretMount",
  "Deployment",
  "AuditFailureLog",
] as const;

function listSourceFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return /\.(?:ts|tsx|mts)$/.test(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) =>
    ["node_modules", ".git", ".next", ".next-e2e", "dist", "build"].includes(entry)
      ? []
      : listSourceFiles(join(path, entry)),
  );
}

function tableBlock(source: string, symbol: string, nextSymbol: string): string {
  const start = source.indexOf(`export const ${symbol} = mysqlTable(`);
  const end = source.indexOf(`export const ${nextSymbol} = mysqlTable(`, start + 1);
  expect(start, `${symbol} 定义必须存在`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextSymbol} 定义必须位于 ${symbol} 之后`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Schema 单一 Authority", () => {
  it("旧 Schema Root 与旧查询聚合文件已物理删除", () => {
    expect(existsSync(join(ROOT, "lib/db/schema.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "lib/db/queries.ts"))).toBe(false);
  });

  it("db/client 只把 Canonical Root 交给 Drizzle", () => {
    const source = readFileSync(join(ROOT, "lib/db/client.ts"), "utf8");
    expect(source).toContain('import * as schema from "@/lib/persistence/schema"');
    expect(source).toContain('drizzle(pool, { schema, mode: "default" })');
    expect(source).not.toMatch(/fullSchema|from\s+["']\.\/schema["']/);
  });

  it("全仓不再定义或导入旧表 Authority", () => {
    const files = [
      ...listSourceFiles(join(ROOT, "app")),
      ...listSourceFiles(join(ROOT, "components")),
      ...listSourceFiles(join(ROOT, "desktop")),
      ...listSourceFiles(join(ROOT, "lib")),
      ...listSourceFiles(join(ROOT, "scripts")),
    ].filter((file) => !file.endsWith("schema-authority.contract.test.ts"));
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (/from\s+["']@\/lib\/db\/(?:schema|queries)["']/.test(source)) {
        violations.push(`${relative(ROOT, file)}:legacy-import`);
      }
      for (const table of LEGACY_TABLES) {
        if (source.includes(`mysqlTable("${table}"`)) {
          violations.push(`${relative(ROOT, file)}:${table}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("AgentCall exact revision/context/task 各自只有一个 Authority", () => {
    const source = readFileSync(join(ROOT, "lib/persistence/schema/agent-calls.ts"), "utf8");
    const call = tableBlock(source, "agentCallTable", "agentCallBindingTable");
    const attempt = tableBlock(source, "agentCallAttemptTable", "agentSessionBindingTable");
    const binding = tableBlock(source, "agentCallBindingTable", "agentCallAttemptTable");
    const session = source.slice(source.indexOf("export const agentSessionBindingTable"));

    expect(call).not.toContain("agentRevisionId:");
    expect(call).not.toContain("externalContextRef:");
    expect(call).toContain("agentSessionBindingId:");
    expect(call).toContain("externalTaskRef:");
    expect(binding).toContain("agentRevisionId:");
    expect(attempt).not.toContain("externalTaskRef:");
    expect(session).toContain("externalContextRef:");
  });
});
