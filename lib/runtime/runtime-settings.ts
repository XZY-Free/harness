/**
 * RuntimeSettings — Runtime 协议正式运行参数的唯一职责校验入口。
 *
 * Authority（工程包 file-plan.json foundation ADD 项）：
 *   "职责参数校验；不提供切新旧架构的 Feature Flag"
 *
 * 本模块只承载与 RuntimeProtocol（协议版本 3）执行语义直接相关的可调参数：
 * 心跳节奏、租约 TTL、调度截止、Token TTL、签名 Key ID、去重窗口、恢复轮询。
 *
 * 严格禁止：
 * - USE_NEW_*、ENABLE_V3_*、LEGACY_*、RUNTIME_PROTOCOL_VERSION_OVERRIDE 等
 *   切换新旧执行架构的 Feature Flag（§十 / §四十八 / residual-removal §14）。
 * - 直接绕过 lib/config.ts 的通用配置（本模块仅覆盖 Runtime 协议专属参数）。
 * - 缺配置默认放行：所有必填项缺失即抛错，绝不静默回退到"旧模式"。
 *
 * 使用模式（对齐 lib/config.ts 惰性 getter 与 instrumentation.register() 校验）：
 * - `runtimeSettings.<name>` 提供零副作用读取（缺失返回默认或抛错视字段而定）。
 * - `assertRuntimeSettingsValid()` 在 instrumentation register() 中调用做 fail-fast。
 * - `assertNoArchitectureFlags(env)` 静态检查环境是否含有禁止的架构切换 Flag。
 */

import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// Forbidden architecture-switch flags (§十 / §四十八 / residual-removal §14)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 环境变量名前缀黑名单。任何以此开头的 key 均视为架构切换 Feature Flag，
 * 出现即 fail-fast。SnowHarness 只允许一套正式执行架构（Canonical Runtime
 * Protocol v3），不接受运行时切换。
 */
export const FORBIDDEN_ENV_FLAG_PREFIXES = [
  "USE_NEW_",
  "ENABLE_V3_",
  "ENABLE_V2_",
  "LEGACY_",
  "COMPAT_",
  "COMPATIBILITY_",
  "DEPRECATED_",
  "FALLBACK_",
  "RUNTIME_PROTOCOL_VERSION_OVERRIDE",
  "OWNERSHIP_MODE_",
  "WORKSPACE_MODE_OVERRIDE",
  "ENVIRONMENT_MODE_OVERRIDE",
] as const;

/**
 * 精确 key 黑名单（不能通过前缀匹配覆盖的完整名称）。
 */
export const FORBIDDEN_ENV_FLAG_KEYS = [
  "USE_NEW_OWNERSHIP",
  "USE_NEW_RUNTIME",
  "USE_NEW_WORKSPACE",
  "USE_NEW_ENVIRONMENT",
  "ENABLE_V3_RUNTIME",
  "ENABLE_LEGACY_RUNTIME",
  "ENABLE_RUNTIME_V2",
  "RUNTIME_PROTOCOL_VERSION",
] as const;

/**
 * 扫描环境对象，返回全部命中的禁止 Flag。空数组表示合规。
 */
export function findForbiddenArchitectureFlags(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const hits: string[] = [];
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) continue;
    if ((FORBIDDEN_ENV_FLAG_KEYS as readonly string[]).includes(key)) {
      hits.push(key);
      continue;
    }
    for (const prefix of FORBIDDEN_ENV_FLAG_PREFIXES) {
      if (key.startsWith(prefix)) {
        hits.push(key);
        break;
      }
    }
  }
  return hits;
}

/**
 * Fail-fast：环境中含任何禁止 Flag 即抛错。
 * 由 instrumentation.register() 在启动时调用。
 */
