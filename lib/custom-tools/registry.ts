import { webConfig } from "@/lib/config";
import { listEnabledCustomTools as listEnabledCustomToolsDb } from "@/lib/db/queries";
import { classifyDomain, fetchWithValidatedRedirects, urlHost } from "@/lib/external/fetch";
import { matchDomain } from "@/lib/external/source";
import { isInternalHost } from "@/lib/external/url-safety";
import { SCRIPT_WHITELIST, runWhitelistedScript } from "./scripts";

/**
 * 自定义工具声明 + executor（蓝图 ）。
 *
 * 两种 executor：
 * - webhook：{ url, method, headers? } 调用，走域名 allowlist + 内网/元数据地址 SSRF 防护 + 超时/体积上限。
 * - script：**只跑平台预置白名单脚本**（lib/custom-tools/scripts.ts），非白名单 scriptId 拒绝，
 * 绝不执行用户提供的任意代码（命门 #2）。
 *
 * 声明校验（parseDeclaration）：name/description/inputSchema(JSON Schema)/executorType/executorConfig。
 * 权限走正式 Policy Revision（custom.<name>，决策 allow/pause/block，由 lib/permission/policy-queries.ts
 * 的 loadPolicySetAndRules + lib/permission/policy-evaluator.ts 表达）。
 */

export type WebhookExecutorConfig = {
  url: string;
  method: string;
  headers?: Record<string, string>;
};

export type ScriptExecutorConfig = {
  scriptId: string;
};

export type CustomToolDeclaration = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  executorType: "webhook" | "script";
  executorConfig: WebhookExecutorConfig | ScriptExecutorConfig;
};

export type ParseResult =
  | { ok: true; declaration: CustomToolDeclaration }
  | { ok: false; error: string };

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * webhook 自定义 headers 白名单过滤。
 *
 * 原实现 `headers: { "content-type": "application/json", ...(cfg.headers ?? {}) }` 直接展开透传，
 * 可被注入 authorization/cookie/set-cookie 等敏感/语义 header（覆盖平台凭证、伪造 Cookie）。
 * 本函数：敏感 header 名（含 auth/cookie/token/key/secret 等）一律剔除；content-type 由平台固定
 * 不允许覆盖（强制 application/json）。返回清洗后的安全 header 子集。
 */
const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|api-key|apikey|x-api-key|token|.*-token|.*-secret|.*-key)$/i;

function sanitizeWebhookHeaders(input?: Record<string, string>): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== "string") continue;
    // content-type 由平台强制 application/json，不允许覆盖
    if (/^content-type$/i.test(k)) continue;
    if (SENSITIVE_HEADER_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 校验自定义工具声明。非法 inputSchema / executorConfig / name 拒绝。
 */
export function parseDeclaration(decl: unknown): ParseResult {
  if (typeof decl !== "object" || decl === null) return { ok: false, error: "声明须为对象" };
  const d = decl as Record<string, unknown>;
  const name = d.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return { ok: false, error: "name 非法（须以字母开头，仅含字母数字下划线）" };
  }
  if (typeof d.description !== "string" || d.description.length === 0) {
    return { ok: false, error: "description 不能为空" };
  }
  const inputSchema = d.inputSchema;
  if (
    typeof inputSchema !== "object" ||
    inputSchema === null ||
    (inputSchema as { type?: string }).type !== "object"
  ) {
    return { ok: false, error: "inputSchema 须为 JSON Schema object" };
  }
  if (d.executorType !== "webhook" && d.executorType !== "script") {
    return { ok: false, error: "executorType 须为 webhook 或 script" };
  }
  const executorConfig = d.executorConfig;
  if (typeof executorConfig !== "object" || executorConfig === null) {
    return { ok: false, error: "executorConfig 须为对象" };
  }
  if (d.executorType === "webhook") {
    const cfg = executorConfig as WebhookExecutorConfig;
    if (typeof cfg.url !== "string" || urlHost(cfg.url) === null) {
      return { ok: false, error: "webhook url 非法" };
    }
    if (typeof cfg.method !== "string" || !ALLOWED_METHODS.has(cfg.method.toUpperCase())) {
      return { ok: false, error: "webhook method 非法" };
    }
    if (cfg.headers !== undefined && (typeof cfg.headers !== "object" || cfg.headers === null)) {
      return { ok: false, error: "webhook headers 须为对象" };
    }
  } else {
    const cfg = executorConfig as ScriptExecutorConfig;
    if (typeof cfg.scriptId !== "string" || cfg.scriptId.length === 0) {
      return { ok: false, error: "script scriptId 不能为空" };
    }
    if (!SCRIPT_WHITELIST.has(cfg.scriptId)) {
      return { ok: false, error: `script scriptId 不在白名单: ${cfg.scriptId}` };
    }
  }
  return {
    ok: true,
    declaration: {
      name,
      description: d.description,
      inputSchema: inputSchema as Record<string, unknown>,
      executorType: d.executorType,
      executorConfig: executorConfig as WebhookExecutorConfig | ScriptExecutorConfig,
    },
  };
}

