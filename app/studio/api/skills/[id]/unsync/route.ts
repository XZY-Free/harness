import { getSkillById, updateSkill } from "@/lib/capability/skill-queries";
import { getSyncBindingByLocalSkill, updateSyncBinding } from "@/lib/capability/skill-sync-queries";
import { apiError, apiSuccess, getRequestId } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import type { NextRequest } from "next/server";

/**
 * POST /studio/api/skills/[id]/unsync → 取消同步（02 文档 §7.2 同步 Skill 归档语义）。
 *
 * 仅对 source=capability-market 的 skill。行为：archive skill（不物理删,历史 run 仍可读旧 commit）
 * + 映射标 not_found（不再进入运行候选）。
 * 仅 admin（skill.write.all）可操作。本地自建 skill 调此接口 → 403。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(req);
  const r = await requireStudioAction(req, "skill.write");
  if (!r.ok) return r.response;
  const { tenantId, userIdentityId: actorUserId } = r.principal;
  const { id } = await params;

  const sk = await getSkillById({ tenantId, skillId: id });
  if (!sk) return apiError("SKILL_NOT_FOUND", "skill 不存在", { requestId });
  if (sk.sourceType !== "capability_market") {
    return apiError("NOT_SYNCED_SKILL", "仅同步 Skill 可取消同步,本地自建 Skill 请使用归档", {
      requestId,
    });
  }

  const mapping = await getSyncBindingByLocalSkill({ tenantId, localSkillId: id });
  // 软停用（lifecycleState=disabled），不物理删。
  await updateSkill({
    tenantId,
    skillId: id,
    lifecycleState: "disabled",
    expectedVersionNo: sk.versionNo,
  });
  if (mapping) {
    await updateSyncBinding(tenantId, mapping.id, {
      syncState: "not_found",
      lastCheckedAt: new Date(),
      lastError: "用户取消同步",
    });
  }

  try {
    await recordAdminAudit({
      actorUserId,
      action: "skills.unsynced",
      targetType: "skill",
      targetId: id,
      outcome: "succeeded",
      metadata: { name: sk.skillKey, remoteAssetId: mapping?.remoteAssetId ?? null },
    });
  } catch {
    /* 审计非关键 */
  }
  return apiSuccess({ skillId: id, status: "archived" });
}
