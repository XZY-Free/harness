import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type mysql from "mysql2/promise";

type Column = { table: string; name: string; type: string; nullable: boolean; generated: boolean };
type Key = { table: string; name: string; columns: string[]; unique: boolean };
type ForeignKey = {
  table: string;
  name: string;
  columns: string[];
  target: string;
  targetColumns: string[];
};

function capture(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error(`迁移 SQL 捕获组 ${index} 缺失`);
  return value;
}

function identifiers(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => capture(match, 1));
}

function migrationShape(): {
  columns: Column[];
  keys: Key[];
  foreignKeys: ForeignKey[];
  checks: string[];
} {
  const ddl = readFileSync(resolve(process.cwd(), "drizzle/0000_initial_schema.sql"), "utf8");
  const columns: Column[] = [];
  const keys: Key[] = [];
  const foreignKeys: ForeignKey[] = [];
  const checks: string[] = [];
  for (const match of ddl.matchAll(/CREATE TABLE `([^`]+)` \(([\s\S]*?)\n\);/g)) {
    const table = capture(match, 1);
    for (const line of capture(match, 2).split("\n")) {
      const column = /^\s*`([^`]+)` ([a-z]+)(?:\([^)]*\))?([^\n]*)/i.exec(line);
      if (column) {
        columns.push({
          table,
          name: capture(column, 1),
          type:
            capture(column, 2).toLowerCase() === "boolean"
              ? "tinyint"
              : capture(column, 2).toLowerCase(),
          nullable: !/\bNOT NULL\b/.test(capture(column, 3)),
          generated: /GENERATED ALWAYS/.test(capture(column, 3)),
        });
        continue;
      }
      const key = /CONSTRAINT `([^`]+)` (PRIMARY KEY|UNIQUE)\(([^)]+)\)/.exec(line);
      if (key) {
        keys.push({
          table,
          name: key[2] === "PRIMARY KEY" ? "PRIMARY" : capture(key, 1),
          columns: identifiers(capture(key, 3)),
          unique: true,
        });
        continue;
      }
      const check = /CONSTRAINT `([^`]+)` CHECK\(/.exec(line);
      if (check) checks.push(`${table}.${check[1]}`);
    }
  }
  for (const match of ddl.matchAll(/CREATE (UNIQUE )?INDEX `([^`]+)` ON `([^`]+)` \(([^)]+)\)/g)) {
    keys.push({
      table: capture(match, 3),
      name: capture(match, 2),
      columns: identifiers(capture(match, 4)),
      unique: Boolean(match[1]),
    });
  }
  for (const match of ddl.matchAll(
    /ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` FOREIGN KEY \(([^)]+)\) REFERENCES `([^`]+)`\(([^)]+)\)/g,
  )) {
    foreignKeys.push({
      table: capture(match, 1),
      name: capture(match, 2),
      columns: identifiers(capture(match, 3)),
      target: capture(match, 4),
      targetColumns: identifiers(capture(match, 5)),
    });
  }
  return { columns, keys, foreignKeys, checks };
}

