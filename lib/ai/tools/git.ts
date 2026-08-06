import { executeToolRun } from "@/lib/ai/tool-runtime";
import { prConfig } from "@/lib/config";
import { appendThreadEvent, updateThreadStatus } from "@/lib/db/queries";
import { buildDeliverySummary } from "@/lib/delivery/summary";
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "@/lib/git/checkpoint";
import { composeCommitMessage, validateCommitMessage } from "@/lib/git/commit-message";
import {
 gitAdd,
 gitBranch,
 gitCommit,
 gitDiff,
 gitPush,
 gitRemoteUrl,
 gitStatus,
} from "@/lib/git/ops";
import { workspaceRoot } from "@/lib/workspace";
import { tool } from "ai";
import { execa } from "execa";
import { z } from "zod";

/**
 * Stage B：git 工具组（plan §6）。
 *
 * 7 个工具均经 `executeToolRun` 包裹（权限引擎自动收口）：
 * - `gitStatus` / `gitDiff`：read，不触发 ask。
 * - `gitCheckpoint` / `gitRestoreCheckpoint` / `gitCreateBranch` / `gitCommit` / `gitPush`：
 * 写操作默认 `ask`（规则在 lib/permission/rules.ts），审批后执行。
 *
 * checkpoint/restore 经 `lib/git/checkpoint.ts` 编排（tag + GitCheckpoint 表 + 事件）；
 * 其余直接调 `lib/git/ops.ts` 原语。git ops 用 `workspaceRoot(threadId)` 直读宿主路径，
 * 与 deliverToGit 一致，不走 ExecutionRuntime.exec（避免 30s 超时）。
 *
 * `gitCommit` 软约束：commit 前应先 `gitStatus`/`gitDiff`。此处不硬阻断（保 agent 自主性），
 * 由 deliverySummary 的 `blindCommit` 审计标记覆盖（Stage C）。
 */

