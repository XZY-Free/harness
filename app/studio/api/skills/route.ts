import {
  createSkill,
  createSkillVersion,
  deleteSkillWithVersions,
  getSkillByName,
  setCurrentVersion,
} from "@/lib/db/queries";
import { listSkills } from "@/lib/db/studio-queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { buildSkillMd } from "@/lib/skill/frontmatter";
import {
  SkillRepoError,
  SkillValidationError,
  assertValidSkillName,
  commitSkillVersion,
  getSkillHeadSha,
  writeSkillFile,
} from "@/lib/skill/repo";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/skills → 列 skill（受 skill.read 守卫）。
 *
 * S1（11-P2-6）：ownerUserId 权限隔离。
 * - 有 skill.write.all（admin）→ 全量。
 * - 否则（member）→ 仅自己 ownerUserId 的 + 公共（ownerUserId null）。
 */
export async function GET(req: NextRequest) {
  const r = await requirePermission(req, "skill.read");
  if (!r.ok) return r.response;
  const isSkillAdmin = await hasPermission(r.user.id, "skill.write.all");
  const skills = isSkillAdmin
    ? await listSkills()
    : await listSkills({ ownerUserId: r.user.id, includePublic: true });
  return jsonOk(skills);
}

/**
 * POST /studio/api/skills → 建 skill（身份层 + skills/<name>/SKILL.md + 初始 commit + v1）。
 * 受 skill.write 守卫。name 撞唯一 → 409；非法 name → 400。
 */
export async function POST(req: NextRequest) {
  const r = await requirePermission(req, "skill.write");
  if (!r.ok) return r.response;
  const actorUserId = r.user.id;

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    category?: string;
    visibility?: string;
    tools?: string[];
    model?: string;
    runtime?: string;
    promptMd?: string;
  };

  const name = body.name?.trim();
  if (!name) return jsonError(400, "missing_name", "缺少 name");
  try {
    assertValidSkillName(name);
  } catch (e) {
    return jsonError(400, "invalid_name", (e as Error).message);
  }
  const existing = await getSkillByName(name);
  if (existing) return jsonError(409, "name_conflict", `skill「${name}」已存在`);

  const description = body.description?.trim() ?? "";
  const tools = body.tools ?? [];
  // S1（11-P2-6）：createSkill 设 ownerUserId = 当前用户(创建者)
  const sk = await createSkill({
    name,
    description: description || null,
    category: body.category ?? null,
    visibility: body.visibility ?? "public",
    ownerUserId: actorUserId,
  });

  // 写 SKILL.md + 初始 commit（版本内容由目录承载，promptTemplate 不再写入）
  const md = buildSkillMd(
    {
      name,
      description: description || name,
      tools,
      model: body.model,
      runtime: body.runtime ?? null,
    },
    body.promptMd?.trim() || defaultSkillBody(name),
  );
  await writeSkillFile(name, "SKILL.md", md);

  let commitSha: string;
  try {
    commitSha = await commitSkillVersion(name, `${name} v1`);
  } catch (e) {
    // S1（11-P1-5）：校验失败(SkillValidationError)→ 400 阻断,不回退
    if (e instanceof SkillValidationError) {
      return jsonError(400, "skill_validation_failed", e.message);
    }
    if (e instanceof SkillRepoError) {
      const headSha = await getSkillHeadSha(name);
      if (headSha) {
        commitSha = headSha;
      } else {
        return jsonError(500, "commit_failed", e.message);
      }
    } else {
      return jsonError(500, "commit_failed", (e as Error).message);
    }
  }

  let version: Awaited<ReturnType<typeof createSkillVersion>>;
  try {
    version = await createSkillVersion({
      skillId: sk.id,
      version: 1,
      commitSha,
      allowedTools: tools.length ? tools : null,
      defaultModelProfile: body.model ?? null,
      runtimeType: body.runtime ?? null,
      status: "active",
    });
    await setCurrentVersion(sk.id, version.id);
  } catch (e) {
    await deleteSkillWithVersions(sk.id).catch(() => {});
    return jsonError(500, "skill_create_failed", (e as Error).message);
  }

  try {
    await recordAdminAudit({
      actorUserId,
      action: "skills.created",
      targetType: "skill",
      targetId: sk.id,
      outcome: "succeeded",
      metadata: { name, versionId: version.id, commitSha },
    });
  } catch {
    /* 审计非关键路径，不阻断 */
  }
  return jsonOk({ skillId: sk.id, versionId: version.id, commitSha });
}

function defaultSkillBody(name: string): string {
  return `# ${name}\n\n（在此编写 skill 的工作指令。agent 会通过 readSkillFile 读取本文件。）\n`;
}
