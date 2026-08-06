import { createHash } from "node:crypto";
import { getToolManifest } from "@/lib/ai/tool-registry";
import type { ToolCategory, ToolRisk } from "@/lib/ai/tool-registry";
import type { RuntimeType } from "@/lib/config";

/**
 * Stage C：Context Manifest 生成与持久化。
 *
 * 每次模型调用前构建一个 `ContextManifest`，结构化记录「本轮模型看到了哪些来源」。
 * 只记录来源与摘要，**不存完整 prompt / 用户消息正文 / 完整工具输出**（隐私约束）。
 *
 * 本模块的 `buildContextManifest` 是纯函数；`recordContextSnapshot` 负责落库 + 事件，
 * 并 fail-open（写入失败不阻断 chat 主流程）。
 */

export type ContextLayer = {
 layer: "instructions" | "thread" | "workspace" | "toolEvidence" | "memory" | "external";
 sourceId: string;
 reason: string;
 estimatedTokens: number;
 priority: number;
 /** 摘要 / 计数，禁止塞完整原文。 */
 inline?: string;
};

export type ContextLayerEntry = ContextLayer;

export type ContextManifestSkillRef = {
 skillId: string;
 versionId: string;
 commitSha?: string | null;
 /**
 * V8 阶段 6：能力声明（string[]），只用于 Resolver 判断和 Studio 提示，不限制工具可见性。
 * 替代旧 allowedTools 字段（已 deprecated，不再作为工具安全边界）。
 */
 requiredCapabilities?: string[] | null;
 runtimeType?: string | null;
};

export type ContextManifestInput = {
 threadId: string;
 /** 触发场景，如 chat.user_message。 */
 trigger: string;
 model: string;
 runtimeType?: RuntimeType | null;
 /** 归属 ThreadRun（由 route.ts 传入预创建的 runId）。 */
 runId?: string | null;
 /** 当前冻结 skill；无 skill 时省略。 */
 skill?: ContextManifestSkillRef | null;
 /** 已加载历史消息数量（不含本轮）。 */
 historyCount: number;
 /** 本轮模型可见工具名。 */
 visibleToolNames: string[];
 /**
 * a：本轮 token 预算（`Infinity` 表示无配置/永不压缩）。可选，不破坏 调用方。
 * 写入 manifest 供审计（不参与 manifest 计算）。
 */
 tokenBudget?: number;
 /**
 * a：本轮装配应用的 ContextSummary id 列表（由 package builder 传入）。可选。
 * 空数组/省略 = 未压缩。写入 manifest 供审计与 Studio 展示。
 */
 appliedSummaryIds?: string[];
 /**
 * buildContextPackage 的真实装配 manifest 摘要。
 *
 * 传入后 manifest 的 protectedRefs/excludedCandidates/compressed/afterTokens 与真实模型输入
 * 一致（不再用静态默认）；未传入时保持 静态行为（零回归）。
 * 这是 Stage 0 硬不变式：context manifest 必须反映本轮真实装配，而非静态来源清单。
 */
 packageManifest?: {
 compressed: boolean;
 beforeTokens: number;
 afterTokens: number;
 protectedRefs: Array<{ kind: string; messageIds: string[]; reason: string }>;
 excludedCandidates: Array<{ kind: string; reason: string }>;
 appliedSummaryIds: string[];
 };
 /**
 * 本轮访问的外部资料来源（webFetch/webSearch/searchDocs/MCP）。
 * 非空时填 external layer（sourceId="external.fetch"），记录 sourceUrl/contentHash 列表供审计/可解释；
 * 空/省略时保持 默认 sourceId="none"（零回归）。
 * external layer 只观测记录，不主动注入——webFetch 是按需工具调用，结果走 tool evidence。
 */
 externalSources?: Array<{
 sourceUrl: string;
 fetchedAt?: string | Date;
 expiresAt?: string | Date | null;
 contentHash?: string;
 }>;
 /**
 * 本轮注入的长期记忆（填 memory layer；空时 sourceId:none 零回归）。
 * 与 packageManifest 不同：这是注入的记忆列表，供 manifest memory layer 记录来源与可观测。
 */
 memories?: Array<{
 id: string;
 scope: string;
 kind: string;
 textHash?: string;
 /** 最终排序分（lexical / semantic rerank 综合）。 */
 retrievalScore?: number;
 /** 命中来源：lexical 召回、semantic rerank 或纯 semantic 匹配。 */
 retrievalReason?: "lexical" | "semantic" | "rerank";
 /** embedding 阶段状态：disabled / stale / error / ready。 */
 semanticStatus?: "disabled" | "stale" | "error" | "ready";
 }>;
 /**
 * V8 Skill Run Resolver：本轮 Resolver 输入摘要（availableSkillCount + uiSelectedSkillIds）。
 * 不含完整 SKILL.md（懒加载约束）。写入 ContextSnapshot.skillResolverInput 供 Studio 复盘。
 */
 skillResolverInput?: {
 availableSkillCount: number;
 uiSelectedSkillIds: string[];
 };
 /**
 * V8：本轮 Resolver 输出（selectedSkillVersions 摘要 + decisionReason + ignoredUiSelectedSkillIds）。
 * 写入 ContextSnapshot.skillResolverOutput。null/省略 = 未使用 Skill。
 */
 skillResolverOutput?: {
 selectedSkillVersions: Array<{
 skillId: string;
 skillVersionId: string;
 role: string;
 source: string;
 }>;
 decisionReason: string;
 ignoredUiSelectedSkillIds: string[];
 } | null;
};

