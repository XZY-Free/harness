import { parseDeclaration } from "@/lib/custom-tools/registry";
import { createCustomTool, listCustomTools } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * V3.4 Stage E：自定义工具管理 API。
 *
 * 权限：GET 任何 studio 用户可见（studio.access）；POST 仅 admin（policy.write）。
 * POST 经 parseDeclaration 校验（非法 inputSchema / 非白名单 scriptId 拒绝）。
 */

/** GET /studio/api/custom-tools → 列全部自定义工具。 */
export async function GET(req: NextRequest) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const rows = await listCustomTools();
  return jsonOk({ rows });
}

/** POST /studio/api/custom-tools → 新建自定义工具（admin-only，声明校验）。 */
export async function POST(req: NextRequest) {
  const r = await requirePermission(req, "policy.write");
  if (!r.ok) return r.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_body", "请求体不是合法 JSON");
  }
  const parsed = parseDeclaration(body);
  if (!parsed.ok) return jsonError(400, "invalid_declaration", parsed.error);
  const decl = parsed.declaration;
  try {
    const created = await createCustomTool({
      name: decl.name,
      description: decl.description,
      inputSchema: decl.inputSchema,
      executorType: decl.executorType,
      executorConfig: decl.executorConfig as Record<string, unknown>,
      enabled: true,
    });
    return jsonOk({ row: created });
  } catch (e) {
    return jsonError(409, "create_failed", e instanceof Error ? e.message : String(e));
  }
}
