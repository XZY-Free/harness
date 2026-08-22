import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeEvidenceConfig, webConfig } from "@/lib/config";
import { type ExternalSource, buildExternalSource, matchDomain } from "./source";
import { assertSafeExternalUrlResolved } from "./url-safety";

/**
 * 确定性 webFetch（蓝图 ）。
 *
 * 域名治理 fail-closed（命门 #2）：
 * - 黑名单命中 → deny
 * - allowlist 为空 → 全 deny（配置缺失不变成 allow）
 * - 域内（allowlist 命中）→ allow
 * - 域外（allowlist 非空但未命中）→ deny
 *
 * 域名治理产出 allow/deny（运行时本地网络策略）。域外访问由 Tool Gateway 的
 * Policy 以 pause（UserAction confirmation）或 block 集中治理，Runtime 不再做
 * ask 批准升级（§38：正式 Permission 全链只 allow/pause/block，无 ask）。
 *
 * 抓取：超时 / 体积上限 / Content-Type 白名单。HTML→text 确定性抽取（不调 LLM）。
 * 原文落 artifact 文件（.snow/runtime/{threadId}/external/{fetchId}.txt），不落 DB blob。
 * 大网页若抽取后仍超 toolOutputThreshold，由 a oversized tool output 机制自动摘要。
 */

export type DomainVerdict = {
  decision: "allow" | "deny";
  reason: string;
};

/** 解析 URL 的 host；非法 URL 返回 null。 */
export function urlHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname || null;
  } catch {
    return null;
  }
}

/**
 * 域名治理分类（纯函数，可单测）。
 * - 黑名单命中 → deny
 * - allowlist 为空 → deny（fail-closed）
 * - allowlist 命中 → allow
 * - allowlist 非空但未命中 → deny（域外；批准升级由 Gateway 的 pause 集中处理）
 */
export function classifyDomain(
  url: string,
  allowlist: string[] = webConfig.domainAllowlist,
  blacklist: string[] = webConfig.domainBlacklist,
): DomainVerdict {
  const host = urlHost(url);
  if (!host) return { decision: "deny", reason: "无效 URL" };
  if (blacklist.some((d) => matchDomain(host, d))) {
    return { decision: "deny", reason: `黑名单域名 ${host}` };
  }
  if (allowlist.length === 0) {
    return { decision: "deny", reason: "域名 allowlist 为空（fail-closed）" };
  }
  if (allowlist.some((d) => matchDomain(host, d))) {
    return { decision: "allow", reason: `域内 ${host}` };
  }
  return { decision: "deny", reason: `域外访问 ${host}` };
}

/**
 * 确定性 HTML→text 抽取（不调 LLM）。
 * 去除 script/style/head，剥标签，解码常见实体，折叠空白。对非 HTML 原样返回（截断后）。
 */
export function htmlToText(html: string): string {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ");
  const noTags = noScript.replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return decoded.replace(/\s+/g, " ").trim();
}

export type FetchOk = {
  ok: true;
  url: string;
  text: string;
  truncated: boolean;
  bytes: number;
  contentType: string;
  source: ExternalSource;
};

export type FetchResult =
  | FetchOk
  | { ok: false; denied: true; reason: string }
  | { ok: false; error: string };

type RedirectValidationResult = { ok: true } | { ok: false; error: string };

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * 手动跟随 redirect，并在每一跳校验目标 URL。
 * 避免 `redirect:"follow"` 先越过治理再让调用方事后发现已访问了错误目标。
 */
export async function fetchWithValidatedRedirects(params: {
  url: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  headers?: HeadersInit;
  method?: string;
  body?: BodyInit | null;
  maxRedirects?: number;
  validateRedirect: (url: string) => RedirectValidationResult | Promise<RedirectValidationResult>;
}): Promise<{ ok: true; response: Response; finalUrl: string } | { ok: false; error: string }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const maxRedirects = params.maxRedirects ?? 5;
  let currentUrl = params.url;
  let method = params.method ?? "GET";
  let body = params.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetchImpl(currentUrl, {
      signal: params.signal,
      redirect: "manual",
      headers: params.headers,
      method,
      body,
    });
    if (!isRedirectStatus(response.status)) {
      return { ok: true, response, finalUrl: currentUrl };
    }

    const location = response.headers.get("location");
    if (!location) {
      return { ok: false, error: `redirect ${response.status} 缺少 Location` };
    }
    const nextUrl = new URL(location, currentUrl).toString();
    const validation = await params.validateRedirect(nextUrl);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }
    currentUrl = nextUrl;

    // 对齐 fetch/浏览器重定向语义：303 恒转 GET；301/302 的 POST 也转 GET。
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method.toUpperCase() === "POST")
    ) {
      method = "GET";
      body = undefined;
    }
  }

  return { ok: false, error: `redirect 超过上限（>${maxRedirects}）` };
}

