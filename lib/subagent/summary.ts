import { type SubagentSummary, extractSubagentSummary } from "@/lib/context/summary-types";
import type { SubagentRun } from "@/lib/db/schema";
import { getDefinition } from "@/lib/subagent/registry";

/**
 * Stage D：subagent 摘要构建（填充 a subagentSummary slot）。
 *
 * 从 SubagentRun 生成结构化 summary：role + goal + status + resultSummary + 证据引用 + 建议交接。
 * transcript 不进摘要（只引用 transcriptPath/outputArtifactId）。父 context layer 只见 summary。
 *
 * 实现委托给 lib/context/summary-types.ts 的 extractSubagentSummary（a slot filler，纯函数），
 * 避免循环依赖：summary.ts → summary-types.ts 单向；summary-types.ts 不反向 import subagent。
 */

/**
 * 从 SubagentRun 构建结构化 subagent 摘要。
 * 会按 run.definitionId 查 definition 取 role（查不到则 role 留空）。
 */
export async function buildSubagentSummary(run: SubagentRun): Promise<SubagentSummary> {
 const definition = await getDefinition(run.definitionId);
 const role = definition?.role ?? "";
 return extractSubagentSummary(
 {
 goal: run.goal,
 status: run.status,
 resultSummary: run.resultSummary,
 errorMessage: run.errorMessage,
 transcriptPath: run.transcriptPath,
 outputArtifactId: run.outputArtifactId,
 },
 role,
 );
}

/**
 * 把多个子代理摘要拼成父 context layer 可见的文本段（不含 transcript）。
 * 空列表 → 返回空串（调用方据此跳过注入，零回归）。
 */
export function renderSubagentSummaries(summaries: SubagentSummary[]): string {
 const valid = summaries.filter((s) => s.text.length > 0);
 if (valid.length === 0) return "";
 const body = valid.map((s, i) => `## 子代理 ${i + 1}\n${s.text}`).join("\n\n");
 return `[子代理结果汇总（，只含 summary 不含 transcript）]\n${body}`;
}
