import { listItemsByThread } from "@/lib/conversations/thread-item-queries";
/**
 * V11 Context 源解析器（阶段 7 S07-C01 / S07-C04 / S07-C05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §3（渐进加载）、§8（作用域）、§9（挂载与检索）、
 * §13（Knowledge 加载：先目录后证据 / 数据保持最新 / 检索失败区分）、§15（失败与恢复）。
 * - ../v11-agentkit-platform/13-memory-and-job-api.md §3（Context Checkpoint API）。
 *
 * 职责：
 * - 定义 SourceResolver 接口与四种稳定结果状态（ok/empty/denied/unavailable）。
 * - 实现 RecentItemsResolver（查询最近 Thread Item，阶段 4 已建）。
 * - 实现 SkillResolver（查询 Skill 指令片段，阶段 6 已建）。
 * - 实现 WorkspaceMapResolver（查询 Workspace 文件地图，占位实现）。
 * - MemoryResolver（S07-C04 接入真实分作用域检索）。
 * - KnowledgeResolver（S07-C05 接入真实证据检索；无 published Document → empty；索引未就绪 → unavailable）。
 *
 * 关键约束（、、§15）：
 * - 权限拒绝、服务不可用和确实无结果必须返回不同稳定结果，不把故障伪装成空结果。
 * - 查询受 Invocation、用户、Agent、Workspace、Policy 和数据分类限制。
 * - 模型不能绕过平台读取未挂载 Memory、Knowledge 或文件。
 */
import { db } from "@/lib/db/client";
import type { MemoryEntry, MemoryScopeType } from "@/lib/persistence/schema/memory";
import { skillTable as skillTableTable } from "@/lib/persistence/schema/skill";
import { getCurrentSkillVersion } from "@/lib/capability/skill-queries";
import {
 type ContextFragment,
 FRAGMENT_PRIORITY_TIERS,
 type FragmentScope,
 type FragmentTrust,
 computeFragmentContentHash,
 derivePriorityTier,
 estimateFragmentTokens,
 verifyFragmentContentHash,
} from "@/lib/context/fragment";
import {
 type KnowledgeEvidenceHit,
 searchKnowledgeEvidence,
} from "@/lib/context/knowledge-queries";
import { listActiveMemoryEntriesByScopes } from "@/lib/context/memory-queries";
import { eq } from "drizzle-orm";

// ─── 源结果状态 ─────────────────────────────────────────────

/**
 * 源查询结果状态（§15：必须区分无结果与不可用）。
 * - ok：查询成功，返回零或多个 Fragment。
 * - empty：确实无结果（数据存在但无匹配）。
 * - denied：权限拒绝（用户/Agent 无权访问该源）。
 * - unavailable：服务不可用（索引故障、依赖未就绪）。
 *
 * 关键不变量：unavailable 不得伪装为 empty，否则模型会回答“没有相关规定”。
 */
export const SOURCE_RESULT_STATUSES = ["ok", "empty", "denied", "unavailable"] as const;
export type SourceResultStatus = (typeof SOURCE_RESULT_STATUSES)[number];

/** 源查询结果。 */
export interface SourceQueryResult {
 /** 源类型标识（recent_items/skill/workspace_map/memory/knowledge）。 */
 sourceType: string;
 status: SourceResultStatus;
 /** status=ok 时的 Fragment 列表（empty 时为空数组）。 */
 fragments: ContextFragment[];
 /** status=denied/unavailable 时的原因代码。 */
 reasonCode?: string;
 /** 状态说明。 */
 detail?: string;
}

// ─── 源解析器接口 ───────────────────────────────────────────

/**
 * Context 查询请求上下文（由 route handler 从 Workload Token + 请求体构造）。
 *
 * - tenantId：租户（来自 Token claims）。
 * - invocationId：当前 Invocation（来自 Token claims）。
 * - threadId：当前 Thread（可选，recent_items 源需要）。
 * - agentId：当前 Agent（可选，skill/agent-specific memory 源需要）。
 * - userId：当前用户（可选，user_preference memory 源需要）。
 * - workspaceId：当前 Workspace（可选，workspace_map/file 源需要）。
 */
export interface ContextQueryContext {
 tenantId: string;
 invocationId: string;
 threadId?: string;
 agentId?: string;
 userId?: string;
 workspaceId?: string | null;
 triggerItemId?: string;
 policyRevisionId?: string | null;
 classification?: ContextFragment["sensitivity"];
 allowedSources?: string[];
 allowedSkillIds?: string[];
 query?: string;
 maxItems?: number;
 maxTokens?: number;
 maxSensitivity?: ContextFragment["sensitivity"];
}

