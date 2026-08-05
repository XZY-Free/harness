import * as controlPlaneOutboxSchema from "@/lib/control-plane/events/control-plane-outbox";
import * as artifactRecordSchema from "@/lib/artifacts/persistence/artifact-record";
import { dbConfig } from "@/lib/config";
import * as publicationRecordSchema from "@/lib/publications/persistence/publication-record";
import * as routeRevisionSchema from "@/lib/routes/persistence/route-revision-record";
import * as runtimeConformanceRunSchema from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import * as v11AdminExportSchema from "@/lib/v11/schema/admin-export";
import * as v11AgentSchema from "@/lib/v11/schema/agent";
import * as v11AuditSchema from "@/lib/v11/schema/audit";
import * as v11AuthorizationSchema from "@/lib/v11/schema/authorization";
import * as v11DeploymentRouteSchema from "@/lib/v11/schema/deployment-route";
import * as v11DeviceSchema from "@/lib/v11/schema/device";
import * as v11EffectSchema from "@/lib/v11/schema/effect";
import * as v11EnvironmentSchema from "@/lib/v11/schema/environment";
import * as v11EvaluationSchema from "@/lib/v11/schema/evaluation";
import * as v11FileChangeSchema from "@/lib/v11/schema/file-change";
import * as v11FilesystemCheckpointSchema from "@/lib/v11/schema/filesystem-checkpoint";
import * as v11IdempotencySchema from "@/lib/v11/schema/idempotency";
import * as v11IdentitySchema from "@/lib/v11/schema/identity";
import * as v11PermissionSchema from "@/lib/v11/schema/permission";
import * as v11RecoveryDrillSchema from "@/lib/v11/schema/recovery-drill";
import * as v11RuntimeSchema from "@/lib/v11/schema/runtime";
import * as v11RuntimeArtifactSchema from "@/lib/v11/schema/runtime-artifact";
import * as v11SecurityIncidentSchema from "@/lib/v11/schema/security-incident";
import * as v11TraceSchema from "@/lib/v11/schema/trace";
import * as v11UsageSchema from "@/lib/v11/schema/usage";
import * as v11UserActionRequestSchema from "@/lib/v11/schema/user-action-request";
import * as v11WorkspaceSchema from "@/lib/v11/schema/workspace";
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
  ...v11IdentitySchema,
  ...v11DeviceSchema,
  ...v11AuthorizationSchema,
  ...v11IdempotencySchema,
  ...v11AuditSchema,
  ...v11AdminExportSchema,
  ...v11AgentSchema,
  ...v11RuntimeSchema,
  ...v11DeploymentRouteSchema,
  ...v11WorkspaceSchema,
  ...v11EnvironmentSchema,
  ...v11PermissionSchema,
  ...v11UserActionRequestSchema,
  ...v11EffectSchema,
  ...v11RuntimeArtifactSchema,
  ...v11FileChangeSchema,
  ...v11FilesystemCheckpointSchema,
  ...v11TraceSchema,
  ...v11EvaluationSchema,
  ...v11UsageSchema,
  ...v11RecoveryDrillSchema,
  ...v11SecurityIncidentSchema,
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
