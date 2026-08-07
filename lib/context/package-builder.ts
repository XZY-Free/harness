import { createHash } from "node:crypto";
import { contextConfig } from "@/lib/config";
import {
 createContextSummary,
 getActiveSummaryByChecksum,
 listSummariesByThread,
 supersedeSummary,
} from "@/lib/db/queries";
import type {
 ContextSummaryType,
 MemoryEntry,
 ThreadEvent,
 ThreadPlan,
 ToolApprovalRequest,
 ToolRun,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { summarizeProvenance } from "@/lib/memory/provenance";
import type { ChatMessage } from "@/lib/types";
import { type ModelMessage, convertToModelMessages } from "ai";
import { estimateMessagesTokens, estimateTokens, shouldCompress, warmupTokenizer } from "./budget-estimation";
import { type ProtectedRef, computeProtectedRefs, renderInjectedProtected } from "./protected-refs";
import {
 extractDecisionLog,
 extractDiffSummary,
 extractToolRunSummary,
 extractTurnSummary,
 isDiffToolRun,
} from "./summary-types";

/**
 * a Stage B+C：Context Package Builder。
 *
 * Stage B（核心行为）：低于预算逐字直通（零回归）；超预算把旧消息区段替换为结构化
 * 摘要 + protected 硬保留；抛错 fail-safe 回退直通。
 *
 * Stage C（触发与持久化）：四种压缩触发（蓝图 ）——
 * 1. 上下文预算 > 70%（Stage B）。
 * 2. 单工具输出 > toolOutputThreshold → 该 toolRun 单独摘要（即使总预算未超）。
 * 3. plan 阶段切换（plan.updated / plan.item_updated）→ decisionLog 摘要。
 * 4. thread 进入 verifying / delivering → turnSummary（执行段收尾）。
 * subagent 完成 → 不实现（）。
 * supersede 链：区段扩展被重新摘要时，旧 turn summary.supersededById 指向新 summary。
 *
 * 压缩是派生视图：原始 Message 不删，只改变 streamText 的 messages 输入。
 */

export type AppliedSummary = {
 id: string;
 type: ContextSummaryType;
 scope: unknown;
 summaryText: string;
 tokenEstimate: number;
 originalTokenEstimate: number;
 /** 本轮新建（true）还是 checksum 复用（false）。route 据此落 context.summary_created 事件。 */
 isNew: boolean;
};

export type ContextPackageManifest = {
 appliedSummaryIds: string[];
 summaries: AppliedSummary[];
 excludedCandidates: Array<{ kind: string; reason: string; memoryId?: string }>;
 protectedRefs: ProtectedRef[];
 beforeTokens: number;
 afterTokens: number;
};

export type ContextPackage = {
 messages: ModelMessage[];
 manifest: ContextPackageManifest;
 compressed: boolean;
};

export type BuildContextPackageInput = {
 threadId: string;
 model: string;
 history: ChatMessage[];
 tokenBudget: number;
 toolRuns?: ToolRun[];
 activePlan?: ThreadPlan | null;
 pendingApprovals?: ToolApprovalRequest[];
 recentFailure?: ToolRun | null;
 /** Stage C：plan 事件（用于 decisionLog 触发与提取）。 */
 planEvents?: ThreadEvent[];
 /** Stage C：状态切换事件 payload（用于 decisionLog 约束提取）。 */
 statusChanges?: Array<{ reason?: string; to?: string }>;
 /** Stage C：当前 thread 状态（verifying/delivering 触发 turnSummary 收尾）。 */
 threadStatus?: string;
 /** Stage D：安全/权限/部署硬约束（protected 注入）。 */
 policyConstraints?: string[];
 /** Stage D：用户 pinned facts（protected 注入）。 */
 pinnedFacts?: string[];
 /**
 * 本轮检索到的长期记忆（低优先级候选）。
 * 注入现有非 system context wrapper（标记 memory-derived，不新增第二个 system message）。
 * 预算紧时先裁 memory，永不裁 protected；被裁进 excludedCandidates。
 * 无 memory（undefined/空）时输出与 a 逐字一致（零回归）。
 */
 memories?: MemoryEntry[];
 /** 最近保留的原始消息条数（默认 6）。 */
 recentKeepCount?: number;
};

/** 计算消息区段的稳定 checksum。 */
function computeSegmentChecksum(threadId: string, messages: ChatMessage[]): string {
 const ids = messages.map((m) => m.id).sort();
 const text = messages
 .map((m) =>
 (m.parts ?? [])
 .map((p) =>
 p &&
 typeof p === "object" &&
 "text" in p &&
 typeof (p as { text: unknown }).text === "string"
 ? (p as { text: string }).text
 : JSON.stringify(p),
 )
 .join("\n"),
 )
 .join(" ");
 return createHash("sha256")
 .update(`${threadId}|turn|${ids.join(",")}|${text}`)
 .digest("hex")
 .slice(0, 64);
}

/** 计算 toolRun 摘要的稳定 checksum（基于 toolRunId + output）。 */
function computeToolRunChecksum(threadId: string, tr: ToolRun): string {
 return createHash("sha256")
 .update(`${threadId}|toolRun|${tr.id}|${JSON.stringify(tr.output ?? null)}`)
 .digest("hex")
 .slice(0, 64);
}

/** 估算 toolRun output 的 token。 */
function toolRunOutputTokens(tr: ToolRun): number {
 return estimateTokens(JSON.stringify(tr.output ?? ""));
}

/**
 * 修复 token/char 单位混用：用二分查找找到最接近 token 预算的字符截断点。
 * estimateTokens 是同步 CJK 估算，二分搜索 O(log n) 即可找到合适的字符数。
 */
function findCharLimitForTokenBudget(text: string, tokenBudget: number): number {
 let lo = 0;
 let hi = text.length;
 while (lo < hi) {
 const mid = (lo + hi + 1) >>> 1;
 if (estimateTokens(text.slice(0, mid)) <= tokenBudget) {
 lo = mid;
 } else {
 hi = mid - 1;
 }
 }
 return Math.max(lo, 1); // 至少保留 1 个字符
}

/**
 * microcompact —— 裁剪超大 text / tool-result part。
 *
 * 扩展：除 text part 外，也裁剪 tool-result part（JSON output 超 cap 时截断）。
 * 遍历 history，对 token 估算超过 `contextConfig.microcompactMessageTokens` 的 text/tool-result part，
 * 截断到 cap 字符 + 微压缩标记。不删 part、不动 tool-call（配对安全），不修改 protected 语义。
 * 返回新 history（深拷贝，不改输入）；无可裁剪大消息时返回 null（调用方退回直通）。
 */
function microcompactHistory(history: ChatMessage[]): ChatMessage[] | null {
 const cap = contextConfig.microcompactMessageTokens;
 let any = false;
 const out = history.map((m) => {
 const parts = (m.parts ?? []).map((p) => {
 if (p && typeof p === "object") {
 const type = (p as { type?: string }).type;
 // text part 裁剪
 if (type === "text" && typeof (p as { text?: unknown }).text === "string") {
 const text = (p as { text: string }).text;
 if (estimateTokens(text) > cap) {
 any = true;
 // 修复：用二分查找找到对应 token 预算的字符截断点，而非直接用 token 数当字符数
 const charLimit = findCharLimitForTokenBudget(text, cap);
 return {
 ...p,
 text: `${text.slice(0, charLimit)}\n[...已微压缩（超 ${cap} token 截断）...]`,
 };
 }
 }
 // : tool-result part 裁剪（output 超 cap token 时截断）
 if (type === "tool-result") {
 const output = (p as { output?: unknown }).output;
 if (output !== undefined) {
 const outputStr = typeof output === "string" ? output : JSON.stringify(output);
 if (estimateTokens(outputStr) > cap) {
 any = true;
 const truncated =
 typeof output === "string"
 ? `${output.slice(0, findCharLimitForTokenBudget(output, cap))}\n[...已微压缩（超 ${cap} token 截断）...]`
 : { result: `Output truncated due to context window pressure (>${cap} tokens)` };
 return { ...p, output: truncated };
 }
 }
 }
 }
 return p;
 });
 return { ...m, parts };
 });
 return any ? (out as ChatMessage[]) : null;
}

/** 复用或新建一条 summary，返回 AppliedSummary。 */
async function reuseOrCreateSummary(args: {
 threadId: string;
 type: ContextSummaryType;
 checksum: string;
 scope: unknown;
 summaryText: string;
 originalTokenEstimate: number;
 protectedRefs: ProtectedRef[];
}): Promise<AppliedSummary> {
 const existing = await getActiveSummaryByChecksum(args.threadId, args.checksum);
 if (existing) {
 return {
 id: existing.id,
 type: args.type,
 scope: args.scope,
 summaryText: existing.summaryText,
 tokenEstimate: existing.tokenEstimate,
 originalTokenEstimate: existing.originalTokenEstimate,
 isNew: false,
 };
 }
 const row = await createContextSummary({
 threadId: args.threadId,
 type: args.type,
 scope: args.scope,
 summaryText: args.summaryText,
 checksum: args.checksum,
 tokenEstimate: estimateTokens(args.summaryText),
 originalTokenEstimate: args.originalTokenEstimate,
 protectedRefs: args.protectedRefs,
 });
 return {
 id: row.id,
 type: args.type,
 scope: args.scope,
 summaryText: args.summaryText,
 tokenEstimate: row.tokenEstimate,
 originalTokenEstimate: row.originalTokenEstimate,
 isNew: true,
 };
}

/**
 * Supersede 旧 turn summary：新建 turn summary 后，把 scope.messageIds 是新段子集的
 * 旧活跃 turn summary 标记为 superseded。查询只取未 supersede，故旧 summary 不再被复用。
 */
async function supersedeOldTurnSummaries(args: {
 threadId: string;
 newSummaryId: string;
 newSegmentIds: string[];
}): Promise<void> {
 const newIdSet = new Set(args.newSegmentIds);
 const active = await listSummariesByThread(args.threadId, { limit: 200 });
 for (const row of active) {
 if (row.id === args.newSummaryId) continue;
 if (row.type !== "turn") continue;
 const scope = row.scope as { messageIds?: string[] } | null;
 const oldIds = scope?.messageIds ?? [];
 if (oldIds.length === 0) continue;
 // 旧 scope 是新段子集 → 被 supersede
 if (oldIds.every((id) => newIdSet.has(id))) {
 await supersedeSummary({ oldSummaryId: row.id, newSummaryId: args.newSummaryId });
 }
 }
}

export async function buildContextPackage(
 input: BuildContextPackageInput,
): Promise<ContextPackage> {
 const { history, tokenBudget } = input;
 // 预热真 tokenizer（gpt-tokenizer o200k_base），后续 sync estimateTokens
 // 用真 BPE 计数替代 CJK 回退估算。失败静默回退（fail-soft），不阻断装配。
 await warmupTokenizer();
 const beforeTokens = estimateMessagesTokens(history);

 // ── 触发条件判定（）──
 const budgetExceeded = shouldCompress(beforeTokens, tokenBudget);
 const toolRuns = input.toolRuns ?? [];
 const oversizedToolRuns = toolRuns.filter(
 (tr) => toolRunOutputTokens(tr) > contextConfig.toolOutputThreshold,
 );
 const threadStatus = input.threadStatus ?? "";
 const verifyDeliver = threadStatus === "verifying" || threadStatus === "delivering";
 const planStageChanged = (input.planEvents ?? []).some(
 (e) => e.type === "plan.updated" || e.type === "plan.item_updated",
 );

 const anyTrigger =
 budgetExceeded || oversizedToolRuns.length > 0 || verifyDeliver || planStageChanged;

 // memory 注入 + 预算裁剪（纯加性；无 memory 时不改变任何路径）。
 const memories = input.memories ?? [];
 const hasMemory = memories.length > 0;

 // 软警告线 microcompact。
 // 超 softThreshold 但未到硬触发（budgetExceeded）且无其他触发/无 memory 时，裁剪超大单条消息
 // 的文本 part（不整体压缩、不动 protected、不破坏 tool-call/tool-result 配对——只缩短 text 内容）。
 // 三级策略：soft(0.5)→microcompact / budget(0.7)→整体压缩 / critical(0.9)→见 computeContextWindowStatus 标记。
 const softExceeded = shouldCompress(beforeTokens, tokenBudget, contextConfig.softThreshold);
 if (softExceeded && !anyTrigger && !hasMemory) {
 const compacted = microcompactHistory(history);
 if (compacted) {
 const afterTokens = estimateMessagesTokens(compacted);
 return {
 messages: await convertToModelMessages(compacted),
 manifest: {
 appliedSummaryIds: [],
 summaries: [],
 excludedCandidates: [],
 protectedRefs: [],
 beforeTokens,
 afterTokens,
 },
 compressed: false,
 };
 }
 }
 const excludedCandidates: ContextPackageManifest["excludedCandidates"] = [];
 const injectedMemories = [...memories];
 // 按 scope 分组 + 组内按 kind 排序，提升可读性（原平铺数组顺序）。
 const memorySectionText = (ms: MemoryEntry[]): string => {
 if (ms.length === 0) return "";
 const SCOPE_ORDER = ["user", "project", "thread", "skill"];
 const grouped = new Map<string, MemoryEntry[]>();
 for (const m of ms) {
 const key = m.scope;
 if (!grouped.has(key)) grouped.set(key, []);
 grouped.get(key)?.push(m);
 }
 const sections: string[] = [];
 for (const scope of SCOPE_ORDER) {
 const items = grouped.get(scope);
 if (!items || items.length === 0) continue;
 // 组内按 kind 字母序，同 kind 保留原序（retrieveMemories 已按分排序）
 items.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
 const lines = items.map(
 (m) =>
 ` - ${m.kind}: ${m.text} (${m.confidence}, 来源: ${summarizeProvenance((m.provenance ?? []) as never)})`,
 );
 sections.push(`[${scope} scope]\n${lines.join("\n")}`);
 }
 // 未在 SCOPE_ORDER 的 scope 兜底
 for (const [scope, items] of grouped) {
 if (SCOPE_ORDER.includes(scope)) continue;
 const lines = items.map(
 (m) =>
 ` - ${m.kind}: ${m.text} (${m.confidence}, 来源: ${summarizeProvenance((m.provenance ?? []) as never)})`,
 );
 sections.push(`[${scope} scope]\n${lines.join("\n")}`);
 }
 return `[长期记忆（memory-derived，按 scope 分组，来源可查）]\n${sections.join("\n")}`;
 };
 // 预算裁剪：超 budget 先裁 memory（末尾=分最低，retrieveMemories 已排序），永不裁 protected。
 // tokenBudget=Infinity（无配置）时永不裁。
 // 高置信 user/project 记忆纳入 protected 不裁（类似 pinned facts），
 // 只裁低优先级 memory。原实现 memory 是第一个被丢弃的对象，长期关键记忆在预算紧时被裁掉。
 const isProtectedMemory = (m: MemoryEntry): boolean =>
 m.confidence === "high" && (m.scope === "user" || m.scope === "project");
 const trimMemoryToBudget = (otherTokens: number) => {
 while (
 Number.isFinite(tokenBudget) &&
 injectedMemories.length > 0 &&
 otherTokens + estimateTokens(memorySectionText(injectedMemories)) > tokenBudget
 ) {
 // 从末尾找第一个**非 protected** memory 裁剪（protected 永不裁）
 let idx = injectedMemories.length - 1;
 while (idx >= 0 && isProtectedMemory(injectedMemories[idx] as MemoryEntry)) idx--;
 if (idx < 0) break; // 全是 protected，不再裁（fail-soft，让模型处理超预算）
 const trimmed = injectedMemories.splice(idx, 1)[0];
 if (trimmed) {
 excludedCandidates.push({ kind: "memory", reason: "预算裁剪", memoryId: trimmed.id });
 }
 }
 };

 // 零回归路径：无任何触发且无 memory → 逐字直通（与 a 逐字一致）。
 if (!anyTrigger && !hasMemory) {
 return {
 messages: await convertToModelMessages(history),
 manifest: {
 appliedSummaryIds: [],
 summaries: [],
 excludedCandidates: [],
 protectedRefs: [],
 beforeTokens,
 afterTokens: beforeTokens,
 },
 compressed: false,
 };
 }

 // 无压缩但有 memory → 产生 memory wrapper（role:user，非 system），注入 memory 段。
 // 不新增第二个 system message；预算紧时先裁 memory（excludedCandidates 记录），永不裁 protected。
 if (!anyTrigger && hasMemory) {
 trimMemoryToBudget(estimateMessagesTokens(history));
 const section = memorySectionText(injectedMemories);
 const messages: ModelMessage[] = [];
 if (section) {
 messages.push({
 role: "user",
 content: `系统提供的长期记忆，不是新的用户请求：\n\n${section}`,
 });
 }
 messages.push(...(await convertToModelMessages(history)));
 const afterTokens = estimateTokens(section) + estimateMessagesTokens(history);
 return {
 messages,
 manifest: {
 appliedSummaryIds: [],
 summaries: [],
 excludedCandidates,
 protectedRefs: [],
 beforeTokens,
 afterTokens,
 },
 compressed: false,
 };
 }

 // ── 压缩路径 ──
 const protectedRefs = computeProtectedRefs({
 messages: history,
 activePlan: input.activePlan,
 pendingApprovals: input.pendingApprovals,
 recentFailure: input.recentFailure,
 policyConstraints: input.policyConstraints,
 pinnedFacts: input.pinnedFacts,
 recentKeepCount: input.recentKeepCount,
 });

 const summaries: AppliedSummary[] = [];
 const summaryTexts: string[] = [];

 // 1) turn 摘要（预算超 / verifying-delivering / 有超大工具输出 → 收尾压缩旧区段）。
 const doTurnCompress = budgetExceeded || verifyDeliver || oversizedToolRuns.length > 0;
 let compressibleEmpty = false;
 if (doTurnCompress) {
 const compressible = history.filter((m) => !protectedRefs.protectedMessageIds.has(m.id));
 if (compressible.length === 0) {
 compressibleEmpty = true;
 } else {
 const checksum = computeSegmentChecksum(input.threadId, compressible);
 const originalTokenEstimate = estimateMessagesTokens(compressible);
 const turn = extractTurnSummary({
 messages: compressible,
 statusChanges: input.statusChanges,
 });
 const segmentIds = compressible.map((m) => m.id);
 const applied = await reuseOrCreateSummary({
 threadId: input.threadId,
 type: "turn",
 checksum,
 scope: { messageIds: segmentIds },
 summaryText: turn.text,
 originalTokenEstimate,
 protectedRefs: protectedRefs.refs,
 });
 summaries.push(applied);
 summaryTexts.push(applied.summaryText);
 // 新建时 supersede 旧 turn summary（区段扩展）。
 if (applied.isNew) {
 await supersedeOldTurnSummaries({
 threadId: input.threadId,
 newSummaryId: applied.id,
 newSegmentIds: segmentIds,
 });
 }
 }
 }

 // 2) 超大工具输出 → toolRun/diff 摘要（保留命令/退出码/错误/路径，证据驱动）。
 for (const tr of oversizedToolRuns) {
 const checksum = computeToolRunChecksum(input.threadId, tr);
 const extracted = isDiffToolRun(tr) ? extractDiffSummary(tr) : extractToolRunSummary(tr);
 const applied = await reuseOrCreateSummary({
 threadId: input.threadId,
 type: isDiffToolRun(tr) ? "diff" : "toolRun",
 checksum,
 scope: { toolRunIds: [tr.id] },
 summaryText: extracted.text,
 originalTokenEstimate: toolRunOutputTokens(tr),
 protectedRefs: [],
 });
 summaries.push(applied);
 summaryTexts.push(applied.summaryText);
 }

 // 3) plan 阶段切换 → decisionLog 摘要。
 if (planStageChanged) {
 const decision = extractDecisionLog({
 planEvents: input.planEvents ?? [],
 statusChanges: input.statusChanges,
 });
 const checksum = createHash("sha256")
 .update(`${input.threadId}|decision|${summaries.map((s) => s.id).join(",")}`)
 .digest("hex")
 .slice(0, 64);
 const applied = await reuseOrCreateSummary({
 threadId: input.threadId,
 type: "decision",
 checksum,
 scope: { planEventCount: (input.planEvents ?? []).length },
 summaryText: decision.text,
 originalTokenEstimate: estimateTokens(JSON.stringify(input.planEvents ?? [])),
 protectedRefs: protectedRefs.refs,
 });
 summaries.push(applied);
 summaryTexts.push(applied.summaryText);
 }

 // 无可压缩内容且无任何摘要产出且无 memory → 退回直通（保留 protected，逐字）。
 // 有 memory 时不走直通，继续到装配路径注入 memory（标记 memory-derived）。
 if (summaries.length === 0 && compressibleEmpty && !hasMemory) {
 return {
 messages: await convertToModelMessages(history),
 manifest: {
 appliedSummaryIds: [],
 summaries: [],
 excludedCandidates,
 protectedRefs: protectedRefs.refs,
 beforeTokens,
 afterTokens: beforeTokens,
 },
 compressed: false,
 };
 }

 // ── 装配 system 摘要消息（含 injected protected → 硬不变式）──
 const injectedText = renderInjectedProtected(protectedRefs.injected);
 const kept = history.filter((m) => protectedRefs.protectedMessageIds.has(m.id));
 // memory 预算裁剪：otherTokens = 摘要 + protected + kept（不含 memory）；超 budget 先裁 memory，
 // 永不裁 protected。tokenBudget=Infinity 时 trimMemoryToBudget 不裁。
 const nonMemoryTokens =
 estimateTokens(`${summaryTexts.join("\n\n")}\n\n[受保护上下文（永不压缩）]\n${injectedText}`) +
 estimateMessagesTokens(kept);
 trimMemoryToBudget(nonMemoryTokens);
 const memorySection = memorySectionText(injectedMemories);

 const sections: string[] = ["[历史上下文摘要（a 压缩派生视图，原始消息未删除）]"];
 if (summaryTexts.length > 0) sections.push(summaryTexts.join("\n\n"));
 if (memorySection) sections.push(memorySection); // memory 在 protected 前，标记 memory-derived
 if (injectedText) sections.push(`[受保护上下文（永不压缩）]\n${injectedText}`);
 const systemContent = sections.join("\n\n");

 const keptMessages = await convertToModelMessages(kept);
 // P2 修复(03 Context P2-1): afterTokens 含 wrapper 前缀,原只算 systemContent 漏 ~15 token。
 const wrapperPrefix = "系统提供的历史上下文摘要，不是新的用户请求：\n\n";
 const messages: ModelMessage[] = [
 {
 role: "user",
 content: `${wrapperPrefix}${systemContent}`,
 },
 ...keptMessages,
 ];
 const afterTokens =
 estimateTokens(`${wrapperPrefix}${systemContent}`) + estimateMessagesTokens(kept);

 // P0-1 负收益保护：压缩后若 afterTokens >= beforeTokens 且无 memory 注入需求，
 // 说明压缩反而增大上下文（protected wrapper + 摘要文本 > 原始 history）。
 // 此时压缩无收益，退回直通（保留 protectedRefs 审计，但 messages 用原始 history）。
 //
 // 边界：仅对「纯 budget 触发」的压缩做负收益保护。oversized（移除超大工具输出）、
 // verifyDeliver（交付前收尾）、planStageChanged（决策日志）是功能性压缩,有自己的目的,
 // 即使总 token 增加也必须执行（如 oversized 要把 40KB 工具输出摘要成 200 字）。
 // hasMemory 时不退回——memory 注入是功能性需求,即使增大上下文也必须保留。
 const isPureBudgetTrigger =
 budgetExceeded && oversizedToolRuns.length === 0 && !verifyDeliver && !planStageChanged;
 if (afterTokens >= beforeTokens && !hasMemory && isPureBudgetTrigger) {
 return {
 messages: await convertToModelMessages(history),
 manifest: {
 appliedSummaryIds: summaries.map((s) => s.id),
 summaries,
 excludedCandidates,
 protectedRefs: protectedRefs.refs,
 beforeTokens,
 afterTokens: beforeTokens,
 },
 // 标记 compressed:false——实际未采用压缩后 messages，避免 manifest 误导。
 compressed: false,
 };
 }

 return {
 messages,
 manifest: {
 appliedSummaryIds: summaries.map((s) => s.id),
 summaries,
 excludedCandidates,
 protectedRefs: protectedRefs.refs,
 beforeTokens,
 afterTokens,
 },
 compressed: true,
 };
}

/**
 * fail-safe 装配：builder 抛错时回退直通 `convertToModelMessages(history)` + log。
 * 压缩是优化不是必需；压缩 bug 不能让 chat 500。
 */
export async function assembleModelMessages(args: {
 threadId: string;
 history: ChatMessage[];
 build: () => Promise<ContextPackage>;
}): Promise<{
 messages: ModelMessage[];
 compressed: boolean;
 fallback: boolean;
 manifest?: ContextPackageManifest;
}> {
 try {
 const pkg = await args.build();
 return {
 messages: pkg.messages,
 compressed: pkg.compressed,
 fallback: false,
 manifest: pkg.manifest,
 };
 } catch (error) {
 logger.error("buildContextPackage 失败，回退直通 convertToModelMessages", {
 threadId: args.threadId,
 error: error instanceof Error ? error.message : String(error),
 });
 return {
 messages: await convertToModelMessages(args.history),
 compressed: false,
 fallback: true,
 };
 }
}