/**
 * 源解析器接口：每种源实现一个。
 *
 * 实现 responsibility：
 * - 按 ctx 限制查询（跨租户隔离、权限边界）。
 * - 返回四种稳定状态之一，不把故障伪装成空结果。
 */
export interface SourceResolver {
 sourceType: string;
 resolve(ctx: ContextQueryContext): Promise<SourceQueryResult>;
}

// ─── RecentItemsResolver ───────────────────────────────────

/**
 * 最近 Thread Item 解析器（最近必要对话）。
 *
 * 查询当前 Thread 的最近 Item，转换为 user/agent_message/tool_call/tool_result Fragment。
 * - threadId 缺失 → empty。
 * - 无 Item → empty。
 * - 查询成功 → ok + fragments。
 */
export class RecentItemsResolver implements SourceResolver {
 readonly sourceType = "recent_items";
 private readonly limit: number;

 constructor(limit = 20) {
 this.limit = limit;
 }

 async resolve(ctx: ContextQueryContext): Promise<SourceQueryResult> {
 if (ctx.allowedSources && !ctx.allowedSources.includes(this.sourceType)) {
 return {
 sourceType: this.sourceType,
 status: "denied",
 fragments: [],
 reasonCode: "source_not_authorized",
 };
 }
 if (!ctx.threadId) {
 return {
 sourceType: this.sourceType,
 status: "empty",
 fragments: [],
 reasonCode: "thread_not_specified",
 detail: "未指定 threadId，无法查询最近 Item",
 };
 }

 const items = await listItemsByThread(ctx.tenantId, ctx.threadId, {
 limit: this.limit,
 includeSuperseded: false,
 });

 if (items.length === 0) {
 return {
 sourceType: this.sourceType,
 status: "empty",
 fragments: [],
 reasonCode: "no_items",
 };
 }

 const query = ctx.query?.trim().toLocaleLowerCase() ?? "";
 const maxItems = Math.max(0, ctx.maxItems ?? this.limit);
 const selectedItems = items
 .filter((item) => {
 if (item.id === ctx.triggerItemId) return true;
 if (!query) return true;
 return extractItemText(item.contentJson).toLocaleLowerCase().includes(query);
 })
 .slice(0, maxItems);
 if (selectedItems.length === 0) {
 return {
 sourceType: this.sourceType,
 status: "empty",
 fragments: [],
 reasonCode: "no_query_match",
 };
 }
 const fragments: ContextFragment[] = selectedItems.map((item, idx) =>
 threadItemToFragment(item, idx, ctx),
 );

 return {
 sourceType: this.sourceType,
 status: "ok",
 fragments,
 };
 }
}

/** 把 ThreadItem 转换为 ContextFragment。 */
export function threadItemToFragment(
 item: { id: string; itemType: string; contentJson: unknown; itemSequence: number | bigint },
 index: number,
 ctx: ContextQueryContext,
): ContextFragment {
 // 从 contentJson 提取文本（Item 的 contentJson 结构由阶段 4 定义）。
 const text = extractItemText(item.contentJson);
 const contentHash = computeFragmentContentHash(text);
 const kind = itemTypeToFragmentKind(item.itemType);
 const isCurrentUserInput =
 item.id === ctx.triggerItemId &&
 (item.itemType === "user_message" || item.itemType === "user_guidance");
 const trust: FragmentTrust = isCurrentUserInput ? "trusted_data" : "untrusted_external";
 const scope: FragmentScope = "thread";
 const sensitivity = ctx.classification ?? "internal";
 const sourceType =
 item.itemType === "tool_call"
 ? "tool_call"
 : item.itemType === "tool_result"
 ? "tool_result"
 : "thread_item";

 return {
 id: `frag-recent-${ctx.invocationId}-${index}`,
 kind,
 sourceRef: {
 type: sourceType,
 id:
 sourceType === "thread_item" ? item.id : (extractOperationId(item.contentJson) ?? item.id),
 },
 scope,
 trust,
 sensitivity,
 contentHash,
 tokenEstimate: estimateTokens(text),
 freshness: { updatedAt: new Date() },
 selectionReason: isCurrentUserInput ? "current_user_input" : "recent_item",
 priorityTier: isCurrentUserInput
 ? FRAGMENT_PRIORITY_TIERS.TIER_MANDATORY
 : FRAGMENT_PRIORITY_TIERS.TIER_RECENT,
 ...(sensitivity === "restricted" ? { contentRef: `thread-item://${item.id}` } : { text }),
 };
}

