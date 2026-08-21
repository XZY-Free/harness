import { getSkillById } from "@/lib/capability/skill-queries";
import { jsonError, jsonOk } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { rejectSyncedSkillWrite } from "@/lib/skill/read-only-guard";
import { SkillRepoError, listSkillFiles, readSkillFile, writeSkillFile } from "@/lib/skill/repo";
import { assertSkillWriteAccess } from "@/lib/studio/skill-access";
import type { NextRequest } from "next/server";

/** GET /studio/api/skills/[id]/files?path= → 读文件；不带 path → 列文件树。受 skill.read 守卫。 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "skill.read");
  if (!r.ok) return r.response;
  const { tenantId } = r.principal;
  const { id } = await params;
  const sk = await getSkillById({ tenantId, skillId: id });
  if (!sk) return jsonError(404, "skill_not_found", "skill 不存在");

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  try {
    if (path) {
      const content = await readSkillFile(sk.skillKey, path);
      if (content === null) return jsonError(404, "file_not_found", "文件不存在");
      return jsonOk({ path, content });
    }
    return jsonOk({ files: await listSkillFiles(sk.skillKey) });
  } catch (e) {
    return jsonError(400, "invalid_path", (e as Error).message);
  }
}

/** PUT /studio/api/skills/[id]/files body { path, content } → 写工作副本文件（不自动发布版本）。受 skill.write 守卫。 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "skill.write");
  if (!r.ok) return r.response;
  const { tenantId } = r.principal;
  const { id } = await params;
  const sk = await getSkillById({ tenantId, skillId: id });
  if (!sk) return jsonError(404, "skill_not_found", "skill 不存在");

  // P1-5: owner 隔离——非 admin 仅能改自己 ownerUserId 的 skill,与 skills/[id] PUT/DELETE 对齐
  const denied = await assertSkillWriteAccess(sk, r.principal);
  if (denied) return denied;

  // 02 文档 §7.2：同步 Skill 只读,拒绝编辑文件
  const synced = rejectSyncedSkillWrite(sk);
  if (synced) return synced;

  const body = (await req.json().catch(() => ({}))) as { path?: string; content?: string };
  const path = body.path?.trim();
  if (!path) return jsonError(400, "missing_path", "缺少 path");
  if (body.content === undefined) return jsonError(400, "missing_content", "缺少 content");

  try {
    await writeSkillFile(sk.skillKey, path, body.content);
  } catch (e) {
    if (e instanceof SkillRepoError) return jsonError(400, "invalid_path", e.message);
    return jsonError(500, "write_failed", (e as Error).message);
  }
  return jsonOk({ path });
}
