import { listProviders } from "@/lib/db/queries";
import { jsonOk } from "@/lib/http";
import { requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/providers → 列全部 provider 档案（受 provider.read 守卫）。
 *
 * 切片 B1：纯只读档案，不接 runtime。返回字段仅 apiKeyRef（env 引用名），不含明文 secret。
 */
export async function GET(req: NextRequest) {
  const r = await requirePermission(req, "provider.read");
  if (!r.ok) return r.response;
  return jsonOk({ rows: await listProviders() });
}