function equal(label: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `Fresh DB ${label} 不一致：expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  }
}

/** 设计字典定稿后由专题内已接受的准备槽、Supervisor 与释放 lane 增补的列。 */
const designAdditions: Record<string, string[]> = {
  ExecutionBinding: ["initialContextCheckpointId"],
  InvocationAttempt: [
    "preparationClaimId",
    "preparationIntentKey",
    "preparationRequestDigest",
    "preparationSourceJson",
  ],
  RuntimeSessionBinding: [
    "sourceOperationKey",
    "sourceRequestDigest",
    "sourceRequestJson",
    "supervisorClaimId",
    "supervisorInstanceId",
    "supervisorLeaseExpiresAt",
    "supervisorReleasedAt",
  ],
  WorkspaceWriteLock: [
    "backendOperationId",
    "backendReceipt",
    "releaseAttemptCount",
    "releaseErrorCode",
    "releaseLeaseExpiresAt",
    "releaseLeaseOwner",
    "releaseNextAttemptAt",
    "releaseReceipt",
  ],
};
const designReplacements: Record<string, string[]> = {
  InvocationAttempt: ["preparationLeaseOwner"], // 稳定 claim nonce 取代可复用的租约 owner 字符串。
};
const designNullableChanges = new Set([
  "Job.agentId", // 无 Agent 的 Job 由可信 service 主体驱动。
  "InvocationCommand.nextDispatchAt", // 已领取/完成的命令无下一次派发时间。
]);

function assertDesignDictionary(columns: Column[]): number {
  const dictionary = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "docs/V12/02/snowharness-execution-design/schema-dictionary.json"),
      "utf8",
    ),
  ) as { tables: Record<string, { fields: Array<{ name: string; nullable: boolean }> }> };
  for (const [table, design] of Object.entries(dictionary.tables)) {
    const actual = columns.filter((column) => column.table === table);
    const names = design.fields
      .map((field) => field.name)
      .filter((name) => !(designReplacements[table] ?? []).includes(name))
      .concat(designAdditions[table] ?? [])
      .sort();
    equal(`设计字典 ${table} 字段`, names, actual.map((column) => column.name).sort());
    for (const field of design.fields) {
      if ((designReplacements[table] ?? []).includes(field.name)) continue;
      if (designNullableChanges.has(`${table}.${field.name}`)) continue;
      equal(
        `设计字典 ${table}.${field.name} 可空性`,
        field.nullable,
        actual.find((column) => column.name === field.name)?.nullable,
      );
    }
  }
  return Object.keys(dictionary.tables).length;
}

/** 空 MySQL 8.4 迁移后，逐列与逐约束核对真实 information_schema。 */
export async function assertFreshSchema(connection: mysql.Connection): Promise<void> {
  const expected = migrationShape();
  const designTables = assertDesignDictionary(expected.columns);
  const [columnRows] = await connection.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()",
  );
  const actualColumns = new Map(
    columnRows.map((row) => [
      `${row.TABLE_NAME}.${row.COLUMN_NAME}`,
      {
        type: String(row.DATA_TYPE).toLowerCase(),
        nullable: row.IS_NULLABLE === "YES",
        generated: /(?:STORED|VIRTUAL) GENERATED/.test(String(row.EXTRA)),
      },
    ]),
  );
  for (const column of expected.columns) {
    equal(
      `列 ${column.table}.${column.name}`,
      { type: column.type, nullable: column.nullable, generated: column.generated },
      actualColumns.get(`${column.table}.${column.name}`),
    );
  }
  const expectedNames = new Set(expected.columns.map((column) => `${column.table}.${column.name}`));
  const extraColumns = [...actualColumns.keys()].filter(
    (name) => !name.startsWith("__") && !expectedNames.has(name),
  );
  equal("额外列", [], extraColumns);

  const [indexRows] = await connection.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
  );
  const actualKeys = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of indexRows) {
    const id = `${row.TABLE_NAME}.${row.INDEX_NAME}`;
    const key = actualKeys.get(id) ?? { columns: [], unique: Number(row.NON_UNIQUE) === 0 };
    key.columns.push(String(row.COLUMN_NAME));
    actualKeys.set(id, key);
  }
  for (const key of expected.keys)
    equal(
      `索引 ${key.table}.${key.name}`,
      { columns: key.columns, unique: key.unique },
      actualKeys.get(`${key.table}.${key.name}`),
    );

  const [foreignRows] = await connection.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION",
  );
  const actualForeignKeys = new Map<
    string,
    { columns: string[]; target: string; targetColumns: string[] }
  >();
  for (const row of foreignRows) {
    const id = `${row.TABLE_NAME}.${row.CONSTRAINT_NAME}`;
    const key = actualForeignKeys.get(id) ?? {
      columns: [],
      target: String(row.REFERENCED_TABLE_NAME),
      targetColumns: [],
    };
    key.columns.push(String(row.COLUMN_NAME));
    key.targetColumns.push(String(row.REFERENCED_COLUMN_NAME));
    actualForeignKeys.set(id, key);
  }
  for (const key of expected.foreignKeys)
    equal(
      `外键 ${key.table}.${key.name}`,
      { columns: key.columns, target: key.target, targetColumns: key.targetColumns },
      actualForeignKeys.get(`${key.table}.${key.name}`),
    );

  const [checkRows] = await connection.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME, CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK'",
  );
  const actualChecks = new Set(checkRows.map((row) => `${row.TABLE_NAME}.${row.CONSTRAINT_NAME}`));
  for (const check of expected.checks)
    if (!actualChecks.has(check)) throw new Error(`Fresh DB CHECK 缺失：${check}`);
  console.log(
    `[fresh-db] design=${designTables}, columns=${expected.columns.length}, indexes=${expected.keys.length}, foreignKeys=${expected.foreignKeys.length}, checks=${expected.checks.length}`,
  );
}
