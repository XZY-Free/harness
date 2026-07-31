/**
 * artifact 导入：把 capability-market 下载的 zip 写入本地 skill 目录并提交 git 快照
 * （02 文档 §5.3）。
 *
 * 规则：
 * - zip 必须含 SKILL.md（入口文件）,且通过现有 validateSkill 校验。
 * - zip 内路径不得越界（zip-reader 已强制：拒绝对路径 / .. / 盘符 / 反斜杠）。
 * - 同步 Skill 是远端镜像,允许覆盖本地目录：写入前清空目录内非 .git 文件,再写入 zip 条目。
 * - 覆盖前不删历史 commit（readSkillFileAtSha 仍可按旧 sha 读历史 run）。
 * - 写入后 git add + commit,返回新 commitSha（由 sync-service 用于创建 SkillVersion）。
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  SkillRepoError,
  SkillValidationError,
  commitSkillVersion,
  skillDir,
  validateSkill,
} from "@/lib/skill/repo";
import { writeSkillFile } from "@/lib/skill/repo";
import { type ZipEntry, ZipReadError, readZipEntries } from "@/lib/skill/sync/zip-reader";

export class ArtifactImportError extends Error {}

/**
 * 把 zip 内容写入指定 skill 目录并提交,返回新 commitSha。
 *
 * @param zip artifact zip 字节
 * @param skillName 本地 skill 目录名（已校验合法）
 * @returns 新 commit sha
 */
export async function importArtifactZip(zip: Buffer, skillName: string): Promise<string> {
  // 1. 解压 + 校验路径安全
  let entries: ZipEntry[];
  try {
    entries = readZipEntries(zip);
  } catch (e) {
    if (e instanceof ZipReadError) {
      throw new ArtifactImportError(`artifact zip 解析失败：${e.message}`);
    }
    throw e;
  }
  if (entries.length === 0) {
    throw new ArtifactImportError("artifact zip 无文件条目");
  }

  // 2. 必须含 SKILL.md（包根,经 zip-reader 剥掉顶层目录后）
  const skillMd = entries.find((e) => e.path === "SKILL.md");
  if (!skillMd) {
    throw new ArtifactImportError("artifact 缺少入口文件 SKILL.md");
  }

  // 3. SKILL.md 通过现有校验（name / description 等）
  try {
    validateSkill(skillMd.content.toString("utf8"));
  } catch (e) {
    if (e instanceof SkillValidationError || e instanceof SkillRepoError) {
      throw new ArtifactImportError(`SKILL.md 校验失败：${e.message}`);
    }
    throw e;
  }

  // 4. 覆盖前清空 skill 目录内非 .git 文件（同步 Skill 是镜像,可覆盖）
  await clearSkillDirExceptGit(skillName);

  // 5. 写入全部条目
  for (const entry of entries) {
    await writeSkillFile(skillName, entry.path, entry.content.toString("utf8"));
  }

  // 6. 提交 git 快照,返回 commitSha
  try {
    return await commitSkillVersion(skillName, `sync from capability-market: ${skillName}`);
  } catch (e) {
    // 同步覆盖后若内容与上次一致,git 无改动 → commitSkillVersion 抛 SkillRepoError
    // 同步场景下应避免：sync-service 已通过 hash 比较避免无变化导入,此处兜底抛错
    throw new ArtifactImportError(`git commit 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 清空 skill 目录内所有文件,保留 .git（skills/ 仓库的 .git 在仓库根,不在 skill 目录内,
 * 但防御性跳过）。skill 目录路径已由 skillDir 校验。
 */
async function clearSkillDirExceptGit(skillName: string): Promise<void> {
  const dir = skillDir(skillName);
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    await rm(join(dir, entry.name), { recursive: true, force: true });
  }
}
