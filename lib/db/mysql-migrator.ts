import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { db } from "./client";

/**
 * 执行 SnowHarness 的 MySQL 迁移。
 *
 * Drizzle 当前生成的迁移日志表使用 `SERIAL PRIMARY KEY`。部分企业 MySQL
 * 兼容数据库不接受该缩写，因此这里使用等价且更明确的 MySQL 主键定义。
 */
export async function migrateMysql(
  database: typeof db,
  migrationsFolder = "./drizzle",
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });

  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS \`__drizzle_migrations\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      \`hash\` TEXT NOT NULL,
      \`created_at\` BIGINT
    )
  `);

  const result = await database.execute(sql`
    SELECT \`id\`, \`hash\`, \`created_at\`
    FROM \`__drizzle_migrations\`
    ORDER BY \`created_at\` DESC
    LIMIT 1
  `);
  const rows = result[0] as unknown as Array<{ created_at: number | string | null }>;
  const lastCreatedAt = rows[0]?.created_at == null ? null : Number(rows[0].created_at);

  await database.transaction(async (tx) => {
    for (const migration of migrations) {
      if (lastCreatedAt !== null && lastCreatedAt >= migration.folderMillis) continue;

      for (const statement of migration.sql) {
        await tx.execute(sql.raw(statement));
      }
      await tx.execute(sql`
        INSERT INTO \`__drizzle_migrations\` (\`hash\`, \`created_at\`)
        VALUES (${migration.hash}, ${migration.folderMillis})
      `);
    }
  });
}
