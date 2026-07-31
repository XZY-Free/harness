import { db } from "@/lib/db/client";
import { listQuarantinedFailures } from "@/lib/v11/conversation/projection-operations";
import { getOverloadProtector } from "@/lib/v11/gateway/overload-protection";
import { getSSEConnectionQuota } from "@/lib/v11/gateway/sse-connection-quota";
/**
 * V11 服务就绪状态检查器（S12-W03）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/14-production-operations-security-and-retention.md §7.1（查询系统就绪状态）
 * - ../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md S12-W03
 *
 * 职责：
 * - 按 scope 检查真实组件状态（DB 迁移、事件投影、网关保护、Job 调度、删除）。
 * - 返回结构化 readiness 结果（overall_state + components[]），不返回 Secret/内部拓扑/敏感 payload。
 * - 用于发布门禁和运维诊断，不作为业务状态事实源。
 *
 * 关键约束：
 * - fail-closed：组件检查失败时标记为 unavailable，不伪造 ready。
 * - 只读：不修改任何状态，不产生副作用。
 * - 租户隔离：projection/job 检查按 tenantId 过滤。
 */
import { sql } from "drizzle-orm";

/** Readiness scope 类型（spec §7.1）。 */
export const READINESS_SCOPES = [
  "employee_api",
  "runtime_dispatch",
  "gateway",
  "event_projection",
  "job_scheduler",
  "deletion",
] as const;
export type ReadinessScope = (typeof READINESS_SCOPES)[number];

const READINESS_SCOPE_SET: ReadonlySet<string> = new Set(READINESS_SCOPES);

/** 判断 scope 是否合法。 */
export function isKnownReadinessScope(scope: string): scope is ReadinessScope {
  return READINESS_SCOPE_SET.has(scope);
}

/** 组件状态。 */
export type ComponentState = "ready" | "degraded" | "unavailable";

/** 单个组件检查结果。 */
export interface ReadinessComponent {
  /** 组件名称（等于 scope 或子组件名）。 */
  name: string;
  /** 组件状态。 */
  state: ComponentState;
  /** 状态原因码（如 QUARANTINED_STREAMS_PRESENT、MIGRATION_PENDING）。 */
  reason_codes: string[];
  /** 结构化指标（如 max_lag_events、quarantined_streams）。 */
  metrics: Record<string, number | string | boolean | null>;
}

/** Readiness 聚合结果。 */
export interface ReadinessResult {
  /** 整体状态：任一组件 unavailable → unavailable；任一 degraded → degraded；否则 ready。 */
  overall_state: ComponentState;
  /** 检查时间（ISO 8601 UTC）。 */
  checked_at: string;
  /** 组件列表。 */
  components: ReadinessComponent[];
}

/** Drizzle migrations 表行（内部查询用）。 */
interface DrizzleMigrationRow {
  id: number;
  hash: string;
  created_at: string;
}

/**
 * 检查数据库迁移状态。
 *
 * 查询 `__drizzle_migrations` 表是否存在且可读。
 * 失败 → unavailable（MIGRATION_TABLE_INACCESSIBLE）。
 */
async function checkDatabaseMigration(): Promise<ReadinessComponent> {
  try {
    const [rows] = (await db.execute(
      sql`SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id DESC LIMIT 1`,
    )) as unknown as [DrizzleMigrationRow[]];
    const count = Array.isArray(rows) ? rows.length : 0;
    const latest = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    return {
      name: "database_migration",
      state: count > 0 ? "ready" : "unavailable",
      reason_codes: count > 0 ? [] : ["MIGRATION_TABLE_EMPTY"],
      metrics: {
        applied_migration_count: count,
        latest_migration_id: latest?.id ?? null,
      },
    };
  } catch {
    return {
      name: "database_migration",
      state: "unavailable",
      reason_codes: ["MIGRATION_TABLE_INACCESSIBLE"],
      metrics: {},
    };
  }
}

/**
 * 检查事件投影状态（spec §7.1 示例：max_lag_events + quarantined_streams）。
 *
 * - 统计租户内 quarantined stream 数。
 * - quarantined_streams > 0 → degraded（QUARANTINED_STREAMS_PRESENT）。
 * - 查询失败 → unavailable。
 */
async function checkEventProjection(tenantId: string): Promise<ReadinessComponent> {
  try {
    const quarantined = await listQuarantinedFailures(tenantId, 500);
    const quarantinedCount = quarantined.length;
    const state: ComponentState = quarantinedCount > 0 ? "degraded" : "ready";
    return {
      name: "event_projection",
      state,
      reason_codes: quarantinedCount > 0 ? ["QUARANTINED_STREAMS_PRESENT"] : [],
      metrics: {
        quarantined_streams: quarantinedCount,
      },
    };
  } catch {
    return {
      name: "event_projection",
      state: "unavailable",
      reason_codes: ["PROJECTION_CHECK_FAILED"],
      metrics: {},
    };
  }
}

/**
 * 检查网关保护状态（过载、限流、SSE 连接配额）。
 *
 * - 过载并发达到 90%+ → degraded（OVERLOAD_NEAR_LIMIT）。
 * - 达到绝对上限 → unavailable（OVERLOAD_MAX_REACHED）。
 */
