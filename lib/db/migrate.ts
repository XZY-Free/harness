import { logger } from "@/lib/logger";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import type { RowDataPacket } from "mysql2";
import { openMigrationConnection } from "./client";

/**
 * 应用 drizzle 迁移（幂等）。由 instrumentation 在启动时调用，确保表结构就绪。
 *
 * 分布式锁。多实例同时启动时，MySQL GET_LOCK 防并发 DDL 元数据锁冲突/超时。
 * P2-5: 获锁失败后 polling 等待(最多 120s),防多实例滚动部署时 B 实例跳过迁移直接运行
 * 导致表结构未就绪(查询触发 Unknown column)。获锁后跑 migrate(幂等,跳过已应用)。
 * 超时仍失败 → throw(fail-closed,启动失败优于表结构不一致)。
 */
export async function runMigrations(): Promise<void> {
  const connection = await openMigrationConnection();
  const maxWaitMs = 120_000;
  const deadline = Date.now() + maxWaitMs;
  let got = false;
  try {
    while (Date.now() < deadline && !got) {
      const [rows] = await connection.query<(RowDataPacket & { got: number | string })[]>(
        "SELECT GET_LOCK('snow_migrate', 10) AS got",
      );
      got = Number(rows[0]?.got) === 1;
      if (!got) {
        logger.warn("[migrate] 未获迁移锁,等待其他实例完成迁移", { got: rows[0]?.got });
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
    if (!got) {
      throw new Error("[migrate] 获迁移锁超时(120s),表结构可能未就绪——fail-closed");
    }
    await migrate(drizzle(connection, { mode: "default" }), { migrationsFolder: "./drizzle" });
    logger.info("db migrations applied");
  } finally {
    if (got) await connection.query("SELECT RELEASE_LOCK('snow_migrate')").catch(() => {});
    connection.release();
  }
}
