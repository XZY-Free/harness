import { getThreadById, requireThreadForUser, updateThreadCicdToken } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * V6-M2-6（G3）：per-thread CI/CD API token 设置 API。
 *
 * 权限：
 * - studio.access 守卫 + thread owner 或 admin(thread.read.all)
 * - foreign → 404；未登录 → 401；无 studio.access → 403
 *
 * 安全：GET 不返回明文 token（只返回 hasToken 布尔）；PUT 接收明文，加密后写 DB（AES-256-GCM）。
 */

/** GET /studio/api/threads/[id]/cicd-token → 是否已设置（不返回明文） */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasPermission(r.user.id, "thread.write.all");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.user.id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  return jsonOk({ threadId: id, hasToken: Boolean(thread.cicdApiToken) });
}

/** PUT /studio/api/threads/[id]/cicd-token → 设置/清除 per-thread CI/CD token */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasPermission(r.user.id, "thread.write.all");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.user.id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  // P2-8: per-thread CI/CD token 是部署凭证(与 secrets 同属 admin-only 管理范畴),
  // member owner 不可自行设置,防绕过 admin 门槛注入部署凭证。
  if (!canAll) {
    return jsonError(403, "admin_required", "设置 CI/CD token 需管理员权限");
  }

  let body: { cicdApiToken?: string | null };
  try {
    body = (await req.json()) as { cicdApiToken?: string | null };
  } catch {
    return jsonError(400, "invalid_body", "请求体非法 JSON");
  }

  if (!("cicdApiToken" in body)) {
    return jsonError(400, "missing_field", "缺少 cicdApiToken 字段");
  }

  const token = body.cicdApiToken;
  // 长度校验（防超长输入；text 列无硬限制，但 API token 不应过长）
  if (typeof token === "string" && token.length > 2048) {
    return jsonError(400, "token_too_long", "cicdApiToken 长度不能超过 2048 字符");
  }
  // 字符集校验:token 用于 Authorization header,含 CRLF 可 HTTP header 注入。
  // 仅允许常见 token 字符,拒绝换行/控制字符。
  if (typeof token === "string" && token.length > 0 && !/^[A-Za-z0-9._~+/=\-]+$/.test(token)) {
    return jsonError(400, "token_invalid", "cicdApiToken 含非法字符");
  }
  // null 表示清除（回退到全局 cicdApiToken）
  await updateThreadCicdToken(id, token ?? null);
  return jsonOk({ threadId: id, hasToken: token !== null && token !== "" });
}
