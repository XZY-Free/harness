import { getThreadById, listQaEventsByThread, listToolRunsByThread } from "@/lib/db/queries";
import type { ToolRun } from "@/lib/db/schema";
import { gitRemoteUrl, gitStatus } from "@/lib/git/ops";

/**
 * Stage C：deliverySummary 聚合（plan §7 / ）。
 *
 * 把 thread 的交付证据聚合成结构化 deliverySummary，对应 `delivery.succeeded` 事件 payload。
 * 不单独建 DeliverySummary 表（决策：复用 ThreadEvent payload）。
 *
 * 数据来源：
 * - 文件变更：`ops.gitStatus`（当前工作区 staged/modified/untracked）。
 * - 测试结果：最近一次 `runTests` ToolRun 的 output.stdout（best-effort 解析 passed/failed）。
 * - 预览 URL：`thread.previewUrl`。
 * - 截图：未落地，空数组（允许）。
 * - commit/PR/branch/remote：从 gitCommit / gitPush / createPullRequest 的 ToolRun output 取。
 * - tested/notTested：从最近 gitCommit ToolRun 的 input（结构化 trailer 字段）取。
 * - blindCommit：最近 gitCommit 之前是否读过 gitStatus/gitDiff（「commit 前必须读」软约束审计）。
 */

export type DeliveryFileChange = { path: string; status: string };

export type DeliveryTestResults = { passed: number; failed: number; summary: string };

export type DeliverySummary = {
 commitSha: string | null;
 branch: string | null;
 remoteUrl: string | null;
 pushed: boolean;
 prUrl: string | null;
 filesChanged: DeliveryFileChange[];
 testResults: DeliveryTestResults;
 previewUrl: string | null;
 screenshots: string[];
 deliveryLink: string | null;
 tested: string | null;
 notTested: string | null;
 blindCommit: boolean;
};

/**
 * 从 runTests 的 stdout best-effort 解析 passed/failed 计数与摘要。
 *
 * 优先解析结构化 JSON（vitest --json / jest --json），回退正则。
 * 原仅正则解析，不同测试框架输出差异导致脆弱。
 */
function parseTestResults(stdout: unknown): DeliveryTestResults {
 const text = typeof stdout === "string" ? stdout : "";

 // 优先尝试解析结构化 JSON（vitest/jest --json 输出）
 try {
 const jsonMatch = text.match(
 /\{[\s\S]*"numTotalTests"[\s\S]*\}|\{[\s\S]*"numPassedTests"[\s\S]*\}/,
 );
 if (jsonMatch) {
 const parsed = JSON.parse(jsonMatch[0]) as {
 numTotalTests?: number;
 numPassedTests?: number;
 numFailedTests?: number;
 numPendingTests?: number;
 };
 const passed = parsed.numPassedTests ?? 0;
 const failed = parsed.numFailedTests ?? 0;
 if (parsed.numTotalTests !== undefined || parsed.numPassedTests !== undefined) {
 return { passed, failed, summary: `JSON: ${passed} passed, ${failed} failed` };
 }
 }
 } catch {
 // JSON 解析失败 → 回退正则
 }

 // 回退：正则解析（兼容不同框架的自由文本输出）
 const passedMatch = /(\d+)\s+passed/i.exec(text);
 const failedMatch = /(\d+)\s+failed/i.exec(text);
 const passed = passedMatch ? Number(passedMatch[1]) : 0;
 const failed = failedMatch ? Number(failedMatch[1]) : 0;
 const summary = text.trim().slice(-500);
 return { passed, failed, summary };
}

/** 取某工具名最近一次 succeeded 的 ToolRun（按 startedAt desc 已是 listToolRunsByThread 顺序）。 */
function latestSucceeded(rows: ToolRun[], toolName: string): ToolRun | null {
 return rows.find((r) => r.toolName === toolName && r.status === "succeeded") ?? null;
}

/**
 * 构建 thread 的 deliverySummary。
 * @param threadId - 所属 thread
 * @param opts.prUrl - 调用方可注入 PR URL（若 createPullRequest 在同轮已执行，避免重复读 ToolRun）
 */
export async function buildDeliverySummary(
 threadId: string,
 opts?: { prUrl?: string | null },
): Promise<DeliverySummary> {
 const [thread, toolRuns, status, remoteUrl] = await Promise.all([
 getThreadById(threadId),
 listToolRunsByThread(threadId, 500),
 gitStatus(threadId),
 gitRemoteUrl(threadId),
 ]);

 const latestCommit = latestSucceeded(toolRuns, "gitCommit");
 const latestPush = latestSucceeded(toolRuns, "gitPush");
 const latestPr = latestSucceeded(toolRuns, "createPullRequest");
 const latestTests = latestSucceeded(toolRuns, "runTests");

 // commitSha / tested / notTested 来自最近 gitCommit
 const commitOutput = (latestCommit?.output ?? {}) as { commitSha?: string };
 const commitInput = (latestCommit?.input ?? {}) as {
 tested?: string;
 notTested?: string;
 };

 // blindCommit：最近 gitCommit 之前是否读过 gitStatus/gitDiff
 let blindCommit = false;
 if (latestCommit) {
 const commitStarted = latestCommit.startedAt.getTime();
 const readBefore = toolRuns.some(
 (r) =>
 (r.toolName === "gitStatus" || r.toolName === "gitDiff") &&
 r.startedAt.getTime() < commitStarted,
 );
 blindCommit = !readBefore;
 }

 // 文件变更：当前工作区状态
 const filesChanged: DeliveryFileChange[] = [
 ...status.staged.map((p) => ({ path: p, status: "staged" })),
 ...status.modified.map((p) => ({ path: p, status: "modified" })),
 ...status.untracked.map((p) => ({ path: p, status: "untracked" })),
 ];

 const pushOutput = (latestPush?.output ?? {}) as {
 branch?: string;
 remote?: string;
 pushed?: boolean;
 };
 const prOutput = (latestPr?.output ?? {}) as {
 prUrl?: string;
 deliveryLink?: string;
 };

 const testResults = parseTestResults(((latestTests?.output ?? {}) as { stdout?: string }).stdout);

 // P2 修复(09 Git P2-1): screenshots 从 qa 事件取最近通过/失败的截图路径。
 // 原恒空数组,交付摘要无截图证据,审计不完整。
 let screenshots: string[] = [];
 try {
 const qaEvents = await listQaEventsByThread(threadId);
 // 取最近 5 条 qa 事件的 artifactPath(截图路径),过滤 null
 screenshots = qaEvents
 .slice(0, 5)
 .map((e) => {
 const p = e.payload as { artifactPath?: string | null } | null;
 return p?.artifactPath ?? null;
 })
 .filter((s): s is string => s !== null && s.length > 0);
 } catch {
 // qa 事件查询失败不阻塞 delivery summary(fail-open)
 }

 return {
 commitSha: commitOutput.commitSha ?? null,
 branch: pushOutput.branch ?? status.current ?? null,
 remoteUrl,
 pushed: Boolean(latestPush),
 prUrl: opts?.prUrl ?? prOutput.prUrl ?? null,
 filesChanged,
 testResults,
 previewUrl: thread?.previewUrl ?? null,
 screenshots,
 deliveryLink: prOutput.deliveryLink ?? prOutput.prUrl ?? null,
 tested: commitInput.tested ?? null,
 notTested: commitInput.notTested ?? null,
 blindCommit,
 };
}
