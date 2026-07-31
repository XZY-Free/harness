import { apiPath } from "@/lib/api-fetch";
import { authErrorResponse, getCurrentUserFromRequest } from "@/lib/auth";
import { requireThreadForUser } from "@/lib/db/queries";
import type { User } from "@/lib/db/schema";
import { resolveRuntimeTypeForThread, resolveRuntimes } from "@/lib/runtime/registry";

/**
 * Phase 5 Stage D：预览反向代理 `/preview/[threadId]/*`。
 *
 * 部署形态下浏览器经 localhost:动态端口不可达（蓝图 §8.2 头号约束）。本 route 作平台进程内
 * 反向代理：按 threadId 查 PreviewRuntime.status，ready 则转发到 `127.0.0.1:{port}`（host 模式
 * 静态 server / container 模式 docker port mapping），未 ready 返回 503。
 *
 * 鉴权：复用 requireThreadForUser（owner guard），非 owner → 404（与 app/api/preview 一致）。
 *
 * 实现取舍：用 fetch 手动转发而非 http-proxy——Next.js route handler 无原生 req/res，http-proxy
 * 需 custom server；本轮 HTTP 转发优先，WebSocket（dev server HMR）留后续（plan D3，HMR 走 polling）。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ threadId: string; path?: string[] }> },
) {
  const { threadId, path } = await params;

  let currentUser: User;
  try {
    currentUser = await getCurrentUserFromRequest(request);
  } catch (error) {
    const authErr = authErrorResponse(error);
    if (authErr) return authErr;
    throw error;
  }

  const thread = await requireThreadForUser(threadId, currentUser.id);
  if (!thread) {
    return new Response(null, { status: 404 });
  }

  // V8 阶段 8：preview 不再依赖 Skill 的 runtimeType，回退到 thread.runtimeType ?? "host"
  const runtimeType = resolveRuntimeTypeForThread(thread, null);
  const preview = resolveRuntimes(threadId, runtimeType).preview;
  let status = preview.status(threadId);
  // S1：dev server / 静态 preview server 仅存内存，重启后丢失。若 thread 已记录 previewUrl，
  // 访问反向代理时自动恢复 preview runtime，避免用户每次重启后都要手动让 agent 重新提交。
  if ((!status || status.state !== "ready" || status.port == null) && thread.previewUrl) {
    try {
      await preview.start(threadId);
      status = preview.status(threadId);
    } catch {
      // 恢复失败仍走下方 503
    }
  }
  if (!status || status.state !== "ready" || status.port == null) {
    return new Response("预览未就绪，请等待 agent 完成自检后重试", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // P2-8:拒 path 段含 `..` 或 null byte,防反代上游 dev-server 时命中内部路由。
  if (path?.some((p) => p === ".." || p.includes("\0"))) {
    return new Response("Bad Request", { status: 400 });
  }
  const subPath = path && path.length > 0 ? `/${path.join("/")}` : "/";
  const search = new URL(request.url).search;
  const target = `http://127.0.0.1:${status.port}${subPath}${search}`;
  // S1（05-P2-8）：带静态预览 token 头（防 host 内进程直读 workspace）
  const reqHeaders: HeadersInit = {};
  if (status.token) reqHeaders["x-preview-token"] = status.token;
  const resp = await fetch(target, { signal: AbortSignal.timeout(30_000), headers: reqHeaders });
  // S1（05-P1-7）：响应头白名单过滤，剔除 X-Powered-By/X-Nextjs/Server 等内部信息泄漏。
  // 重写 Location（3xx）为 /preview/{threadId}/... 相对路径，防浏览器跳到 127.0.0.1:{port} 不可达。
  const ALLOWED_HEADERS = new Set([
    "content-type",
    "content-length",
    "content-encoding",
    "cache-control",
    "etag",
    "last-modified",
    "vary",
  ]);
  const respHeaders = new Headers();
  for (const [k, v] of resp.headers.entries()) {
    if (ALLOWED_HEADERS.has(k.toLowerCase())) respHeaders.set(k, v);
  }
  // V6-M1-5: 注入 CSP 头（G4）——上游响应头被白名单过滤，在此层统一注入
  respHeaders.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self';",
  );
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get("location");
    if (loc) {
      try {
        const locUrl = new URL(loc, target);
        respHeaders.set(
          "location",
          apiPath(`/preview/${threadId}${locUrl.pathname}${locUrl.search}`),
        );
      } catch {
        // 非法 Location 不重写
      }
    }
  }
  return new Response(resp.body, { status: resp.status, headers: respHeaders });
}
