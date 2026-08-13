import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { skillsConfig } from "@/lib/config";
import { parseSkillMd } from "@/lib/skill/frontmatter";
import { load as yamlLoad } from "js-yaml";
import { type SimpleGit, simpleGit } from "simple-git";

/**
 * Skill 目录仓库（Agent Skills 开放标准）。
 *
 * skill 不再是 DB 里一段 promptTemplate 文本，而是磁盘上一个标准 skill 目录：
 * skills/<name>/SKILL.md（YAML frontmatter name/description + 正文）+ 任意支持文件。
 * skills/ 整体是一个独立 git 仓库（范式同 workspaces/{threadId}/，父项目 gitignore 排除）。
 * 版本快照 = git commit，SkillVersion.commitSha 指向该 commit。
 *
 * 路径安全：复用 workspace.ts 的词法边界风格（resolve + startsWith 拒 `..`）。
 * skill name 校验遵循 Agent Skills 标准（小写字母数字 + 单连字符，1-64）。
 */

export class SkillRepoError extends Error {}

/**
 * skill 发布校验失败(缺 name/description、非法 YAML、未知 tools 等)。
 *
 * 与 SkillRepoError 区分:校验失败是用户输入问题 → 路由层返回 400;
 * 其他 SkillRepoError(无改动、git 故障)→ 500 或回退逻辑。
 */
export class SkillValidationError extends SkillRepoError {}

/** Agent Skills 标准 name：小写字母数字 + 单连字符，1-64 字符。 */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export function assertValidSkillName(name: string): void {
  if (!name || name.length > 64 || !NAME_RE.test(name)) {
    throw new SkillRepoError(`非法 skill name（须小写字母数字+单连字符，1-64）：${name}`);
  }
}

/** skills/ 仓库根（绝对路径）。 */
export function skillsRepoRoot(): string {
  return resolve(skillsConfig.root);
}