export type ContextManifest = {
 threadId: string;
 trigger: string;
 model: string;
 runtimeType: string | null;
 activeSkillVersionId: string | null;
 toolNames: string[];
 layers: ContextLayerEntry[];
 protectedRefs: Array<{ layer: ContextLayer["layer"]; sourceId: string; reason?: string }>;
 excludedCandidates: Array<{ layer: ContextLayer["layer"]; sourceId: string; reason: string }>;
 checksums: Record<string, string>;
 estimatedTokens: number;
 /**
 * 本轮是否压缩装配（来自 buildContextPackage 的真实 manifest）。
 * 与真实模型输入一致——非静态推断，避免 manifest 与装配脱节。
 */
 compressed: boolean;
 /**
 * 本轮装配后真实模型输入 token（压缩后 ≠ estimatedTokens）。
 * null = 未传 packageManifest（旧调用方 / 零回归路径）。
 */
 afterTokens: number | null;
 /** 归属 ThreadRun（nullable（历史快照可空））。 */
 runId: string | null;
};

/**
 * token 估算统一到 budget.ts。
 *
 * 原本模块自带 char/4 估算，与 budget.ts 的 CJK 友好版各算各的，中文场景 manifest 低估。
 * 改用 budget.estimateTokens（tokenizer 加载后用真 BPE，否则 CJK 回退），口径与 package-builder 一致。
 */
import { estimateTokens } from "./budget";

