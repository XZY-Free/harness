/**
 * Skill 内容缓存（替代原 git 仓库范式）。
 *
 * 设计（2026-10-17 定稿）：
 * - 工作副本：`<root>/<name>/` —— Studio 读写、编辑的目录（不含 .git）。
 * - 版本快照：`<root>/.snapshots/<name>/<hash>/` —— 按**正文内容 hash**（sha256 hex）
 *   分目录保存的历史快照；`createSnapshot` 落盘，运行时 `readSkillFileAtHash`
 *   按 hash 读取（回滚 / 历史 run 复现用）。只保留当前版本之外按需清理（见 pruneSnapshots）。
 *
 * 与旧范式（git 仓库）的区别：
 * - 版本身份从 git commitSha 改为**正文内容 hash**（sha256: + 64 hex）。
 * - 不再依赖简单 git 操作；快照即目录拷贝。
 * - `SkillVersion.contentRef` / `contentHash` 均使用该 hash，与运行时
 *   Fragment 的 `computeFragmentContentHash`（对 SKILL.md 正文取 sha256）同源。
 *
 * 路径安全：沿用 resolve + startsWith 拒 `..`；realpath 校验拒 symlink 越界。
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { skillsConfig } from "@/lib/config";
import { parseSkillMd } from "@/lib/skill/frontmatter";
import { load as yamlLoad } from "js-yaml";

export class SkillRepoError extends Error {}

/**
 * skill 发布校验失败(缺 name/description、非法 YAML、未知 tools 等)。
 *
 * 与 SkillRepoError 区分:校验失败是用户输入问题 → 路由层返回 400;
 * 其他 SkillRepoError(路径越界、IO 故障)→ 500 或回退逻辑。
 */
export class SkillValidationError extends SkillRepoError {}

/** Agent Skills 标准 name：小写字母数字 + 单连字符，1-64 字符。 */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export function assertValidSkillName(name: string): void {
  if (!name || name.length > 64 || !NAME_RE.test(name)) {
    throw new SkillRepoError(`非法 skill name（须小写字母数字+单连字符，1-64）：${name}`);
  }
}

/** 快照 hash 目录名格式（sha256 hex，无前缀；对应 contentHash 去掉 `sha256:`）。 */
const SNAPSHOT_HASH_RE = /^[0-9a-f]{64}$/;

/** skills 缓存根（绝对路径）。 */
export function skillsRepoRoot(): string {
  return resolve(skillsConfig.root);
}

/** 单个 skill 工作副本目录绝对路径。 */
export function skillDir(name: string): string {
  assertValidSkillName(name);
  return resolve(skillsRepoRoot(), name);
}

/** 快照根目录（`<root>/.snapshots`）。 */
function snapshotsRoot(): string {
  return resolve(skillsRepoRoot(), ".snapshots");
}

/** 某个 skill 版本快照根（`<root>/.snapshots/<name>`）。 */
function skillSnapshotsDir(name: string): string {
  assertValidSkillName(name);
  return resolve(snapshotsRoot(), name);
}

/** 某个版本的快照目录（`<root>/.snapshots/<name>/<hashHex>`）。 */
function snapshotDir(name: string, hashHex: string): string {
  assertValidSkillName(name);
  if (!SNAPSHOT_HASH_RE.test(hashHex)) {
    throw new SkillRepoError(`非法内容 hash（须 64 hex）：${hashHex}`);
  }
  return resolve(skillSnapshotsDir(name), hashHex);
}

/** 安全解析 skill 内文件路径，拒 `..` 越界。返回绝对路径。 */
function safeSkillFilePath(name: string, relPath: string): string {
  assertValidSkillName(name);
  const root = skillDir(name);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new SkillRepoError(`非法路径（越界 skill 目录）：${relPath}`);
  }
  return target;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * realpath 解析符号链接后校验结果仍在 skill 目录内。
 * safeSkillFilePath 仅做词法边界检查（resolve + startsWith），不解析 symlink。
 * 若 skill 目录内被放置了指向外部的 symlink，readFile / writeFile 会沿 symlink 读写外部文件。
 * realpath 解析所有 symlink 层级后重新校验边界，堵住此穿越。
 *
 * 注意：root 也需 realpath 解析（macOS /var → /private/var），否则比较失败。
 */
