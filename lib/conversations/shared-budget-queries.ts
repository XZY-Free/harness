import type { ChildThreadBudgetUsage } from "@/lib/conversations/child-thread-queries";
import { SharedBudgetExhaustedError } from "@/lib/conversations/errors";
/**
 * 共享父任务总预算聚合校验（S09-C07）。
 *
 * 事实源：
 * - docs/architecture/conversations.md §18 行 352-362（预算硬上限时副作用先核对）
 * - docs/architecture/persistence.md （ThreadRelation.budgetUsedJson）
 * - docs/architecture/conversations.md S09-C07
 *
 * 职责：
 * - getSharedBudgetUsage：聚合父 Thread 下所有 active delegate ThreadRelation 的 budgetUsedJson。
 * - assertSharedBudgetNotExhausted：跨 sibling 共享父任务总预算聚合校验；超限抛 SharedBudgetExhaustedError。
 * - computeSharedBudgetUsage：纯函数版聚合（用于测试与离线计算）。
 *
 * 关键约束（§18）：
 * - 父 Thread 多个 active delegate sibling 共享父任务总预算上限。
 * - 硬上限触发后阻止新行动；正在执行副作用的 ToolCall 先进入 unknown_effect 核对流程，
 * 不能粗暴杀死后当成失败重试（§18 行 358-360）。
 * - 聚合超限（非单个 relation 超限）由本模块识别；调用方负责后续 unknown_effect 核对。
 * - 不写入 DB：本模块仅做读取 + 校验；累积用量由 recordChildThreadBudgetUsage 维护。
 */
import { db } from "@/lib/db/client";
import { threadRelationTable } from "@/lib/persistence/schema/conversation";
import { and, eq } from "drizzle-orm";

/**
 * 共享父任务总预算策略（与 DelegationBudgetPolicy 形状一致）。
 *
 * 字段语义（§18）：
 * - maxTokens：所有 sibling 累积 token 数上限。
 * - maxCost：所有 sibling 累积成本上限。
 * - maxToolCalls：所有 sibling 累积 Tool 调用次数上限。
 * - maxWallClockMs：所有 sibling 累积墙钟时长上限（毫秒）。
 * - maxChildCount：所有 sibling 累积孙辈 Thread 数量上限。
 * - maxSandboxSeconds：所有 sibling 累积 sandbox 执行时长上限（秒）。
 * - maxArtifactBytes：所有 sibling 累积 Artifact 字节数上限。
 *
 * 缺省字段表示不设上限（继承父）。
 */
export interface SharedBudgetPolicy {
 maxTokens?: number;
 maxCost?: number;
 maxToolCalls?: number;
 maxWallClockMs?: number;
 maxChildCount?: number;
 maxSandboxSeconds?: number;
 maxArtifactBytes?: number;
}

/**
 * 跨 sibling 聚合后的预算用量。
 *
 * 字段语义：所有 active delegate ThreadRelation 的 budgetUsedJson 对应字段之和。
 * - tokens/cost/toolCalls/wallClockMs/childCount/sandboxSeconds/artifactBytes：数值累加。
 * - unknownEffect：任一 sibling 标记 true 即为 true（用于 §18 副作用核对提示）。
 * - contributingRelations：参与聚合的 relation id 列表（用于错误诊断与审计）。
 */
export interface SharedBudgetUsage {
 tokens: number;
 cost: number;
 toolCalls: number;
 wallClockMs: number;
 childCount: number;
 sandboxSeconds: number;
 artifactBytes: number;
 unknownEffect: boolean;
 contributingRelations: string[];
}

/** 共享预算超限字段类型（与 SharedBudgetExhaustedError.exceededField 一致）。 */
export type SharedBudgetExceededField =
 | "tokens"
 | "cost"
 | "tool_calls"
 | "wall_clock_ms"
 | "child_count"
 | "sandbox_seconds"
 | "artifact_bytes";

/**
 * 计算单个 relation 的预算用量贡献（从 budgetUsedJson 提取）。
 * 空值或非法值视为 0；unknownEffect 取布尔值。
 */