function extractOperationId(contentJson: unknown): string | null {
 if (!contentJson || typeof contentJson !== "object") return null;
 const value = contentJson as Record<string, unknown>;
 for (const key of ["operation_id", "operationId", "tool_call_id", "toolCallId"]) {
 if (typeof value[key] === "string" && value[key]) return value[key];
 }
 return null;
}

/** 从 Item contentJson 提取纯文本（容错处理）。 */
function extractItemText(contentJson: unknown): string {
 if (typeof contentJson === "string") return contentJson;
 if (contentJson && typeof contentJson === "object") {
 const obj = contentJson as Record<string, unknown>;
 if (typeof obj.text === "string") return obj.text;
 if (typeof obj.content === "string") return obj.content;
 if (typeof obj.message === "string") return obj.message;
 }
 return JSON.stringify(contentJson ?? "");
}

/** ThreadItem.itemType → FragmentKind 映射。 */
function itemTypeToFragmentKind(itemType: string): ContextFragment["kind"] {
 switch (itemType) {
 case "user_message":
 case "user_guidance":
 return "user";
 case "agent_message":
 return "user";
 case "tool_call":
 case "tool_result":
 return "tool";
 case "plan":
 return "user";
 default:
 return "user";
 }
}

// ─── SkillResolver ─────────────────────────────────────────

/**
 * Skill 指令片段解析器（按需加载 Skill 完整指令）。
 *
 * 查询指定 Skill 的当前 published 版本内容，转换为 skill Fragment。
 * - skillId 缺失 → empty。
 * - Skill 不存在 / 非 enabled → empty。
 * - 无 published 版本 → empty。
 */
export class SkillResolver implements SourceResolver {
 readonly sourceType = "skill";
 private readonly skillId: string;
 private readonly contentLoader: SkillContentLoader;

 constructor(skillId: string, contentLoader: SkillContentLoader = defaultSkillContentLoader) {
 this.skillId = skillId;
 this.contentLoader = contentLoader;
 }

 async resolve(ctx: ContextQueryContext): Promise<SourceQueryResult> {
 if (
 (ctx.allowedSources && !ctx.allowedSources.includes(this.sourceType)) ||
 (ctx.allowedSkillIds && !ctx.allowedSkillIds.includes(this.skillId))
 ) {
 return {
 sourceType: this.sourceType,
 status: "denied",
 fragments: [],
 reasonCode: "skill_not_authorized",
 };
 }
 if (!this.skillId) {
 return {
 sourceType: this.sourceType,
 status: "empty",
 fragments: [],
 reasonCode: "skill_not_specified",
 };
 }

 // 查询 Skill（跨租户隔离由查询保证）
 const [skillRow] = await db
 .select()
 .from(skillTableTable)
 .where(eq(skillTableTable.id, this.skillId))
 .limit(1);

 if (!skillRow || skillRow.tenantId !== ctx.tenantId) {
 // 跨租户隐藏：统一返回 empty，不暴露存在性
 return {
 sourceType: this.sourceType,
 status: "empty",
 fragments: [],
 reasonCode: "skill_not_found",
 };
 }

 if (skillRow.lifecycleState !== "enabled") {
 return {
 sourceType: this.sourceType,
 status: "denied",
 fragments: [],
 reasonCode: "skill_not_enabled",
 detail: `Skill lifecycleState=${skillRow.lifecycleState}，不可加载`,
 };
 }

 if (!skillRow.currentVersionId) {
 return {
 sourceType: this.sourceType,
 status: "empty",
 fragments: [],
 reasonCode: "no_published_version",
 };
 }

 const version = await getCurrentSkillVersion({ tenantId: ctx.tenantId, skillId: this.skillId });
 if (!version) {
 return {
 sourceType: this.sourceType,
 status: "empty",
 fragments: [],
 reasonCode: "no_current_version",
 };
 }

 const text = await this.contentLoader.load(version.contentRef).catch(() => null);
 if (text === null) {
 return {
 sourceType: this.sourceType,
 status: "unavailable",
 fragments: [],
 reasonCode: "skill_content_unavailable",
 };
 }
 const contentHash = version.contentHash;
 if (!verifyFragmentContentHash(text, contentHash)) {
 return {
 sourceType: this.sourceType,
 status: "unavailable",
 fragments: [],
 reasonCode: "skill_content_hash_mismatch",
 };
 }
 const fragment: ContextFragment = {
 id: `frag-skill-${ctx.invocationId}-${this.skillId}`,
 kind: "skill",
 sourceRef: {
 type: "skill_version",
 id: this.skillId,
 revisionId: version.id,
 hash: contentHash,
 },
 scope: "agent",
 trust: "trusted_data",
 sensitivity: ctx.classification ?? "internal",
 contentHash,
 tokenEstimate: estimateTokens(text),
 freshness: version.publishedAt
 ? { updatedAt: version.publishedAt }
 : { updatedAt: new Date() },
 selectionReason: "skill_instruction",
 priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RELATED,
 ...(ctx.classification === "restricted" ? { contentRef: version.contentRef } : { text }),
 };

 return {
 sourceType: this.sourceType,
 status: "ok",
 fragments: [fragment],
 };
 }
}

