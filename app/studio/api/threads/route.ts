import { listAllThreads, listThreadsForUser } from "@/lib/db/studio-queries";
import { jsonOk, omitThreadSecrets } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads → thread 列表（受 studio.access 守卫）。
 * - member：只列自己的（listThreadsForUser）。
 * - admin（thread.read.all）：列全部（listAllThreads）。
 */
export async function GET(req: NextRequest) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const canAll = await hasPermission(r.user.id, "thread.read.all");
  const threads = canAll ? await listAllThreads() : await listThreadsForUser(r.user.id);
  // P1-5:剥离 cicdApiToken 密文,防泄露给 Studio 前端。
  const safeThreads = threads.map(omitThreadSecrets);
  return jsonOk({ threads: safeThreads, canViewAll: canAll });
}
