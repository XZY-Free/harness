/**
 * Context 预算策略（阶段 7 S07-C01）。
 *
 * 事实源：docs/architecture/context-memory-and-knowledge.md §5（优先级与预算）。
 *
 * 平台先为模型输出和 Tool 结果预留空间，再按优先级顺序选择 Fragment：
 * 1. 平台强制规则和当前 Agent 指令（TIER_MANDATORY）。
 * 2. 当前用户要求与运行中引导（TIER_MANDATORY）。
 * 3. 已确认约束、决定、Goal 和未完成事项（TIER_MANDATORY）。
 * 4. 最近原始对话与直接相关结果（TIER_RECENT）。
 * 5. 任务相关的 Workspace、Knowledge、Memory 和 Skill（TIER_RELATED）。
 * 6. Tool 结果摘要与 Child Thread 结果（TIER_SUMMARY）。
 * 7. 更早历史的压缩摘要（TIER_HISTORY）。
 *
 * 预算不足时（§5）：
 * - 先删重复日志、无关进度和可重新查询内容。
 * - 保留 ToolCall 与 ToolResult 配对。
 * - 把长结果转为结构化摘要和引用。
 * - 记录被排除内容及原因。
 * - 如果关键内容（TIER_MANDATORY）仍无法容纳，明确失败或换用允许的长上下文模型，
 * 不能静默丢掉约束。
 */
import {
 type ContextFragment,
 type ExcludedFragment,
 type ExclusionReasonCode,
 FRAGMENT_PRIORITY_TIERS,
 type FragmentPriorityTier,
 assertContextFragment,
} from "@/lib/context/fragment";

// ─── 预算配置 ───────────────────────────────────────────────

/**
 * Context 预算配置。
 *
 * - totalBudget：本次模型上下文 Token 总预算。
 * - modelOutputReserve：为模型输出预留的 Token（不分配给输入 Fragment）。
 * - toolResultReserve：为 Tool 结果预留的 Token（保证 ToolResult 有空间）。
 *
 * 可用输入预算 = totalBudget - modelOutputReserve。
 * ToolResult 保留空间从可用输入预算中划出，保证最近 ToolResult 优先容纳。
 */
export interface ContextBudgetConfig {
 totalBudget: number;
 modelOutputReserve: number;
 toolResultReserve: number;
}

/** 默认预算配置（可由调用方覆盖）。 */
export const DEFAULT_BUDGET_CONFIG: ContextBudgetConfig = {
 totalBudget: 128_000,
 modelOutputReserve: 8_000,
 toolResultReserve: 16_000,
};

// ─── 预算选择结果 ───────────────────────────────────────────

/**
 * 预算选择结果。
 *
 * - selected：选入视图的 Fragment（按优先级与插入顺序）。
 * - excluded：被排除的 Fragment 及原因。
 * - totalInputTokens：选入 Fragment 的 Token 总和。
 * - failureReason：关键内容无法容纳时的失败原因（非空表示应显式失败或切换模型）。
 */
export interface BudgetSelectionResult {
 selected: ContextFragment[];
 excluded: ExcludedFragment[];
 totalInputTokens: number;
 /** 可用输入预算（totalBudget - modelOutputReserve）。 */
 availableInputBudget: number;
 /** 关键内容无法容纳时的失败原因；非空调用方应显式失败。 */
 failureReason: string | null;
}

// ─── 内部：去重 key ─────────────────────────────────────────

/**
 * 计算去重 key：相同 contentHash 视为重复内容。
 * 不同来源但相同正文视为重复，保留首个。
 */
function dedupKey(fragment: ContextFragment): string {
 return fragment.contentHash;
}

// ─── 预算选择 ───────────────────────────────────────────────