export interface SkillContentLoader {
 load(contentRef: string): Promise<string>;
}

const defaultSkillContentLoader: SkillContentLoader = {
 async load(contentRef) {
 const prefix = "inline+base64:";
 if (!contentRef.startsWith(prefix)) {
 throw new Error("Skill content provider 不支持该受控引用");
 }
 return Buffer.from(contentRef.slice(prefix.length), "base64url").toString("utf8");
 },
};

// ─── WorkspaceMapResolver ──────────────────────────────────

/**
 * Workspace 文件地图解析器（可用资料和能力的简短索引）。
 *
 * 当前为占位实现：Workspace 模块在阶段 8 完整接入。
 * 阶段 7 返回 empty（确实无结果），不伪装 unavailable。
 */
export class WorkspaceMapResolver implements SourceResolver {
 readonly sourceType = "workspace_map";

 async resolve(ctx: ContextQueryContext): Promise<SourceQueryResult> {
 if (ctx.allowedSources && !ctx.allowedSources.includes(this.sourceType)) {
 return {
 sourceType: this.sourceType,
 status: "denied",
 fragments: [],
 reasonCode: "source_not_authorized",
 };
 }
 if (!ctx.workspaceId) {
 return {
 sourceType: this.sourceType,
 status: "empty",
 fragments: [],
 reasonCode: "workspace_not_specified",
 };
 }
 return {
 sourceType: this.sourceType,
 status: "unavailable",
 fragments: [],
 reasonCode: "workspace_provider_not_ready",
 detail: "Workspace 文件地图索引在阶段 8 接入",
 };
 }
}

// ─── MemoryResolver（S07-C04 分作用域检索接入） ────────────

/**
 * Memory 源解析器（按需加载某一作用域的 Memory；§8 作用域；§9 挂载与检索）。
 *
 * 阶段 7 S07-C04：接入真实检索实现。
 *
 * 挂载规则（§9）：
 * - Thread 默认挂载：当前 Thread + 当前 Workspace + User Preference + 当前 Agent + Organization。
 * - 跨范围读取必须有明确挂载和权限，不允许模型猜测另一个 Store ID。
 * - 只有低风险通用 User Preference 默认跨 Agent；项目事实和 Agent 业务习惯不扩大范围。
 *
 * 检索流程：
 * 1. 根据 ContextQueryContext 构造 scopes 列表（thread/workspace/agent/user_preference/organization）。
 * 2. 调用 listActiveMemoryEntriesByScopes 查询 active Entry。
 * 3. 转换为 memory kind Fragment（scope 映射：thread→thread, workspace→project, agent→agent,
 * user_preference→user, organization→organization）。
 *
 * 不变量：
 * - 跨租户隔离（tenantId 必须匹配）。
 * - restricted sensitivity 的 Entry 不返回正文（仅保留引用）。
 * - 查询失败 → unavailable（不伪装为 empty）。
 * - 无匹配 → empty（确实无记忆，非服务故障）。
 */
export class MemoryResolver implements SourceResolver {
 readonly sourceType = "memory";
 private readonly limit: number;

 constructor(limit = 20) {
 this.limit = limit;
 }