/** 列启用的自定义工具（DB）。供 Studio API 与（未来）route 预加载用。 */
export async function listEnabledCustomTools() {
  return listEnabledCustomToolsDb();
}

/**
 * webhook executor：域名 allowlist（必须域内 allow）+ 内网/元数据 SSRF 防护 + 超时/体积上限。
 * 域外 / 黑名单 / 内网 → 拒绝（不 ask，webhook 是平台配置的固定端点，须显式 allowlist）。
 */
export async function executeWebhook(
  cfg: WebhookExecutorConfig,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; content: unknown } | { ok: false; error: string }> {
  const host = urlHost(cfg.url);
  if (!host) return { ok: false, error: "webhook url 非法" };
  if (isInternalHost(host)) return { ok: false, error: `webhook 禁止内网/元数据地址: ${host}` };
  const v = classifyDomain(cfg.url);
  if (v.decision !== "allow") {
    return { ok: false, error: `webhook 域名未在 allowlist: ${v.reason}` };
  }
  // 二次确认 allowlist 命中（classifyDomain allow 即命中，但显式校验防漂移）
  if (!webConfig.domainAllowlist.some((d) => matchDomain(host, d))) {
    return { ok: false, error: `webhook 域名未在 allowlist: ${host}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), webConfig.timeoutMs);
  try {
    const res = await fetchWithValidatedRedirects({
      url: cfg.url,
      fetchImpl,
      signal: controller.signal,
      method: cfg.method.toUpperCase(),
      headers: { "content-type": "application/json", ...sanitizeWebhookHeaders(cfg.headers) },
      body: ["GET", "DELETE"].includes(cfg.method.toUpperCase()) ? undefined : JSON.stringify(args),
      validateRedirect: (nextUrl) => {
        const nextHost = urlHost(nextUrl);
        if (!nextHost) return { ok: false, error: "redirect 目标 URL 非法" };
        if (isInternalHost(nextHost)) {
          return { ok: false, error: `redirect 禁止内网/元数据地址: ${nextHost}` };
        }
        const verdict = classifyDomain(nextUrl);
        if (verdict.decision !== "allow") {
          return { ok: false, error: `redirect 域名未在 allowlist: ${verdict.reason}` };
        }
        if (!webConfig.domainAllowlist.some((d) => matchDomain(nextHost, d))) {
          return { ok: false, error: `redirect 域名未在 allowlist: ${nextHost}` };
        }
        return { ok: true };
      },
    });
    if (!res.ok) return { ok: false, error: res.error };
    const text = await res.response.text();
    const truncated = text.length > webConfig.maxBytes;
    const content = truncated ? text.slice(0, webConfig.maxBytes) : text;
    if (!res.response.ok) return { ok: false, error: `webhook HTTP ${res.response.status}` };
    return { ok: true, content };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("abort"))
      return { ok: false, error: `webhook 超时（${webConfig.timeoutMs}ms）` };
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** script executor：只跑白名单脚本；非白名单 scriptId 拒绝（parseDeclaration 已挡，此处兜底）。 */
export async function executeScript(
  scriptId: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; content: unknown } | { ok: false; error: string }> {
  return runWhitelistedScript(scriptId, args);
}
