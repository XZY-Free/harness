import { createPermissionRule, listPermissionRules } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import {
  PermissionRuleValidationError,
  validateCreateInput,
} from "@/lib/studio/permission-rule-validation";
import type { NextRequest } from "next/server";

/**
 * S1（07-P2-5）：permission rule 管理 API。
 *
 * 07-P2-5 审计函数(createPermissionRule/updatePermissionRule/deletePermissionRule)早已写好,
 * 但 app/ 全目录 0 调用 → 无入口触发,审计是死代码。本路由接通入口:
 * 写操作调现有函数并传 actorUserId,审计(permission_rule.created/updated/deleted)自动落库。
 *
 * 守卫:policy.read 列表 / policy.write 增改删(与 policies 页面同域,admin 角色拥有)。
 * 引擎(tool-runtime.ts:279)运行时已 listPermissionRules 读 DB 规则合并默认规则——
 * 本路由写入后,规则即刻对后续工具调用生效(无需额外刷新,DB 直读)。
 */

/** GET /studio/api/permission-rules → 列全部持久化权限规则(按 priority 降序)。 */
export async function GET(req: NextRequest) {
  const r = await requireStudioAction(req, "policy.read");
  if (!r.ok) return r.response;
  const rules = await listPermissionRules();
  return jsonOk({ rules });
}

/** POST /studio/api/permission-rules → 新建规则(policy.write 守卫 + 服务端校验 + 审计)。 */
export async function POST(req: NextRequest) {
  const r = await requireStudioAction(req, "policy.write");
  if (!r.ok) return r.response;
  const actorUserId = r.principal.userIdentityId;

  const body = await req.json().catch(() => null);
  let input: ReturnType<typeof validateCreateInput> | undefined;
  try {
    input = validateCreateInput(body);
  } catch (error) {
    if (error instanceof PermissionRuleValidationError) {
      return jsonError(400, error.code, error.message);
    }
    throw error;
  }

  // 传 actorUserId → createPermissionRule 同事务落 permission_rule.created 审计
  const rule = await createPermissionRule({
    scope: input.scope,
    scopeRef: input.scopeRef,
    toolPattern: input.toolPattern,
    argMatcher: input.argMatcher,
    decision: input.decision,
    reason: input.reason,
    priority: input.priority,
    actorUserId,
  });
  return jsonOk({ rule });
}
