#!/usr/bin/env npx tsx
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { db } from "@/lib/db/client";
import Ajv2020 from "ajv/dist/2020.js";

const ROOT = process.cwd();
const OUTPUT_DIR = resolve(ROOT, "docs/implementation/topic-01-final-closure");
const INVENTORY_PATH = resolve(OUTPUT_DIR, "70-schema-table-inventory.json");
const INVENTORY_MD_PATH = resolve(OUTPUT_DIR, "70-schema-table-inventory.md");
const INVENTORY_SCHEMA_PATH = resolve(OUTPUT_DIR, "70-schema-table-inventory.schema.json");
const MANIFEST_PATH = resolve(OUTPUT_DIR, "71-final-schema-manifest.json");
const OLD_INVENTORY_PATH = resolve(
  ROOT,
  "docs/implementation/topic-01-loop-schema/04-schema-table-inventory.json",
);
const MIGRATION_PATH = resolve(ROOT, "drizzle/0000_initial_schema.sql");
const REMOVED_EMPTY_TABLES = ["MemoryIndex", "WorkspaceMergeConflict", "WorkspaceOverlay"];
const REQUIRED_FIELDS = [
  "physicalTableName",
  "schemaDeclaration",
  "migrationSource",
  "domainOwner",
  "tenantBoundary",
  "productionWriters",
  "productionReaders",
  "lifecycle",
  "authorityStatement",
  "duplicateCandidates",
  "retentionOrGc",
  "constraints",
  "decision",
  "evidence",
  "notes",
] as const;

type PreviousRecord = {
  physicalTableName: string;
  declarationSymbol: string;
  declarationFile: string;
  canonicalDomain: string;
  exportedByRoot: boolean;
  productionWriters: string[];
  productionReaders: string[];
  lifecycle: string;
  authorityFact: string;
  duplicateCandidate: string | null;
  retention: string;
  decisionReason: string;
  evidence: string[];
};

type InventoryRecord = {
  physicalTableName: string;
  schemaDeclaration: string;
  migrationSource: string[];
  domainOwner: string;
  tenantBoundary: string;
  productionWriters: string[];
  productionReaders: string[];
  lifecycle: string;
  authorityStatement: string;
  duplicateCandidates: string[];
  retentionOrGc: string;
  constraints: string[];
  decision: "keep";
  evidence: string[];
  notes: string;
};

