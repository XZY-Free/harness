import { deployConfig } from "@/lib/config";
import { assertSafeExternalUrlResolved } from "@/lib/external/url-safety";
import { logger } from "@/lib/logger";
import {
  clearThreadSecrets,
  redactTextGlobal,
  registerSecretValues,
} from "@/lib/runtime/secret-redaction";

/**
 * V3.8 Stage D：CI/CD webhook 交接（部署触发/状态查询/回滚）。
 *
 * 生产级 CI/CD 交接（plan §1/§8）：
 * - `triggerDeploy`：POST 部署上下文到 CI/CD webhook（鉴权 token + body 含环境/commit/image tag/artifact ref）
 * - `queryStatus`：GET CI/CD job 状态（轮询用）
 * - `triggerRollback`：POST webhook 标记 rollback + 上一版 ref
 * - 失败重试（有限次）+ 超时 + 明确错误（不含 secret）
 * - webhook URL/token 未配置 → 明确错误（不静默失败）
 *
 * SnowHarness 不直接操作 K8s——部署经公司现有 CI/CD 交接，由 CI/CD 负责底层集群。
 */

/** CI/CD webhook 响应。 */
export interface CicdDeployResponse {
  cicdJobId: string;
  cicdJobUrl?: string;
}

/** CI/CD job 状态。 */
export interface CicdJobStatus {
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  message?: string;
  url?: string;
}

/** 部署请求参数。 */
export interface TriggerDeployParams {
  environment: string;
  commitSha?: string;
  imageTag?: string;
  artifactRef?: string;
  previousDeploymentId?: string;
  previousCommitSha?: string;
  previousImageTag?: string;
  /** S1（09-P2-3）：per-thread CI/CD token（覆盖全局）。 */
  threadCicdToken?: string;
}

/** 检查 CI/CD 是否已配置（webhook URL 非空）。 */
export function isCicdConfigured(): boolean {
  return deployConfig.cicdWebhookUrl.length > 0;
}

/** 确保 CI/CD 已配置，否则抛错（不静默失败）。 */
function assertCicdConfigured(): void {
  if (!isCicdConfigured()) {
    throw new Error(
      "[deploy] DEPLOY_CICD_WEBHOOK_URL 未配置——无法触发部署。请在环境变量中配置 CI/CD webhook URL。",
    );
  }
}

/** 带重试的 fetch（有限次 + 超时）。 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries: number,
  timeoutMs: number,
  token?: string,
): Promise<Response> {
  // P1-2: SSRF 守卫——防 webhook URL 被配为内网/元数据端点,secret 透传+写操作。
  // 含 DNS rebinding 校验(域名解析到内网/元数据 IP)。
  await assertSafeExternalUrlResolved(url, "cicd webhook");
  // P1-2: 注册 cicd token 到全局脱敏 registry,4xx body 经 redactTextGlobal 替换,
  // 防恶意 webhook 在 4xx 响应体回显 Authorization 头值经 logger 泄露 token。
  const CICD_REDACT_KEY = "__cicd__";
  if (token) registerSecretValues(CICD_REDACT_KEY, [token]);
  try {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (response.ok) return response;
        // 4xx 不重试（客户端错误）
        if (response.status >= 400 && response.status < 500) {
          const body = await response.text().catch(() => "");
          // P1-6:body 仅进服务端日志,不入 error message——防恶意 webhook 在 4xx 响应体
          // 回显 Authorization 头值,经 errorMessage 落 deployment 表 + deployment.failed 事件泄露 token。
          // P1-2: body 经 redactTextGlobal 替换已注册的 cicd token。
          logger.warn("[cicd] webhook 返回 4xx", {
            status: response.status,
            body: redactTextGlobal(body).slice(0, 500),
          });
          throw new Error(
            `CI/CD webhook 返回 ${response.status}（4xx 客户端错误,响应体见服务端日志）`,
          );
        }
        // 5xx 重试
        lastError = new Error(`CI/CD webhook 返回 ${response.status}`);
      } catch (error) {
        if (error instanceof Error && error.message.includes("CI/CD webhook 返回 4")) {
          throw error; // 4xx 不重试
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); // 指数退避
      }
    }
    throw lastError ?? new Error("CI/CD webhook 请求失败");
  } finally {
    if (token) clearThreadSecrets(CICD_REDACT_KEY);
  }
}

/**
 * 触发部署（POST CI/CD webhook）。
 *
 * @returns CI/CD 返回的 job id + url
 * @throws CI/CD 未配置 / webhook 请求失败 / 4xx 错误
 */
