/**
 * 同步 Skill 只读守卫（02 文档 ）。
 *
 * 服务端硬拦截同步 Skill 的写操作（编辑文件 / 发布 / 回滚 / 归档）。
 * 前端隐藏按钮不能代替服务端校验。
 */

import type { Skill } from "@/lib/db/schema";
import { jsonError } from "@/lib/http";

/**
 * 若 skill 是同步镜像（source=capability-market）,返回 403 Response;否则返回 null 放行。
 */
export function rejectSyncedSkillWrite(sk: Pick<Skill, "source" | "name">): Response | null {
 if (sk.source === "capability-market") {
 return jsonError(
 403,
 "synced_skill_readonly",
 `同步 Skill「${sk.name}」只读,不可编辑/发布/回滚/归档,请取消同步或重新同步`,
 );
 }
 return null;
}
