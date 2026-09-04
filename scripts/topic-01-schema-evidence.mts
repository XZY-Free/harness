#!/usr/bin/env npx tsx
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { db } from "@/lib/db/client";
import Ajv2020 from "ajv/dist/2020.js";
import {
  type SchemaDeclaration,
  assertCurrentProductionReference,
  discoverSchemaDeclarations,
  scanCurrentProductionReferences,
} from "./topic-01-schema-evidence-core.mjs";

const ROOT = process.cwd();
const EVIDENCE_DIR = resolve(ROOT, "docs/topic-01/evidence");
const INVENTORY_PATH = resolve(EVIDENCE_DIR, "schema-inventory.json");
const INVENTORY_MD_PATH = resolve(EVIDENCE_DIR, "schema-inventory.md");
const INVENTORY_SCHEMA_PATH = resolve(EVIDENCE_DIR, "schema-inventory.schema.json");
const MANIFEST_PATH = resolve(EVIDENCE_DIR, "schema-manifest.json");
const MIGRATION_PATH = resolve(ROOT, "drizzle/0000_initial_schema.sql");
const REMOVED_EMPTY_TABLES = ["MemoryIndex", "WorkspaceMergeConflict", "WorkspaceOverlay"];

type AccessException = { exceptionReason: string; projectionOwner: string };
type AuthorityKind = "canonical-entity" | "binding" | "append-only-fact" | "projection";
type InventoryRecord = {
  physicalTableName: string;
  schemaDeclaration: string;
  migrationSource: string[];
  domainOwner: string;
  tenantBoundary: string;
  productionWriters: string[];
  productionReaders: string[];
  lifecycle: string;
  authorityKind: AuthorityKind;
  authorityStatement: string;
  accessException: AccessException | null;
  duplicateCandidates: string[];
  retentionOrGc: string;
  constraints: string[];
  decision: "keep";
  evidence: string[];
  notes: string;
};

