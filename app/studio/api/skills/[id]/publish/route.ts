import { getSkillById, getSkillVersion, setCurrentVersion } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { logger } from "@/lib/logger";
import { rejectSyncedSkillWrite } from "@/lib/skill/read-only-guard";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import { assertSkillWriteAccess } from "@/lib/studio/skill-access";
import type { NextRequest } from "next/server";

/**
 * POST /studio/api/skills/[id]/publish body `{ versionId }` → 切换 currentVersionId（受 skill.write 守卫）。
 * foreign versionId（不属于该 skill）→ 404，不泄露是否存在。
 *
 * 审计（切片 C）：401/403/缺 versionId/skill 不存在 → 不审计。foreign version（skill 存在、
 * 版本不属于它）→ failed 审计 reasonCode=version_not_found。成功 → succeeded 审计 { versionId }。
 * 审计写失败 → 500 audit_failed（Known gap：version 可能已切换，§4.3）。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "skill.write");
  if (!r.ok) return r.response;
  const actorUserId = r.principal.userIdentityId;
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as { versionId?: string };
  const { versionId } = body;
  if (!versionId) return jsonError(400, "missing_version", "缺少 versionId");

  const sk = await getSkillById(id);
  if (!sk) return jsonError(404, "skill_not_found", "skill 不存在");
  // P1-5: owner 隔离——非 admin 仅能发布自己 ownerUserId 的 skill
  const denied = await assertSkillWriteAccess(sk, r.principal);
  if (denied) return denied;
  // 02 文档 §7.2：同步 Skill 只读,拒绝发布版本
  const synced = rejectSyncedSkillWrite(sk);
  if (synced) return synced;
  const ver = await getSkillVersion(versionId);
  if (!ver || ver.skillId !== id) {
    try {
      await recordAdminAudit({
        actorUserId,
        action: "skills.published",
        targetType: "skill",
        targetId: id,
        outcome: "failed",
        metadata: { reasonCode: "version_not_found", versionId },
      });
    } catch (auditError) {
      logger.error("admin audit write failed (skill publish failed path)", {
        skillId: id,
        error: String(auditError),
      });
    }
    return jsonError(404, "version_not_found", "版本不存在或不属于该 skill");
  }
  // P1-14: CAS——仅当 currentVersionId 仍是读取时的值才切换,防并发 publish/rollback 互覆盖
  const swapped = await setCurrentVersion(id, versionId, sk.currentVersionId);
  if (!swapped) {
    return jsonError(409, "version_conflict", "skill 当前版本已被并发修改,请刷新后重试");
  }
  try {
    await recordAdminAudit({
      actorUserId,
      action: "skills.published",
      targetType: "skill",
      targetId: id,
      outcome: "succeeded",
      metadata: { versionId },
    });
  } catch (error) {
    logger.error("admin audit write failed (skill publish success path)", {
      skillId: id,
      error: String(error),
    });
    return jsonError(500, "audit_failed", "审计写入失败");
  }
  return jsonOk({ skillId: id, currentVersionId: versionId });
}
