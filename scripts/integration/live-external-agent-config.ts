/**
 * Generic Live External Agent Runner — 配置解析（06 §3）。
 *
 * 只允许黑盒运行所需的公共输入；provider 源码路径 / 仓 SHA / 框架名 /
 * employee id / raw bearer token 一律拒绝（fail closed，不进入 Runner）。
 * bearer 模式只接受 SnowHarness CredentialRef ID；真实 secret 由平台
 * Credential Authority 解析，Runner 永不接触。
 */

export interface LiveExternalAgentConfig {
  /** SnowHarness Web/API 基础 URL（如 http://127.0.0.1:3000）。 */
  baseUrl: string;
  /** 公共 Agent Contract JSON 文件路径（本地文件，仅模拟管理员导入）。 */
  contractFile: string;
  /** Provider live endpoint（黑盒，无源码知识）。 */
  runtimeEndpoint: string;
  runtimeAuthMode: "none" | "bearer";
  /** bearer 模式必填：CredentialRef ID（非 token）。 */
  runtimeCredentialRefId: string | null;
  basicInput: string;
  inputRequiredInput: string | null;
  resumeStartInput: string | null;
  resumeInput: string | null;
  expectCancelSupported: boolean;
  /** 是否执行 API-level Employee 验收（Thread/Turn/Resume）。 */
  exercise: boolean;
  /** 协议合同修订号（登记请求 protocol.contract_revision）。 */
  protocolContractRevision: string;
  /** Admin API Bearer Token（operator 提供；仅访问 SnowHarness，非 Provider 凭据）。 */
  adminBearerToken: string | null;
  /** 步骤超时上限（有限，禁止无限等待）。 */
  httpTimeoutMs: number;
  catalogWaitMs: number;
  invocationWaitMs: number;
}

/** 明确禁止的输入键（出现即 fail closed，06 §3）。 */
const FORBIDDEN_ENV_KEYS = [
  "SNOW_LIVE_PROVIDER_SOURCE_DIR",
  "SNOW_LIVE_PROVIDER_REPO",
  "SNOW_LIVE_PROVIDER_GIT_SHA",
  "SNOW_LIVE_FRAMEWORK",
  "SNOW_LIVE_VEDAK",
  "SNOW_LIVE_AGENTKIT",
  "SNOW_LIVE_EMPLOYEE_ID",
  "SNOW_LIVE_RAW_BEARER_TOKEN",
  "SNOW_LIVE_TOKEN",
  "SNOW_LIVE_AUTHORIZATION",
] as const;

export class LiveExternalAgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveExternalAgentConfigError";
  }
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value || value.trim().length === 0) {
    throw new LiveExternalAgentConfigError(`缺少必填环境变量 ${key}`);
  }
  return value.trim();
}

function optional(env: Record<string, string | undefined>, key: string): string | null {
  const value = env[key];
  return value && value.trim().length > 0 ? value.trim() : null;
}

function boundedInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/** 从 env 解析 Runner 配置；任何禁止键/非法组合 fail closed。 */
export function resolveLiveExternalAgentConfig(
  env: Record<string, string | undefined> = process.env,
): LiveExternalAgentConfig {
  for (const forbidden of FORBIDDEN_ENV_KEYS) {
    if ((env[forbidden] ?? "").trim().length > 0) {
      throw new LiveExternalAgentConfigError(`禁止的输入 ${forbidden}（黑盒 Runner 不接受）`);
    }
  }
  const runtimeAuthMode = optional(env, "SNOW_LIVE_RUNTIME_AUTH_MODE") ?? "none";
  if (runtimeAuthMode !== "none" && runtimeAuthMode !== "bearer") {
    throw new LiveExternalAgentConfigError("SNOW_LIVE_RUNTIME_AUTH_MODE 只支持 none|bearer");
  }
  const runtimeCredentialRefId = optional(env, "SNOW_LIVE_RUNTIME_CREDENTIAL_REF_ID");
  if (runtimeAuthMode === "bearer" && !runtimeCredentialRefId) {
    throw new LiveExternalAgentConfigError(
      "bearer 模式必须提供 CredentialRef ID（SNOW_LIVE_RUNTIME_CREDENTIAL_REF_ID），不接受 raw token",
    );
  }
  const inputRequiredInput = optional(env, "SNOW_LIVE_INPUT_REQUIRED_INPUT");
  const resumeStartInput = optional(env, "SNOW_LIVE_RESUME_INPUT");
  return {
    baseUrl: required(env, "SNOW_LIVE_BASE_URL"),
    contractFile: required(env, "SNOW_LIVE_AGENT_CONTRACT_FILE"),
    runtimeEndpoint: required(env, "SNOW_LIVE_RUNTIME_ENDPOINT"),
    runtimeAuthMode,
    runtimeCredentialRefId,
    basicInput: required(env, "SNOW_LIVE_BASIC_INPUT"),
    inputRequiredInput,
    resumeStartInput,
    resumeInput: resumeStartInput
      ? (optional(env, "SNOW_LIVE_RESUME_INPUT_TEXT") ?? "明天一天")
      : null,
    expectCancelSupported:
      (optional(env, "SNOW_LIVE_EXPECT_CANCEL_SUPPORTED") ?? "false").toLowerCase() === "true",
    exercise: (optional(env, "SNOW_LIVE_EXERCISE") ?? "0") === "1",
    protocolContractRevision: optional(env, "SNOW_LIVE_PROTOCOL_CONTRACT_REVISION") ?? "0.3.0",
    adminBearerToken: optional(env, "SNOW_LIVE_ADMIN_BEARER_TOKEN"),
    httpTimeoutMs: boundedInt(env, "SNOW_LIVE_HTTP_TIMEOUT_MS", 30_000, 120_000),
    catalogWaitMs: boundedInt(env, "SNOW_LIVE_CATALOG_WAIT_MS", 30_000, 120_000),
    invocationWaitMs: boundedInt(env, "SNOW_LIVE_INVOCATION_WAIT_MS", 120_000, 600_000),
  };
}
