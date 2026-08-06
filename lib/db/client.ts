import * as artifactRecordSchema from "@/lib/artifacts/persistence/artifact-record";
import { dbConfig } from "@/lib/config";
import * as controlPlaneOutboxSchema from "@/lib/control-plane/events/control-plane-outbox";
import * as adminExportSchemaTable from "@/lib/persistence/schema/admin-export";
import * as agentSchemaTable from "@/lib/persistence/schema/agent";
import * as auditSchemaTable from "@/lib/persistence/schema/audit";
import * as authorizationSchemaTable from "@/lib/persistence/schema/authorization";
import * as deploymentRouteSchemaTable from "@/lib/persistence/schema/deployment-route";
import * as deviceSchemaTable from "@/lib/persistence/schema/device";
import * as effectSchemaTable from "@/lib/persistence/schema/effect";
import * as environmentSchemaTable from "@/lib/persistence/schema/environment";
import * as evaluationSchemaTable from "@/lib/persistence/schema/evaluation";
import * as fileChangeSchemaTable from "@/lib/persistence/schema/file-change";
import * as filesystemCheckpointSchemaTable from "@/lib/persistence/schema/filesystem-checkpoint";
import * as idempotencySchemaTable from "@/lib/persistence/schema/idempotency";
import * as identitySchemaTable from "@/lib/persistence/schema/identity";
import * as permissionSchemaTable from "@/lib/persistence/schema/permission";
import * as recoveryDrillSchemaTable from "@/lib/persistence/schema/recovery-drill";
import * as runtimeSchemaTable from "@/lib/persistence/schema/runtime";
import * as runtimeArtifactSchemaTable from "@/lib/persistence/schema/runtime-artifact";
import * as securityIncidentSchemaTable from "@/lib/persistence/schema/security-incident";
import * as traceSchemaTable from "@/lib/persistence/schema/trace";
import * as usageSchemaTable from "@/lib/persistence/schema/usage";
import * as userActionRequestSchemaTable from "@/lib/persistence/schema/user-action-request";
import * as workspaceSchemaTable from "@/lib/persistence/schema/workspace";
import * as publicationRecordSchema from "@/lib/publications/persistence/publication-record";
import * as routeRevisionSchema from "@/lib/routes/persistence/route-revision-record";
import * as runtimeConformanceRunSchema from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";

/** 合并旧 schema 与 V11 schema，使 db.query.* 关系查询覆盖 V11 表。 */
const fullSchema = {
  ...schema,
  ...controlPlaneOutboxSchema,
  ...artifactRecordSchema,
  ...publicationRecordSchema,
  ...runtimeConformanceRunSchema,
  ...routeRevisionSchema,
  ...identitySchemaTable,
  ...deviceSchemaTable,
  ...authorizationSchemaTable,
  ...idempotencySchemaTable,
  ...auditSchemaTable,
  ...adminExportSchemaTable,
  ...agentSchemaTable,
  ...runtimeSchemaTable,
  ...deploymentRouteSchemaTable,
  ...workspaceSchemaTable,
  ...environmentSchemaTable,
  ...permissionSchemaTable,
  ...userActionRequestSchemaTable,
  ...effectSchemaTable,
  ...runtimeArtifactSchemaTable,
  ...fileChangeSchemaTable,
  ...filesystemCheckpointSchemaTable,
  ...traceSchemaTable,
  ...evaluationSchemaTable,
  ...usageSchemaTable,
  ...recoveryDrillSchemaTable,
  ...securityIncidentSchemaTable,
};

/**
 * 外部 MySQL + Drizzle（mysql2 驱动）。
 *
 * v2 改造：
 * - ensureSchema() 已退役，改用 drizzle-kit migration 管理（db:migrate）
 * - 连接池与 migration 生命周期由 drizzle-kit + 应用启动时 db:migrate 脚本负责
 *
 * 用 globalThis 缓存连接池，避免 Next.js 开发模式热重载反复建池。
 */

const connectionString =
  dbConfig.url || "mysql://build-placeholder:build-placeholder@127.0.0.1:3306/placeholder";

// S1（08-P1-5）：连接池参数可配置（原仅用连接串默认 connectionLimit=10）。
const poolOptions: mysql.PoolOptions = {
  connectionLimit: Number.parseInt(process.env.SNOW_DB_CONNECTION_LIMIT ?? "10", 10),
  waitForConnections: true,
  queueLimit: Number.parseInt(process.env.SNOW_DB_QUEUE_LIMIT ?? "100", 10),
};

const globalForDb = globalThis as unknown as {
  __snowMysqlPool?: mysql.Pool;
};

const pool =
  globalForDb.__snowMysqlPool ?? mysql.createPool({ uri: connectionString, ...poolOptions });
if (!globalForDb.__snowMysqlPool) {
  globalForDb.__snowMysqlPool = pool;
}

export const db = drizzle(pool, { schema: fullSchema, mode: "default" });

/**
 * §07.3: DB 或事务的公共查询接口类型。
 *
 * Drizzle 的 MySqlTransaction 和 MySql2Database 共享 .select()/.from()/.where()
 * 等查询构建器方法，但 TypeScript 类型系统未建立继承关系（Transaction 缺少 $client）。
 * 运行时两者完全兼容 — 所有需要事务内读取的 Reader 均应使用此类型。
 */
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
