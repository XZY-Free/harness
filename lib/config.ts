/**
 * 集中化配置模块 — 环境感知、类型安全。
 *
 * 设计原则：
 * 1. 用 APP_ENV 区分部署环境（development / test / production），与 NODE_ENV 解耦——
 *    NODE_ENV 由 Next.js 控制构建优化，且无法区分 test / production 部署（两者 NODE_ENV 均为 production）。
 * 2. 本模块【零副作用、零文件系统依赖】：不读文件、不校验、不抛错、不打日志，也不 import node:fs。
 *    —— next build 的 "collect page data" 会 import 服务端模块并执行其顶层；顶层若读文件 / 校验会让
 *       build 无谓失败，而 import node:fs + 动态 process.cwd() 还会触发 Turbopack 文件追踪（NFT）警告。
 *    文件加载逻辑因此独立到 lib/env-loader.ts（仅 instrumentation 引用）。
 * 3. 环境文件加载、必填校验、启动日志统一在 instrumentation.ts 的 register() 中完成
 *    （仅运行时、仅 nodejs runtime）。
 * 4. 配置项惰性求值（getter）：缺失的必填项返回空串而非抛错；真正的 fail-fast 由 register() 负责。
 * 5. 下游模块只读本模块导出的配置，禁止直接读 process.env。
 */

// ─── 环境识别 ───────────────────────────────────────────

export type AppEnv = "development" | "test" | "production";

const ENV_ALIASES: Record<string, AppEnv> = {
  dev: "development",
  prod: "production",
};

function resolveAppEnv(): AppEnv {
  const raw = process.env.APP_ENV || process.env.NODE_ENV || "development";
  const normalized = ENV_ALIASES[raw] ?? raw;
  if (normalized !== "development" && normalized !== "test" && normalized !== "production") {
    throw new Error(
      `[config] 无效的 APP_ENV="${raw}"，可选值：development | test | production（别名 dev / prod）`,
    );
  }
  return normalized as AppEnv;
}

/**
 * 当前部署环境（与 NODE_ENV 解耦）。
 * 仅在 APP_ENV 取非法值时抛错——build / 运行时 APP_ENV 总是合法，故对 build 安全。
 */
export const APP_ENV: AppEnv = resolveAppEnv();

// ─── 配置访问（惰性 getter：缺失必填项返回空串，不在此抛错）─────────────

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * X50 修复：统一布尔环境变量解析。
 *
 * 接受 true/false/1/0/yes/no/on/off（大小写不敏感），其余值回退到 fallback。
 * 避免各处 `=== "true"` 导致 `1`/`TRUE`/`yes` 误判为 false 的部署坑。
 */
function parseBooleanEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