function extractRelationUsage(
 budgetUsedJson: unknown,
 relationId: string,
): {
 usage: Omit<SharedBudgetUsage, "contributingRelations">;
 relationId: string;
} {
 const raw = (budgetUsedJson ?? {}) as Partial<ChildThreadBudgetUsage>;
 return {
 usage: {
 tokens: typeof raw.tokens === "number" && Number.isFinite(raw.tokens) ? raw.tokens : 0,
 cost: typeof raw.cost === "number" && Number.isFinite(raw.cost) ? raw.cost : 0,
 toolCalls:
 typeof raw.toolCalls === "number" && Number.isFinite(raw.toolCalls) ? raw.toolCalls : 0,
 wallClockMs:
 typeof raw.wallClockMs === "number" && Number.isFinite(raw.wallClockMs)
 ? raw.wallClockMs
 : 0,
 childCount:
 typeof raw.childCount === "number" && Number.isFinite(raw.childCount) ? raw.childCount : 0,
 sandboxSeconds:
 typeof raw.sandboxSeconds === "number" && Number.isFinite(raw.sandboxSeconds)
 ? raw.sandboxSeconds
 : 0,
 artifactBytes:
 typeof raw.artifactBytes === "number" && Number.isFinite(raw.artifactBytes)
 ? raw.artifactBytes
 : 0,
 unknownEffect: Boolean(raw.unknownEffect),
 },
 relationId,
 };
}

/**
 * 纯函数版聚合：从给定 ThreadRelation 行的 budgetUsedJson 列表计算 SharedBudgetUsage。
 *
 * 仅累加数值字段；contributingRelations 收集所有 relation id（即使 budgetUsedJson 为空）。
 */
export function computeSharedBudgetUsage(
 relations: Array<{ id: string; budgetUsedJson: unknown }>,
): SharedBudgetUsage {
 const usage: SharedBudgetUsage = {
 tokens: 0,
 cost: 0,
 toolCalls: 0,
 wallClockMs: 0,
 childCount: 0,
 sandboxSeconds: 0,
 artifactBytes: 0,
 unknownEffect: false,
 contributingRelations: [],
 };

 for (const rel of relations) {
 const { usage: relUsage } = extractRelationUsage(rel.budgetUsedJson, rel.id);
 usage.tokens += relUsage.tokens;
 usage.cost += relUsage.cost;
 usage.toolCalls += relUsage.toolCalls;
 usage.wallClockMs += relUsage.wallClockMs;
 usage.childCount += relUsage.childCount;
 usage.sandboxSeconds += relUsage.sandboxSeconds;
 usage.artifactBytes += relUsage.artifactBytes;
 usage.unknownEffect = usage.unknownEffect || relUsage.unknownEffect;
 usage.contributingRelations.push(rel.id);
 }

 return usage;
}

/** 终态 relation 不计入共享预算聚合（用量已通过结果投影结算）。 */
const NON_TERMINAL_RELATION_STATES = ["active", "cancel_requested"] as const;

/**
 * 查询父 Thread 下所有 active delegate ThreadRelation 的累积预算用量。
 *
 * "active" 范围（§18）：
 * - relationState ∈ {active, cancel_requested}：仍在运行或待取消确认的 sibling 计入。
 * - 终态 relation（completed/failed/cancelled）不计入：用量已通过结果投影结算。
 *
 * @returns 聚合用量（无 sibling 时返回零值 + 空 contributingRelations）
 */
export async function getSharedBudgetUsage(parentThreadId: string): Promise<SharedBudgetUsage> {
 const relations = await db
 .select({
 id: threadRelationTable.id,
 budgetUsedJson: threadRelationTable.budgetUsedJson,
 relationState: threadRelationTable.relationState,
 })
 .from(threadRelationTable)
 .where(
 and(
 eq(threadRelationTable.parentThreadId, parentThreadId),
 eq(threadRelationTable.relationType, "delegate"),
 ),
 );

 // 仅聚合 active/cancel_requested 状态（终态 sibling 用量已结算）
 const activeRelations = relations.filter((r) =>
 (NON_TERMINAL_RELATION_STATES as readonly string[]).includes(r.relationState),
 );

 return computeSharedBudgetUsage(
 activeRelations.map((r) => ({ id: r.id, budgetUsedJson: r.budgetUsedJson })),
 );
}

