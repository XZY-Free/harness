import { existsSync } from "node:fs";
import { join } from "node:path";
import { workspaceRoot } from "@/lib/workspace";
import { simpleGit } from "simple-git";

/**
 * : git ref/分支名安全校验。
 * 拒绝 `--` 前缀(参数注入如 `--upload-pack=`)、`..`(路径穿越)、空格/控制字符/`:~^`(refspec 元字符)。
 * simple-git 用数组传参不经 shell,但 ref 名仍进 git 选项位,需防 git 参数注入。
 */
export function assertGitRefName(name: string): void {
  // P2-7: 白名单为主 + 显式拒 refspec 元字符(原黑名单漏 @{、//、前导 .、控制字符)
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(name) ||
    name.includes("..") ||
    name.includes("@{") ||
    name.endsWith(".lock") ||
    name.endsWith("/") ||
    name.endsWith(".")
  ) {
    throw new Error(`非法 git 分支名: ${name}`);
  }
}

/**
 * Stage A：细粒度 git 原语层（蓝图 §9 / plan §5）。
 *
 * 基于 `simple-git`（已是依赖），`simpleGit({ baseDir: workspaceRoot(threadId) })`
 * 直读宿主路径——workspace 是 bind mount，宿主可直读写，与现有 `deliverToGit` 一致；
 * 不走 `ExecutionRuntime.exec`（避免 30s 超时，git ops 可能慢）。
 *
 * 写原语（add/commit/branch/push/tag/reset/ensureRemote）在工作区非 repo 时按需 `git.init()`，
 * 并设置 bot 提交身份（与 `deliverToGit` 既有逻辑对齐）。读原语（status/diff）只探测是否 repo，
 * 不 auto-init——对非 repo 工作区诚实返回 `isRepo:false`，而非副作用式地造一个空 repo。
 *
 * repo 探测用 `existsSync(join(cwd, ".git"))` 而非 `checkIsRepo()`：父目录 snow-harness 本身是
 * git repo 会让 checkIsRepo 误判为 true，导致 git 操作落到父仓库、被父 .gitignore 拦截
 * （与 deliverToGit 同一防护）。
 */

const BOT_NAME = "SnowHarness";
const BOT_EMAIL = "bot@snow-harness.local";

/** diff 文本上限（避免把超大 diff 灌入 agent 上下文，完整 diff 走 ToolRun/artifact）。 */
const MAX_DIFF_BYTES = 20_000;

/**
 * git ops 超时（ms），默认 60s，env 可配。原无超时，push 可能挂死 agent。
 *
 * 走 getter 而非顶层 const：测试与运行时动态读 env，改 `SNOW_GIT_OP_TIMEOUT_MS` 立即生效，
 * 无需重新 import。NaN / 非正数回退默认 60s。
 */
function gitOpTimeoutMs(): number {
  const raw = process.env.SNOW_GIT_OP_TIMEOUT_MS ?? "60000";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

/**
 * 带超时的 promise 包装（git ops 可能因网络/大 repo 挂死）。
 * 导出供 deliver.ts 复用（extraHeader push 分支需同一超时语义）。
 */
export function withGitTimeout<T>(p: Promise<T>, ms = gitOpTimeoutMs()): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`git op 超时（${ms}ms）`)), ms),
    ),
  ]);
}

function git(threadId: string) {
  return simpleGit({ baseDir: workspaceRoot(threadId) });
}

/** 工作区自身是否已是 repo 根（防父 repo 误判，见上方注释）。 */
function isRepoAt(threadId: string): boolean {
  return existsSync(join(workspaceRoot(threadId), ".git"));
}

/**
 * 写原语前置：非 repo 则 `git.init()`，并确保 bot 提交身份（与 deliverToGit 一致）。
 * 返回配好身份的 simpleGit 实例。
 */
async function ensureRepo(threadId: string) {
  const g = git(threadId);
  if (!isRepoAt(threadId)) {
    await withGitTimeout(g.init());
  }
  await withGitTimeout(g.addConfig("user.name", BOT_NAME));
  await withGitTimeout(g.addConfig("user.email", BOT_EMAIL));
  return g;
}

// ─── 读原语 ──────────────────────────────────────────────────

export type GitStatusResult = {
  isRepo: boolean;
  current: string | null;
  staged: string[];
  modified: string[];
  untracked: string[];
  ahead: number;
  behind: number;
};

/** `git status` → 结构化（非 repo 工作区返回 isRepo:false，不 init）。 */
export async function gitStatus(threadId: string): Promise<GitStatusResult> {
  if (!isRepoAt(threadId)) {
    return {
      isRepo: false,
      current: null,
      staged: [],
      modified: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    };
  }
  const s = await withGitTimeout(git(threadId).status());
  return {
    isRepo: true,
    current: s.current,
    staged: s.staged,
    modified: s.modified,
    untracked: s.not_added,
    ahead: s.ahead,
    behind: s.behind,
  };
}