function namesFromSchema(): string[] {
  const expression =
    'import * as s from "./lib/persistence/schema/index.ts"; import {Table,is,getTableName} from "drizzle-orm"; process.stdout.write(Object.values(s).filter(v=>is(v,Table)).map(v=>getTableName(v)).sort().join("\\n"))';
  return execFileSync("pnpm", ["exec", "tsx", "-e", expression], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

function runtimeNames(): string[] {
  return Object.values(db._.schema ?? {})
    .map((table) => table.dbName)
    .sort();
}

function migrationNames(sql: string): string[] {
  return Array.from(sql.matchAll(/CREATE TABLE `([^`]+)`/g), (match) => match[1] as string).sort();
}

function sourceFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return /\.(?:ts|tsx|mts|mjs)$/.test(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) =>
    ["node_modules", ".git", ".next", "dist", "build"].includes(entry)
      ? []
      : sourceFiles(resolve(path, entry)),
  );
}

const PRODUCTION_SOURCES = ["app", "components", "desktop", "hooks", "lib", "scripts"]
  .flatMap((root) => sourceFiles(resolve(ROOT, root)))
  .filter((path) => !path.includes(".test.") && !path.includes("/test-support/"));

function currentDirectReferences(symbol: string, declarationFile: string): {
  writers: string[];
  readers: string[];
} {
  const writers: string[] = [];
  const readers: string[] = [];
  for (const absolutePath of PRODUCTION_SOURCES) {
    const path = relative(ROOT, absolutePath);
    if (path === declarationFile) continue;
    const source = readFileSync(absolutePath, "utf8");
    if (!new RegExp(`\\b${symbol}\\b`).test(source)) continue;
    if (new RegExp(`\\.(?:insert|update|delete)\\(\\s*${symbol}\\b`).test(source)) writers.push(path);
    if (
      new RegExp(`\\.(?:from|join|leftJoin|rightJoin|innerJoin|fullJoin)\\(\\s*${symbol}\\b`).test(source) ||
      new RegExp(`\\b${symbol}\\.[A-Za-z_]`).test(source)
    ) {
      readers.push(path);
    }
  }
  return { writers, readers };
}

function constraintsFor(tableName: string, sql: string): string[] {
  const marker = `CREATE TABLE \`${tableName}\` (`;
  const start = sql.indexOf(marker);
  const end = start < 0 ? -1 : sql.indexOf("\n);", start);
  const create = start < 0 || end < 0 ? "" : sql.slice(start + marker.length, end);
  const local = Array.from(create.matchAll(/CONSTRAINT `([^`]+)` ([^\n]+)/g), (match) =>
    `${match[1]}: ${match[2].trim()}`,
  );
  const external = sql
    .split("\n")
    .filter(
      (line) =>
        line.startsWith(`ALTER TABLE \`${tableName}\``) ||
        (line.startsWith("CREATE INDEX ") && line.includes(` ON \`${tableName}\``)),
    )
    .map((line) => line.replace(/;--> statement-breakpoint$/, ""));
  return [...new Set([...local, ...external])];
}

function tenantBoundaryFor(tableName: string, sql: string): string {
  const marker = `CREATE TABLE \`${tableName}\` (`;
  const start = sql.indexOf(marker);
  const end = start < 0 ? -1 : sql.indexOf("\n);", start);
  const definition = start < 0 || end < 0 ? "" : sql.slice(start, end);
  if (definition.includes("`tenantId`")) return "tenantId 直接隔离；所有生产查询必须携带 tenantId";
  if (definition.includes("`tenant_id`")) return "tenant_id 直接隔离；所有生产查询必须携带 tenant_id";
  return "经父记录外键或不可变绑定继承 tenant；读取前由父 Authority 校验租户";
}

function build() {
  const sourcePath = existsSync(INVENTORY_PATH) ? INVENTORY_PATH : OLD_INVENTORY_PATH;
  const sourceDocument = JSON.parse(readFileSync(sourcePath, "utf8")) as {
    tables: Array<PreviousRecord | InventoryRecord>;
  };
  const previous: { tables: PreviousRecord[] } = {
    tables: sourceDocument.tables.map((record) => {
      if ("schemaDeclaration" in record) {
        const [declarationFile, declarationSymbol] = record.schemaDeclaration.split("#", 2);
        return {
          physicalTableName: record.physicalTableName,
          declarationSymbol: declarationSymbol ?? "",
          declarationFile: declarationFile ?? "",
          canonicalDomain: record.domainOwner,
          exportedByRoot: true,
          productionWriters: record.productionWriters,
          productionReaders: record.productionReaders,
          lifecycle: record.lifecycle,
          authorityFact: record.authorityStatement,
          duplicateCandidate: record.duplicateCandidates[0] ?? null,
          retention: record.retentionOrGc,
          decisionReason: record.notes,
          evidence: record.evidence,
        };
      }
      return record;
    }),
  };
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const canonical = namesFromSchema();
  const runtime = runtimeNames();
  const migration = migrationNames(sql);
  const byName = new Map(
    previous.tables.filter((record) => record.exportedByRoot).map((record) => [record.physicalTableName, record]),
  );
  const tables: InventoryRecord[] = canonical.map((name) => {
    const old = byName.get(name);
    if (!old) throw new Error(`旧逐表证据中缺少 Canonical 表：${name}`);
    const direct = currentDirectReferences(old.declarationSymbol, old.declarationFile);
    const writers = [
      ...new Set([
        ...old.productionWriters.filter((path) => existsSync(resolve(ROOT, path))),
        ...direct.writers,
      ]),
    ].sort();
    const readers = [
      ...new Set([
        ...old.productionReaders.filter((path) => existsSync(resolve(ROOT, path))),
        ...direct.readers,
      ]),
    ].sort();
    return {
      physicalTableName: name,
      schemaDeclaration: `${old.declarationFile}#${old.declarationSymbol}`,
      migrationSource: ["drizzle/0000_initial_schema.sql"],
      domainOwner: old.canonicalDomain,
      tenantBoundary: tenantBoundaryFor(name, sql),
      productionWriters: writers,
      productionReaders: readers,
      lifecycle: old.lifecycle,
      authorityStatement: old.authorityFact,
      duplicateCandidates: old.duplicateCandidate ? [old.duplicateCandidate] : [],
      retentionOrGc: old.retention,
      constraints: constraintsFor(name, sql),
      decision: "keep",
      evidence: [
        ...new Set([
          `${old.declarationFile}#${old.declarationSymbol}`,
          ...writers,
          ...readers,
          ...old.evidence.filter((path) => existsSync(resolve(ROOT, path.split("#", 1)[0] as string))),
          "drizzle/0000_initial_schema.sql",
        ]),
      ],
      notes: old.decisionReason,
    };
  });
  const counts = {
    canonical: canonical.length,
    runtimeLoaded: runtime.length,
    migration: migration.length,
    freshDbPlanned: migration.length,
  };
  const inventory = {
    generatedAt: "2026-09-04",
    authority: "lib/persistence/schema/index.ts",
    counts,
    currentDevelopmentDatabase: {
      status: "not_observed",
      tableCount: null,
      reason:
        "Batch 00 已确认项目开发端口无 MySQL 服务；Batch 06 按工程包只做静态检查，未连接任何数据库。",
    },
    frameworkMetadataExclusions: [
      {
        physicalTableName: "__drizzle_migrations",
        reason: "Drizzle migration runner 内部元数据，不属于应用 Canonical Schema。",
      },
    ],
    baselineChanges: REMOVED_EMPTY_TABLES.map((name) => ({
      physicalTableName: name,
      baseline: "旧 123 表清单",
      decision: "delete",
      reason: "无生产 writer、reader、worker 或运维消费者，属于未落地空壳表。",
    })),
    tables,
  };
  const manifest = {
    generatedAt: "2026-09-04",
    canonicalRoot: "lib/persistence/schema/index.ts",
    runtimeSchemaImport: "lib/db/client.ts -> @/lib/persistence/schema",
    cleanMigration: "drizzle/0000_initial_schema.sql",
    counts,
    tables: canonical,
    frameworkMetadataExclusions: inventory.frameworkMetadataExclusions,
    deletedFromBaseline123: inventory.baselineChanges,
  };
  return { inventory, manifest, canonical, runtime, migration };
}

function stable(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function markdown(inventory: ReturnType<typeof build>["inventory"]): string {
  const rows = inventory.tables
    .map(
      (table) =>
        `| ${table.physicalTableName} | ${table.domainOwner} | ${table.schemaDeclaration} | ${table.productionWriters.join("<br>")} | ${table.productionReaders.join("<br>")} | ${table.authorityStatement} |`,
    )
    .join("\n");
  return `# Topic 01 最终 Schema 逐表证据\n\n` +
    `Canonical = ${inventory.counts.canonical}\n\nRuntime-loaded = ${inventory.counts.runtimeLoaded}\n\nMigration = ${inventory.counts.migration}\n\nFresh DB = ${inventory.counts.freshDbPlanned}\n\n` +
    `当前开发数据库未观察：Batch 00 已确认项目开发端口没有 MySQL 服务，本批按约束未连接数据库；这不等同于 0 张表。框架元数据 \`__drizzle_migrations\` 单独排除。\n\n` +
    `旧 123 基线中 \`MemoryIndex\`、\`WorkspaceMergeConflict\`、\`WorkspaceOverlay\` 均无生产读写或 Worker，已从 Root、Runtime 与 clean migration 同步删除，最终为 120 张。\n\n` +
    `完整生命周期、租户边界、约束、保留策略和证据见同目录机器清单。\n\n` +
    `| 表 | 领域 | Schema 声明 | 生产写入者 | 生产读取者 | 唯一事实 |\n|---|---|---|---|---|---|\n${rows}\n`;
}

function validate(built: ReturnType<typeof build>): void {
  const { inventory, manifest, canonical, runtime, migration } = built;
  const inventorySchema = JSON.parse(readFileSync(INVENTORY_SCHEMA_PATH, "utf8"));
  const validateInventory = new Ajv2020({ allErrors: true }).compile(inventorySchema);
  if (!validateInventory(inventory)) {
    throw new Error(`inventory JSON Schema 校验失败：${JSON.stringify(validateInventory.errors)}`);
  }
  const names = inventory.tables.map((table) => table.physicalTableName);
  if (new Set(names).size !== names.length) throw new Error("inventory 存在重复表名");
  if (JSON.stringify(names) !== JSON.stringify(canonical)) throw new Error("Canonical 表未被唯一覆盖");
  if (JSON.stringify(runtime) !== JSON.stringify(canonical)) throw new Error("Runtime-loaded 与 Canonical 不一致");
  if (JSON.stringify(migration) !== JSON.stringify(canonical)) throw new Error("Migration 与 Canonical 不一致");
  if (manifest.counts.freshDbPlanned !== canonical.length) throw new Error("Fresh DB 计划与 Canonical 不一致");
  for (const table of inventory.tables) {
    for (const field of REQUIRED_FIELDS) {
      if (!(field in table)) throw new Error(`${table.physicalTableName} 缺少 ${field}`);
    }
    if (table.productionWriters.length === 0) throw new Error(`${table.physicalTableName} writers 为空`);
    if (table.productionReaders.length === 0) throw new Error(`${table.physicalTableName} readers 为空`);
    if (table.decision !== "keep") throw new Error(`${table.physicalTableName} decision 非 keep`);
  }
  if (!process.argv.includes("--write")) {
    if (readFileSync(INVENTORY_PATH, "utf8") !== stable(inventory)) throw new Error("70 inventory 未更新");
    if (readFileSync(MANIFEST_PATH, "utf8") !== stable(manifest)) throw new Error("71 manifest 未更新");
    if (readFileSync(INVENTORY_MD_PATH, "utf8") !== markdown(inventory)) throw new Error("70 markdown 未更新");
  }
}

const built = build();
if (process.argv.includes("--write")) {
  writeFileSync(INVENTORY_PATH, stable(built.inventory));
  writeFileSync(MANIFEST_PATH, stable(built.manifest));
  writeFileSync(INVENTORY_MD_PATH, markdown(built.inventory));
}
validate(built);
console.log(
  `Schema evidence OK: Canonical=${built.canonical.length}, Runtime=${built.runtime.length}, Migration=${built.migration.length}, Fresh=${built.manifest.counts.freshDbPlanned}`,
);
