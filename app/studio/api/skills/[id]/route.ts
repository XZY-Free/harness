import { getSkillById, getSkillVersionById, updateSkill } from "@/lib/capability/skill-queries";
import { jsonError, jsonOk } from "@/lib/http";
import {
  hasStudioAction,
  requireStudioAction,
  type resolveStudioPrincipal,
} from "@/lib/identity/studio-access";
import { buildSkillMd, parseSkillMd } from "@/lib/skill/frontmatter";
import { rejectSyncedSkillWrite } from "@/lib/skill/read-only-guard";
import { readSkillFile, writeSkillFile } from "@/lib/skill/repo";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import type { NextRequest } from "next/server";

/**
 * S1（11-P2-6）：owner 权限检查。
 *
 * 非 admin(无 skill.write.all)只能改/删自己 ownerUserId 的 skill;
 * admin(skill.write.all)可改所有。公共 skill(ownerUserId null)只有 admin 能改。
 *
 * @returns null=放行;Response=拒绝(403)
 */
async function assertSkillWriteAccess(
  sk: { id: string; ownerUserId: string | null },
  principal: Awaited<ReturnType<typeof resolveStudioPrincipal>>,
): Promise<Response | null> {
  const isSkillAdmin = await hasStudioAction(principal, "skill.write");
  if (isSkillAdmin) return null;
  if (sk.ownerUserId === principal.userIdentityId) return null;
  return jsonError(403, "not_owner", "非 skill 所有者,无权修改");
}

/** GET /studio/api/skills/[id] → skill + 当前版本（受 skill.read 守卫）。 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "skill.read");
  if (!r.ok) return r.response;
  const { tenantId } = r.principal;
  const { id } = await params;
  const sk = await getSkillById({ tenantId, skillId: id });
  if (!sk) return jsonError(404, "skill_not_found", "skill 不存在");
  const currentVersion = sk.currentVersionId
    ? await getSkillVersionById({ tenantId, skillVersionId: sk.currentVersionId })
    : null;
  return jsonOk({ skill: sk, currentVersion });
}

/**
 * PUT /studio/api/skills/[id] → 改身份（description/category/visibility），同步 SKILL.md frontmatter。
 * name 不可改（目录名即身份锁定）。受 skill.write 守卫 + S1（11-P2-6）owner 隔离。
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "skill.write");
  if (!r.ok) return r.response;
  const { tenantId, userIdentityId: actorUserId } = r.principal;
  const { id } = await params;
  const sk = await getSkillById({ tenantId, skillId: id });
  if (!sk) return jsonError(404, "skill_not_found", "skill 不存在");

  // S1（11-P2-6）：owner 权限检查(admin 可改所有,非 admin 只能改自己的)
  const accessDenied = await assertSkillWriteAccess(sk, r.principal);
  if (accessDenied) return accessDenied;

  // 02 文档 §7.2：同步 Skill 只读,拒绝编辑
  const synced = rejectSyncedSkillWrite(sk);
  if (synced) return synced;

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    category?: string | null;
    visibility?: string;
  };
  if (body.name !== undefined && body.name !== sk.skillKey) {
    return jsonError(400, "name_immutable", "skill name 不可改（目录名锁定）");
  }

  // category 丢弃；visibility 仅当 body.visibility 提供才传（否则保留原值）
  const updates: { description?: string | null; visibilityScope?: "internal" | "tenant" } = {};
  if (body.description !== undefined) updates.description = body.description.trim() || null;
  if (body.visibility !== undefined) {
    updates.visibilityScope = body.visibility === "internal" ? "internal" : "tenant";
  }
  await updateSkill({
    tenantId,
    skillId: id,
    description: updates.description,
    visibilityScope: updates.visibilityScope,
    expectedVersionNo: sk.versionNo,
  });

  // 同步 SKILL.md frontmatter（description 改了 → 重写 frontmatter，正文保留，不自动发布版本）
  if (body.description !== undefined) {
    const md = await readSkillFile(sk.skillKey, "SKILL.md");
    if (md) {
      try {
        const fm = parseSkillMd(md);
        const bodyText = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
        await writeSkillFile(
          sk.skillKey,
          "SKILL.md",
          buildSkillMd(
            { ...fm, description: body.description.trim() || sk.skillKey },
            bodyText.trim(),
          ),
        );
      } catch {
        /* frontmatter 解析失败不阻断身份更新 */
      }
    }
  }

  try {
    await recordAdminAudit({
      actorUserId,
      action: "skills.updated",
      targetType: "skill",
      targetId: id,
      outcome: "succeeded",
      metadata: updates,
    });
  } catch {
    /* 审计非关键路径，不阻断 */
  }
  return jsonOk({ skillId: id });
}

/**
 * DELETE /studio/api/skills/[id] → 软删（status=archived，目录保留供历史 thread 读 commitSha）。
 * 受 skill.write 守卫 + S1（11-P2-6）owner 隔离。
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "skill.write");
  if (!r.ok) return r.response;
  const { tenantId, userIdentityId: actorUserId } = r.principal;
  const { id } = await params;
  const sk = await getSkillById({ tenantId, skillId: id });
  if (!sk) return jsonError(404, "skill_not_found", "skill 不存在");

  // S1（11-P2-6）：owner 权限检查(admin 可删所有,非 admin 只能删自己的)
  const accessDenied = await assertSkillWriteAccess(sk, r.principal);
  if (accessDenied) return accessDenied;

  // 02 文档 §7.2：同步 Skill 不走普通归档,需走取消同步（/unsync）
  const synced = rejectSyncedSkillWrite(sk);
  if (synced) return synced;

  // 软停用（lifecycleState=disabled），不物理删。
  await updateSkill({
    tenantId,
    skillId: id,
    lifecycleState: "disabled",
    expectedVersionNo: sk.versionNo,
  });
  try {
    await recordAdminAudit({
      actorUserId,
      action: "skills.deleted",
      targetType: "skill",
      targetId: id,
      outcome: "succeeded",
      metadata: { name: sk.skillKey },
    });
  } catch {
    /* 审计非关键路径，不阻断 */
  }
  return jsonOk({ skillId: id, status: "archived" });
}