async function assertRealpathInRoot(root: string, target: string): Promise<void> {
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new SkillRepoError(`非法路径（符号链接越界 skill 目录）：${target}`);
    }
  } catch (err) {
    if (isEnoent(err)) {
      await assertNoSymlinkAncestor(root, target);
      return;
    }
    throw err;
  }
}

/** 检查从 root 到 target 的路径上是否有 symlink 祖先目录（写入新文件场景）。 */
async function assertNoSymlinkAncestor(root: string, target: string): Promise<void> {
  let current = dirname(target);
  while (current !== root && current.startsWith(root + sep)) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new SkillRepoError(`非法路径（父目录含符号链接）：${current}`);
      }
    } catch (err) {
      if (isEnoent(err)) {
        current = dirname(current);
        continue;
      }
      throw err;
    }
    current = dirname(current);
  }
}

/** 判断 skill 工作副本目录是否存在。 */
export async function skillDirExists(name: string): Promise<boolean> {
  try {
    await readdir(skillDir(name));
    return true;
  } catch {
    return false;
  }
}

/** 建空 skill 工作副本目录（不写文件）。 */
export async function createSkillDir(name: string): Promise<void> {
  await mkdir(skillDir(name), { recursive: true });
}

/** 写 skill 工作副本文件（自动建父目录），返回相对路径。 */
export async function writeSkillFile(
  name: string,
  relPath: string,
  content: string,
): Promise<string> {
  const root = skillDir(name);
  const target = safeSkillFilePath(name, relPath);
  await assertRealpathInRoot(root, target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return relPath;
}

/** 读 skill 工作副本文件；不存在返回 null。 */
export async function readSkillFile(name: string, relPath: string): Promise<string | null> {
  const root = skillDir(name);
  const target = safeSkillFilePath(name, relPath);
  try {
    await assertRealpathInRoot(root, target);
    return await readFile(target, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** 递归列出 skill 工作副本所有文件（相对 skill 根的路径）。 */
export async function listSkillFiles(name: string): Promise<string[]> {
  const root = skillDir(name);
  const out: string[] = [];
  async function walk(dir: string, prefix: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".snapshots") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  }
  await walk(root, "");
  return out;
}

// ─── 内容 hash 与快照 ──────────────────────────────────────

/** 计算 skill 内容 hash（sha256: 前缀，对 SKILL.md 正文取 sha256；与运行时段一致）。 */
export function computeSkillContentHash(skillMdText: string): string {
  return `sha256:${createHash("sha256").update(skillMdText, "utf8").digest("hex")}`;
}

/** 去掉 `sha256:` 前缀得到快照目录名（64 hex）；非法抛错。 */
function hashToSnapshotKey(contentHash: string): string {
  if (!contentHash.startsWith("sha256:")) {
    throw new SkillRepoError(`非法 contentHash（须 sha256: 前缀）：${contentHash}`);
  }
  const hex = contentHash.slice("sha256:".length);
  if (!SNAPSHOT_HASH_RE.test(hex)) {
    throw new SkillRepoError(`非法 contentHash（须 64 hex）：${contentHash}`);
  }
  return hex;
}

/**
 * 把 skill 工作副本快照到 `<root>/.snapshots/<name>/<hashHex>/`，
 * 返回内容 hash（`sha256:<64hex>`）。
 *
 * 快照内容 = 工作副本当前全部文件（不含 .snapshots）。同一 hash 已存在则跳过拷贝（幂等）。
 * 不再有 git commit；版本身份即该内容 hash。
 */
export async function createSkillSnapshot(name: string): Promise<string> {
  const skillMd = await readSkillFile(name, "SKILL.md");
  if (!skillMd) {
    throw new SkillRepoError(`skill「${name}」缺 SKILL.md，无法快照`);
  }
  const contentHash = computeSkillContentHash(skillMd);
  const hashHex = hashToSnapshotKey(contentHash);
  const dest = snapshotDir(name, hashHex);
  if (existsSync(dest)) return contentHash; // 幂等：同内容不重复快照
  await mkdir(dirname(dest), { recursive: true });
  await cp(skillDir(name), dest, { recursive: true });
  return contentHash;
}

/**
 * 读指定内容 hash 下的 skill 文件（运行时按冻结 hash 复现历史内容）。
 * 文件不存在 / hash 非法 → null。
 *
 * 大小上限 + 二进制扩展名检测：大文件截断，二进制不读入上下文。
 */
const SKILL_FILE_MAX_BYTES = 256 * 1024; // 256KB
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".rar",
  ".7z",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".webm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
]);

export async function readSkillFileAtHash(
  name: string,
  contentHash: string,
  relPath: string,
): Promise<string | null> {
  assertValidSkillName(name);
  const hashHex = hashToSnapshotKey(contentHash);
  const root = snapshotDir(name, hashHex);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new SkillRepoError(`非法路径（越界快照目录）：${relPath}`);
  }
  const ext = relPath.toLowerCase().slice(relPath.lastIndexOf("."));
  if (BINARY_EXTENSIONS.has(ext)) return null;
  try {
    const content = await readFile(target, "utf8");
    if (content.length > SKILL_FILE_MAX_BYTES) {
      return `${content.slice(0, SKILL_FILE_MAX_BYTES)}\n\n[... 文件过大,已截断到 ${SKILL_FILE_MAX_BYTES} bytes ...]`;
    }
    return content;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * 只保留给定 hash 之外的快照（回滚/历史复现按需从 capm 重拉时，可清理旧快照）。
 * `keepHash` 为空表示清空该 skill 的全部快照。
 *
 * 说明：默认策略为「只留当前版本」。调用方在切换 currentVersion 后传入新 hash。
 */
export async function pruneSkillSnapshots(name: string, keepHash: string | null): Promise<void> {
  assertValidSkillName(name);
  const dir = skillSnapshotsDir(name);
  const keepHex = keepHash ? hashToSnapshotKey(keepHash) : null;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (keepHex && entry.name === keepHex) continue;
    await rm(join(dir, entry.name), { recursive: true, force: true });
  }
}

/** 删除 skill 工作副本与全部快照（软停用/归档时的清理，非必需）。 */
export async function removeSkillCache(name: string): Promise<void> {
  assertValidSkillName(name);
  await rm(skillDir(name), { recursive: true, force: true });
  await rm(skillSnapshotsDir(name), { recursive: true, force: true });
}

/**
 * skill 发布校验。检查 SKILL.md 可解析 + name 非空 + description 显式存在 + tools 引用在已知工具集。
 * @throws SkillValidationError 如果校验失败(路由层应返回 400)。
 *
 * 注意:description 校验要求 frontmatter **显式**含 description 字段(不能仅靠 name 退回),
 * 因为 description 是 skill 触发关键词的来源,缺失会导致自动匹配失效。
 */
export function validateSkill(content: string, knownTools?: Set<string>): void {
  let meta: ReturnType<typeof parseSkillMd>;
  try {
    meta = parseSkillMd(content);
  } catch (e) {
    throw new SkillValidationError(
      e instanceof Error ? e.message : "SKILL.md frontmatter 解析失败",
    );
  }
  if (!meta.name || meta.name.trim().length === 0) {
    throw new SkillValidationError("SKILL.md frontmatter 缺 name 字段");
  }
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    let fmObj: unknown;
    try {
      fmObj = yamlLoad(fmMatch[1] ?? "");
    } catch {
      // parseSkillMd 已通过,这里不会失败
    }
    if (fmObj && typeof fmObj === "object" && !Array.isArray(fmObj)) {
      const descRaw = (fmObj as Record<string, unknown>).description;
      if (typeof descRaw !== "string" || descRaw.trim().length === 0) {
        throw new SkillValidationError("SKILL.md frontmatter 缺 description 字段");
      }
    }
  }
  if (knownTools && meta.tools) {
    for (const t of meta.tools) {
      if (!knownTools.has(t)) {
        throw new SkillValidationError(`SKILL.md 引用了未知工具: ${t}`);
      }
    }
  }
}

/**
 * 发布 skill 新版本：校验工作副本 SKILL.md → 快照到内容 hash 目录，返回内容 hash。
 *
 * 前置：工作副本已由调用方写入（Studio 编辑 / sync 导入）。
 * 无 SKILL.md → 抛 SkillRepoError。校验失败 → 抛 SkillValidationError。
 */
export async function publishSkillSnapshot(name: string): Promise<string> {
  const skillContent = await readSkillFile(name, "SKILL.md");
  if (!skillContent) {
    throw new SkillRepoError(`skill「${name}」缺 SKILL.md，无法发布`);
  }
  validateSkill(skillContent);
  return createSkillSnapshot(name);
}
