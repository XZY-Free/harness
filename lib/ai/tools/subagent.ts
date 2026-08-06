import { executeToolRun } from "@/lib/ai/tool-runtime";
import { type CreateRunRejection, createRun } from "@/lib/subagent/registry";
import { startSubagentExecution, waitForSubagent, waitForSubagents } from "@/lib/subagent/runtime";
import { tool } from "ai";
import { z } from "zod";

/**
 * Stage C：父 agent 可见的子代理控制工具（spawnSubagent / joinSubagent / joinSubagents）。
 *
 * 语义（计划 / §1 决策）：
 * - spawnSubagent：异步启动子代理（createRun 校验 writeScope 互斥 + 并发上限 → queued +
 * subagent.spawned 事件），再 fire-and-forget startSubagentExecution（不阻塞父），返回 runId。
 * 经 executeToolRun 收口（落 tool_runs + tool.* 事件，受权限引擎治理，默认 ask）。
 * - joinSubagent：等待单个 run 完成（waitForSubagent），返回结构化结果。
 * - joinSubagents（P0 修复 G1 真并行）：批量等待多个 run 完成（waitForSubagents Promise.all）。
 * 父 agent 在单个 turn 内 spawn 多个子代理后,调本工具并行等待,而非逐个 join 串行。
 * 配合 AI SDK v6 streamText 的并行工具执行,实现真正的并行子代理。
 *
 * 这两个工具只挂载在父 agent（allTools）；子代理工具集经 buildSubagentTools 的 allowedTools
 * 白名单 + runtime.stripSpawnTools 双重剥离，不暴露 spawn 能力（嵌套深度=1）。
 */

/** 把 createRun 拒绝原因转为人可读 error 文本。 */
function rejectionMessage(rejection: CreateRunRejection): string {
 switch (rejection.kind) {
 case "definition_not_found":
 return `子代理定义不存在：${rejection.definitionId}`;
 case "concurrency_cap":
 return `并发子代理数已达上限（活跃 ${rejection.active}，上限 ${rejection.cap}）`;
 case "write_scope_overlap":
 return `writeScope 与活跃子代理（run ${rejection.conflictingRunId}）重叠，拒绝 spawn（§14）`;
 }
}