export type GitDiffResult = { diff: string; truncated: boolean };

/** `git diff`（工作区未暂存改动）→ 限长文本 + truncated 标记。 */
export async function gitDiff(
  threadId: string,
  opts?: { pathFilter?: string },
): Promise<GitDiffResult> {
  if (!isRepoAt(threadId)) return { diff: "", truncated: false };
  const g = git(threadId);
  // pathFilter 走 raw 以稳定支持 pathspec（`git diff -- <path>`）；无 filter 用 .diff()。
  const diff = opts?.pathFilter
    ? await withGitTimeout(g.raw(["diff", "--", opts.pathFilter]))
    : await withGitTimeout(g.diff());
  const truncated = diff.length > MAX_DIFF_BYTES;
  return { diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff, truncated };
}

/** 取远程 `name`（默认 origin）的 URL；远程不存在返回 null。只读，不 init。 */
export async function gitRemoteUrl(threadId: string, name = "origin"): Promise<string | null> {
  if (!isRepoAt(threadId)) return null;
  const g = git(threadId);
  const remotes = await withGitTimeout(g.getRemotes(true));
  const r = remotes.find((x) => x.name === name);
  return r?.refs?.fetch ?? r?.refs?.push ?? null;
}

// ─── 写原语 ──────────────────────────────────────────────────

/** `git add <paths|.|>`（非 repo 则先 init + 配身份）。 */
export async function gitAdd(threadId: string, paths?: string[]): Promise<void> {
  const g = await ensureRepo(threadId);
  await withGitTimeout(g.add(paths ?? "."));
}

export type GitCommitResult = { commitSha?: string; nothingToCommit?: boolean };

/**
 * `git commit -m <message>` → commitSha；无改动返回 `{ nothingToCommit: true }`
 * （与 deliverToGit 既有「swallow nothing-to-commit」语义一致，不抛错）。
 */
export async function gitCommit(threadId: string, message: string): Promise<GitCommitResult> {
  const g = await ensureRepo(threadId);
  try {
    const res = await withGitTimeout(g.commit(message));
    if (!res.commit) return { nothingToCommit: true };
    return { commitSha: res.commit };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/nothing to commit|no changes added/i.test(msg)) {
      return { nothingToCommit: true };
    }
    throw err;
  }
}

/**
 * 创建并切换到新分支（`git checkout -b <name> HEAD`）。
 * 若 `name` 已是当前分支则视为成功（幂等，供 deliverToGit 复用）。
 */
export async function gitBranch(threadId: string, name: string): Promise<void> {
  assertGitRefName(name);
  const g = await ensureRepo(threadId);
  const status = await withGitTimeout(g.status());
  if (status.current === name) return;
  await withGitTimeout(g.checkoutBranch(name, "HEAD"));
}

/** `git push <remote> <branch> [--force] [--set-upstream]`（默认设上游、非 force）。 */
export async function gitPush(
  threadId: string,
  opts: { remote: string; branch: string; force?: boolean },
): Promise<{ pushed: boolean; branch: string; remote: string }> {
  assertGitRefName(opts.branch);
  const g = await ensureRepo(threadId);
  const args: string[] = ["--set-upstream"];
  if (opts.force) args.push("--force");
  await withGitTimeout(g.push(opts.remote, opts.branch, args));
  return { pushed: true, branch: opts.branch, remote: opts.remote };
}

export type GitTagResult = { tag: string; commitSha: string };

/**
 * `git tag <name>`（轻量 tag，指向当前 HEAD）。返回 tag 名与所指向的 commitSha。
 * 无 commit 时 `rev-parse HEAD` 失败 → 抛错（checkpoint 必须有可指向的 commit）。
 */
export async function gitTag(threadId: string, name: string): Promise<GitTagResult> {
  const g = await ensureRepo(threadId);
  const commitSha = (await withGitTimeout(g.raw(["rev-parse", "HEAD"]))).trim();
  await withGitTimeout(g.addTag(name));
  return { tag: name, commitSha };
}

/** `git reset --hard <ref>`（不可逆，调用方负责 ask 审批）。 */
export async function gitResetHard(threadId: string, ref: string): Promise<void> {
  const g = await ensureRepo(threadId);
  await withGitTimeout(g.reset(["--hard", ref]));
}

/**
 * 确保远程 `name` 存在且 URL 为 `url`：已存在则 `remote set-url`，否则 `remote add`。
 * （从 deliverToGit 抽出，供 deliverToGit 重构与未来 agent 远程管理复用。）
 */
export async function ensureRemote(threadId: string, name: string, url: string): Promise<void> {
  const g = await ensureRepo(threadId);
  const remotes = await withGitTimeout(g.getRemotes(true));
  if (remotes.some((r) => r.name === name)) {
    await withGitTimeout(g.remote(["set-url", name, url]));
  } else {
    await withGitTimeout(g.addRemote(name, url));
  }
}
