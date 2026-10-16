/**
 * 同步 Skill 只读守卫。
 *
 * 服务端硬拦截同步 Skill 的写操作（编辑文件 / 发布 / 回滚 / 归档）。
 * 前端隐藏按钮不能代替服务端校验。
 */

import { apiError } from "@/lib/http";
import type { Skill } from "@/lib/persistence/schema/skill";

/**
 * 若 skill 是同步镜像（sourceType=capability_market）,返回 403 Response;否则返回 null 放行。
 *
 * @param requestId 请求上下文 id（由路由的 getRequestId 提供，用于错误可跟踪）
 */
export function rejectSyncedSkillWrite(
  sk: Pick<Skill, "sourceType" | "skillKey">,
  requestId: string,
): Response | null {
  if (sk.sourceType === "capability_market") {
    return apiError(
      "SYNCED_SKILL_READONLY",
      `同步 Skill「${sk.skillKey}」只读,不可编辑/发布/回滚/归档,请取消同步或重新同步`,
      { requestId },
    );
  }
  return null;
}
