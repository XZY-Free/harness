import { listAllThreads, listThreadsForUser } from "@/lib/db/studio-queries";
import { jsonOk, omitThreadSecrets } from "@/lib/http";
import { hasStudioAction, requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads → thread 列表（受 studio.access 守卫）。
 * - member：只列自己的（listThreadsForUser）。
 * - admin（thread.read.all）：列全部（listAllThreads）。
 */
export async function GET(req: NextRequest) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const canAll = await hasStudioAction(r.principal, "thread.read");
  const threads = canAll ? await listAllThreads() : await listThreadsForUser(r.principal.userIdentityId);
  // P1-5:剥离 cicdApiToken 密文,防泄露给 Studio 前端。
  const safeThreads = threads.map(omitThreadSecrets);
  return jsonOk({ threads: safeThreads, canViewAll: canAll });
}