function sha256(content: string): string {
 return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * 构建上下文 manifest（纯函数）。
 *
 * 分层（）：
 * - instructions.system.base：chat route 固定系统约束（只记来源，不存 prompt 文本）
 * - instructions.skill.<versionId>：当前 active skill 版本摘要（不存 SKILL.md 全文）
 * - thread.messages.history：已加载历史消息数量
 * - workspace.runtime.<runtimeType>：当前 runtime 类型
 * - toolEvidence.tools.visible：本轮可见工具 manifest
 * - external / memory：默认空
 *
 * protectedRefs：最新用户指令、当前 plan/todo 等不可压缩来源。标记 instructions 与
 * thread 层为受保护，具体内容后续阶段填充。
 */
export function buildContextManifest(input: ContextManifestInput): ContextManifest {
 const toolManifest = getToolManifest(input.visibleToolNames);
 const toolNames = toolManifest.map((t) => t.name);
 const visibleToolsInline = toolManifest
 .map((t) => `${t.name}(${t.category}/${t.risk})`)
 .join(",");

 const layers: ContextLayerEntry[] = [
 {
 layer: "instructions",
 sourceId: "system.base",
 reason: "chat route 固定系统约束",
 estimatedTokens: 0,
 priority: 100,
 },
 ];

 if (input.skill) {
 layers.push({
 layer: "instructions",
 sourceId: `skill.${input.skill.versionId}`,
 reason: "当前 active skill 版本指令",
 estimatedTokens: 0,
 priority: 95,
 inline: JSON.stringify({
 skillId: input.skill.skillId,
 versionId: input.skill.versionId,
 commitSha: input.skill.commitSha ?? null,
 // V8 阶段 6：记录能力声明（审计用），不再记录 allowedTools 作为安全边界
 requiredCapabilities: input.skill.requiredCapabilities ?? null,
 runtimeType: input.skill.runtimeType ?? null,
 }),
 });
 }

 const historyInline = `count=${Math.max(0, input.historyCount)}`;
 layers.push({
 layer: "thread",
 sourceId: "messages.history",
 reason: "已加载历史消息",
 estimatedTokens: estimateTokens(historyInline),
 priority: 90,
 inline: historyInline,
 });

 const runtimeInline = `runtime=${input.runtimeType ?? "host"}`;
 layers.push({
 layer: "workspace",
 sourceId: `runtime.${input.runtimeType ?? "host"}`,
 reason: "当前 runtime 类型",
 estimatedTokens: estimateTokens(runtimeInline),
 priority: 70,
 inline: runtimeInline,
 });

 layers.push({
 layer: "toolEvidence",
 sourceId: "tools.visible",
 reason: "本轮可见工具名与 metadata",
 estimatedTokens: estimateTokens(visibleToolsInline),
 priority: 60,
 inline: visibleToolsInline,
 });

 // external layer：填实。非空 externalSources → sourceId="external.fetch"，
 // inline 记 sourceUrl/contentHash 列表（只摘要，不塞原文）；空 → 保持 默认 "none"（零回归）。
 // external layer 只观测记录，不主动注入（webFetch 结果走 tool evidence）。
 const externalSources = input.externalSources ?? [];
 if (externalSources.length > 0) {
 const externalInline = externalSources
 .map((s) => `${s.sourceUrl}#${s.contentHash ?? "?"}`)
 .join(",");
 layers.push({
 layer: "external",
 sourceId: "external.fetch",
 reason: "本轮访问的外部资料来源（webFetch/webSearch/searchDocs/MCP）",
 estimatedTokens: estimateTokens(externalInline),
 priority: 30,
 inline: externalInline,
 });
 } else {
 // 默认空，仅占位以稳定分层结构。
 layers.push({
 layer: "external",
 sourceId: "none",
 reason: "默认无外部资料",
 estimatedTokens: 0,
 priority: 30,
 });
 }
 // memory layer：填实。非空 memories → sourceId="memory.store"，inline 记 id/scope/kind/score/reason/status；
 // 空 → 保持 默认 "none"（零回归）。
 const mems = input.memories ?? [];
 if (mems.length > 0) {
 const memInline = mems
 .map((m) => {
 const parts = [m.id, m.scope, m.kind];
 if (m.retrievalScore !== undefined) parts.push(String(m.retrievalScore));
 if (m.retrievalReason) parts.push(m.retrievalReason);
 if (m.semanticStatus) parts.push(m.semanticStatus);
 return parts.join(":");
 })
 .join(",");
 layers.push({
 layer: "memory",
 sourceId: "memory.store",
 reason: `本轮注入 ${mems.length} 条长期记忆（memory-derived）`,
 estimatedTokens: estimateTokens(memInline),
 priority: 40,
 inline: memInline,
 });
 } else {
 layers.push({
 layer: "memory",
 sourceId: "none",
 reason: "默认无长期记忆",
 estimatedTokens: 0,
 priority: 40,
 });
 }

 // 有 packageManifest 时用真实 protected/excluded（与装配一致）；
 // 否则保持 静态默认（零回归）。protectedRef.kind → layer 全归 thread（protected
 // 内容最终都进入装配 messages / system 摘要，属 thread 层硬保留）。excludedCandidate.kind
 // 为 memory 时归 memory 层，其余归 thread 层；reason 透传真实裁剪原因。
 const pkg = input.packageManifest;
 const protectedRefs: ContextManifest["protectedRefs"] = pkg
 ? pkg.protectedRefs.map((r) => ({
 layer: "thread" as const,
 sourceId: r.kind,
 reason: r.reason,
 }))
 : [
 { layer: "instructions", sourceId: "system.base" },
 { layer: "thread", sourceId: "messages.history" },
 ];

 const excludedCandidates: ContextManifest["excludedCandidates"] = pkg
 ? pkg.excludedCandidates.map((c) => ({
 layer: c.kind === "memory" ? ("memory" as const) : ("thread" as const),
 sourceId: c.kind,
 reason: c.reason,
 }))
 : [];

 // 稳定层 checksum：工具集合 + skill 版本 + runtime。
 const checksums: Record<string, string> = {
 tools: sha256(toolNames.join(",")),
 runtime: sha256(input.runtimeType ?? "host"),
 };
 if (input.skill) {
 checksums.skill = sha256(`${input.skill.versionId}:${input.skill.commitSha ?? ""}`);
 }

 const estimatedTokens = layers.reduce((sum, l) => sum + l.estimatedTokens, 0);

 return {
 threadId: input.threadId,
 trigger: input.trigger,
 model: input.model,
 runtimeType: input.runtimeType ?? null,
 activeSkillVersionId: input.skill?.versionId ?? null,
 toolNames,
 layers,
 protectedRefs,
 excludedCandidates,
 checksums,
 estimatedTokens,
 // 与真实模型输入一致（来自 packageManifest；未传则零回归默认）。
 compressed: pkg?.compressed ?? false,
 afterTokens: pkg?.afterTokens ?? null,
 // 归属 ThreadRun 透传。
 runId: input.runId ?? null,
 };
}

/** manifest 中导出的工具 manifest 条目类型（供 Studio/UI 复用）。 */
export type ToolManifestEntry = {
 name: string;
 category: ToolCategory;
 risk: ToolRisk;
 permissionKey: string;
};

/** 工具 manifest 单独导出，供 route 组装 input 时不必直接依赖 registry 内部类型。 */
export function buildToolManifest(names: Iterable<string>): ToolManifestEntry[] {
 return getToolManifest(names);
}

// ─── 落库编排（fail-open）─────────────────────────────────────
//
// recordContextSnapshot：构建 manifest → 写 ContextSnapshot → 追加 context.snapshot_created
// 事件。任一步失败只记 server log，**不抛出、不阻断 chat 主流程、不改变 thread status**
// （/ 验收：manifest 写入失败不会让 /api/chat 直接 500）。

import { appendThreadEvent, saveContextSnapshot } from "@/lib/db/queries";
import { logger } from "@/lib/logger";

export async function recordContextSnapshot(input: ContextManifestInput): Promise<void> {
 try {
 const manifest = buildContextManifest(input);
 const snapshot = await saveContextSnapshot({
 threadId: manifest.threadId,
 trigger: manifest.trigger,
 model: manifest.model,
 runtimeType: manifest.runtimeType,
 activeSkillVersionId: manifest.activeSkillVersionId,
 runId: manifest.runId ?? null,
 toolNames: manifest.toolNames,
 layers: manifest.layers,
 protectedRefs: manifest.protectedRefs,
 excludedCandidates: manifest.excludedCandidates,
 checksums: manifest.checksums,
 estimatedTokens: manifest.estimatedTokens,
 compressed: manifest.compressed,
 afterTokens: manifest.afterTokens,
 // V8：Resolver 输入/输出摘要写入快照（不含完整 SKILL.md，懒加载约束）
 skillResolverInput: input.skillResolverInput,
 skillResolverOutput: input.skillResolverOutput ?? null,
 });
 await appendThreadEvent(
 manifest.threadId,
 "context.snapshot_created",
 {
 snapshotId: snapshot.id,
 model: manifest.model,
 estimatedTokens: manifest.estimatedTokens,
 toolCount: manifest.toolNames.length,
 },
 manifest.runId ?? null,
 );
 } catch (error) {
 // fail-open：观测性数据写入失败不应阻断 chat
 logger.error("context snapshot 写入失败（fail-open）", {
 threadId: input.threadId,
 error: error instanceof Error ? error.message : String(error),
 });
 }
}