/** 单个 skill 目录绝对路径。 */
export function skillDir(name: string): string {
  assertValidSkillName(name);
  return resolve(skillsRepoRoot(), name);
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

/** 确保 skills/ git 仓库已 init，返回 SimpleGit 实例（baseDir=skillsRepoRoot）。 */
async function ensureRepo(): Promise<SimpleGit> {
  const root = skillsRepoRoot();
  await mkdir(root, { recursive: true });
  const git = simpleGit({ baseDir: root });
  if (!existsSync(join(root, ".git"))) {
    await git.init();
    await git.addConfig("user.name", "SnowHarness");
    await git.addConfig("user.email", "bot@snow-harness.local");
  }
  return git;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * 审计修复 H3：realpath 解析符号链接后校验结果仍在 skill 目录内。
 * safeSkillFilePath 仅做词法边界检查（resolve + startsWith），不解析 symlink。
 * 若 skill 目录内被放置了指向外部的 symlink（如 `skills/my-skill/config -> /etc/passwd`），
 * readFile / writeFile 会沿 symlink 读写外部文件。realpath 解析所有 symlink 层级后
 * 重新校验边界，堵住此穿越。
 *
 * 注意：root 也需 realpath 解析（macOS /var → /private/var，/tmp → /private/tmp），
 * 否则 root="/var/folders/..." 与 real="/private/var/folders/..." 比较失败。
 */
async function assertRealpathInSkillRoot(root: string, target: string): Promise<void> {
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

/** 判断 skill 目录是否存在（工作副本）。 */
export async function skillDirExists(name: string): Promise<boolean> {
  try {
    await readdir(skillDir(name));
    return true;
  } catch {
    return false;
  }
}

/** 建空 skill 目录（不写文件）。副作用：顺带 init skills/ 仓库。 */
export async function createSkillDir(name: string): Promise<void> {
  await ensureRepo();
  await mkdir(skillDir(name), { recursive: true });
}

/** 写 skill 工作副本文件（自动建父目录），返回相对路径。 */
export async function writeSkillFile(
  name: string,
  relPath: string,
  content: string,
): Promise<string> {
  await ensureRepo();
  const root = skillDir(name);
  const target = safeSkillFilePath(name, relPath);
  await assertRealpathInSkillRoot(root, target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return relPath;
}

/** 读 skill 工作副本文件；不存在返回 null。 */
export async function readSkillFile(name: string, relPath: string): Promise<string | null> {
  const root = skillDir(name);
  const target = safeSkillFilePath(name, relPath);
  try {
    await assertRealpathInSkillRoot(root, target);
    return await readFile(target, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** 递归列出 skill 工作副本所有文件（相对 skill 根的路径，跳过 .git）。 */
export async function listSkillFiles(name: string): Promise<string[]> {
  const root = skillDir(name);
  const out: string[] = [];
  async function walk(dir: string, prefix: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git") continue;
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

/**
 * 读指定版本（commitSha）下的 skill 文件。agent 加载 skill 的核心：按 thread 固化的
 * commitSha 读历史快照，不受工作副本后续编辑影响（§10 不回归）。
 * 文件不存在 / sha 非法 → null（或抛 SkillRepoError，见下）。
 *
 * P2 修复(11 Skill P2-4): 大文件/二进制限制。
 * 原实现 git.show 全量读文件,大文件(如 references 下大 markdown 或二进制图片)
 * 会全量灌入 agent 上下文。现加大小上限 + 二进制扩展名检测,超限截断或跳过。
 */
const SKILL_FILE_MAX_BYTES = 256 * 1024; // 256KB,对齐 readFile 限制
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

export async function readSkillFileAtSha(
  name: string,
  relPath: string,
  sha: string,
): Promise<string | null> {
  assertValidSkillName(name);
  safeSkillFilePath(name, relPath); // 词法校验 relPath
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
    throw new SkillRepoError(`非法 commitSha：${sha}`);
  }
  // P2: 二进制文件跳过(不读入上下文)
  const ext = relPath.toLowerCase().slice(relPath.lastIndexOf("."));
  if (BINARY_EXTENSIONS.has(ext)) {
    return null;
  }
  const git = await ensureRepo();
  try {
    const content = await git.show([`${sha}:${name}/${relPath}`]);
    // P2: 大文件截断
    if (typeof content === "string" && content.length > SKILL_FILE_MAX_BYTES) {
      return `${content.slice(0, SKILL_FILE_MAX_BYTES)}\n\n[... 文件过大,已截断到 ${SKILL_FILE_MAX_BYTES} bytes ...]`;
    }
    return content;
  } catch {
    return null;
  }
}

/**
 * 发布 skill 新版本：把该 skill 工作副本的改动 git add + commit，返回新 commit sha。
 * 无改动 → 抛 SkillRepoError（调用方应提示先编辑再发布）。
 */
/**
 * skill 发布校验。检查 SKILL.md 可解析 + name 非空 + description 显式存在 + tools 引用在已知工具集。
 * @throws SkillValidationError 如果校验失败(路由层应返回 400)。
 *
 * 注意:description 校验要求 frontmatter **显式**含 description 字段(不能仅靠 name 退回),
 * 因为 description 是 skill 触发关键词的来源,缺失会导致自动匹配失效。
 */
export function validateSkill(content: string, knownTools?: Set<string>): void {
  // parseSkillMd 失败(缺 frontmatter / 非法 YAML / 缺 name)统一转 SkillValidationError
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
  // description 必须显式存在(parseSkillMd 缺 description 时退回 name,这里需要检查原始 frontmatter)
  // 重新解析原始 YAML 取 description 字段,判断是否显式提供
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
  // tools 引用校验（可选——knownTools 传入时才检查）
  if (knownTools && meta.tools) {
    for (const t of meta.tools) {
      if (!knownTools.has(t)) {
        throw new SkillValidationError(`SKILL.md 引用了未知工具: ${t}`);
      }
    }
  }
}

export async function commitSkillVersion(name: string, message: string): Promise<string> {
  // 发布前校验工作副本 SKILL.md（即将 commit 的内容）。
  // 校验失败 → 抛 SkillRepoError 阻断发布（不再 warn 吞掉）。
  // 调用方（createSkill 路由等）捕获后返回 400 错误信息给前端。
  const skillContent = await readSkillFile(name, "SKILL.md");
  if (skillContent) {
    validateSkill(skillContent); // 抛 SkillRepoError → 阻断 commit
  }
  const git = await ensureRepo();
  await git.add([`${name}/`]);
  const status = await git.status();
  if (status.staged.length === 0) {
    throw new SkillRepoError("无改动，无需发布新版本");
  }
  await git.commit(message);
  return (await git.revparse(["HEAD"])).trim();
}

/** 返回当前 HEAD 是否包含该 skill 的 SKILL.md；用于发布失败后的重试恢复。 */
export async function getSkillHeadSha(name: string): Promise<string | null> {
  assertValidSkillName(name);
  const git = await ensureRepo();
  try {
    await git.raw(["cat-file", "-e", `HEAD:${name}/SKILL.md`]);
    return (await git.revparse(["HEAD"])).trim();
  } catch {
    return null;
  }
}

/** 两版本间 skill 的 diff（git diff <from> <to> -- <name>/）。 */
export async function diffSkill(name: string, fromSha: string, toSha: string): Promise<string> {
  const git = await ensureRepo();
  return await git.diff([fromSha, toSha, "--", `${name}/`]);
}
