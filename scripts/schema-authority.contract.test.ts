import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { db } from "@/lib/db/client";
import * as canonicalSchema from "@/lib/persistence/schema";
import { Table, getTableName, is } from "drizzle-orm";
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

function canonicalTableNames(): string[] {
  return (Object.values(canonicalSchema) as unknown[])
    .filter((value) => is(value, Table))
    .map((table) => getTableName(table as Table))
    .sort();
}

function runtimeTableNames(): string[] {
  return Object.values(db._.schema ?? {})
    .map((table) => table.dbName)
    .sort();
}

function migrationTableNames(sql: string): string[] {
  return Array.from(sql.matchAll(/CREATE TABLE `([^`]+)`/g), (match) => match[1])
    .filter((name): name is string => Boolean(name))
    .sort();
}

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
    expect(call).not.toContain("externalTaskRef:");
    expect(binding).toContain("agentRevisionId:");
    expect(attempt).toContain("externalTaskRef:");
    expect(session).toContain("externalContextRef:");
  });

  it("clean initial migration 只有一条，不含开发期 drop/rename 兼容链", () => {
    const migrationFiles = readdirSync(join(ROOT, "drizzle"))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();
    expect(migrationFiles).toEqual(["0000_initial_schema.sql"]);
    const migration = readFileSync(join(ROOT, "drizzle", migrationFiles[0] as string), "utf8");
    expect(migration).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|RENAME TABLE|RENAME COLUMN)\b/i);

    const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries).toEqual([
      expect.objectContaining({ idx: 0, tag: "0000_initial_schema" }),
    ]);
  });

  it("Canonical Root、Runtime、Migration 与最终 manifest 完全一致", () => {
    const manifestPath = join(
      ROOT,
      "docs/implementation/topic-01-final-closure/71-final-schema-manifest.json",
    );
    expect(existsSync(manifestPath), "最终 Schema manifest 必须存在").toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      counts: { canonical: number };
      tables: string[];
    };
    const migration = readFileSync(join(ROOT, "drizzle/0000_initial_schema.sql"), "utf8");
    const canonical = canonicalTableNames();

    expect(canonical).toHaveLength(120);
    expect(runtimeTableNames()).toEqual(canonical);
    expect(migrationTableNames(migration)).toEqual(canonical);
    expect(manifest.counts.canonical).toBe(canonical.length);
    expect(manifest.tables).toEqual(canonical);
    for (const legacy of LEGACY_TABLES) expect(canonical).not.toContain(legacy);
  });
});