/**
 * 跨 sibling 共享父任务总预算聚合校验（§18 行 352-362）。
 *
 * 与 assertChildThreadBudgetNotExhausted 的区别：
 * - assertChildThreadBudgetNotExhausted：单 relation 级别校验（child budgetPolicyJson）。
 * - assertSharedBudgetNotExhausted：跨 sibling 聚合校验（parent sharedBudgetPolicy）。
 *
 * 触发场景：
 * - sibling A 用了 80% + sibling B 再用 30% → 第二次记录触发本错误（不是单个 relation 超限，是聚合超限）。
 * - 硬上限触发后阻止新行动；正在执行副作用的 ToolCall 先进入 unknown_effect 核对流程。
 *
 * @param parentThreadId 父 Thread id
 * @param sharedBudgetPolicy 父任务共享预算策略（来自父 Agent delegationPolicyJson.sharedBudget）
 * @returns 聚合用量（用于调用方决策与审计）
 * @throws SharedBudgetExhaustedError 任一字段聚合超限
 */
export async function assertSharedBudgetNotExhausted(
 parentThreadId: string,
 sharedBudgetPolicy: SharedBudgetPolicy,
): Promise<SharedBudgetUsage> {
 const usage = await getSharedBudgetUsage(parentThreadId);

 // 按字段优先级校验：tokens → cost → tool_calls → wall_clock_ms →
 // child_count → sandbox_seconds → artifact_bytes
 const checks: Array<{
 field: SharedBudgetExceededField;
 used: number;
 max: number | undefined;
 }> = [
 { field: "tokens", used: usage.tokens, max: sharedBudgetPolicy.maxTokens },
 { field: "cost", used: usage.cost, max: sharedBudgetPolicy.maxCost },
 { field: "tool_calls", used: usage.toolCalls, max: sharedBudgetPolicy.maxToolCalls },
 { field: "wall_clock_ms", used: usage.wallClockMs, max: sharedBudgetPolicy.maxWallClockMs },
 { field: "child_count", used: usage.childCount, max: sharedBudgetPolicy.maxChildCount },
 {
 field: "sandbox_seconds",
 used: usage.sandboxSeconds,
 max: sharedBudgetPolicy.maxSandboxSeconds,
 },
 {
 field: "artifact_bytes",
 used: usage.artifactBytes,
 max: sharedBudgetPolicy.maxArtifactBytes,
 },
 ];

 for (const check of checks) {
 if (check.max !== undefined && check.max >= 0 && check.used > check.max) {
 throw new SharedBudgetExhaustedError(
 parentThreadId,
 check.field,
 check.used,
 check.max,
 usage.contributingRelations,
 );
 }
 }

 return usage;
}

/**
 * 校验 sharedBudgetPolicy：所有数值字段必须为非负数。
 *
 * @throws Error 任一字段为负或非法
 */
export function validateSharedBudgetPolicy(policy: SharedBudgetPolicy): void {
 const fields: Array<[keyof SharedBudgetPolicy, number | undefined]> = [
 ["maxTokens", policy.maxTokens],
 ["maxCost", policy.maxCost],
 ["maxToolCalls", policy.maxToolCalls],
 ["maxWallClockMs", policy.maxWallClockMs],
 ["maxChildCount", policy.maxChildCount],
 ["maxSandboxSeconds", policy.maxSandboxSeconds],
 ["maxArtifactBytes", policy.maxArtifactBytes],
 ];

 for (const [field, value] of fields) {
 if (
 value !== undefined &&
 (typeof value !== "number" || !Number.isFinite(value) || value < 0)
 ) {
 throw new Error(`SharedBudgetPolicy.${field} 非法：${value}（必须为非负有限数）`);
 }
 }
}
