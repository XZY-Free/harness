/**
 * 同步 Skill 只读守卫（02 文档，关口02 02-4 正式化）。
 *
 * 服务端硬拦截同步 Skill 的写操作（编辑文件 / 发布 / 回滚 / 归档）。
 * 前端隐藏按钮不能代替服务端校验。
 */

import { jsonError } from "@/lib/http";
import type { Skill } from "@/lib/persistence/schema/skill";

/**
 * 若 skill 是同步镜像（sourceType=capability_market）,返回 403 Response;否则返回 null 放行。
 */
export function rejectSyncedSkillWrite(
  sk: Pick<Skill, "sourceType" | "skillKey">,
): Response | null {
  if (sk.sourceType === "capability_market") {
    return jsonError(
      403,
      "synced_skill_readonly",
      `同步 Skill「${sk.skillKey}」只读,不可编辑/发布/回滚/归档,请取消同步或重新同步`,
    );
  }
  return null;
}