/** 构造父 agent 的子代理控制工具集。 */
export function buildSubagentControlTools(threadId: string) {
 return {
 spawnSubagent: tool({
 description:
 "异步派生一个子代理执行有界工作单元（如只读探索代码、研究文档、审查变更、验证测试）。" +
 "子代理有独立上下文（只看裁剪后的目标+提示，不看本线程完整历史）、受限工具、结构化输出契约。" +
 "返回 runId；用 joinSubagent 等待并收集结果。可 spawn 多个再 join 实现并行。",
 inputSchema: z.object({
 definitionId: z.string().describe("子代理定义 id（SubagentDefinition.id）"),
 goal: z.string().describe("派给子代理的目标（一句话说明要它做什么）"),
 contextHints: z
 .array(z.string())
 .optional()
 .describe("给子代理的上下文提示（相关路径/约束/已知信息）"),
 writeScope: z
 .array(z.string())
 .optional()
 .describe("本次允许写入的路径 glob；不传=只读（默认）"),
 maxSteps: z
 .number()
 .int()
 .min(1)
 .max(48)
 .optional()
 .describe("子代理 step 上限（默认 12）；复杂任务可调高"),
 timeoutMs: z
 .number()
 .int()
 .min(1000)
 .max(600_000)
 .optional()
 .describe("子代理执行超时 ms（默认 120000）"),
 }),
 execute: async ({ definitionId, goal, contextHints, writeScope, maxSteps, timeoutMs }) => {
 try {
 return await executeToolRun(
 threadId,
 "spawnSubagent",
 { definitionId, goal, contextHints, writeScope, maxSteps, timeoutMs },
 async (signal) => {
 const result = await createRun({
 parentThreadId: threadId,
 definitionId,
 goal,
 contextHints: contextHints ?? null,
 writeScope: writeScope ?? null,
 });
 if (!result.ok) {
 return { ok: false, error: rejectionMessage(result.rejection) };
 }
 // 异步启动执行（不阻塞父）；executeSubagent 内部收敛异常为终态
 // S1（04-G4/G5）：透传 per-run maxSteps / timeoutMs
 startSubagentExecution(result.run.id, { maxSteps, timeoutMs });
 return { ok: true, runId: result.run.id, status: result.run.status };
 },
 );
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
 },
 }),

 joinSubagent: tool({
 description:
 "等待一个子代理 run 完成并返回其结构化结果。子代理 transcript 不回传（落 artifact 文件），" +
 "只回 result/summary + outputArtifactId。失败/超时返回 ok:false 与原因，不影响父 agent。" +
 "并行多个子代理时优先用 joinSubagents 批量等待。",
 inputSchema: z.object({
 runId: z.string().describe("spawnSubagent 返回的 runId"),
 timeoutMs: z
 .number()
 .optional()
 .describe("等待超时（ms，默认 30000）；超时返回当前 status"),
 }),
 execute: async ({ runId, timeoutMs }) => {
 try {
 return await executeToolRun(
 threadId,
 "joinSubagent",
 { runId, timeoutMs },
 async (signal) => {
 const run = await waitForSubagent(runId, timeoutMs);
 if (!run) return { ok: false, error: "子代理 run 不存在" };
 if (run.status === "completed") {
 return {
 ok: true,
 status: run.status,
 result: run.resultSummary,
 summary: run.resultSummary,
 outputArtifactId: run.outputArtifactId,
 };
 }
 // 非完成（failed/timed_out/cancelled/仍 running）→ ok:false
 return {
 ok: false,
 status: run.status,
 error: run.errorMessage ?? run.status,
 };
 },
 );
 } catch (error) {
 return { ok: false, error: (error as Error).message };
 }
 },
 }),

 joinSubagents: tool({
 description:
 "P0 修复（真并行）：批量等待多个子代理 run 完成。父 agent 在单个 turn 内 spawn 多个" +
 "子代理后调本工具,内部 Promise.all 并行等待,而非逐个 joinSubagent 串行。" +
 "配合 streamText 并行工具执行,实现真正并行子代理。每个 run 独立超时/失败,互不影响。" +
 "返回 results 数组（按 runIds 顺序对齐）,每项含 status/result/summary/outputArtifactId。",
 inputSchema: z.object({
 runIds: z.array(z.string()).min(1).describe("spawnSubagent 返回的 runId 列表（至少 1 个）"),
 timeoutMs: z
 .number()
 .optional()
 .describe("每个 run 的等待超时（ms，默认 30000）；共享预算"),
 }),
 execute: async ({ runIds, timeoutMs }) => {
 try {
 return await executeToolRun(
 threadId,
 "joinSubagents",
 { runIds, timeoutMs },
 async (signal) => {
 const runs = await waitForSubagents(runIds, timeoutMs);
 const results = runs.map((run, i) => {
 if (!run) {
 return { runId: runIds[i], ok: false, error: "子代理 run 不存在" };
 }
 if (run.status === "completed") {
 return {
 runId: runIds[i],
 ok: true,
 status: run.status,
 result: run.resultSummary,
 summary: run.resultSummary,
 outputArtifactId: run.outputArtifactId,
 };
 }
 return {
 runId: runIds[i],
 ok: false,
 status: run.status,
 error: run.errorMessage ?? run.status,
 };
 });
 // 整体 ok = 所有 run 都完成；任一未完成/失败 → ok:false（但仍返回所有结果供父决策）
 const allOk = results.every((r) => r.ok);
 return { ok: allOk, results };
 },
 );
 } catch (error) {
 return { ok: false, error: (error as Error).message, results: [] };
 }
 },
 }),
 };
}
