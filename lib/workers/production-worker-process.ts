import { createServer } from "node:http";
import { db } from "@/lib/db/client";
import { logger } from "@/lib/logger";
import {
  type DurableWorkerRole,
  WORKER_REQUIRED_TABLES,
  createProductionWorkerRole,
  parseDurableWorkerRole,
} from "@/lib/workers/production-worker-role";
import { sql } from "drizzle-orm";

export interface WorkerHealthState {
  role: DurableWorkerRole;
  startedAt: Date;
  lastLoopPulseAt: Date;
  lastSuccessfulPollAt: Date | null;
  loopCrashed: boolean;
}

export function isWorkerLive(state: WorkerHealthState, now = new Date(), maxSilenceMs = 30_000) {
  return !state.loopCrashed && now.getTime() - state.lastLoopPulseAt.getTime() <= maxSilenceMs;
}

export function isWorkerReady(
  state: WorkerHealthState,
  databaseReadWrite: boolean,
  now = new Date(),
  maxPollAgeMs = 30_000,
) {
  return (
    databaseReadWrite &&
    !state.loopCrashed &&
    state.lastSuccessfulPollAt !== null &&
    now.getTime() - state.lastSuccessfulPollAt.getTime() <= maxPollAgeMs
  );
}

export async function checkWorkerDatabase(role: DurableWorkerRole): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 缺失");
  const [rows] = await db.execute(sql`SELECT @@read_only AS readOnly`);
  const row = Array.isArray(rows)
    ? (rows[0] as { readOnly?: number | string } | undefined)
    : undefined;
  if (String(row?.readOnly ?? "1") !== "0") throw new Error("数据库处于只读模式");
  // 零行 UPDATE 不改变业务事实，但会由 MySQL 校验当前账号确实具备 DML 写权限。
  await db.execute(sql.raw("UPDATE `Tenant` SET `updatedAt` = `updatedAt` WHERE 1 = 0"));
  for (const table of WORKER_REQUIRED_TABLES[role]) {
    await db.execute(sql.raw(`SELECT 1 FROM \`${table}\` LIMIT 0`));
  }
}

export async function runProductionWorkerProcess(roleOverride?: string): Promise<void> {
  const role = parseDurableWorkerRole(roleOverride ?? process.env.WORKER_ROLE ?? process.argv[2]);
  await checkWorkerDatabase(role);
  const worker = createProductionWorkerRole(role);
  const now = new Date();
  const state: WorkerHealthState = {
    role,
    startedAt: now,
    lastLoopPulseAt: now,
    lastSuccessfulPollAt: null,
    loopCrashed: false,
  };
  const pollIntervalMs = positiveInt(process.env.WORKER_POLL_INTERVAL_MS, 1_000);
  const healthPort = positiveInt(process.env.WORKER_HEALTH_PORT, 8080);
  let stopping = false;
  let databaseReadWrite = true;
  const healthServer = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/live") {
      const live = isWorkerLive(state);
      response.statusCode = live ? 200 : 503;
      response.end(JSON.stringify({ status: live ? "live" : "dead", role }));
      return;
    }
    if (request.url === "/ready") {
      try {
        await checkWorkerDatabase(role);
        databaseReadWrite = true;
      } catch {
        databaseReadWrite = false;
      }
      const ready = isWorkerReady(state, databaseReadWrite);
      response.statusCode = ready ? 200 : 503;
      response.end(JSON.stringify({ status: ready ? "ready" : "not_ready", role }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ status: "not_found" }));
  });
  healthServer.listen(healthPort, "0.0.0.0");

  const stop = () => {
    stopping = true;
    worker.stop();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  logger.info("[worker] 生产角色启动", { role, healthPort });
  try {
    while (!stopping) {
      state.lastLoopPulseAt = new Date();
      try {
        await worker.pollOnce();
        state.lastSuccessfulPollAt = new Date();
      } catch (error) {
        logger.error("[worker] poll 失败", { role, error: String(error) });
      }
      state.lastLoopPulseAt = new Date();
      if (!stopping) await wait(pollIntervalMs);
    }
  } catch (error) {
    state.loopCrashed = true;
    throw error;
  } finally {
    healthServer.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
