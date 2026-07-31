import {
  createSkillVersion,
  getCurrentSkillVersion,
  getMaxSkillVersionNumber,
  getSkillById,
  getSkillVersionByCommitSha,
  setCurrentVersion,
} from "@/lib/db/queries";
import { listSkillVersions } from "@/lib/db/studio-queries";
import { jsonError, jsonOk } from "@/lib/http";
import { requirePermission } from "@/lib/rbac";
import { parseSkillMd } from "@/lib/skill/frontmatter";
import { rejectSyncedSkillWrite } from "@/lib/skill/read-only-guard";
import {
  SkillRepoError,
  commitSkillVersion,
  getSkillHeadSha,
  readSkillFile,
} from "@/lib/skill/repo";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import { assertSkillWriteAccess } from "@/lib/studio/skill-access";
import type { NextRequest } from "next/server";

/** GET /studio/api/skills/[id]/versions → 版本列表（受 skill.read 守卫）。 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "skill.read");
  if (!r.ok) return r.response;
  const { id } = await params;
  return jsonOk(await listSkillVersions(id));
}

/**
 * POST /studio/api/skills/[id]/versions → 发布新版本（工作副本改动 git commit + 建 SkillVersion + 切 currentVersionId）。
 * 受 skill.write 守卫。无改动 → 400。frontmatter 解析失败不阻断（用 null 快照）。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "skill.write");
  if (!r.ok) return r.response;
  const actorUserId = r.user.id;
  const { id } = await params;

  const sk = await getSkillById(id);
  if (!sk) return jsonError(404, "skill_not_found", "skill 不存在");

  // P1-5: owner 隔离——非 admin 仅能发布自己 ownerUserId 的 skill
  const denied = await assertSkillWriteAccess(sk, actorUserId);
  if (denied) return denied;

  // 02 文档 §7.2：同步 Skill 只读,拒绝发布新版本
  const synced = rejectSyncedSkillWrite(sk);
  if (synced) return synced;

  const body = (await req.json().catch(() => ({}))) as { message?: string };
  const message = body.message?.trim() || `${sk.name} 新版本`;

  // 解析当前 SKILL.md frontmatter 作版本快照（allowedTools/model/runtime）
  const md = await readSkillFile(sk.name, "SKILL.md");
  let tools: string[] | null = null;
  let model: string | null = null;
  let runtime: string | null = null;
  if (md) {
    try {
      const fm = parseSkillMd(md);
      tools = fm.tools.length ? fm.tools : null;
      model = fm.model ?? null;
      runtime = fm.runtime ?? null;
    } catch {
      /* frontmatter 解析失败不阻断，用 null */
    }
  }

  let commitSha: string;
  try {
    commitSha = await commitSkillVersion(sk.name, message);
  } catch (e) {
    if (!(e instanceof SkillRepoError)) {
      return jsonError(500, "commit_failed", (e as Error).message);
    }
    const headSha = await getSkillHeadSha(sk.name);
    if (!headSha) return jsonError(400, "no_changes", e.message);
    const existing = await getSkillVersionByCommitSha(sk.id, headSha);
    if (existing) return jsonError(400, "no_changes", e.message);
    commitSha = headSha;
  }

  const existing = await getSkillVersionByCommitSha(sk.id, commitSha);
  if (existing) {
    // P1-14:CAS——仅当 currentVersionId 仍是读取时的值才切换,防并发 publish/rollback 互覆盖。
    const swapped = await setCurrentVersion(sk.id, existing.id, sk.currentVersionId);
    if (!swapped) {
      return jsonError(409, "version_conflict", "skill 当前版本已被并发修改,请刷新后重试");
    }
    return jsonOk({
      skillId: id,
      versionId: existing.id,
      version: existing.version,
      commitSha,
      recovered: true,
    });
  }

  const versionNum = (await getMaxSkillVersionNumber(sk.id)) + 1;

  const version = await createSkillVersion({
    skillId: sk.id,
    version: versionNum,
    commitSha,
    allowedTools: tools,
    defaultModelProfile: model,
    runtimeType: runtime,
    status: "active",
  });
  // P1-14:CAS——防并发 publish/rollback 互覆盖。失败时新版本行已创建但未切 current,
  // 调用方可重试 publish 切换;不回滚版本创建(版本本身不可逆)。
  const swapped = await setCurrentVersion(sk.id, version.id, sk.currentVersionId);
  if (!swapped) {
    return jsonError(
      409,
      "version_conflict",
      "skill 当前版本已被并发修改,新版本已创建但未切换,请刷新后用 publish 切换",
    );
  }

  try {
    await recordAdminAudit({
      actorUserId,
      action: "skills.published",
      targetType: "skill",
      targetId: id,
      outcome: "succeeded",
      metadata: { versionId: version.id, commitSha, version: versionNum },
    });
  } catch {
    /* 审计非关键路径，不阻断 */
  }
  return jsonOk({ skillId: id, versionId: version.id, version: versionNum, commitSha });
}