export const dbConfig = {
  /** MySQL 连接串。缺失时返回空串——由 assertRuntimeConfig() 在运行时 fail-fast。 */
  get url(): string {
    return process.env.DATABASE_URL ?? "";
  },
  /**
   * P2 修复（08 DB P2-4）：已结束 thread 明细数据保留天数。
   * 超过此天数的已结束(idle/ready_for_review/failed/cancelled/completed)thread 的
   * 明细(threadEvent/toolRun/contextSnapshot/contextSummary)可被 purgeExpiredThreadDetails
   * 清理,避免表无限膨胀。thread 主记录保留(历史列表可见)。
   * 默认 90 天;0 表示禁用清理(保留所有数据,仅排查用)。
   */
  get retentionDays(): number {
    const n = Number.parseInt(optionalEnv("SNOW_DB_RETENTION_DAYS", "90"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 90;
  },
  /**
   * S1（08-P2-5）：ContextSnapshot 独立短保留期。
   *
   * 用户已决策保留全量 + 收紧 retention(不做分区/增量)。ContextSnapshot 每轮模型调用都落一行,
   * 体积远大于 threadEvent/toolRun,90 天保留下表膨胀严重。给它独立的、更短的保留期(默认 7 天),
   * cleanupOldSnapshots 用这个值;其他表仍用 retentionDays(90)。
   * 0 表示禁用 snapshot 清理(保留全部,仅排查用)。
   */
  get snapshotRetentionDays(): number {
    const n = Number.parseInt(optionalEnv("SNOW_DB_SNAPSHOT_RETENTION_DAYS", "7"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 7;
  },
  /**
   * S1（08-P1-2）：已软删 thread 主记录的物理删除阈值(天)。
   *
   * purgeExpiredThreadDetails 先清明细(retentionDays),主记录默认永久保留(软删可见于历史列表)。
   * 设此阈值后,软删(deletedAt 非空)且超过阈值天数的 thread 主记录由 deleteThreadRecursive 物理删除,
   * 形成软删 →(阈值天)→ 物理删闭环。
   * 默认 0 = 禁用(主记录永久保留,仅 admin 显式彻底删除入口可物理删);仅长周期生产按需开启。
   */
  get hardDeleteRetentionDays(): number {
    const n = Number.parseInt(optionalEnv("SNOW_DB_HARD_DELETE_DAYS", "0"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  },
} as const;

/** 可信 Runtime Conformance Runner 回传报告的 HMAC 验签配置。缺失时 fail-closed。 */
export const runtimeConformanceConfig = {
  get signingSecret(): string {
    return process.env.SNOW_RUNTIME_CONFORMANCE_SIGNING_SECRET ?? "";
  },
} as const;

/** Hosted 制品证明与独立 Conformance Runner 的受管服务配置。 */
export const hostedControlPlaneConfig = {
  get endpoint(): string {
    return optionalEnv("SNOW_HOSTED_EVIDENCE_SERVICE_URL", "").replace(/\/$/, "");
  },
  get token(): string {
    return process.env.SNOW_HOSTED_EVIDENCE_SERVICE_TOKEN ?? "";
  },
  get builderKeys(): Record<string, string> {
    const raw = optionalEnv("SNOW_HOSTED_BUILDER_KEYS_JSON", "");
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  },
  get timeoutMs(): number {
    const value = Number.parseInt(optionalEnv("SNOW_HOSTED_EVIDENCE_TIMEOUT_MS", "30000"), 10);
    return Number.isFinite(value) && value > 0 ? value : 30_000;
  },
} as const;

export const aiConfig = {
  /** OpenAI 兼容端点 API 密钥。缺失返回空串，运行时校验。 */
  get apiKey(): string {
    return process.env.LLM_API_KEY ?? "";
  },
  /** OpenAI 兼容端点 base URL。 */
  get baseUrl(): string {
    return optionalEnv("LLM_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1");
  },
  /** 主聊天 / 代码生成默认模型。 */
  get chatModel(): string {
    return optionalEnv("SNOW_CHAT_MODEL", "glm-5.2");
  },
  /**
   * OpenAI-compatible reasoning effort。空值表示按模型选择安全默认：
   * GLM-5 系列使用 minimal，其他模型不发送该参数。
   */
  get reasoningEffort(): string {
    return optionalEnv("SNOW_REASONING_EFFORT", "").trim();
  },
  /**
   * P1 修复（01 AI Core P1-2 完整化）：LLM fallback endpoints。
   * 主 endpoint(LLM_BASE_URL)连续失败熔断后,切这些备用 endpoint。
   * env SNOW_LLM_FALLBACK_BASEURLS 逗号分隔,默认空(单 endpoint,仅 maxRetries 重试)。
   * 每个 fallback 共用同一 LLM_API_KEY(OpenAI 兼容端点惯例)。
   */
  get fallbackBaseUrls(): string[] {
    const raw = optionalEnv("SNOW_LLM_FALLBACK_BASEURLS", "");
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },
  /**
   * P1 修复（01 AI Core P1-9）：streamText 单步生成输出 token 上限。
   * 原实现未传 maxOutputTokens,单步生成无界,模型若陷入重复/长跑会耗尽预算。
   * 默认 16384：足够单次文件工具参数，同时避免模型在调用工具前长时间生成 reasoning。
   * stopWhen stepCountIs(24) 仍限制总步数。
   * 0 表示不限制(保留旧行为,仅用于排查)。
   */
  get maxOutputTokens(): number {
    const n = Number.parseInt(optionalEnv("SNOW_MAX_OUTPUT_TOKENS", "16384"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 16384;
  },
} as const;

/**
 * S1 修复（01-P1-8）：模型列表过滤配置。
 *
 * - `allowlist`：显式白名单（CHAT_MODEL_ALLOWLIST，逗号分隔）。设了就**只**放行白名单内模型
 *   （+ 当前 chatModel），不再走子串猜测——最精确，新增模型类别零误判。默认空（退回黑名单）。
 * - `denySubstrings`：子串黑名单（CHAT_MODEL_DENY_SUBSTRINGS，逗号分隔），默认含
 *   image/tts/asr/embedding/vl/语音/翻译/数学等已知非对话子串。allowlist 为空时生效。
 */
export const modelFilterConfig = {
  get allowlist(): string[] {
    return optionalEnv("CHAT_MODEL_ALLOWLIST", "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },
  get denySubstrings(): string[] {
    return optionalEnv("CHAT_MODEL_DENY_SUBSTRINGS", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  },
} as const;

/**
 * S1 修复（01-P2-7）：工具超时统一配置。
 *
 * - `defaultMs`：execute 类工具未在元数据声明 defaultTimeoutMs 时的全局默认（30s）。
 * - `maxMs`：所有工具超时硬上限（5min），resolveToolTimeoutMs 取 min(caller, default, max)，
 *   防单个工具超时配置过大拖垮 thread-runner reaper（5min）。
 */
export const toolTimeoutConfig = {
  get defaultMs(): number {
    return Number.parseInt(optionalEnv("SNOW_TOOL_TIMEOUT_DEFAULT_MS", "30000"), 10);
  },
  get maxMs(): number {
    return Number.parseInt(optionalEnv("SNOW_TOOL_TIMEOUT_MAX_MS", "300000"), 10);
  },
} as const;

/**
 * S1 修复（02-P1-2）：host exec 沙箱配置（Linux bubblewrap）。
 *
 * - `mode`：off（默认，开发信任环境）/ on（强制开启，bwrap 不可用则 fail-open 原样执行）/ auto（bwrap 可用则开启）。
 *   默认 off：host 模式为开发环境，且 bwrap 对任意命令并非 100% 兼容；运维需硬隔离时显式开启。
 */
export const hostSandboxConfig = {
  get mode(): "off" | "on" | "auto" {
    const raw = optionalEnv("SNOW_HOST_SANDBOX", "off");
    return raw === "on" || raw === "auto" ? raw : "off";
  },
} as const;

export const workspaceConfig = {
  /** 工作区文件根目录。 */
  get root(): string {
    return optionalEnv("SNOW_WORKSPACES_DIR", "workspaces");
  },
} as const;

/**
 * Skill 目录仓库根（Phase 4-4 后续切片）。
 *
 * skill 不再是 DB 里一段 promptTemplate 文本，而是磁盘上的标准 Agent Skills 目录：
 * `<root>/<name>/SKILL.md` + 任意支持文件；<root> 整体是一个独立 git 仓库，
 * 版本快照 = git commit（SkillVersion.commitSha 指向）。范式同 workspaces/，父项目 gitignore 排除。
 */
export const skillsConfig = {
  /** skill 目录仓库根目录。 */
  get root(): string {
    return optionalEnv("SNOW_SKILLS_DIR", "skills");
  },
} as const;

/**
 * capability-market 同步源配置（02 文档 §八）。
 *
 * capability-market 仅作为后台手动同步的上游来源,运行时（chat / resolver / tools /
 * thread-runner）不访问。配置缺失时同步 API 明确失败,运行时不受影响。
 *
 * endpoint 语义：`SNOW_CAPABILITY_MARKET_ENDPOINT` 是 **API base**（如
 * `http://localhost:3000/api`），同步客户端在此后追加 `/capabilities` 等子路径。
 * 请勿含尾斜杠,避免出现 `//capabilities`。
 */
export const capabilityMarketConfig = {
  /** capability-market API base（同步入口必填，缺失则同步 API 失败）。 */
  get endpoint(): string {
    return optionalEnv("SNOW_CAPABILITY_MARKET_ENDPOINT", "");
  },
  /** 同步用 Bearer token。 */
  get token(): string | null {
    return process.env.SNOW_CAPABILITY_MARKET_TOKEN ?? null;
  },
  /** 同步请求超时（ms，默认 10000；artifact 下载单独按流式超时保护）。 */
  get timeoutMs(): number {
    return Number.parseInt(optionalEnv("SNOW_CAPABILITY_MARKET_TIMEOUT_MS", "10000"), 10) || 10000;
  },
} as const;

/**
 * 认证配置（Phase 4-3）。
 *
 * 采用 trusted-headers 作为公司 SSO 的稳定接入边界：生产由公司网关 / SSO 代理注入
 * 用户 header，应用只消费已认证身份；开发 / 测试保留 dev fallback。
 * 协议未知时不引入 OAuth / OIDC / SAML 依赖。
 */
export const authConfig = {
  /** 认证模式：dev（默认用户）/ trusted-headers（可信网关注入）。生产默认 trusted-headers。 */
  get mode(): "dev" | "trusted-headers" {
    const fallback = appConfig.isProd ? "trusted-headers" : "dev";
    const raw = optionalEnv("SNOW_AUTH_MODE", fallback);
    if (raw !== "dev" && raw !== "trusted-headers") {
      throw new Error(`[config] 无效的 SNOW_AUTH_MODE="${raw}"`);
    }
    return raw;
  },
  /** 注入 externalId 的 header 名（小写）。 */
  get externalIdHeader(): string {
    return optionalEnv("SNOW_AUTH_HEADER_EXTERNAL_ID", "x-snow-user-id").toLowerCase();
  },
  /** 注入 email 的 header 名（小写）。 */
  get emailHeader(): string {
    return optionalEnv("SNOW_AUTH_HEADER_EMAIL", "x-snow-user-email").toLowerCase();
  },
  /** 注入显示名的 header 名（小写）。 */
  get nameHeader(): string {
    return optionalEnv("SNOW_AUTH_HEADER_NAME", "x-snow-user-name").toLowerCase();
  },
} as const;

/**
 * 审批 scope 配置。
 *
 * session scope（07-P1-6）：同 thread 短 TTL 复用，区别于 thread 的 24h。
 * TTL 在决议（resolve）时写入 expiresAt，过期后引擎 isApprovalExpired 自动过滤，
 * findMatchingApprovals 查询的 `expiresAt > now` 条件同步失效。
 */
export const approvalConfig = {
  /** session scope 批准后的有效时长（ms），默认 30min。 */
  get sessionTtlMs(): number {
    const n = Number.parseInt(optionalEnv("SNOW_APPROVAL_SESSION_TTL_MS", "1800000"), 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("[config] 无效的 SNOW_APPROVAL_SESSION_TTL_MS");
    }
    return n;
  },
} as const;

export const appConfig = {
  /** 当前部署环境。 */
  env: APP_ENV,
  /** 是否开发环境。 */
  isDev: APP_ENV === "development",
  /** 是否测试环境。 */
  isTest: APP_ENV === "test",
  /** 是否生产环境。 */
  isProd: APP_ENV === "production",
  /** 服务端口。 */
  get port(): number {
    return Number.parseInt(optionalEnv("PORT", "3000"), 10);
  },
  /** 监听地址。 */
  get host(): string {
    return optionalEnv("HOSTNAME", "0.0.0.0");
  },
} as const;

/**
 * Agent Studio 后台配置（Phase 4-4）。
 *
 * `devOpen`：dev/test 下默认用户（DEFAULT_USER_ID）是否自动获得 admin 直进 /studio，
 * 兼容本地与既有测试（零回归）。生产**强制 false**——生产用户角色必须由 UserRole 表决定，
 * 无角色 = 无 studio 权限 → /studio 返回 403。
 */
export const studioConfig = {
  get devOpen(): boolean {
    return appConfig.isProd ? false : optionalEnv("SNOW_STUDIO_OPEN", "true") === "true";
  },
} as const;

/**
 * 运行时隔离配置（Phase 5）。
 *
 * - `defaultType`：全局默认 runtimeType（host / container）。默认 host 零回归；
 *   container 由 skill / 显式配置开启（解析优先级：thread.runtimeType → skill → 本默认）。
 * - docker 可用性由 `lib/runtime/container/availability.ts` 探测缓存（不在 config，因 config 零副作用）；
 *   defaultType=container 但 docker 不可用 → 默认 fail-closed；仅显式开启降级时回退 host。
 * - `idleTtlMs`：容器空闲回收 TTL（默认 10min）。
 * - `portRange`：容器 port mapping 分配区间。
 * - `runtimeImage` / `memoryLimit` / `cpus`：容器镜像与资源限制。
 */
export type RuntimeType = "host" | "container";

export const runtimeConfig = {
  get defaultType(): RuntimeType {
    const isProd = optionalEnv("NODE_ENV", "development") === "production";
    const raw = optionalEnv("RUNTIME_DEFAULT", isProd ? "container" : "host");
    if (raw !== "host" && raw !== "container") {
      throw new Error(`[config] 无效的 RUNTIME_DEFAULT="${raw}"，可选值：host | container`);
    }
    return raw;
  },
  get idleTtlMs(): number {
    return Number.parseInt(optionalEnv("SNOW_RUNTIME_IDLE_TTL_MS", "600000"), 10);
  },
  get portRangeStart(): number {
    return Number.parseInt(optionalEnv("SNOW_RUNTIME_PORT_START", "41000"), 10);
  },
  get portRangeEnd(): number {
    return Number.parseInt(optionalEnv("SNOW_RUNTIME_PORT_END", "41999"), 10);
  },
  get runtimeImage(): string {
    return optionalEnv("SNOW_RUNTIME_IMAGE", "snow-harness-runtime:node22");
  },
  get memoryLimit(): string {
    return optionalEnv("SNOW_RUNTIME_MEMORY", "1g");
  },
  get cpus(): string {
    return optionalEnv("SNOW_RUNTIME_CPUS", "1.0");
  },
  get readyTimeoutMs(): number {
    return Number.parseInt(optionalEnv("SNOW_PREVIEW_READY_TIMEOUT_MS", "30000"), 10);
  },
  get degradeOnDockerUnavailable(): boolean {
    const isProd = optionalEnv("NODE_ENV", "development") === "production";
    return (
      optionalEnv("RUNTIME_DEGRADE_ON_DOCKER_UNAVAILABLE", isProd ? "false" : "true") === "true"
    );
  },
} as const;

/**
 * V3.8：资源配额配置（per-thread 覆盖只能收紧不能放宽）。
 *
 * - `cpu` / `memory`：container 模式 docker `--cpus` / `--memory` 硬配额；
 *   host 模式 soft limit + 诚实标注 `quotaEnforced=false`。
 * - `timeoutMs`：命令超时上限（默认 60s）。
 * - `logCapBytes`：日志体积上限（默认 1MB）。与既有 MAX_OUTPUT(10000 字符)取 min。
 *
 * 默认值继承 `runtimeConfig`（memoryLimit/cpus），可通过 env 单独覆盖全局默认。
 * per-thread 覆盖由 `resolveQuota` 合并（只能收紧）。
 */
export const quotaConfig = {
  get cpu(): string {
    return optionalEnv("RUNTIME_QUOTA_CPU", runtimeConfig.cpus);
  },
  get memory(): string {
    return optionalEnv("RUNTIME_QUOTA_MEMORY", runtimeConfig.memoryLimit);
  },
  get timeoutMs(): number {
    return Number.parseInt(optionalEnv("RUNTIME_QUOTA_TIMEOUT_MS", "60000"), 10);
  },
  get logCapBytes(): number {
    return Number.parseInt(optionalEnv("RUNTIME_QUOTA_LOG_CAP_BYTES", String(1024 * 1024)), 10);
  },
  /** S1（04-G2）：进程数上限。container --pids-limit / host Linux prlimit --nproc。0=不限。 */
  get pidsLimit(): number {
    return Number.parseInt(optionalEnv("RUNTIME_QUOTA_PIDS_LIMIT", "256"), 10);
  },
  /** S1（04-G2）：文件描述符上限。container --ulimit nofile / host Linux prlimit --nofile。0=不限。 */
  get openFilesLimit(): number {
    return Number.parseInt(optionalEnv("RUNTIME_QUOTA_OPEN_FILES_LIMIT", "1024"), 10);
  },
  /** S1（02-P1-6）：容器 rootfs 磁盘配额（bytes）。docker --storage-opt size=。0=不限。 */
  get diskQuotaBytes(): number {
    return Number.parseInt(optionalEnv("RUNTIME_QUOTA_DISK_BYTES", "0"), 10);
  },
} as const;

/**
 * S1（04-G2 真隔离）：子代理专属资源配额覆盖（只能比父 thread 收紧）。
 *
 * 现状（修复前）：buildSubagentTools 直接复用父 thread 的 runtime/quota，子代理 runCommand/runTests
 * 用父 quota，无独立资源约束，单子代理可耗尽父进程资源。
 *
 * 修复：buildSubagentTools 传本配置作为 resolveRuntimes 的 quotaOverride，构造子代理专属
 * execution runtime 实例（独立 quota）。host 模式下 exec 命令经 wrapWithHostRlimits(command, 子代理 quota)
 * 施加独立 prlimit（pids/nofile 硬限），与父进程隔离；container 模式子代理复用父 container
 * （cgroup 限额在容器启动时已定，子代理在其内受父 container 限额约束 + HEAVY_COMMAND_TOOLS 互斥）。
 *
 * 默认值比 quotaConfig 收紧一档（pids 128/nofile 512/timeout 30s/log 512KB），经 resolveQuota
 * 的 tightenQuota 合并，无法放宽父配额。
 */
export const subagentQuotaConfig = {
  get pidsLimit(): number {
    return Number.parseInt(optionalEnv("SNOW_SUBAGENT_QUOTA_PIDS_LIMIT", "128"), 10);
  },
  get openFilesLimit(): number {
    return Number.parseInt(optionalEnv("SNOW_SUBAGENT_QUOTA_OPEN_FILES_LIMIT", "512"), 10);
  },
  get timeoutMs(): number {
    return Number.parseInt(optionalEnv("SNOW_SUBAGENT_QUOTA_TIMEOUT_MS", "30000"), 10);
  },
  get logCapBytes(): number {
    return Number.parseInt(
      optionalEnv("SNOW_SUBAGENT_QUOTA_LOG_CAP_BYTES", String(512 * 1024)),
      10,
    );
  },
} as const;

/**
 * V3.8：网络策略配置（per-thread 可覆盖）。
 *
 * S1 修复（02-P0-2，方案 B）：删除 `allowlist` 模式，只留 `disabled | open`。
 * 原 allowlist 与 disabled 等价却谎报"白名单模式"，契约不兑现；生产默认改为 `disabled`
 * （最安全，需出网的 thread 显式配 `open`）。域名级放行由 host 侧平台工具的 domainAllowlist 负责。
 *
 * - `default`：全局默认网络策略（disabled/open）。开发默认 open，生产默认 disabled。
 *   host 模式恒为 open + `networkPolicyEnforced=false`（诚实标注，不伪装）；
 *   container 模式按策略实际执行 egress 治理（Stage B 实现）。
 */
export const networkPolicyConfig = {
  get default(): "disabled" | "open" {
    const isProd = optionalEnv("NODE_ENV", "development") === "production";
    const raw = optionalEnv("RUNTIME_NETWORK_POLICY", isProd ? "disabled" : "open");
    if (raw !== "disabled" && raw !== "open") {
      throw new Error(`[config] 无效的 RUNTIME_NETWORK_POLICY="${raw}"，可选值：disabled | open`);
    }
    return raw;
  },
} as const;

/**
 * V3.8：Secret mount 配置。
 *
 * - `masterKey`：AES-256-GCM 平台 master key（来自 env/secret manager）。
 *   缺失时 secretMount fail-closed（拒绝启用，不明文回退）。
 * - `keyId`：当前 master key 的标识符（用于密文记录加密用 key，支持后续 key 轮换）。
 */
export const secretConfig = {
  get masterKey(): string {
    return process.env.SECRET_MASTER_KEY ?? "";
  },
  get keyId(): string {
    return optionalEnv("SECRET_MASTER_KEY_ID", "default");
  },
} as const;

/**
 * V3.8：部署配置（CI/CD webhook 交接）。
 *
 * - `cicdWebhookUrl`：CI/CD 部署 webhook URL。空 → 部署工具明确错误（不静默失败）。
 * - `cicdStatusUrl`：CI/CD job 状态查询 URL（{jobId} 占位符）。
 * - `cicdApiToken`：CI/CD webhook 鉴权 token（secret，可存 SecretMount）。
 * - `environments`：允许的 environment 列表（逗号分隔，默认 staging,prod）。
 * - `timeoutMs`：webhook 请求超时（默认 30s）。
 * - `maxRetries`：失败重试次数（默认 3）。
 */
export const deployConfig = {
  get cicdWebhookUrl(): string {
    return optionalEnv("DEPLOY_CICD_WEBHOOK_URL", "");
  },
  get cicdStatusUrl(): string {
    return optionalEnv("DEPLOY_CICD_STATUS_URL", "");
  },
  get cicdApiToken(): string {
    return process.env.DEPLOY_CICD_API_TOKEN ?? "";
  },
  get environments(): string[] {
    return optionalEnv("DEPLOY_ENVIRONMENTS", "staging,prod")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },
  get timeoutMs(): number {
    return Number.parseInt(optionalEnv("DEPLOY_TIMEOUT_MS", "30000"), 10);
  },
  get maxRetries(): number {
    return Number.parseInt(optionalEnv("DEPLOY_MAX_RETRIES", "3"), 10);
  },
} as const;

/**
 * 后台任务配置（V3.2 命令治理）。
 *
 * - `idleTtlMs`：后台任务空闲回收 TTL（默认对齐容器 10min）。日志最后写入时间超 TTL → stop(reason=idle)。
 * - `maxLogReadBytes`：readTaskLogs 单次读取上限（默认 64KB），避免把全量日志塞进模型上下文。
 * - `hostLogDir`：host 模式日志平台目录（非用户 workspace）；container 模式日志落 workspace bind mount，
 *   不受此项影响。默认 `.snow/runtime`（相对 cwd，已加入 .gitignore）。
 */
export const backgroundTaskConfig = {
  get idleTtlMs(): number {
    return Number.parseInt(
      optionalEnv("SNOW_BG_TASK_IDLE_TTL_MS", String(runtimeConfig.idleTtlMs)),
      10,
    );
  },
  get maxLogReadBytes(): number {
    return Number.parseInt(optionalEnv("SNOW_BG_TASK_MAX_LOG_BYTES", String(64 * 1024)), 10);
  },
  get hostLogDir(): string {
    return optionalEnv("SNOW_BG_TASK_HOST_LOG_DIR", ".snow/runtime");
  },
  /** S1（02-P1-7）：单日志文件大小上限（bytes），超限轮转（保留尾部一半）。0=不轮转。默认 10MB。 */
  get maxLogFileSize(): number {
    return Number.parseInt(
      optionalEnv("SNOW_BG_TASK_MAX_LOG_FILE_SIZE", String(10 * 1024 * 1024)),
      10,
    );
  },
} as const;

/**
 * 长期记忆配置（V3.3b Stage B）。
 *
 * - `embeddingsEnabled`：semantic index 开关。非 test 默认 true，test 默认 false（显式 set 覆盖）；
 *   disabled 时 retrieve lexical fallback + semanticStatus=disabled（manifest/UI 可观测，不静默伪装）。
 * - `embeddingModel`：embedding 模型 id（OpenAI-compatible）。空串 → semanticStatus=disabled，
 *   **绝不偷偷复用 chat model**（计划 §1 决策）。部署时通过 MEMORY_EMBEDDING_MODEL 注入。
 * - `embeddingDimension`：向量维度。0 表示首次写入记录实际维度（不校验）；非 0 时校验 provider 返回维度。
 * - `retrievalLimit`：单轮注入记忆上限（默认 5，蓝图 §6.1「少量注入」）。
 * - `candidateLimit`：lexical 候选上限（默认 50），semantic 只 rerank 候选。
 *
 * 全部惰性求值、零副作用（不在 import 时校验），与 config 模块既有原则一致。
 */
export const memoryConfig = {
  get embeddingsEnabled(): boolean {
    const fallback = appConfig.isTest ? "false" : "true";
    return optionalEnv("MEMORY_EMBEDDINGS_ENABLED", fallback) === "true";
  },
  get embeddingModel(): string {
    return optionalEnv("MEMORY_EMBEDDING_MODEL", "");
  },
  get embeddingDimension(): number {
    return Number.parseInt(optionalEnv("MEMORY_EMBEDDING_DIMENSION", "0"), 10);
  },
  get retrievalLimit(): number {
    return Number.parseInt(optionalEnv("MEMORY_RETRIEVAL_LIMIT", "5"), 10);
  },
  get candidateLimit(): number {
    return Number.parseInt(optionalEnv("MEMORY_RETRIEVAL_CANDIDATE_LIMIT", "50"), 10);
  },
  /** S1（06-P2-7）：scope 权重（JSON env 覆盖）。默认 user1.0/project0.8/thread0.6/skill0.5。 */
  get scopeWeights(): Record<string, number> {
    const raw = optionalEnv("MEMORY_SCOPE_WEIGHTS", "");
    if (!raw) return { user: 1.0, project: 0.8, thread: 0.6, skill: 0.5 };
    try {
      return JSON.parse(raw) as Record<string, number>;
    } catch {
      return { user: 1.0, project: 0.8, thread: 0.6, skill: 0.5 };
    }
  },
  /** S1（06-P2-7）：confidence 权重（JSON env 覆盖）。默认 low0.4/medium0.7/high1.0。 */
  get confidenceWeights(): Record<string, number> {
    const raw = optionalEnv("MEMORY_CONFIDENCE_WEIGHTS", "");
    if (!raw) return { low: 0.4, medium: 0.7, high: 1.0 };
    try {
      return JSON.parse(raw) as Record<string, number>;
    } catch {
      return { low: 0.4, medium: 0.7, high: 1.0 };
    }
  },
} as const;

/**
 * 上下文压缩配置（V3.3a）。
 *
 * - `contextWindowByModel`：per-model 上下文窗口（token）。默认空 → `resolveTokenBudget`
 *   返回 `Infinity` → 永不压缩 → 零回归。部署时通过 `SNOW_CONTEXT_WINDOWS`（JSON map）
 *   注入，例如 `{"kimi-k2.7-code": 131072}`。解析失败回退空 map（不抛错，保持零副作用）。
 * - `budgetThreshold`：触发压缩的预算占比（默认 0.7，蓝图 §6.4）。
 * - `toolOutputThreshold`：单工具输出超此 token 估算 → 该 toolRun 单独摘要（Stage C）。
 */
export const contextConfig = {
  get contextWindowByModel(): Record<string, number> {
    const raw = optionalEnv("SNOW_CONTEXT_WINDOWS", "");
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, number>)
        : {};
    } catch {
      return {};
    }
  },
  get budgetThreshold(): number {
    return Number.parseFloat(optionalEnv("SNOW_CONTEXT_BUDGET_THRESHOLD", "0.7"));
  },
  get toolOutputThreshold(): number {
    return Number.parseInt(optionalEnv("SNOW_CONTEXT_TOOL_OUTPUT_THRESHOLD", String(8 * 1024)), 10);
  },
  /**
   * S1 修复（03-P1-4）：三级阈值。
   * - `softThreshold`（默认 0.5）：软警告线，超此触发 microcompact（单条超大消息裁剪），不整体压缩。
   * - `budgetThreshold`（0.7）：硬触发线，超此整体压缩（既有行为）。
   * - `criticalThreshold`（默认 0.9）：临界线，超此拒绝追加新工具输出（硬保护防 413）。
   */
  get softThreshold(): number {
    return Number.parseFloat(optionalEnv("SNOW_CONTEXT_SOFT_THRESHOLD", "0.5"));
  },
  get criticalThreshold(): number {
    return Number.parseFloat(optionalEnv("SNOW_CONTEXT_CRITICAL_THRESHOLD", "0.9"));
  },
  /** S1（03-P1-4）：microcompact 单条消息 token 上限，超此在软警告线触发时裁剪该消息文本。 */
  get microcompactMessageTokens(): number {
    return Number.parseInt(optionalEnv("SNOW_CONTEXT_MICROCOMPACT_TOKENS", "2048"), 10);
  },
} as const;

/**
 * 外部资料 / Web 访问配置（V3.4）。
 *
 * 域名治理 fail-closed：
 * - `domainAllowlist`：默认空 → webFetch/webSearch 全 deny（配置缺失不变成 allow）。
 *   域内 allow；域外默认 ask；命中 blacklist → deny。
 * - `domainBlacklist`：命中即 deny。
 * - `maxBytes`：单次 fetch 体积上限（默认 512KB），超出截断并标 truncated。
 * - `timeoutMs`：fetch 超时（默认 15s）。
 * - `contentTypes`：允许的 Content-Type 白名单（默认 text/html,text/plain,application/json）。
 *
 * 域名匹配按 host 后缀：allowlist 含 "example.com" 则匹配 example.com 与 *.example.com。
 */
function parseDomainList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export const webConfig = {
  get domainAllowlist(): string[] {
    return parseDomainList(optionalEnv("WEB_FETCH_DOMAIN_ALLOWLIST", ""));
  },
  get domainBlacklist(): string[] {
    return parseDomainList(optionalEnv("WEB_FETCH_DOMAIN_BLACKLIST", ""));
  },
  get maxBytes(): number {
    return Number.parseInt(optionalEnv("WEB_FETCH_MAX_BYTES", String(512 * 1024)), 10);
  },
  get timeoutMs(): number {
    return Number.parseInt(optionalEnv("WEB_FETCH_TIMEOUT_MS", "15000"), 10);
  },
  get contentTypes(): string[] {
    return parseDomainList(
      optionalEnv("WEB_FETCH_CONTENT_TYPES", "text/html,text/plain,application/json"),
    );
  },
} as const;

/**
 * MCP 调用配置（V3.4）。
 *
 * - `callTimeoutMs`：单次 MCP 工具调用超时（默认 30s）。
 */
export const mcpConfig = {
  get callTimeoutMs(): number {
    return Number.parseInt(optionalEnv("MCP_CALL_TIMEOUT_MS", "30000"), 10);
  },
} as const;

/**
 * QA gate 配置（V3.6 预览 / 浏览器 QA gate）。
 *
 * 命门（plan §1 决策）：
 * - `enabled`：默认 **false**（零回归）——禁用时 `reportThreadReady` 行为与今天逐字一致，
 *   不插 gate、不查浏览器、不写 qa 事件。启用是 opt-in，启用即 fail-closed。
 * - `browserRequired`：启用且 Playwright 浏览器不可用时，true（默认）→ fail-closed 阻断交付；
 *   false → 跳过 gate（不推荐，会让 gate 形同虚设）。
 * - `viewports`：响应式检查的核心 viewport（默认 375/768/1280）。
 * - `timeoutMs`：单次浏览器检查超时（默认 30s）。
 * - `notFound404Whitelist`：404 白名单（favicon/fonts 等，避免误杀），按 URL 子串匹配。
 *
 * 浏览器安装时机：`pnpm playwright install`（仅 chromium）作为部署 / CI 步骤，
 * 非运行时自动装（运行时下载不可控）。运行时只检查可用性。
 */
export const qaConfig = {
  get enabled(): boolean {
    return optionalEnv("QA_GATE_ENABLED", "true") === "true";
  },
  get browserRequired(): boolean {
    return optionalEnv("QA_BROWSER_REQUIRED", "true") === "true";
  },
  get viewports(): number[] {
    return optionalEnv("QA_VIEWPORTS", "375,768,1280")
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  },
  get timeoutMs(): number {
    return Number.parseInt(optionalEnv("QA_TIMEOUT_MS", "30000"), 10);
  },
  get notFound404Whitelist(): string[] {
    return optionalEnv(
      "QA_404_WHITELIST",
      "favicon.ico,apple-touch-icon.png,fonts,.woff,.woff2,.ttf,.otf",
    )
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },
  /**
   * P1 修复（05 QA P1-1）：gate 连续失败重试上限。
   * 超过此值 → 转人工审核(thread.reviewState = "needs_human_review"),停止自动重试。
   * 防 agent 陷入 gate 失败无限循环烧 token。默认 3。
   */
  get maxConsecutiveFailures(): number {
    const n = Number.parseInt(optionalEnv("QA_MAX_CONSECUTIVE_FAILURES", "3"), 10);
    return Number.isFinite(n) && n > 0 ? n : 3;
  },
  /** V6-M3-7（D5）：gate 规则集默认含 responsive + a11y（browser-check 无条件运行，无需配置）。 */
  get gateRules(): string[] {
    return optionalEnv("QA_GATE_RULES", "responsive,a11y")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s === "responsive" || s === "a11y");
  },
  /** S1（05-P1-4）：QA 浏览器并发上限（openQaPage 信号量），防多 thread 同时交付 OOM。默认 2。 */
  get maxBrowserConcurrency(): number {
    const n = Number.parseInt(optionalEnv("QA_MAX_BROWSER_CONCURRENCY", "2"), 10);
    return Number.isFinite(n) && n > 0 ? n : 2;
  },
} as const;

/**
 * 文档检索配置（V3.4 searchDocs）。
 *
 * - `docsDomains`：官方文档域 allowlist（SNOW_DOCS_DOMAINS，逗号分隔）。默认空 →
 *   searchDocs 全 deny（无文档源可搜，fail-closed）。
 * - `docsIndexPath`：可选 JSON 文档全文索引路径（SNOW_DOCS_INDEX_PATH）。配置后 searchDocs
 *   优先走本地索引；未配置时才降级为域名限定 webSearch。
 */
export const docsConfig = {
  get docsDomains(): string[] {
    return optionalEnv("SNOW_DOCS_DOMAINS", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  },
  get docsIndexPath(): string {
    return optionalEnv("SNOW_DOCS_INDEX_PATH", "");
  },
} as const;

/**
 * Pull/Merge Request provider 配置。
 *
 * 下游模块统一从这里读取 token / provider URL，避免散落直接读 process.env。
 */
export const prConfig = {
  get githubToken(): string {
    return optionalEnv("GITHUB_TOKEN", "");
  },
  get gitlabToken(): string {
    return optionalEnv("GITLAB_TOKEN", "");
  },
  get gitlabUrl(): string {
    return optionalEnv("GITLAB_URL", "https://gitlab.com");
  },
  get defaultBaseBranch(): string {
    return optionalEnv("PR_BASE_BRANCH", "main");
  },
} as const;

/**
 * 通用浏览器策略配置（V10 保留：供 Phase 6 Desktop Browser Tool 策略校验）。
 *
 * 设计原则：所有数值均由 env 可配，不写死。生产按环境调整，开发用安全默认。
 *
 * V10 架构说明：V9 服务器远程浏览器链路（Docker + Chromium + Xvfb + FFmpeg +
 * WebRTC + TURN）已全部删除。V10 Desktop 浏览器由 Electron + WebContentsView
 * 本地承载，partition 隔离（persist:snowharness-browser-{userId}）。以下
 * networkAllowlist / blockPrivateNetwork / maxUploadFileMb 等通用限制仍用于
 * Desktop Browser Tool 策略校验（Phase 6）。profileRetentionDays /
 * sessionIdleTimeoutMinutes 等字段保留但当前无消费者，供未来 Desktop 策略扩展使用。
 *
 * - `profileRetentionDays`：用户级登录态保留天数（V10 暂未使用，预留扩展）。默认 30。
 * - `sessionIdleTimeoutMinutes`：浏览器 session 空闲超时（V10 暂未使用，预留扩展）。默认 30。
 * - `sessionRetentionDays`：已结束 Thread 的浏览器现场保留天数（V10 暂未使用，预留扩展）。默认 30。
 * - `maxContexts`：最大同时活跃 BrowserContext 数（V10 暂未使用，预留扩展）。默认 8。
 * - `maxTabsPerSession`：单个 session 最大 tab 数（V10 暂未使用，预留扩展）。默认 8。
 * - `maxDownloadsPerThread`：单个 Thread 最大下载记录数。默认 100。
 * - `lockTtlMinutes`：AI 操作锁租约时长（分钟）。租约过期后用户可操作。
 *   防 AI 断线或工具卡死时永久阻塞用户。默认 5 分钟。
 * - `defaultViewport`：默认浏览器 viewport 宽度（px）。默认 1280。
 * - `networkAllowlist`：浏览器允许访问的 host/origin 列表。默认 "*" = 允许所有外部 URL
 *   （配合 blockPrivateNetwork 保护内网）。生产环境应配置具体域名收紧策略。
 *   注意：Thread AppRuntime 内的项目 URL 始终允许（localhost），不受此 allowlist 限制。
 * - `blockPrivateNetwork`：是否禁止 AI 浏览器访问私有网段/云元数据地址。默认 true。
 */
export const browserConfig = {
  get profileRetentionDays(): number {
    const n = Number.parseInt(optionalEnv("SNOW_BROWSER_PROFILE_RETENTION_DAYS", "30"), 10);
    return Number.isFinite(n) && n > 0 ? n : 30;
  },
  get sessionIdleTimeoutMinutes(): number {
    const n = Number.parseInt(optionalEnv("SNOW_BROWSER_SESSION_IDLE_TIMEOUT_MIN", "30"), 10);
    return Number.isFinite(n) && n > 0 ? n : 30;
  },
  get sessionRetentionDays(): number {
    const n = Number.parseInt(optionalEnv("SNOW_BROWSER_SESSION_RETENTION_DAYS", "30"), 10);
    return Number.isFinite(n) && n > 0 ? n : 30;
  },
  get maxContexts(): number {
    const n = Number.parseInt(optionalEnv("SNOW_BROWSER_MAX_CONTEXTS", "8"), 10);
    return Number.isFinite(n) && n > 0 ? n : 8;
  },
  get maxTabsPerSession(): number {
    const n = Number.parseInt(optionalEnv("SNOW_BROWSER_MAX_TABS_PER_SESSION", "8"), 10);
    return Number.isFinite(n) && n > 0 ? n : 8;
  },
  get maxDownloadsPerThread(): number {
    const n = Number.parseInt(optionalEnv("SNOW_BROWSER_MAX_DOWNLOADS_PER_THREAD", "100"), 10);
    return Number.isFinite(n) && n > 0 ? n : 100;
  },
  /** V9 阶段 8：下载文件落工作区的子目录名（相对 Thread 工作区根）。默认 "downloads"。 */
  get downloadsDirName(): string {
    const s = optionalEnv("SNOW_BROWSER_DOWNLOADS_DIR_NAME", "downloads").trim();
    // 防路径注入：禁止空、禁止 .. / 绝对路径 / 路径分隔符
    if (!s || s.includes("..") || s.startsWith("/") || s.includes("/") || s.includes("\\")) {
      return "downloads";
    }
    // X49 修复：拒绝内部目录名——.snow/.git/node_modules 等会被工作区 API 拒绝读取
    const internalDirs = [".snow", ".git", "node_modules", ".next", ".cache", ".config"];
    if (internalDirs.includes(s.toLowerCase())) {
      return "downloads";
    }
    return s;
  },
  get lockTtlMinutes(): number {
    const n = Number.parseInt(optionalEnv("SNOW_BROWSER_LOCK_TTL_MIN", "5"), 10);
    return Number.isFinite(n) && n > 0 ? n : 5;
  },
  get defaultViewport(): number {
    const n = Number.parseInt(optionalEnv("SNOW_BROWSER_DEFAULT_VIEWPORT", "1280"), 10);
    return Number.isFinite(n) && n > 0 ? n : 1280;
  },
  get networkAllowlist(): string[] {
    // F13 修复：默认 "*" 允许所有外部 URL（配合 blockPrivateNetwork 保护内网）。
    // 旧实现默认空 → fail-closed deny 全部外部 URL，开箱即用 AI 任何外部导航被拒绝。
    // 生产环境应配置具体 allowlist 收紧策略。
    return optionalEnv("SNOW_BROWSER_NETWORK_ALLOWLIST", "*")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },
  get blockPrivateNetwork(): boolean {
    // X50 修复：使用统一 boolean parser，接受 1/TRUE/yes/on 等常见写法
    return parseBooleanEnv("SNOW_BROWSER_BLOCK_PRIVATE_NETWORK", true);
  },
  /** X39 修复：browserUploadFile 单文件大小上限（MB）。0 = 不限制。
   *  默认 50MB——上传前先 stat 检查 size，超限直接拒绝，避免把大文件整体读进 Node 内存。
   *  Playwright setInputFiles 也需要把文件完整读进内存传 buffer，无上限会拖垮进程。 */
  get maxUploadFileMb(): number {
    const n = Number.parseInt(optionalEnv("SNOW_BROWSER_MAX_UPLOAD_FILE_MB", "50"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 50;
  },
  /** 阶段九：browserUploadFile 允许的 MIME 类型列表（逗号分隔）。
   *  默认 "*" = 允许所有类型。生产环境可配置具体类型收紧策略，例如：
   *  SNOW_BROWSER_UPLOAD_ALLOWED_MIME_TYPES="image/png,image/jpeg,application/pdf,text/csv"
   *  空=拒绝所有上传（fail-closed）。 */
  get uploadAllowedMimeTypes(): string[] {
    return optionalEnv("SNOW_BROWSER_UPLOAD_ALLOWED_MIME_TYPES", "*")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },
  /** 阶段十一：浏览器写 API 请求体大小上限（字节）。默认 1 MiB。
   *  POST/PATCH/PUT 请求在读取 body 前先检查 Content-Length，超限直接 413。 */
  get maxApiBodyBytes(): number {
    const n = Number.parseInt(
      optionalEnv("SNOW_BROWSER_MAX_API_BODY_BYTES", String(1024 * 1024)),
      10,
    );
    return Number.isFinite(n) && n > 0 ? n : 1024 * 1024;
  },
  /** 阶段十一：浏览器写 API 速率限制（每用户每分钟请求数）。默认 60。
   *  超限返回 429。0 = 不限制。 */
  get apiRateLimitPerMinute(): number {
    const n = Number.parseInt(optionalEnv("SNOW_BROWSER_API_RATE_LIMIT_PER_MINUTE", "60"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 60;
  },
} as const;

// V10 Phase 2：remoteBrowserConfig 和 webrtcConfig 已删除。
// 原 V9 自研远程浏览器运行时配置（Docker 容器 + Chromium + Xvfb + FFmpeg +
// streamer + WebRTC + TURN）整条链路已移除。Desktop 浏览器由 Electron +
// WebContentsView 本地承载（Phase 3+），不经 Server 配置。
// browserConfig 保留：通用浏览器限制（networkAllowlist、blockPrivateNetwork、
// maxUploadFileMb、uploadAllowedMimeTypes、maxApiBodyBytes、apiRateLimitPerMinute）
// 仍用于 Desktop Browser Tool 的策略校验（Phase 6）。

// ─── 运行时校验 + 启动日志（由 instrumentation 调用）──────────────────

/** 遮蔽 URL 中的密码用于日志：mysql://user:***@host:port/db */
function maskUrl(url: string): string {
  return url.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
}

/**
 * 校验必填项并打印启动诊断；缺失则一次性列出所有缺项并抛错（fail-fast）。
 * 仅供 instrumentation.ts 在运行时调用——确保 next build 不受影响。
 */
export function assertRuntimeConfig(): void {
  const required: Array<[key: string, description: string]> = [
    ["DATABASE_URL", "MySQL 连接串"],
    ["LLM_API_KEY", "LLM API 密钥"],
  ];

  const missing = required.filter(([key]) => !process.env[key]);
  if (missing.length > 0) {
    const lines = missing.map(([key, description]) => `  - ${key}（${description}）`).join("\n");
    throw new Error(
      `[config] 缺少必填环境变量（APP_ENV="${APP_ENV}"）：\n${lines}\n` +
        `请在 .env.${APP_ENV}.local 配置，或由部署平台（K8s / docker -e）注入。`,
    );
  }

  // 生产环境禁止隐式 dev auth fallback——必须接入 trusted-headers SSO 边界。
  if (appConfig.isProd && authConfig.mode === "dev") {
    throw new Error("[config] production 禁止 SNOW_AUTH_MODE=dev；请接入 trusted-headers SSO");
  }
  // trusted-headers 模式：身份由网关注入的 x-snow-user-* header 决定。
  // Next 16 route handler 无法获取 TCP 对端 IP（NextRequest.ip 已移除），应用层不再做来源校验，
  // 必须靠网络隔离（K8s NetworkPolicy / 防火墙）保证仅网关能达 pod——否则任意客户端可伪造
  // x-snow-user-* header 越权（含冒充 admin）。启动 warn 提示该部署约束。
  if (authConfig.mode === "trusted-headers") {
    console.warn(
      "[config] SNOW_AUTH_MODE=trusted-headers：身份 header 由网关注入，应用层不做来源校验。必须靠 K8s NetworkPolicy / 防火墙保证仅网关能达 pod，否则可被伪造 x-snow-user-* header 越权。",
    );
  }

  console.log(
    `[config] APP_ENV=${APP_ENV} | DB=${maskUrl(dbConfig.url)} | AI=${aiConfig.baseUrl} | model=${aiConfig.chatModel}`,
  );

  // S1（06-P1-6）：embedding 配置踩坑防护。enabled=true 但未设 model → 静默走 DisabledEmbeddingProvider，
  // 语义检索不生效。启动时显式 warn（不 fail-fast，因 disabled 是合法降级）。
  if (memoryConfig.embeddingsEnabled && !memoryConfig.embeddingModel) {
    console.warn(
      "[config] MEMORY_EMBEDDINGS_ENABLED=true 但未设 MEMORY_EMBEDDING_MODEL → 语义检索将降级为 disabled（lexical only）。如需语义检索，请配置 embedding 模型；否则设 MEMORY_EMBEDDINGS_ENABLED=false 显式关闭。",
    );
  } else if (memoryConfig.embeddingsEnabled) {
    console.log(
      `[config] memory embedding: enabled, model=${memoryConfig.embeddingModel}, dim=${memoryConfig.embeddingDimension}`,
    );
  } else {
    console.log("[config] memory embedding: disabled（lexical only）");
  }
}

/**
 * S1（11-P1-3）：skill 匹配 LLM 兜底（可选）。
 * 默认 off（零 LLM 是设计优点）；设 SNOW_SKILL_LLM_FALLBACK=on 启用——
 * 关键词匹配失败时调 LLM 判断用户意图与 skill 描述是否语义匹配。
 */
export const skillMatcherConfig = {
  get llmFallback(): boolean {
    return optionalEnv("SNOW_SKILL_LLM_FALLBACK", "off") === "on";
  },
} as const;

/**
 * S1（11-P2-1）：skill 匹配停用词配置（env 覆盖,逗号分隔,叠加默认停用词）。
 *
 * - SNOW_SKILL_STOPWORDS="词1,词2,word3"：自定义停用词,与默认集合并去重。
 * - 不设或空串：仅使用默认停用词。
 *
 * 中文停用词过滤"用于/这是/一个"等无区分度词;英文停用词过滤"use/the/and"等。
 * 自定义停用词对中英文都生效(匹配时按字符串相等比较,不做大小写归一化处理——
 * 中文不需要、英文停用词表已 lowercase)。
 */
export const skillStopwordsConfig = {
  /** 自定义停用词(已 trim 去空,保留原大小写);未配置 → 空数组。 */
  get custom(): string[] {
    const raw = optionalEnv("SNOW_SKILL_STOPWORDS", "");
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },
} as const;