export function assertNoArchitectureFlags(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const hits = findForbiddenArchitectureFlags(env);
  if (hits.length > 0) {
    throw new Error(
      `[runtime-settings] 检测到禁止的架构切换 Flag: ${hits.join(", ")}。SnowHarness 只有一套正式执行架构（Canonical Runtime Protocol v3），不接受 USE_NEW_* / ENABLE_V3_* / LEGACY_* 等运行时切换。`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings schema — 全部严格正整数、显式上限
// ═══════════════════════════════════════════════════════════════════════════

/** 正整数（毫秒 / 秒 / 计数）通用校验，附带上限避免溢出。 */
function positiveInt(max = Number.MAX_SAFE_INTEGER) {
  return z.number().int().positive().max(max);
}

/**
 * RuntimeSettings 严格 Schema。所有字段必填或有明确 default；
 * 不接受未知字段（.strict()），防止悄悄塞入架构切换 Flag。
 */
export const RuntimeSettingsSchema = z
  .object({
    /**
     * Runtime 任务级心跳节奏（毫秒）。默认 15_000（15 秒）。
     * §7.6：Heartbeat 只 renew 当前未过期 Owner；间隔必须 << leaseTtlMs。
     */
    heartbeatIntervalMs: positiveInt().default(15_000),

    /**
     * Ownership 租约 TTL（毫秒）。默认 60_000（60 秒）。
     * §7.6：过期后 Heartbeat 不能续租，Takeover 才能建立新 generation。
     * 必须 >= 3 * heartbeatIntervalMs 以容忍两次心跳丢失。
     */
    leaseTtlMs: positiveInt().default(60_000),

    /**
     * 平台调度截止（毫秒）。默认 300_000（5 分钟）。
     * §7.11：Transport 重试不越过 dispatchDeadline；恢复/Job 命令持久安排。
     */
    dispatchDeadlineMs: positiveInt().default(300_000),

    /**
     * 单次执行超时（毫秒）。默认 3_600_000（1 小时）。
     * 到期后由平台 Recovery 走失联判定与正式收口。
     */
    executionTimeoutMs: positiveInt().default(3_600_000),

    /**
     * WorkloadToken 有效期（毫秒）。默认 900_000（15 分钟）。
     * §7.3：Token 过期不容忍延长；Heartbeat 成功后可签发新的同代际凭据。
     */
    workloadTokenTtlMs: positiveInt().default(900_000),

    /**
     * WorkloadToken 签名 Key ID（受管配置）。必填，无默认。
     * §7.3：header Key ID 只能命中服务端已配置 Key；不接受 Token 指定算法。
     */
    workloadSigningKeyId: z.string().min(1).max(128),

    /**
     * RuntimeEventIngress 去重窗口（毫秒）。默认 86_400_000（24 小时）。
     * §7.7：Exact Replay 需匹配 eventId/sequence/payloadHash/Attempt/Ownership/
     * Epoch/Session 全部一致；窗口内保留 receipt 供重放。
     */
    ingressDeduplicationWindowMs: positiveInt().default(86_400_000),

    /**
     * 恢复 Worker 轮询节奏（毫秒）。默认 5_000（5 秒）。
     * §7.11：恢复/Job 命令最多退避 30 秒并持久安排 next* 时间。
     */
    recoveryWorkerPollIntervalMs: positiveInt().default(5_000),
  })
  .strict();

export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Env variable mapping — 全部 SNOWHARNESS_ 前缀，无短别名
// ═══════════════════════════════════════════════════════════════════════════

/** 环境变量到 RuntimeSettings 字段的唯一映射。 */
export const RUNTIME_SETTINGS_ENV_KEYS = {
  heartbeatIntervalMs: "SNOWHARNESS_RUNTIME_HEARTBEAT_INTERVAL_MS",
  leaseTtlMs: "SNOWHARNESS_RUNTIME_LEASE_TTL_MS",
  dispatchDeadlineMs: "SNOWHARNESS_RUNTIME_DISPATCH_DEADLINE_MS",
  executionTimeoutMs: "SNOWHARNESS_RUNTIME_EXECUTION_TIMEOUT_MS",
  workloadTokenTtlMs: "SNOWHARNESS_WORKLOAD_TOKEN_TTL_MS",
  workloadSigningKeyId: "WORKLOAD_SIGNING_KEY_ID",
  ingressDeduplicationWindowMs: "SNOWHARNESS_RUNTIME_INGRESS_DEDUP_WINDOW_MS",
  recoveryWorkerPollIntervalMs: "SNOWHARNESS_RUNTIME_RECOVERY_POLL_INTERVAL_MS",
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Loader
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从环境对象加载 RuntimeSettings。缺失字段走 Schema default；
 * workloadSigningKeyId 无 default，缺失即抛错（§7.3 fail-closed）。
 *
 * 严格解析（非 int / 负数 / 未知字段）均抛 zod 错误。
 */
export function loadRuntimeSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeSettings {
  const raw: Record<string, unknown> = {};
  for (const [field, envKey] of Object.entries(RUNTIME_SETTINGS_ENV_KEYS)) {
    const value = env[envKey];
    if (value === undefined || value === "") continue;
    if (field === "workloadSigningKeyId") {
      raw[field] = value;
      continue;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error(`[runtime-settings] ${envKey} 必须是整数毫秒，收到 "${value}"`);
    }
    raw[field] = parsed;
  }
  const result = RuntimeSettingsSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `[runtime-settings] 参数校验失败: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/**
 * 跨字段不变量校验：
 * - leaseTtlMs >= 3 * heartbeatIntervalMs（容忍两次心跳丢失）
 * - workloadTokenTtlMs >= heartbeatIntervalMs（Token 至少要能撑过一次心跳）
 * - dispatchDeadlineMs <= executionTimeoutMs（调度截止不能晚于执行超时）
 * - recoveryWorkerPollIntervalMs <= leaseTtlMs（恢复轮询必须比租约更频繁）
 *
 * 违反即抛错；不提供"放宽一点也行"的降级路径。
 */
export function assertRuntimeSettingsInvariants(settings: RuntimeSettings): void {
  const violations: string[] = [];
  if (settings.leaseTtlMs < 3 * settings.heartbeatIntervalMs) {
    violations.push(
      `leaseTtlMs (${settings.leaseTtlMs}) 必须 >= 3 * heartbeatIntervalMs (${3 * settings.heartbeatIntervalMs})`,
    );
  }
  if (settings.workloadTokenTtlMs < settings.heartbeatIntervalMs) {
    violations.push(
      `workloadTokenTtlMs (${settings.workloadTokenTtlMs}) 必须 >= heartbeatIntervalMs (${settings.heartbeatIntervalMs})`,
    );
  }
  if (settings.dispatchDeadlineMs > settings.executionTimeoutMs) {
    violations.push(
      `dispatchDeadlineMs (${settings.dispatchDeadlineMs}) 必须 <= executionTimeoutMs (${settings.executionTimeoutMs})`,
    );
  }
  if (settings.recoveryWorkerPollIntervalMs > settings.leaseTtlMs) {
    violations.push(
      `recoveryWorkerPollIntervalMs (${settings.recoveryWorkerPollIntervalMs}) 必须 <= leaseTtlMs (${settings.leaseTtlMs})`,
    );
  }
  if (violations.length > 0) {
    throw new Error(`[runtime-settings] 跨字段不变量违反: ${violations.join("; ")}`);
  }
}

/**
 * 完整启动校验（instrumentation.register() 唯一入口）：
 * 1. 环境中不得含禁止的架构切换 Flag
 * 2. RuntimeSettings 结构与类型合法
 * 3. 跨字段不变量成立
 *
 * 任一失败即抛错，进程不启动。不存在"降级为旧模式"路径。
 */
export function assertRuntimeSettingsValid(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeSettings {
  assertNoArchitectureFlags(env);
  const settings = loadRuntimeSettings(env);
  assertRuntimeSettingsInvariants(settings);
  return settings;
}