/**
 * 按预算与优先级选择 Fragment（§5）。
 *
 * 流程：
 * 1. 计算可用输入预算 = totalBudget - modelOutputReserve。
 * 2. 按优先级层级稳定排序（同层保持插入顺序）。
 * 3. 去重：相同 contentHash 只保留首个，其余标记 duplicate 排除。
 * 4. 按优先级由高到低依次选入：
 * - TIER_MANDATORY 必须容纳；若超出预算 → failureReason = mandatory_overflow。
 * - TIER_RECENT 的 ToolResult 优先使用 toolResultReserve 空间。
 * - 低优先级（TIER_SUMMARY/TIER_HISTORY）在预算不足时优先排除（requeryable/low_priority）。
 * 5. 剩余预算耗尽后，未选入的按 budget_exhausted 排除。
 *
 * 关键不变量：
 * - 不静默丢弃 TIER_MANDATORY（约束/规则/当前用户要求）。
 * - failureReason 非空时调用方应显式失败或切换长上下文模型。
 *
 * @param candidates 候选 Fragment（已由 source resolvers 产生）。
 * @param config 预算配置；默认 DEFAULT_BUDGET_CONFIG。
 */
export function selectFragmentsByBudget(
 candidates: readonly ContextFragment[],
 config: ContextBudgetConfig = DEFAULT_BUDGET_CONFIG,
): BudgetSelectionResult {
 const availableInputBudget = Math.max(0, config.totalBudget - config.modelOutputReserve);
 const reservedForToolResults = Math.min(
 Math.max(0, config.toolResultReserve),
 availableInputBudget,
 );
 const regularInputBudget = availableInputBudget - reservedForToolResults;
 const selected: ContextFragment[] = [];
 const excluded: ExcludedFragment[] = [];
 const seenHashes = new Set<string>();
 let totalInputTokens = 0;
 let regularTokens = 0;
 let toolReserveTokens = 0;
 let failureReason: string | null = null;

 for (const fragment of candidates) assertContextFragment(fragment);

 type SelectionUnit = {
 fragments: ContextFragment[];
 priorityTier: FragmentPriorityTier;
 operationId?: string;
 };
 const toolGroups = new Map<string, ContextFragment[]>();
 const units: SelectionUnit[] = [];
 for (const fragment of candidates) {
 if (
 fragment.kind === "tool" &&
 (fragment.sourceRef.type === "tool_call" || fragment.sourceRef.type === "tool_result")
 ) {
 const group = toolGroups.get(fragment.sourceRef.id) ?? [];
 group.push(fragment);
 toolGroups.set(fragment.sourceRef.id, group);
 } else {
 units.push({ fragments: [fragment], priorityTier: fragment.priorityTier });
 }
 }
 for (const [operationId, fragments] of toolGroups) {
 const hasCall = fragments.some((fragment) => fragment.sourceRef.type === "tool_call");
 const hasResult = fragments.some((fragment) => fragment.sourceRef.type === "tool_result");
 if (!hasCall || !hasResult) {
 for (const fragment of fragments) {
 excluded.push(
 toExcluded(
 fragment,
 "tool_pair_incomplete",
 `Tool operation ${operationId} 缺少 ${hasCall ? "tool_result" : "tool_call"}`,
 ),
 );
 }
 continue;
 }
 units.push({
 fragments,
 priorityTier: Math.min(
 ...fragments.map((fragment) => fragment.priorityTier),
 ) as FragmentPriorityTier,
 operationId,
 });
 }
 units.sort((a, b) => a.priorityTier - b.priorityTier);

 for (const unit of units) {
 const duplicate = unit.fragments.find((fragment) => seenHashes.has(dedupKey(fragment)));
 if (duplicate) {
 for (const fragment of unit.fragments) {
 excluded.push(toExcluded(fragment, "duplicate", "与已选入 Fragment 内容重复"));
 }
 continue;
 }

 const resultTokens = unit.fragments
 .filter((fragment) => fragment.sourceRef.type === "tool_result")
 .reduce((sum, fragment) => sum + fragment.tokenEstimate, 0);
 const nonResultTokens =
 unit.fragments.reduce((sum, fragment) => sum + fragment.tokenEstimate, 0) - resultTokens;
 const resultReserveAvailable = reservedForToolResults - toolReserveTokens;
 const reserveUse = Math.min(resultTokens, resultReserveAvailable);
 const requiredRegular = nonResultTokens + resultTokens - reserveUse;
 const regularAvailable = regularInputBudget - regularTokens;
 const mandatory = unit.priorityTier === FRAGMENT_PRIORITY_TIERS.TIER_MANDATORY;

 if (requiredRegular > regularAvailable) {
 const reasonCode: ExclusionReasonCode = mandatory
 ? "mandatory_overflow"
 : unit.priorityTier >= FRAGMENT_PRIORITY_TIERS.TIER_SUMMARY
 ? "low_priority"
 : unit.priorityTier === FRAGMENT_PRIORITY_TIERS.TIER_RELATED
 ? "requeryable"
 : "budget_exhausted";
 const pairDetail = unit.operationId
 ? `Tool operation ${unit.operationId} 必须成组选择，预算不足`
 : mandatory
 ? "关键内容超出普通输入预算"
 : "输入预算耗尽";
 for (const fragment of unit.fragments) {
 excluded.push(toExcluded(fragment, reasonCode, pairDetail));
 }
 if (mandatory) {
 failureReason = `关键内容 Token 超出普通输入预算 ${regularInputBudget}，不能静默丢弃约束`;
 }
 continue;
 }

 for (const fragment of unit.fragments) {
 selected.push(fragment);
 seenHashes.add(dedupKey(fragment));
 totalInputTokens += fragment.tokenEstimate;
 }
 regularTokens += requiredRegular;
 toolReserveTokens += reserveUse;
 }

 return {
 selected,
 excluded,
 totalInputTokens,
 availableInputBudget,
 failureReason,
 };
}

