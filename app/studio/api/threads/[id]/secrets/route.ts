import {
  deleteSecretMount,
  getSecretMount,
  getThreadById,
  listSecretsByScope,
  requireThreadForUser,
} from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { createSecret, revokeSecret } from "@/lib/runtime/secret-mount";
import { isSecretMountAvailable } from "@/lib/runtime/secret-redaction";
import type { NextRequest } from "next/server";

/**
 * Secret 管理 API（admin-only，返回脱敏，不返回明文/密文）。
 *
 * V3.8 Stage E：Studio secret 管理入口。
 *
 * 权限：
 * - studio.access + thread.read.all（admin）→ 可管理 secret
 * - member（owner）→ 只读（GET 允许，POST/DELETE 需 admin）
 * - foreign → 404；未登录 → 401；无 studio.access → 403
 *
 * 安全：**绝不返回明文或密文**。GET 只返回 name/scope/status/时间戳。
 */

/** 脱敏的 secret 摘要（不含明文/密文）。 */
function sanitizeSecret(s: {
  id: string;
  name: string;
  scope: string;
  scopeRef: string | null;
  status: string;
  keyId: string;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt: Date | null;
}) {
  return {
    id: s.id,
    name: s.name,
    scope: s.scope,
    scopeRef: s.scopeRef,
    status: s.status,
    keyId: s.keyId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    rotatedAt: s.rotatedAt,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasPermission(r.user.id, "thread.write.all");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.user.id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  const secrets = await listSecretsByScope("thread", id);
  const secretMountAvailable = isSecretMountAvailable();

  return jsonOk({
    threadId: id,
    secretMountAvailable,
    secrets: secrets.map(sanitizeSecret),
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  // secret 管理仅 admin
  const canAll = await hasPermission(r.user.id, "thread.write.all");
  if (!canAll) return jsonError(403, "forbidden", "secret 管理需要 admin 权限");

  const thread = await getThreadById(id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  if (!isSecretMountAvailable()) {
    return jsonError(
      503,
      "secret_mount_unavailable",
      "SECRET_MASTER_KEY 未配置，secret mount 不可用",
    );
  }

  let body: { name?: string; value?: string };
  try {
    body = (await req.json()) as { name?: string; value?: string };
  } catch {
    return jsonError(400, "bad_request", "请求体非合法 JSON");
  }

  if (!body.name || typeof body.name !== "string") {
    return jsonError(400, "bad_request", "name 必填");
  }
  if (!body.value || typeof body.value !== "string") {
    return jsonError(400, "bad_request", "value 必填");
  }

  try {
    const mount = await createSecret({
      threadId: id,
      name: body.name,
      scope: "thread",
      scopeRef: id,
      value: body.value,
    });
    return jsonOk({ secret: sanitizeSecret(mount) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return jsonError(500, "secret_create_failed", msg);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  // secret 管理仅 admin
  const canAll = await hasPermission(r.user.id, "thread.write.all");
  if (!canAll) return jsonError(403, "forbidden", "secret 管理需要 admin 权限");

  const thread = await getThreadById(id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  const url = new URL(req.url);
  const secretId = url.searchParams.get("id");
  const action = url.searchParams.get("action"); // "revoke" | "delete"

  if (!secretId) {
    return jsonError(400, "bad_request", "id 参数必填");
  }

  try {
    if (action === "delete") {
      // 审计修复：校验 thread 所有权（原仅按 secretMountId 操作，不验证 threadId，
      // 若调用方能控制 secretMountId 可删除其他 thread 的 secret——与 revokeSecret 的
      // 所有权校验不一致，属于 IDOR 漏洞）。
      const existing = await getSecretMount(secretId);
      if (!existing) {
        return jsonError(404, "secret_not_found", "secret 不存在");
      }
      if (existing.scope === "thread" && existing.scopeRef && existing.scopeRef !== id) {
        return jsonError(403, "forbidden", "无权操作其他 thread 的 secret");
      }
      await deleteSecretMount(secretId);
      return jsonOk({ deleted: true });
    }
    // 默认 revoke（撤销，停止注入）
    const revoked = await revokeSecret(id, secretId);
    return jsonOk({ secret: sanitizeSecret(revoked) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return jsonError(500, "secret_action_failed", msg);
  }
}