const INVENTORY_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: [
    "schemaVersion",
    "authority",
    "counts",
    "freshDbVerification",
    "frameworkMetadataExclusions",
    "baselineChanges",
    "tables",
  ],
  properties: {
    schemaVersion: { const: 2 },
    authority: { type: "string", minLength: 1 },
    counts: {
      type: "object",
      required: ["canonical", "runtimeLoaded", "migration", "freshDbPlanned"],
      properties: {
        canonical: { type: "integer", minimum: 1 },
        runtimeLoaded: { type: "integer", minimum: 1 },
        migration: { type: "integer", minimum: 1 },
        freshDbPlanned: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    freshDbVerification: {
      type: "object",
      required: ["status", "reason"],
      properties: {
        status: { const: "planned-for-batch-07" },
        reason: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    frameworkMetadataExclusions: { type: "array", minItems: 1 },
    baselineChanges: { type: "array" },
    tables: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: [
          "physicalTableName",
          "schemaDeclaration",
          "migrationSource",
          "domainOwner",
          "tenantBoundary",
          "productionWriters",
          "productionReaders",
          "lifecycle",
          "authorityKind",
          "authorityStatement",
          "accessException",
          "duplicateCandidates",
          "retentionOrGc",
          "constraints",
          "decision",
          "evidence",
          "notes",
        ],
        properties: {
          physicalTableName: { type: "string", minLength: 1 },
          schemaDeclaration: { type: "string", minLength: 1 },
          migrationSource: { type: "array", minItems: 1, items: { type: "string" } },
          domainOwner: { type: "string", minLength: 1 },
          tenantBoundary: { type: "string", minLength: 1 },
          productionWriters: { type: "array", items: { type: "string" } },
          productionReaders: { type: "array", items: { type: "string" } },
          lifecycle: { type: "string", minLength: 1 },
          authorityKind: {
            enum: ["canonical-entity", "binding", "append-only-fact", "projection"],
          },
          authorityStatement: { type: "string", minLength: 1 },
          accessException: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                required: ["exceptionReason", "projectionOwner"],
                properties: {
                  exceptionReason: { type: "string", minLength: 1 },
                  projectionOwner: { type: "string", minLength: 1 },
                },
                additionalProperties: false,
              },
            ],
          },
          duplicateCandidates: { type: "array", items: { type: "string" } },
          retentionOrGc: { type: "string", minLength: 1 },
          constraints: { type: "array", minItems: 1, items: { type: "string" } },
          decision: { const: "keep" },
          evidence: { type: "array", minItems: 2, items: { type: "string" } },
          notes: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

function canonicalNames(): string[] {
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

function constraintsFor(tableName: string, sql: string): string[] {
  const marker = `CREATE TABLE \`${tableName}\` (`;
  const start = sql.indexOf(marker);
  const end = start < 0 ? -1 : sql.indexOf("\n);", start);
  const create = start < 0 || end < 0 ? "" : sql.slice(start + marker.length, end);
  const local = create
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => /PRIMARY KEY|UNIQUE|CONSTRAINT|NOT NULL/.test(line));
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
  if (definition.includes("`tenantId`")) return "tenantId 直接隔离；生产查询必须携带 tenantId";
  if (definition.includes("`tenant_id`")) {
    return "tenant_id 直接隔离；生产查询必须携带 tenant_id";
  }
  return "通过父记录外键或不可变绑定继承租户；访问前由父 Authority 校验";
}

function authorityKindFor(name: string): AuthorityKind {
  if (/Projection|Checkpoint|Snapshot|Aggregate|Index$/.test(name)) return "projection";
  if (/Binding|Route|Grant|Policy/.test(name)) return "binding";
  if (/Event|Ingress|Attempt|Record|Audit|Trace|Span|Observation|Outbox/.test(name)) {
    return "append-only-fact";
  }
  return "canonical-entity";
}

function accessExceptionFor(
  declaration: SchemaDeclaration,
  kind: AuthorityKind,
  writers: string[],
  readers: string[],
): AccessException | null {
  if (writers.length > 0 && readers.length > 0) return null;
  if (kind !== "projection" || writers.length + readers.length === 0) return null;
  return {
    exceptionReason:
      writers.length === 0
        ? "该表是只读投影；写入由声明的投影 owner 间接维护"
        : "该表是写入侧物化投影；当前没有独立生产读取路径",
    projectionOwner: writers[0] ?? readers[0] ?? declaration.file,
  };
}

function domainOwnerFor(declaration: SchemaDeclaration): string {
  if (declaration.file.startsWith("lib/control-plane/")) return "control-plane";
  return basename(declaration.file).replace(/\.[^.]+$/, "");
}

function build() {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const canonical = canonicalNames();
  const runtime = runtimeNames();
  const migration = migrationNames(sql);
  const declarations = discoverSchemaDeclarations(ROOT);
  const declarationsByName = new Map(
    declarations.map((declaration) => [declaration.physicalTableName, declaration]),
  );
  const tables: InventoryRecord[] = canonical.map((name) => {
    const declaration = declarationsByName.get(name);
    if (!declaration) throw new Error(`当前源码缺少 Canonical 表声明：${name}`);
    const { writers, readers } = scanCurrentProductionReferences(ROOT, declaration);
    const authorityKind = authorityKindFor(name);
    const accessException = accessExceptionFor(declaration, authorityKind, writers, readers);
    const schemaDeclaration = `${declaration.file}#${declaration.symbol}`;
    return {
      physicalTableName: name,
      schemaDeclaration,
      migrationSource: ["drizzle/0000_initial_schema.sql"],
      domainOwner: domainOwnerFor(declaration),
      tenantBoundary: tenantBoundaryFor(name, sql),
      productionWriters: writers,
      productionReaders: readers,
      lifecycle:
        authorityKind === "projection"
          ? "由生产投影 owner 随源事实更新，并按投影重建或保留策略清理"
          : authorityKind === "append-only-fact"
            ? "由生产写入者创建不可变事实，并按领域保留策略归档或清理"
            : "由领域服务创建和转换状态，并按领域保留策略清理",
      authorityKind,
      authorityStatement: `${schemaDeclaration} 是 ${name} 的唯一物理 Schema Authority`,
      accessException,
      duplicateCandidates: [],
      retentionOrGc: "由 domain owner 的生产保留、删除或投影重建流程负责",
      constraints: constraintsFor(name, sql),
      decision: "keep",
      evidence: [schemaDeclaration, ...writers, ...readers, "drizzle/0000_initial_schema.sql"],
      notes: "writer/reader 每次从当前生产源码重新扫描；不读取或合并历史 inventory",
    };
  });
  const counts = {
    canonical: canonical.length,
    runtimeLoaded: runtime.length,
    migration: migration.length,
    freshDbPlanned: migration.length,
  };
  const inventory = {
    schemaVersion: 2,
    authority: "lib/persistence/schema/index.ts",
    counts,
    freshDbVerification: {
      status: "planned-for-batch-07",
      reason: "批次06只验证生成器；空库迁移、运行时加载与数据库 introspection 在批次07执行",
    },
    frameworkMetadataExclusions: [
      {
        physicalTableName: "__drizzle_migrations",
        reason: "Drizzle migration runner 元数据，不属于应用 Canonical Schema",
      },
    ],
    baselineChanges: REMOVED_EMPTY_TABLES.map((physicalTableName) => ({
      physicalTableName,
      decision: "delete",
      reason: "无生产 writer、reader、worker 或运维消费者",
    })),
    tables,
  };
  const manifest = {
    schemaVersion: 2,
    canonicalRoot: "lib/persistence/schema/index.ts",
    runtimeSchemaImport: "lib/db/client.ts -> @/lib/persistence/schema",
    cleanMigration: "drizzle/0000_initial_schema.sql",
    inventory: "docs/topic-01/evidence/schema-inventory.json",
    counts,
    tables: canonical,
    frameworkMetadataExclusions: inventory.frameworkMetadataExclusions,
    deletedFromBaseline: inventory.baselineChanges,
  };
  return { inventory, manifest, declarationsByName, canonical, runtime, migration };
}

function stable(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function markdown(inventory: ReturnType<typeof build>["inventory"]): string {
  const rows = inventory.tables
    .map(
      (table) =>
        `| ${table.physicalTableName} | ${table.domainOwner} | ${table.authorityKind} | ${table.productionWriters.join("<br>") || "受控例外"} | ${table.productionReaders.join("<br>") || "受控例外"} |`,
    )
    .join("\n");
  return `# Topic 01 Schema 逐表证据\n\n本清单只由当前 Canonical Schema、clean migration、runtime-loaded schema 与当前生产源码生成，不继承历史清单。Fresh DB introspection 在批次07执行。\n\n| 表 | 领域 owner | Authority 类型 | 生产写入者 | 生产读取者 |\n|---|---|---|---|---|\n${rows}\n`;
}

function validate(built: ReturnType<typeof build>): void {
  const { inventory, manifest, declarationsByName, canonical, runtime, migration } = built;
  const validateInventory = new Ajv2020({ allErrors: true }).compile(INVENTORY_SCHEMA);
  if (!validateInventory(inventory)) {
    throw new Error(`inventory JSON Schema 校验失败：${JSON.stringify(validateInventory.errors)}`);
  }
  const names = inventory.tables.map((table) => table.physicalTableName);
  if (new Set(names).size !== names.length) throw new Error("inventory 存在重复表名");
  if (JSON.stringify(names) !== JSON.stringify(canonical))
    throw new Error("Canonical 表未被唯一覆盖");
  if (JSON.stringify(runtime) !== JSON.stringify(canonical)) {
    throw new Error("Runtime-loaded 与 Canonical 不一致");
  }
  if (JSON.stringify(migration) !== JSON.stringify(canonical)) {
    throw new Error("Migration 与 Canonical 不一致");
  }
  for (const table of inventory.tables) {
    const declaration = declarationsByName.get(table.physicalTableName) as SchemaDeclaration;
    for (const path of [...table.productionWriters, ...table.productionReaders]) {
      assertCurrentProductionReference(ROOT, declaration, path);
    }
    const hasBothDirections =
      table.productionWriters.length > 0 && table.productionReaders.length > 0;
    if (!hasBothDirections) {
      if (table.authorityKind !== "projection" || !table.accessException) {
        throw new Error(
          `${table.physicalTableName} 缺少生产 writer/reader 且没有受控 projection 例外`,
        );
      }
      assertCurrentProductionReference(ROOT, declaration, table.accessException.projectionOwner);
    } else if (table.accessException) {
      throw new Error(`${table.physicalTableName} 不需要 accessException`);
    }
    if (table.constraints.length === 0) throw new Error(`${table.physicalTableName} 缺少约束证据`);
  }
  if (!process.argv.includes("--write")) {
    if (readFileSync(INVENTORY_PATH, "utf8") !== stable(inventory)) {
      throw new Error("schema-inventory.json 未更新");
    }
    if (readFileSync(MANIFEST_PATH, "utf8") !== stable(manifest)) {
      throw new Error("schema-manifest.json 未更新");
    }
    if (readFileSync(INVENTORY_MD_PATH, "utf8") !== markdown(inventory)) {
      throw new Error("schema-inventory.md 未更新");
    }
    if (readFileSync(INVENTORY_SCHEMA_PATH, "utf8") !== stable(INVENTORY_SCHEMA)) {
      throw new Error("schema-inventory.schema.json 未更新");
    }
  }
}

const built = build();
if (process.argv.includes("--write")) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(INVENTORY_PATH, stable(built.inventory));
  writeFileSync(MANIFEST_PATH, stable(built.manifest));
  writeFileSync(INVENTORY_MD_PATH, markdown(built.inventory));
  writeFileSync(INVENTORY_SCHEMA_PATH, stable(INVENTORY_SCHEMA));
}
validate(built);
console.log(
  `Schema evidence OK: Canonical=${built.canonical.length}, Runtime=${built.runtime.length}, Migration=${built.migration.length}, Fresh=Batch07`,
);
