import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

/** 仅供一次性空库使用的最小 MySQL 执行接口。 */
export interface FreshSchemaExecutor {
  query(statement: string): Promise<unknown>;
}

/**
 * 将已审查的完整 Schema SQL 批次加载到一次性空库。
 *
 * 该加载器不创建迁移日志表、不判断版本，也不能用于存量数据库升级。
 * 正式环境的建库和变更始终通过数据库提单执行；这里只服务于可随时销毁的测试空库。
 */
export async function loadFreshMysqlSchema(
  executor: FreshSchemaExecutor,
  schemaDirectory = resolve(process.cwd(), "drizzle"),
): Promise<void> {
  const files = (await readdir(schemaDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    throw new Error(`没有可加载的 Schema SQL：${schemaDirectory}`);
  }

  for (const file of files) {
    const content = await readFile(resolve(schemaDirectory, file), "utf8");
    const statements = content
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await executor.query(statement);
    }
  }
}