/** 构造 git 工具集（仅需 threadId；ops 自行解析 workspaceRoot）。 */
export function buildGitTools(threadId: string) {
 return {
 gitStatus: tool({
 description:
 "查看当前项目工作区的 git 状态（当前分支、staged/modified/untracked 文件、ahead/behind）。只读，不触发审批。" +
 "提交前应先调用本工具查看改动。",
 inputSchema: z.object({}),
 execute: async () => {
 try {
 return await executeToolRun(threadId, "gitStatus", {}, async (signal) => {
 const s = await gitStatus(threadId);
 return {
 ok: true,
 isRepo: s.isRepo,
 current: s.current,
 staged: s.staged,
 modified: s.modified,
 untracked: s.untracked,
 ahead: s.ahead,
 behind: s.behind,
 };
 });
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
 },
 }),

 gitDiff: tool({
 description:
 "查看当前项目工作区的未暂存改动（git diff）。返回限长 diff 文本与 truncated 标记。只读，不触发审批。" +
 "可用 pathFilter 限定单个文件路径。",
 inputSchema: z.object({
 pathFilter: z.string().optional().describe("仅查看该相对路径文件的 diff"),
 }),
 execute: async ({ pathFilter }) => {
 try {
 return await executeToolRun(threadId, "gitDiff", { pathFilter }, async (signal) => {
 const r = await gitDiff(threadId, { pathFilter });
 return { ok: true, diff: r.diff, truncated: r.truncated };
 });
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
 },
 }),

 gitCheckpoint: tool({
 description:
 "在当前 HEAD 创建一个轻量 tag 快照（snow-checkpoint-*），便于后续 gitRestoreCheckpoint 回滚。" +
 "风险操作前（如 gitPush / gitCommit）建议先打 checkpoint。默认需审批。",
 inputSchema: z.object({
 reason: z.string().describe("创建 checkpoint 的原因，如「before gitPush」"),
 }),
 execute: async ({ reason }) => {
 try {
 return await executeToolRun(threadId, "gitCheckpoint", { reason }, async (signal) => {
 const cp = await createCheckpoint(threadId, { reason });
 return {
 ok: true,
 checkpointId: cp.id,
 tag: cp.tag,
 commitSha: cp.commitSha,
 };
 });
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
 },
 }),

 gitRestoreCheckpoint: tool({
 description:
 "回滚到指定 checkpoint：执行 git reset --hard <tag>（不可逆，未提交改动会丢失）。默认需审批。" +
 "checkpointId 由 gitCheckpoint 返回，或经 delivery 面板查看历史。",
 inputSchema: z.object({
 checkpointId: z.string().describe("要回滚到的 checkpoint id"),
 }),
 execute: async ({ checkpointId }) => {
 try {
 return await executeToolRun(
 threadId,
 "gitRestoreCheckpoint",
 { checkpointId },
 async (signal) => {
 const cp = await restoreCheckpoint(threadId, checkpointId);
 return {
 ok: true,
 checkpointId: cp.id,
 tag: cp.tag,
 restoredTo: cp.commitSha,
 restoredAt: cp.restoredAt,
 };
 },
 );
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
 },
 }),

 gitCreateBranch: tool({
 description: "从当前 HEAD 创建并切换到新分支（git checkout -b）。默认需审批。",
 inputSchema: z.object({
 name: z.string().describe("新分支名，如 feature-login"),
 }),
 execute: async ({ name }) => {
 try {
 return await executeToolRun(threadId, "gitCreateBranch", { name }, async (signal) => {
 await gitBranch(threadId, name);
 return { ok: true, branch: name };
 });
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
 },
 }),

 gitCommit: tool({
 description:
 "暂存全部改动并提交（git add . + git commit）。commit message 用 Lore trailer 协议，" +
 "入参为结构化字段（subject + Constraint/Rejected/Confidence/Scope-risk/Tested/Not-tested）。" +
 "提交前应先 gitStatus/gitDiff 查看改动（软约束）。默认需审批。无改动返回 nothingToCommit。",
 inputSchema: z.object({
 subject: z.string().describe("commit 主题行（祈使句，如 feat: 新增登录页）"),
 constraint: z.string().optional().describe("本次改动受到的硬约束"),
 rejected: z.string().optional().describe("考虑过但放弃的方案及原因"),
 confidence: z.string().optional().describe("置信度：high / medium / low"),
 scopeRisk: z.string().optional().describe("影响面与风险：narrow / moderate / broad"),
 tested: z.string().optional().describe("已验证项（命令/场景）"),
 notTested: z.string().optional().describe("未验证空白"),
 }),
 execute: async (fields) => {
 try {
 // commit message 规范校验——subject 校验失败阻断提交，
 // conventional 不符仅 warn（不阻断）。校验在 executeToolRun 外层做，
 // 避免无谓的 toolRun 记录（校验失败不构成一次工具执行）。
 const validation = validateCommitMessage(fields.subject);
 if (!validation.valid) {
 return { ok: false, error: validation.warning };
 }
 return await executeToolRun(
 threadId,
 "gitCommit",
 fields,
 async (signal) => {
 await gitAdd(threadId);
 const message = composeCommitMessage(fields);
 const res = await gitCommit(threadId, message);
 if (res.nothingToCommit) {
 return { ok: true, nothingToCommit: true, warning: validation.warning };
 }
 return { ok: true, commitSha: res.commitSha, warning: validation.warning };
 },
 // conventional warn 不阻断：warning 透传到结果，executeToolRun 正常执行
 );
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
 },
 }),

 gitPush: tool({
 description:
 "推送到远程分支（git push --set-upstream origin <branch>）。默认非 force；force 需显式传入且高风险。" +
 "默认需审批。push 成功后 thread 进入 delivering 生命周期（Stage D）。",
 inputSchema: z.object({
 branch: z.string().optional().describe("目标分支；不传则推当前分支"),
 remote: z.string().optional().describe("远程名，默认 origin"),
 force: z.boolean().optional().describe("是否 force push（覆盖远程历史，高风险）"),
 }),
 execute: async (args) => {
 const { branch, remote, force } = args;
 try {
 return await executeToolRun(threadId, "gitPush", args, async (signal?: AbortSignal) => {
 // branch 缺省取当前分支；无当前分支（空 repo）则报错
 let targetBranch = branch;
 if (!targetBranch) {
 const s = await gitStatus(threadId);
 targetBranch = s.current ?? undefined;
 }
 if (!targetBranch) {
 return { ok: false, error: "无法确定目标分支（工作区无当前分支）" };
 }
 try {
 const r = await gitPush(threadId, {
 remote: remote ?? "origin",
 branch: targetBranch,
 force: force === true,
 });
 // push 成功 → thread 进入 delivering 生命周期（plan §8）
 await appendThreadEvent(threadId, "agent.status_changed", {
 from: "ready_for_review",
 to: "delivering",
 reason: "git_push_succeeded",
 });
 await updateThreadStatus(threadId, "delivering");
 return { ok: true, pushed: true, branch: r.branch, remote: r.remote };
 } catch (error) {
 // push 的网络/认证/remote reject 属于可恢复工具失败；不要终结整个 thread。
 return { ok: false, error: (error as Error).message };
 }
 });
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
 },
 }),

 createPullRequest: tool({
 description:
 "为已推送的分支创建 Pull/Merge Request（GitHub gh/API、GitLab API）。不支持的平台或凭据缺失时" +
 "返回可人工打开的 fallback 链接，并明确以 ok:false 表示未真正创建 PR。默认需审批。",
 inputSchema: z.object({
 title: z.string().optional().describe("PR 标题；不传用最近 commit 主题行"),
 body: z.string().optional().describe("PR 正文"),
 targetBranch: z.string().optional().describe("目标分支；默认 PR_BASE_BRANCH 或 main"),
 }),
 execute: async (args) => {
 try {
 return await executeToolRun(threadId, "createPullRequest", args, async (signal) => {
 const s = await gitStatus(threadId);
 const branch = s.current;
 if (!branch) {
 return { ok: false, error: "无法确定当前分支" };
 }
 const remoteUrl = await gitRemoteUrl(threadId);
 const result = await createPullRequestViaProvider(threadId, {
 remoteUrl,
 branch,
 title: args.title,
 body: args.body,
 targetBranch: args.targetBranch,
 });
 return result;
 });
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
 },
 }),

 deliverySummary: tool({
 description:
 "聚合生成本次交付的带证据摘要：文件变更、测试结果、预览 URL、commit/PR 链接、blindCommit 标记。" +
 "只读，不触发审批。用于交付收尾与审计。",
 inputSchema: z.object({}),
 execute: async () => {
 try {
 return await executeToolRun(threadId, "deliverySummary", {}, async (signal) => {
 let summary: Awaited<ReturnType<typeof buildDeliverySummary>>;
 try {
 summary = await buildDeliverySummary(threadId);
 } catch (error) {
 await markDeliveryFailed(
 threadId,
 "delivering",
 "deliverySummary",
 (error as Error).message,
 );
 throw error;
 }
 // 仅在已推送时切 completed + delivery.succeeded（plan §8：delivering → completed）
 if (summary.pushed) {
 await appendThreadEvent(threadId, "delivery.succeeded", summary);
 await appendThreadEvent(threadId, "agent.status_changed", {
 from: "delivering",
 to: "completed",
 reason: "delivery_succeeded",
 });
 await updateThreadStatus(threadId, "completed");
 }
 return { ok: true, summary };
 });
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
 },
 }),
 };
}

/**
 * 交付失败统一处理：追加 `delivery.failed` + `agent.status_changed→failed`，并切 thread=failed。
 * 不留 delivering 悬空状态（plan §8 命门）。`from` 为失败时的名义源状态（projector 只用 to）。
 */
async function markDeliveryFailed(
 threadId: string,
 from: string,
 step: string,
 reason: string,
): Promise<void> {
 await appendThreadEvent(threadId, "delivery.failed", { step, reason });
 await appendThreadEvent(threadId, "agent.status_changed", {
 from,
 to: "failed",
 reason: "delivery_failed",
 });
 await updateThreadStatus(threadId, "failed");
}

// ─── createPullRequest 辅助 ─────────────────────────────────

type PrResult = {
 ok: boolean;
 prUrl?: string;
 deliveryLink: string;
 fallback: boolean;
 error?: string;
 provider?: "github" | "gitlab" | "fallback";
};

type ProviderFailure = { ok: false; error: string };

/** 从 remoteUrl 解析 GitHub owner/repo；非 GitHub 返回 null。 */
function parseGitHubRepo(remoteUrl: string | null): { owner: string; repo: string } | null {
 if (!remoteUrl) return null;
 // https://github.com/owner/repo(.git) | git@github.com:owner/repo(.git)
 const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#]|$)/.exec(remoteUrl);
 if (!m?.[1] || !m?.[2]) return null;
 return { owner: m[1], repo: m[2] };
}

function parseGitLabRepo(
 remoteUrl: string | null,
): { host: string; projectPath: string; webBaseUrl: string } | null {
 if (!remoteUrl) return null;
 const configured = new URL(prConfig.gitlabUrl);
 const hosts = new Set(["gitlab.com", configured.hostname]);
 try {
 const url = new URL(remoteUrl);
 if ((url.protocol === "http:" || url.protocol === "https:") && hosts.has(url.hostname)) {
 const projectPath = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
 if (!projectPath) return null;
 return {
 host: url.hostname,
 projectPath,
 webBaseUrl: `${url.protocol}//${url.hostname}`,
 };
 }
 } catch {
 // SSH remote 走下面的解析
 }
 const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remoteUrl);
 if (ssh?.[1] && ssh[2] && hosts.has(ssh[1].toLowerCase())) {
 return {
 host: ssh[1],
 projectPath: ssh[2],
 webBaseUrl: `${configured.protocol}//${ssh[1]}`,
 };
 }
 return null;
}

/**
 * 通过平台 provider 创建 Pull/Merge Request。
 *
 * 顺序：
 * - GitHub：优先 gh CLI；失败后若有 GITHUB_TOKEN，走 REST API。
 * - GitLab：若有 GITLAB_TOKEN，走 Merge Request API。
 * - 其他 remote / 凭据缺失 / provider 失败：返回可人工打开的分支/新建 MR 链接。
 *
 * provider 失败时返回 `ok:false + fallback:true + deliveryLink`，诚实暴露“未真正创建 PR”，
 * 但仍给出可人工打开的交付链接。
 */
async function createPullRequestViaProvider(
 threadId: string,
 params: {
 remoteUrl: string | null;
 branch: string;
 title?: string;
 body?: string;
 targetBranch?: string;
 },
): Promise<PrResult> {
 const gh = parseGitHubRepo(params.remoteUrl);
 if (gh) return createGitHubPullRequest(threadId, gh, params);

 const gl = parseGitLabRepo(params.remoteUrl);
 if (gl) return createGitLabMergeRequest(gl, params);

 return {
 ok: false,
 deliveryLink: params.remoteUrl ?? `(已推送分支 ${params.branch})`,
 fallback: true,
 provider: "fallback",
 error: "不支持的 Git remote provider",
 };
}

async function createGitHubPullRequest(
 threadId: string,
 repo: { owner: string; repo: string },
 params: { branch: string; title?: string; body?: string; targetBranch?: string },
): Promise<PrResult> {
 const fallbackLink = `https://github.com/${repo.owner}/${repo.repo}/pull/new/${params.branch}`;
 const title = params.title ?? `delivery: ${params.branch}`;
 const ghResult = await tryGhPullRequest(threadId, title, params.body);
 if (ghResult.ok) return ghResult;

 if (!prConfig.githubToken) {
 return {
 ok: false,
 deliveryLink: fallbackLink,
 fallback: true,
 provider: "github",
 error: ghResult.error ?? "GITHUB_TOKEN 未配置",
 };
 }

 const apiResult = await createGitHubPullRequestViaApi(repo, {
 branch: params.branch,
 targetBranch: params.targetBranch ?? prConfig.defaultBaseBranch,
 title,
 body: params.body,
 });
 if (apiResult.ok) return apiResult;

 return {
 ok: false,
 deliveryLink: fallbackLink,
 fallback: true,
 provider: "github",
 error: apiResult.error,
 };
}

async function tryGhPullRequest(
 threadId: string,
 title: string,
 body?: string,
): Promise<PrResult | ProviderFailure> {
 try {
 const args = ["pr", "create", "--title", title];
 if (body) args.push("--body", body);
 const res = await execa("gh", args, {
 cwd: workspaceRoot(threadId),
 timeout: 30_000,
 reject: false,
 });
 const stdout = (res.stdout ?? "").trim();
 // gh pr create 成功时输出 PR URL（https://github.com/.../pull/N）
 if (res.exitCode === 0 && /^https?:\/\//.test(stdout)) {
 return { ok: true, prUrl: stdout, deliveryLink: stdout, fallback: false, provider: "github" };
 }
 return { ok: false, error: res.stderr?.trim() || stdout || "gh pr create 不可用" };
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
}

async function createGitHubPullRequestViaApi(
 repo: { owner: string; repo: string },
 params: { branch: string; targetBranch: string; title: string; body?: string },
): Promise<PrResult | ProviderFailure> {
 try {
 const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`, {
 method: "POST",
 headers: {
 accept: "application/vnd.github+json",
 authorization: `Bearer ${prConfig.githubToken}`,
 "content-type": "application/json",
 "user-agent": "snow-harness-pr/1.0",
 },
 body: JSON.stringify({
 title: params.title,
 head: params.branch,
 base: params.targetBranch,
 body: params.body,
 }),
 });
 const payload = (await res.json().catch(() => ({}))) as { html_url?: string; message?: string };
 if (res.ok && payload.html_url) {
 return {
 ok: true,
 prUrl: payload.html_url,
 deliveryLink: payload.html_url,
 fallback: false,
 provider: "github",
 };
 }
 return { ok: false, error: payload.message ?? `GitHub API HTTP ${res.status}` };
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
}

async function createGitLabMergeRequest(
 repo: { projectPath: string; webBaseUrl: string },
 params: { branch: string; title?: string; body?: string; targetBranch?: string },
): Promise<PrResult> {
 const title = params.title ?? `delivery: ${params.branch}`;
 const targetBranch = params.targetBranch ?? prConfig.defaultBaseBranch;
 const fallbackLink = `${repo.webBaseUrl}/${repo.projectPath}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(params.branch)}&merge_request[target_branch]=${encodeURIComponent(targetBranch)}`;
 if (!prConfig.gitlabToken) {
 return {
 ok: false,
 deliveryLink: fallbackLink,
 fallback: true,
 provider: "gitlab",
 error: "GITLAB_TOKEN 未配置",
 };
 }

 try {
 const res = await fetch(
 `${repo.webBaseUrl}/api/v4/projects/${encodeURIComponent(repo.projectPath)}/merge_requests`,
 {
 method: "POST",
 headers: {
 "content-type": "application/json",
 "private-token": prConfig.gitlabToken,
 },
 body: JSON.stringify({
 source_branch: params.branch,
 target_branch: targetBranch,
 title,
 description: params.body,
 }),
 },
 );
 const payload = (await res.json().catch(() => ({}))) as { web_url?: string; message?: string };
 if (res.ok && payload.web_url) {
 return {
 ok: true,
 prUrl: payload.web_url,
 deliveryLink: payload.web_url,
 fallback: false,
 provider: "gitlab",
 };
 }
 return {
 ok: false,
 deliveryLink: fallbackLink,
 fallback: true,
 provider: "gitlab",
 error: payload.message ?? `GitLab API HTTP ${res.status}`,
 };
 } catch (error) {
 return {
 ok: false,
 deliveryLink: fallbackLink,
 fallback: true,
 provider: "gitlab",
 error: (error as Error).message,
 };
 }
}

/** 暴露给 Studio / 测试的 checkpoint 列表查询（工具集同构辅助）。 */
export { listCheckpoints };