 async resolve(ctx: ContextQueryContext): Promise<SourceQueryResult> {
 if (ctx.allowedSources && !ctx.allowedSources.includes(this.sourceType)) {
 return {
 sourceType: this.sourceType,
 status: "denied",
 fragments: [],
 reasonCode: "source_not_authorized",
 };
 }

 // 构造 scopes 列表（§9 挂载规则）
 const scopes: Array<{ scopeType: MemoryScopeType; scopeRef?: string | null }> = [];

 // thread scope：当前 Thread
 if (ctx.threadId) {
 scopes.push({ scopeType: "thread", scopeRef: ctx.threadId });
 }

 // workspace scope：当前 Workspace
 if (ctx.workspaceId) {
 scopes.push({ scopeType: "workspace", scopeRef: ctx.workspaceId });
 }

 // agent scope：当前 Agent
 if (ctx.agentId) {
 scopes.push({ scopeType: "agent", scopeRef: ctx.agentId });
 }

 // user_preference scope：用户级（scopeRef=null，跨 Agent）
 scopes.push({ scopeType: "user_preference", scopeRef: null });

 // organization scope：组织级（scopeRef=null）
 scopes.push({ scopeType: "organization", scopeRef: null });

 try {
 const entries = await listActiveMemoryEntriesByScopes(ctx.tenantId, scopes, {
 limit: this.limit,
 });

 if (entries.length === 0) {
 return {
 sourceType: this.sourceType,
 status: "empty",
 fragments: [],
 reasonCode: "no_active_memory",
 };
 }

 const fragments = entries.map((entry) => entryToFragment(entry));
 return {
 sourceType: this.sourceType,
 status: "ok",
 fragments,
 reasonCode: "memory_loaded",
 };
 } catch (err) {
 return {
 sourceType: this.sourceType,
 status: "unavailable",
 fragments: [],
 reasonCode: "memory_query_failed",
 detail: err instanceof Error ? err.message : String(err),
 };
 }
 }
}

/**
 * 把 MemoryEntry 转换为 memory kind Fragment。
 *
 * scope 映射（MemoryScopeType → FragmentScope）：
 * - thread → thread
 * - workspace → project
 * - agent → agent
 * - user_preference → user
 * - organization → organization
 *
 * restricted sensitivity 的 Entry 不返回正文（text=undefined），仅保留引用。
 */
function entryToFragment(entry: MemoryEntry): ContextFragment {
 const scopeMap: Record<MemoryScopeType, FragmentScope> = {
 thread: "thread",
 workspace: "project",
 agent: "agent",
 user_preference: "user",
 organization: "organization",
 };

 const sensitivityMap: Record<string, ContextFragment["sensitivity"]> = {
 public: "public",
 internal: "internal",
 confidential: "confidential",
 restricted: "restricted",
 };

 const fragment: ContextFragment = {
 id: `frag-memory-${entry.id}`,
 kind: "memory",
 sourceRef: {
 type: "memory",
 id: entry.id,
 hash: entry.contentHash,
 },
 scope: scopeMap[entry.scopeType],
 trust: "trusted_data",
 sensitivity: sensitivityMap[entry.sensitivityClass] ?? "internal",
 contentHash: entry.contentHash,
 tokenEstimate: entry.contentRedacted ? Math.ceil(entry.contentRedacted.length / 4) : 0,
 freshness: {
 updatedAt: entry.updatedAt,
 expiresAt: entry.expiresAt,
 needsRefresh: false,
 },
 selectionReason: "memory_scope_mount",
 priorityTier: derivePriorityTier("memory", scopeMap[entry.scopeType]),
 };

 // restricted sensitivity 不返回正文
 if (entry.sensitivityClass !== "restricted" && entry.contentRedacted) {
 fragment.text = entry.contentRedacted;
 }
 if (entry.contentRef) {
 fragment.contentRef = entry.contentRef;
 }

 return fragment;
}

// ─── KnowledgeResolver（S07-C05 真实证据检索接入） ───────────

/**
 * Knowledge 源解析器（按需加载 Knowledge 文档与图谱证据；§13 加载规则）。
 *
 * 阶段 7 S07-C05：接入真实证据检索。
 *
 * 挂载与检索规则（§13）：
 * - Agent 通过 KnowledgeBase 绑定引用 Knowledge；不单独绑定 Knowledge Graph。
 * - 检索返回 Chunk/hash、修订、相关性与时效信息；权限拒绝、索引不可用、确实无结果必须区分。
 * - 检索结果只包含 published 状态 revision 的 chunk（draft/superseded/retracted 不参与）。
 * - 索引未就绪（indexState != ready）→ unavailable（不伪装为 empty）。
 *
 * 检索流程：
 * 1. 校验 allowedSources（如指定）。
 * 2. 调用 searchKnowledgeEvidence，按 ctx.query 在 active KnowledgeBase 的 published ready 修订上检索。
 * 3. 无 KnowledgeBase / 无 published Document / 无 query → empty。
 * 4. 有 Document 但 revision index 未就绪 → unavailable（不伪装为 empty）。
 * 5. 检索成功 → ok + fragments（kind=knowledge）。
 *
 * 不变量：
 * - 跨租户隔离（tenantId 必须匹配）。
 * - 证据 Fragment 的 sourceRef 含 revisionId + hash（用于 CapabilityUse 记录）。
 * - ctx.query 缺失时返回 empty（reasonCode=empty_query）。
 */