// ─── 内部工具 ───────────────────────────────────────────────

function toExcluded(
 frag: ContextFragment,
 reasonCode: ExclusionReasonCode,
 detail?: string,
): ExcludedFragment {
 return {
 id: frag.id,
 kind: frag.kind,
 contentHash: frag.contentHash,
 tokenEstimate: frag.tokenEstimate,
 priorityTier: frag.priorityTier,
 reasonCode,
 detail,
 };
}

// ─── ToolCall/ToolResult 配对校验 ───────────────────────────

/**
 * 校验选入 Fragment 中 ToolCall 与 ToolResult 是否配对（§5：保留 ToolCall 与 ToolResult 配对）。
 *
 * 规则：每个 tool_call sourceRef 应有对应 tool_result（同 operationId/source id 配对）。
 * 若 ToolCall 选入但对应 ToolResult 被排除，返回需要补回的 ToolResult fragment id 列表。
 *
 * 本函数仅做检测；调用方决定是否从 excluded 中补回（预算允许时）。
 *
 * @returns unpairedToolCallIds：选入了 ToolCall 但缺少配对 ToolResult 的来源 id。
 */
export function detectUnpairedToolResults(
 selected: readonly ContextFragment[],
 excluded: readonly ExcludedFragment[],
): {
 unpairedToolCallSourceIds: string[];
 recoverableToolResultFragmentIds: string[];
} {
 const toolCalls = selected.filter((f) => f.kind === "tool" && f.sourceRef.type === "tool_call");
 const toolResults = selected.filter(
 (f) => f.kind === "tool" && f.sourceRef.type === "tool_result",
 );
 const pairedResultIds = new Set(toolResults.map((r) => r.sourceRef.id));

 const unpairedToolCallSourceIds: string[] = [];
 for (const call of toolCalls) {
 // 约定：tool_call 的 sourceRef.id 与对应 tool_result 的 sourceRef.id 相同（operationId）。
 if (!pairedResultIds.has(call.sourceRef.id)) {
 unpairedToolCallSourceIds.push(call.sourceRef.id);
 }
 }

 // 从 excluded 中找出可补回的 ToolResult（对应未配对的 tool_call）
 const recoverableToolResultFragmentIds: string[] = [];
 if (unpairedToolCallSourceIds.length > 0) {
 const unpairedSet = new Set(unpairedToolCallSourceIds);
 for (const ex of excluded) {
 // excluded 是 ExcludedFragment，不含 sourceRef；通过 id 关联回原 fragment 由调用方处理。
 // 此处仅返回 excluded 中 kind=tool 的 fragment id，调用方按需匹配。
 if (ex.kind === "tool") {
 recoverableToolResultFragmentIds.push(ex.id);
 }
 }
 void unpairedSet;
 }

 return { unpairedToolCallSourceIds, recoverableToolResultFragmentIds };
}
