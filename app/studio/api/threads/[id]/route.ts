import { getThreadById, requireThreadForUser, updateThreadReviewState } from "@/lib/db/queries";
import {
  listArtifactsForThread,
  listEventsForThread,
  listToolRunsForThread,
} from "@/lib/db/studio-queries";
import { jsonError, jsonOk, omitThreadSecrets } from "@/lib/http";
import { hasStudioAction, requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads/[id] → thread 详情（受 studio.access 守卫）。
 * - member：requireThreadForUser（foreign → null → 404，不泄露存在性）。
 * - admin（thread.read.all）：getThreadById（不存在 → 404）。
 * 返回 thread + events + toolRuns + artifacts（均只读）。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasStudioAction(r.principal, "thread.read");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  const [events, toolRuns, artifacts] = await Promise.all([
    listEventsForThread(id),
    listToolRunsForThread(id),
    listArtifactsForThread(id),
  ]);
  return jsonOk({ thread: omitThreadSecrets(thread), events, toolRuns, artifacts });
}

/**
 * PATCH /studio/api/threads/[id] → 更新 thread 字段（受 studio.access 守卫）。
 *
 * P1 修复（05 QA P1-1 完整化）：人工审核后重置 reviewState。
 * - body { reviewState: null } → 重置 QA gate 熔断状态,允许 thread 恢复执行。
 * - 仅 thread 归属者或 admin(thread.read.all)可操作。
 * - 当前仅支持 reviewState 字段(白名单,防越权改其他字段)。
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasStudioAction(r.principal, "thread.write");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  let body: { reviewState?: string | null };
  try {
    body = (await req.json()) as { reviewState?: string | null };
  } catch {
    return jsonError(400, "invalid_body", "请求体非法 JSON");
  }

  // 白名单:当前仅支持重置 reviewState(人工审核后恢复 thread)
  if (!("reviewState" in body)) {
    return jsonError(400, "unsupported_field", "当前仅支持更新 reviewState 字段");
  }
  // 仅允许重置为 null(恢复);转 needs_human_review 由 gate 自动触发,不接受手动设置
  if (body.reviewState !== null) {
    return jsonError(400, "invalid_review_state", "reviewState 仅可重置为 null(人工审核恢复)");
  }

  // P1-6: 重置 QA 熔断需 admin(thread.read.all);member owner 不可自审自重置绕过熔断。
  if (!canAll) {
    return jsonError(403, "admin_required", "重置 reviewState 需管理员权限");
  }

  await updateThreadReviewState(id, null);
  return jsonOk({ threadId: id, reviewState: null });
}