function checkGateway(): ReadinessComponent {
  try {
    const protector = getOverloadProtector();
    const config = protector.getConfig();
    const concurrent = protector.getConcurrent();
    const ratio = config.maxConcurrent > 0 ? concurrent / config.maxConcurrent : 0;

    const sseQuota = getSSEConnectionQuota();
    const sseSnapshot = sseQuota.getSnapshot();

    let state: ComponentState = "ready";
    const reasonCodes: string[] = [];

    if (ratio >= 1.0) {
      state = "unavailable";
      reasonCodes.push("OVERLOAD_MAX_REACHED");
    } else if (ratio >= 0.9) {
      state = "degraded";
      reasonCodes.push("OVERLOAD_NEAR_LIMIT");
    }

    return {
      name: "gateway",
      state,
      reason_codes: reasonCodes,
      metrics: {
        concurrent_requests: concurrent,
        max_concurrent: config.maxConcurrent,
        concurrent_ratio: Number.parseFloat(ratio.toFixed(4)),
        sse_active_tenant: sseSnapshot.totalActive.tenant,
        sse_active_user: sseSnapshot.totalActive.user,
        sse_active_thread: sseSnapshot.totalActive.thread,
      },
    };
  } catch {
    return {
      name: "gateway",
      state: "unavailable",
      reason_codes: ["GATEWAY_CHECK_FAILED"],
      metrics: {},
    };
  }
}

/**
 * 检查 Employee API 状态（数据库迁移 + 基本连通性）。
 *
 * Employee API 依赖数据库可用。迁移状态不 ready → degraded。
 */
async function checkEmployeeApi(): Promise<ReadinessComponent> {
  const migration = await checkDatabaseMigration();
  const state: ComponentState = migration.state === "ready" ? "ready" : "degraded";
  return {
    name: "employee_api",
    state,
    reason_codes: migration.reason_codes.length > 0 ? migration.reason_codes : [],
    metrics: {
      migration_state: migration.state,
    },
  };
}

/**
 * 检查 Runtime 调度状态。
 *
 * Runtime 调度依赖数据库 + 网关。任一 degraded → degraded。
 */
async function checkRuntimeDispatch(): Promise<ReadinessComponent> {
  const migration = await checkDatabaseMigration();
  const gateway = checkGateway();

  let state: ComponentState = "ready";
  const reasonCodes: string[] = [];

  if (migration.state === "unavailable" || gateway.state === "unavailable") {
    state = "unavailable";
    reasonCodes.push("RUNTIME_DISPATCH_BLOCKED");
  } else if (migration.state === "degraded" || gateway.state === "degraded") {
    state = "degraded";
    if (gateway.reason_codes.length > 0) {
      reasonCodes.push(...gateway.reason_codes);
    }
  }

  return {
    name: "runtime_dispatch",
    state,
    reason_codes: reasonCodes,
    metrics: {
      migration_state: migration.state,
      gateway_state: gateway.state,
    },
  };
}

/**
 * 检查 Job 调度器状态。
 *
 * 目前依赖数据库可用。后续可扩展为检查队列积压、调度器心跳。
 */
async function checkJobScheduler(): Promise<ReadinessComponent> {
  const migration = await checkDatabaseMigration();
  return {
    name: "job_scheduler",
    state: migration.state === "ready" ? "ready" : "degraded",
    reason_codes: migration.state !== "ready" ? migration.reason_codes : [],
    metrics: {
      migration_state: migration.state,
    },
  };
}

/**
 * 检查删除管线状态。
 *
 * S12-W07 尚未实施，删除管线为 stub 状态（ready，无活跃请求）。
 * W07 实施后扩展为检查活跃删除请求、超期请求、步骤失败率。
 */
async function checkDeletion(): Promise<ReadinessComponent> {
  return {
    name: "deletion",
    state: "ready",
    reason_codes: [],
    metrics: {
      active_requests: 0,
      overdue_requests: 0,
    },
  };
}

/**
 * 聚合多个组件状态为整体状态。
 *
 * - 任一 unavailable → unavailable
 * - 任一 degraded → degraded
 * - 全部 ready → ready
 */
function aggregateState(components: ReadinessComponent[]): ComponentState {
  if (components.some((c) => c.state === "unavailable")) return "unavailable";
  if (components.some((c) => c.state === "degraded")) return "degraded";
  return "ready";
}

/**
 * 执行 readiness 检查。
 *
 * @param tenantId 租户 ID（用于租户隔离的组件检查）
 * @param scope 可选，检查特定 scope；不传则检查全部
 * @returns readiness 聚合结果
 */
export async function checkReadiness(
  tenantId: string,
  scope?: ReadinessScope,
): Promise<ReadinessResult> {
  const components: ReadinessComponent[] = [];

  if (!scope || scope === "employee_api") {
    components.push(await checkEmployeeApi());
  }
  if (!scope || scope === "runtime_dispatch") {
    components.push(await checkRuntimeDispatch());
  }
  if (!scope || scope === "gateway") {
    components.push(checkGateway());
  }
  if (!scope || scope === "event_projection") {
    components.push(await checkEventProjection(tenantId));
  }
  if (!scope || scope === "job_scheduler") {
    components.push(await checkJobScheduler());
  }
  if (!scope || scope === "deletion") {
    components.push(await checkDeletion());
  }

  return {
    overall_state: aggregateState(components),
    checked_at: new Date().toISOString(),
    components,
  };
}
