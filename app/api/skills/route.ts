import { jsonError, jsonOk } from "@/lib/http";
import { resolveStudioPrincipal } from "@/lib/identity/studio-access";
import { logger } from "@/lib/logger";
import { getSkillProvider } from "@/lib/skill/provider";
import type { NextRequest } from "next/server";

/**
 * GET /api/skills → 列出本地 Provider 的可用 Skill（供前端选择器使用）。
 *
 * 02 文档后运行时只读本地 DB：
 * - 本地自建 Skill 和 capability-market 同步镜像都来自本地 Provider。
 * - 同步镜像只有映射 syncState=active 时才会进入候选。
 * - 仅返回 `uiVisible=true` 的 Skill。
 * - Provider 异常时返回空候选（fail-closed），UI 显示空列表，基础 agent 仍可运行。
 *
 * UI 选择只是 Resolver 输入信号，不是强制绑定：
 * Resolver 可采纳或忽略，忽略原因进入 `skillResolverOutput.ignoredUiSelectedSkillIds`。
 *
 * 字段映射：`id` = `skillId`（与 chat route 的 `uiSelectedSkillIds` 对齐），
 * `name` 优先取 `displayName`，`category` 取 `tags[0]`。
 */
export async function GET(request: NextRequest) {
  let tenantId: string;
  try {
    tenantId = (await resolveStudioPrincipal(request.headers)).tenantId;
  } catch {
    return jsonError(401, "unauthorized", "未授权");
  }
  try {
    const summaries = await getSkillProvider().listAvailableSkills(tenantId);
    const visible = summaries.filter((s) => s.uiVisible);
    return jsonOk(
      visible.map((s) => ({
        id: s.skillId,
        name: s.displayName || s.name,
        description: s.description,
        category: s.tags[0] ?? null,
      })),
    );
  } catch (error) {
    // fail-closed：Provider 未预期的异常 → 空列表，不阻断 UI 和后续 chat
    logger.warn("[/api/skills] 拉取可用 Skill 失败，返回空列表", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonOk([]);
  }
}