/**
 * 纯抓取（无域名治理）：超时 / 体积上限 / Content-Type 白名单 + HTML→text 抽取 + artifact 落盘 + 来源标记。
 *
 * 域名治理由调用方收口——只有 classifyDomain allow 才会到达本函数。
 * 直接调用方应先 classifyDomain 或用 fetchUrl 便捷封装。
 */
export async function rawFetch(params: {
  url: string;
  threadId: string;
  fetchImpl?: typeof fetch;
}): Promise<FetchOk | { ok: false; error: string }> {
  const { url, threadId } = params;
  // : SSRF 入口守卫——协议白名单 + 内网/元数据拒绝 + DNS rebinding 校验。
  // classifyDomain 只做域名 allowlist,不挡 file:// / 127.0.0.1.nip.io / 169.254.169.254 /
  // 域名解析到内网;此处兜底(含 DNS 解析后二次校验)。
  await assertSafeExternalUrlResolved(url, "webFetch url");
  const maxBytes = webConfig.maxBytes;
  const timeoutMs = webConfig.timeoutMs;
  const allowedContentTypes = webConfig.contentTypes;
  const fetchImpl = params.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchWithValidatedRedirects({
      url,
      fetchImpl,
      signal: controller.signal,
      headers: { "user-agent": "snow-harness-webfetch/1.0" },
      validateRedirect: async (nextUrl) => {
        // : redirect 目标也过 SSRF 守卫(含 DNS rebinding),防 redirect 到内网/元数据绕过入口校验。
        try {
          await assertSafeExternalUrlResolved(nextUrl, "webFetch redirect");
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
        const verdict = classifyDomain(nextUrl);
        if (verdict.decision !== "allow") {
          return { ok: false, error: `redirect 目标未通过域名治理：${verdict.reason}` };
        }
        return { ok: true };
      },
    });
    if (!res.ok) return { ok: false, error: res.error };
    if (!res.response.ok) return { ok: false, error: `HTTP ${res.response.status}` };
    const contentType =
      (res.response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (contentType && !allowedContentTypes.includes(contentType)) {
      return { ok: false, error: `不允许的 Content-Type: ${contentType}` };
    }
    const buf = await res.response.arrayBuffer();
    const full = Buffer.from(buf);
    const truncated = full.byteLength > maxBytes;
    const slice = full.subarray(0, maxBytes);
    const raw = slice.toString("utf8");
    const text = contentType === "text/html" ? htmlToText(raw) : raw;
    const bytes = slice.byteLength;

    const fetchId = randomUUID();
    const artifactPath = join(
      runtimeEvidenceConfig.hostDir,
      threadId,
      "external",
      `${fetchId}.txt`,
    );
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, raw, "utf8");

    const source = buildExternalSource({
      sourceUrl: res.finalUrl,
      content: raw,
      dynamic: contentType !== "text/html",
      artifactPath,
    });

    return {
      ok: true,
      url: res.finalUrl,
      text,
      truncated,
      bytes,
      contentType: contentType || "unknown",
      source,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("abort")) return { ok: false, error: `fetch 超时（${timeoutMs}ms）` };
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓取一个 URL 并确定性抽取正文（带域名治理的便捷封装，供独立调用/测试）。
 *
 * 域名治理：deny → {ok:false,denied}；allow → rawFetch。
 */
export async function fetchUrl(params: {
  url: string;
  threadId: string;
  fetchImpl?: typeof fetch;
}): Promise<FetchResult> {
  const v = classifyDomain(params.url);
  if (v.decision === "deny") return { ok: false, denied: true, reason: v.reason };
  return rawFetch(params);
}
