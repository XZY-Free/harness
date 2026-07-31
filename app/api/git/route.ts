import { authErrorResponse, getCurrentUserFromRequest } from "@/lib/auth";
import { getThreadById, listPermissionRules, requireThreadForUser } from "@/lib/db/queries";
import type { User } from "@/lib/db/schema";
import { deliverToGit } from "@/lib/git/deliver";
import { jsonError, jsonOk } from "@/lib/http";
import { evaluatePermission } from "@/lib/permission/engine";
import { toPermissionRule } from "@/lib/permission/rules";

/**
 * Git 交付 API：把会话工作区推送到用户指定的远程仓库。
 * HTTP 层成功即 jsonOk(result)，推送本身成败由 result.ok 表示（业务结果与 HTTP 分层）。
 *
 * S1（09-P1-6）：双层守卫——
 * - owner guard（requireThreadForUser）：owner 直接放行（数据可见性 + 执行授权合一）。
 * - 权限引擎（evaluatePermission, permissionKey=tool.gitPush）：非 owner 需有显式 allow rule
 *   （DB 中 tool.gitPush allow）才放行；ask/deny → 403（HTTP 入口不支持 ask 暂停流程）。
 *   thread 不存在 → 404（不泄露存在性）。
 * API body 不暴露 force 字段（防绕过 ask 审批）。
 */
export async function POST(request: Request) {
  let body: {
    threadId?: string;
    remoteUrl?: string;
    commitMessage?: string;
    branch?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError(400, "bad_request", "无效请求体");
  }

  const { threadId, remoteUrl, commitMessage, branch } = body;
  if (!threadId || !remoteUrl) {
    return jsonError(400, "missing_params", "缺少 threadId 或 remoteUrl");
  }

  let currentUser: User;
  try {
    currentUser = await getCurrentUserFromRequest(request);
  } catch (error) {
    const authErr = authErrorResponse(error);
    if (authErr) return authErr;
    return jsonError(500, "internal_error", "服务器内部错误");
  }

  // 第一层：owner guard——owner 直接放行
  const ownedThread = await requireThreadForUser(threadId, currentUser.id);
  if (ownedThread) {
    const result = await deliverToGit(threadId, remoteUrl, { commitMessage, branch });
    return jsonOk(result);
  }

  // 非 owner：先判断 thread 是否存在（不存在 → 404，不泄露存在性）
  const targetThread = await getThreadById(threadId);
  if (!targetThread) {
    return jsonError(404, "thread_not_found", "会话不存在");
  }

  // 第二层：权限引擎。permissionKey=tool.gitPush，与 agent 侧 gitPush 工具一致。
  // 非 owner 需有显式 allow rule 才放行；ask/deny → 403（HTTP 入口不支持 ask 暂停流程）。
  const dbRules = (await listPermissionRules()).map(toPermissionRule);
  const verdict = evaluatePermission({
    toolName: "gitPush",
    permissionKey: "tool.gitPush",
    input: { remoteUrl, commitMessage, branch },
    threadId,
    projectId: targetThread.projectId ?? null,
    dbRules,
  });
  if (verdict.decision !== "allow") {
    return jsonError(
      403,
      "permission_denied",
      `无 gitPush 权限（${verdict.decision}${verdict.reason ? `：${verdict.reason}` : ""}）`,
    );
  }

  const result = await deliverToGit(threadId, remoteUrl, { commitMessage, branch });
  return jsonOk(result);
}