export class KnowledgeResolver implements SourceResolver {
 readonly sourceType = "knowledge";
 private readonly limit: number;

 constructor(limit = 20) {
 this.limit = limit;
 }

 async resolve(ctx: ContextQueryContext): Promise<SourceQueryResult> {
 if (ctx.allowedSources && !ctx.allowedSources.includes(this.sourceType)) {
 return {
 sourceType: this.sourceType,
 status: "denied",
 fragments: [],
 reasonCode: "source_not_authorized",
 };
 }

 // 无 query 时返回 empty（Agent 先看到目录，需要时提交查询）
 if (!ctx.query || ctx.query.trim().length === 0) {
 return {
 sourceType: this.sourceType,
 status: "empty",
 fragments: [],
 reasonCode: "empty_query",
 };
 }

 const result = await searchKnowledgeEvidence({
 tenantId: ctx.tenantId,
 query: ctx.query,
 limit: this.limit,
 });

 if (result.status === "unavailable") {
 return {
 sourceType: this.sourceType,
 status: "unavailable",
 fragments: [],
 reasonCode: result.reasonCode ?? "knowledge_search_failed",
 detail: result.detail,
 };
 }

 if (result.status === "empty" || result.hits.length === 0) {
 return {
 sourceType: this.sourceType,
 status: "empty",
 fragments: [],
 reasonCode: result.reasonCode ?? "no_evidence",
 };
 }

 const fragments = result.hits.map((hit) => evidenceHitToFragment(hit, ctx));
 return {
 sourceType: this.sourceType,
 status: "ok",
 fragments,
 reasonCode: "evidence_loaded",
 };
 }
}

/**
 * 把 KnowledgeEvidenceHit 转换为 knowledge kind Fragment。
 *
 * - sourceRef.type="knowledge_chunk"；含 revisionId/documentId/knowledgeBaseId 与 hash。
 * - scope="project"（KnowledgeBase 是工作空间/项目级资源；后续可按 aclSnapshot 细化）。
 * - trust="trusted_data"（Knowledge 是组织或业务事实）。
 * - sensitivity 来自 ctx.classification（默认 internal）。
 * - freshness.updatedAt 来自 revision.publishedAt（数据保持最新）。
 */
function evidenceHitToFragment(
 hit: KnowledgeEvidenceHit,
 ctx: ContextQueryContext,
): ContextFragment {
 const text = hit.chunkText ?? "";
 const contentHash = hit.chunkHash;
 const updatedAt = hit.revisionPublishedAt ?? new Date();

 const fragment: ContextFragment = {
 id: `frag-knowledge-${hit.chunkId}`,
 kind: "knowledge",
 sourceRef: {
 type: "knowledge_chunk",
 id: hit.chunkId,
 hash: contentHash,
 revisionId: hit.revisionId,
 documentId: hit.documentId,
 knowledgeBaseId: hit.knowledgeBaseId,
 },
 scope: "project",
 trust: "trusted_data",
 sensitivity: ctx.classification ?? "internal",
 contentHash,
 tokenEstimate: estimateTokens(text),
 freshness: {
 updatedAt,
 needsRefresh: false,
 },
 selectionReason: `knowledge_evidence:${hit.selectionReason}`,
 priorityTier: derivePriorityTier("knowledge", "project"),
 };

 if (ctx.classification !== "restricted") {
 fragment.text = text;
 }
 if (hit.chunkContentRef) {
 fragment.contentRef = hit.chunkContentRef;
 }

 return fragment;
}

// ─── Token 估算工具 ─────────────────────────────────────────

/**
 * 粗略 Token 估算：约 4 字符 ≈ 1 token（英文为主）。
 * 中文约 2 字符 ≈ 1 token，取折中 3 字符/token。
 */
export function estimateTokens(text: string): number {
 return estimateFragmentTokens(text);
}