export async function triggerDeploy(params: TriggerDeployParams): Promise<CicdDeployResponse> {
  assertCicdConfigured();

  const body = {
    action: params.previousDeploymentId ? "rollback" : "deploy",
    environment: params.environment,
    commitSha: params.commitSha,
    imageTag: params.imageTag,
    artifactRef: params.artifactRef,
    previousDeploymentId: params.previousDeploymentId,
    previousCommitSha: params.previousCommitSha,
    previousImageTag: params.previousImageTag,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // S1（09-P2-3）：per-thread token 优先于全局
  const token = (params as TriggerDeployParams).threadCicdToken ?? deployConfig.cicdApiToken;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetchWithRetry(
    deployConfig.cicdWebhookUrl,
    { method: "POST", headers, body: JSON.stringify(body) },
    deployConfig.maxRetries,
    deployConfig.timeoutMs,
    token,
  );

  const data = (await response.json()) as {
    cicdJobId?: string;
    cicdJobUrl?: string;
    jobId?: string;
    url?: string;
  };
  const cicdJobId = data.cicdJobId ?? data.jobId;
  if (!cicdJobId) {
    throw new Error("[deploy] CI/CD webhook 响应缺少 cicdJobId");
  }
  // P1-17: cicdJobId 来自外部 CI/CD 响应,后继拼入 status URL。校验字符集 + 拒绝路径穿越,
  // 防恶意/被攻破 CI/CD 用 ../../internal 改写 status 请求路径(SSRF 探测内网管理端点)。
  if (!/^[A-Za-z0-9_.\-]+$/.test(cicdJobId)) {
    throw new Error(`[deploy] CI/CD 返回非法 cicdJobId: ${cicdJobId}`);
  }
  return {
    cicdJobId,
    cicdJobUrl: data.cicdJobUrl ?? data.url,
  };
}

/**
 * 查询 CI/CD job 状态（GET status URL）。
 *
 * V6-M2-6（D3）：支持 per-thread token（与 triggerDeploy 一致）。
 * @param threadCicdToken per-thread CI/CD token（优先于全局 deployConfig.cicdApiToken）
 * @throws CI/CD status URL 未配置 / 请求失败
 */
export async function queryStatus(
  cicdJobId: string,
  threadCicdToken?: string,
): Promise<CicdJobStatus> {
  if (!deployConfig.cicdStatusUrl) {
    throw new Error("[deploy] DEPLOY_CICD_STATUS_URL 未配置——无法查询 job 状态");
  }

  // P1-17: cicdJobId 已在 triggerDeploy 校验字符集;此处额外 encodeURIComponent 防注入
  const url = deployConfig.cicdStatusUrl.replace("{jobId}", encodeURIComponent(cicdJobId));
  const headers: Record<string, string> = {};
  // V6-M2-6: per-thread token 优先于全局（与 triggerDeploy 一致）
  const token = threadCicdToken ?? deployConfig.cicdApiToken;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetchWithRetry(
    url,
    { method: "GET", headers },
    deployConfig.maxRetries,
    deployConfig.timeoutMs,
    token,
  );

  const data = (await response.json()) as { status?: string; message?: string; url?: string };
  const status = data.status ?? "pending";
  const validStatuses: CicdJobStatus["status"][] = [
    "pending",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ];
  return {
    status: validStatuses.includes(status as CicdJobStatus["status"])
      ? (status as CicdJobStatus["status"])
      : "pending",
    message: data.message,
    url: data.url,
  };
}

/**
 * 触发回滚（POST CI/CD webhook with rollback action）。
 *
 * @returns CI/CD 返回的新 job id + url
 */
export async function triggerRollback(params: {
  environment: string;
  previousDeploymentId: string;
  previousCommitSha?: string;
  previousImageTag?: string;
  threadCicdToken?: string;
}): Promise<CicdDeployResponse> {
  return triggerDeploy({
    environment: params.environment,
    previousDeploymentId: params.previousDeploymentId,
    previousCommitSha: params.previousCommitSha,
    previousImageTag: params.previousImageTag,
    threadCicdToken: params.threadCicdToken,
  });
}

// S1（09-P1-4）：后台轮询 deploying 状态的 deployment
/**
 * 扫描所有 deploying 状态的 deployment，查询 CI/CD 状态，更新终态。
 * 由 idle sweep 定时调用（防 deployment 永远停在 deploying）。
 */
export async function sweepDeployingStatuses(): Promise<void> {
  const { getThreadById, listDeployingDeployments, updateDeployment } = await import(
    "@/lib/db/queries"
  );
  const { decryptCicdToken } = await import("@/lib/runtime/secret-crypto");
  const deploying = await listDeployingDeployments();
  for (const d of deploying) {
    if (!d.cicdJobId) continue;
    try {
      // V6-M2-6: 获取并解密 per-thread token 用于 queryStatus 鉴权
      const thread = d.threadId ? await getThreadById(d.threadId) : null;
      const threadToken = decryptCicdToken(thread?.cicdApiToken) ?? undefined;
      const status = await queryStatus(d.cicdJobId, threadToken);
      if (status.status === "succeeded") {
        await updateDeployment(d.id, { status: "deployed", deployedAt: new Date() });
      } else if (status.status === "failed") {
        await updateDeployment(d.id, {
          status: "failed",
          errorMessage: status.message ?? "CI/CD 失败",
        });
      }
    } catch (err) {
      // P2-12: 查询失败 → 保持 deploying(下次 sweep 再试),但记 warn 供运维排查
      logger.warn("[cicd] sweep 查询失败,deployment 暂保持 deploying", {
        deploymentId: d.id,
        cicdJobId: d.cicdJobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
