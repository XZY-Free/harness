import {
  contentHashFromGitSha,
  createSkillVersion,
  getSkillById,
  getSkillVersionByContentRef,
  setCurrentSkillVersion,
} from "@/lib/capability/skill-queries";
import { listSkillVersions } from "@/lib/capability/skill-studio-queries";
import { apiError, apiSuccess, getRequestId } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { rejectSyncedSkillWrite } from "@/lib/skill/read-only-guard";
import { SkillRepoError, commitSkillVersion, getSkillHeadSha } from "@/lib/skill/repo";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import { assertSkillWriteAccess } from "@/lib/studio/skill-access";
import type { NextRequest } from "next/server";

/** GET /studio/api/skills/[id]/versions → 版本列表（受 skill.read 守卫）。 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "skill.read");
  if (!r.ok) return r.response;
  const { tenantId } = r.principal;
  const { id } = await params;
  return apiSuccess(await listSkillVersions(tenantId, id));
}

/**
 * POST /studio/api/skills/[id]/versions → 发布新版本（工作副本改动 git commit + 建 SkillVersion + 切 currentVersionId）。
 * 受 skill.write 守卫。无改动 → 400。frontmatter 解析失败不阻断（用 null 快照）。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(req);
  const r = await requireStudioAction(req, "skill.write");
  if (!r.ok) return r.response;
  const { tenantId, userIdentityId: actorUserId } = r.principal;
  const { id } = await params;

  const sk = await getSkillById({ tenantId, skillId: id });
  if (!sk) return apiError("SKILL_NOT_FOUND", "skill 不存在", { requestId });

  // P1-5: owner 隔离——非 admin 仅能发布自己 ownerUserId 的 skill
  const denied = await assertSkillWriteAccess(sk, r.principal, requestId);
  if (denied) return denied;

  // 02 文档 §7.2：同步 Skill 只读,拒绝发布新版本
  const synced = rejectSyncedSkillWrite(sk, requestId);
  if (synced) return synced;

  const body = (await req.json().catch(() => ({}))) as { message?: string };
  const message = body.message?.trim() || `${sk.skillKey} 新版本`;

  let commitSha: string;
  try {
    commitSha = await commitSkillVersion(sk.skillKey, message);
  } catch (e) {
    if (!(e instanceof SkillRepoError)) {
      return apiError("SKILL_COMMIT_FAILED", (e as Error).message, { requestId });
    }
    const headSha = await getSkillHeadSha(sk.skillKey);
    if (!headSha) return apiError("SKILL_NO_CHANGES", e.message, { requestId });
    const existing = await getSkillVersionByContentRef({
      tenantId,
      skillId: sk.id,
      contentRef: headSha,
    });
    if (existing) return apiError("SKILL_NO_CHANGES", e.message, { requestId });
    commitSha = headSha;
  }

  const existing = await getSkillVersionByContentRef({
    tenantId,
    skillId: sk.id,
    contentRef: commitSha,
  });
  if (existing) {
    // P1-14:CAS——仅当 currentVersionId 仍是读取时的值才切换,防并发 publish/rollback 互覆盖。
    const swapped = await setCurrentSkillVersion({
      tenantId,
      skillId: sk.id,
      skillVersionId: existing.id,
      expectedCurrentVersionId: sk.currentVersionId,
    });
    if (!swapped) {
      return apiError("VERSION_CONFLICT", "skill 当前版本已被并发修改,请刷新后重试", { requestId });
    }
    return apiSuccess({
      skillId: id,
      versionId: existing.id,
      version: existing.versionNo,
      commitSha,
      recovered: true,
    });
  }

  // allowedTools/model/runtime 丢弃（正式用 manifestJson，此处不填）；versionNo 由正式仓储自动分配。
  const version = await createSkillVersion({
    tenantId,
    skillId: sk.id,
    contentRef: commitSha,
    contentHash: contentHashFromGitSha(commitSha),
    sourceType: "local",
    createdBy: actorUserId,
  });
  // P1-14:CAS——防并发 publish/rollback 互覆盖。失败时新版本行已创建但未切 current,
  // 调用方可重试 publish 切换;不回滚版本创建(版本本身不可逆)。
  const swapped = await setCurrentSkillVersion({
    tenantId,
    skillId: sk.id,
    skillVersionId: version.id,
    expectedCurrentVersionId: sk.currentVersionId,
  });
  if (!swapped) {
    return apiError(
      "VERSION_CONFLICT",
      "skill 当前版本已被并发修改,新版本已创建但未切换,请刷新后用 publish 切换",
      { requestId },
    );
  }

  try {
    await recordAdminAudit({
      actorUserId,
      action: "skills.published",
      targetType: "skill",
      targetId: id,
      outcome: "succeeded",
      metadata: { versionId: version.id, commitSha, version: version.versionNo },
    });
  } catch {
    /* 审计非关键路径，不阻断 */
  }
  return apiSuccess({ skillId: id, versionId: version.id, version: version.versionNo, commitSha });
}
