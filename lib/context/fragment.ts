/**
 * Context Fragment 领域类型（阶段 7 S07-C01）。
 *
 * 事实源：docs/architecture/context-memory-and-knowledge.md §4（Fragment）、§5（优先级与预算）。
 *
 * Fragment 是模型本次视图中的有限内容单元，带来源和策略：
 * - kind：内容类型（system/agent_instruction/user/memory/knowledge/file/tool/skill）。
 * - sourceRef：原始事件、文档、文件、Memory 或 ToolResult 引用。
 * - scope：作用域（thread/project/user/agent/organization）。
 * - trust：信任级别（instruction/trusted_data/untrusted_external）。
 * - sensitivity：数据分类与外发限制。
 * - contentHash：实际内容摘要（sha256: 前缀）。
 * - tokenEstimate：上下文预算估算。
 * - freshness：更新时间、有效期和是否需要刷新。
 * - reason：为什么选入或排除。
 *
 * 关键约束（§4 末段）：
 * - 外部网页、文件、Knowledge 和 ToolResult 默认是数据（trust=untrusted_external 或 trusted_data），
 * 不因正文包含“忽略上面的指令”而获得指令优先级（trust=instruction）。
 * - 只有平台规则与 Agent 指令可为 instruction 信任级别。
 * - Credential 原值永远不进入 Fragment。
 */
import { createHash } from "node:crypto";

// ─── Fragment Kind ─────────────────────────────────────────

/**
 * Fragment 内容类型。
 * - system：平台强制规则。
 * - agent_instruction：当前 Agent 指令。
 * - user：用户消息或引导。
 * - memory：长期记忆条目。
 * - knowledge：知识文档片段。
 * - file：Workspace 文件片段。
 * - tool：Tool 结果摘要。
 * - skill：Skill 指令片段。
 */
export const FRAGMENT_KINDS = [
  "system",
  "agent_instruction",
  "user",
  "memory",
  "knowledge",
  "file",
  "tool",
  "skill",
] as const;
export type FragmentKind = (typeof FRAGMENT_KINDS)[number];

const FRAGMENT_KIND_SET: ReadonlySet<string> = new Set(FRAGMENT_KINDS);

/** 判断 kind 是否在目录内。 */
export function isKnownFragmentKind(kind: string): kind is FragmentKind {
  return FRAGMENT_KIND_SET.has(kind);
}

// ─── Fragment Scope ────────────────────────────────────────

/**
 * Fragment 作用域（与 Memory 作用域对齐，§8）。
 * - thread：当前会话。
 * - project：当前 Workspace / Project。
 * - user：用户偏好（可跨 Agent）。
 * - agent：Agent 专属。
 * - organization：组织共享。
 */
export const FRAGMENT_SCOPES = ["thread", "project", "user", "agent", "organization"] as const;
export type FragmentScope = (typeof FRAGMENT_SCOPES)[number];

// ─── Fragment Trust ────────────────────────────────────────

/**
 * Fragment 信任级别（§4 trust 字段）。
 * - instruction：指令（平台规则、Agent 指令）——可影响模型行为。
 * - trusted_data：可信数据（用户确认消息、已验证 Artifact）。
 * - untrusted_external：不可信外部数据（网页、文件、Knowledge、ToolResult）。
 *
 * 关键不变量：untrusted_external 内容不得因正文包含指令性文本而提升为 instruction。
 */
export const FRAGMENT_TRUST_LEVELS = ["instruction", "trusted_data", "untrusted_external"] as const;
export type FragmentTrust = (typeof FRAGMENT_TRUST_LEVELS)[number];

// ─── Fragment Sensitivity ──────────────────────────────────

/**
 * Fragment 数据分类（sensitivity）。
 * - public：公开。
 * - internal：内部。
 * - confidential：机密。
 * - restricted：受限（不进入模型正文，仅保留引用）。
 */
export const FRAGMENT_SENSITIVITIES = ["public", "internal", "confidential", "restricted"] as const;
export type FragmentSensitivity = (typeof FRAGMENT_SENSITIVITIES)[number];

// ─── Source Ref ────────────────────────────────────────────

/**
 * Fragment 来源引用。
 * - type：来源类型（thread_item/thread_event/memory_entry/knowledge_chunk/file/artifact/tool_call/skill_version/platform_rule）。
 * - id：来源稳定 id。
 * - revisionId：来源修订 id（可空）。
 * - hash：来源内容 hash（sha256: 前缀，可空）。
 * - documentId：Knowledge 文档稳定 id（knowledge_chunk 专用，可空）。
 * - knowledgeBaseId：所属 KnowledgeBase id（knowledge_chunk 专用，可空）。
 */
export interface FragmentSourceRef {
  type: string;
  id: string;
  revisionId?: string | null;
  hash?: string | null;
  documentId?: string | null;
  knowledgeBaseId?: string | null;
}

// ─── Freshness ─────────────────────────────────────────────

/**
 * Fragment 时效信息。
 * - updatedAt：内容最后更新时间。
 * - expiresAt：有效期截止（可空表示无过期）。
 * - needsRefresh：是否需要重新加载。
 */
export interface FragmentFreshness {
  updatedAt: Date;
  expiresAt?: Date | null;
  needsRefresh?: boolean;
}

// ─── Priority Tier ─────────────────────────────────────────

/**
 * Fragment 优先级层级（§5 优先级顺序）。
 * 数值越小优先级越高；同层按插入顺序保留。
 *
 * - TIER_MANDATORY(1)：平台强制规则 + Agent 指令 + 当前用户要求 + 已确认约束。
 * - TIER_RECENT(2)：最近原始对话与直接相关结果。
 * - TIER_RELATED(3)：任务相关 Workspace、Knowledge、Memory、Skill。
 * - TIER_SUMMARY(4)：Tool 结果摘要与 Child Thread 结果。
 * - TIER_HISTORY(5)：更早历史的压缩摘要。
 */
export const FRAGMENT_PRIORITY_TIERS = {
  TIER_MANDATORY: 1,
  TIER_RECENT: 2,
  TIER_RELATED: 3,
  TIER_SUMMARY: 4,
  TIER_HISTORY: 5,
} as const;

export type FragmentPriorityTier =
  (typeof FRAGMENT_PRIORITY_TIERS)[keyof typeof FRAGMENT_PRIORITY_TIERS];

// ─── Fragment ──────────────────────────────────────────────

/**
 * Context Fragment：模型本次视图的内容单元。
 *
 * 不变量：
 * - restricted sensitivity 的 Fragment 只保留 sourceRef + hash，不携带正文 text。
 * - Credential 原值永远不进入 Fragment（调用方负责过滤）。
 * - trust=instruction 仅用于 system/agent_instruction kind。
 */
export interface ContextFragment {
  /** Fragment 稳定 id（同一视图内唯一，用于排除追踪）。 */
  id: string;
  kind: FragmentKind;
  sourceRef: FragmentSourceRef;
  scope: FragmentScope;
  trust: FragmentTrust;
  sensitivity: FragmentSensitivity;
  /** 内容 hash（sha256: 前缀）。 */
  contentHash: string;
  /** 上下文 Token 估算（>=0）。 */
  tokenEstimate: number;
  freshness: FragmentFreshness;
  /** 选入理由代码（如 platform_rule/current_user/recent_item/query_match）。 */
  selectionReason: string;
  /** 优先级层级（由 budget 模块根据 kind/scope 推导或调用方显式指定）。 */
  priorityTier: FragmentPriorityTier;
  /** 正文文本（restricted sensitivity 时为空，仅保留引用）。 */
  text?: string;
  /** 结构化内容引用（如 content_ref，与 text 二选一或并存）。 */
  contentRef?: string;
}

// ─── Excluded Fragment ─────────────────────────────────────

/**
 * 被预算排除的 Fragment 记录（§5：记录被排除内容及原因）。
 */
export interface ExcludedFragment {
  id: string;
  kind: FragmentKind;
  contentHash: string;
  tokenEstimate: number;
  priorityTier: FragmentPriorityTier;
  /** 排除理由代码。 */
  reasonCode: ExclusionReasonCode;
  /** 排除说明（可空）。 */
  detail?: string;
}

/**
 * 排除理由代码（§5 预算不足处理）。
 * - budget_exhausted：预算耗尽，按优先级由低到高排除。
 * - duplicate：与已选入 Fragment 内容重复。
 * - requeryable：可重新查询内容，按需加载即可。
 * - low_priority：低优先级，为高优先级腾出空间。
 * - mandatory_overflow：关键内容仍无法容纳（触发显式失败）。
 */
export const EXCLUSION_REASON_CODES = [
  "budget_exhausted",
  "duplicate",
  "requeryable",
  "low_priority",
  "mandatory_overflow",
  "tool_pair_incomplete",
] as const;
export type ExclusionReasonCode = (typeof EXCLUSION_REASON_CODES)[number];

// ─── 优先级推导 ─────────────────────────────────────────────

/**
 * 根据 Fragment kind 与 scope 推导默认优先级层级（§5）。
 *
 * 规则：
 * - system / agent_instruction → TIER_MANDATORY
 * - user（当前用户要求） → TIER_MANDATORY
 * - tool（最近 ToolResult） → TIER_RECENT（直接相关结果）
 * - file / knowledge / memory / skill → TIER_RELATED（任务相关资源）
 * - tool（摘要） → TIER_SUMMARY（调用方可通过 priorityTier 显式覆盖）
 * - 历史压缩摘要 → TIER_HISTORY
 *
 * 注意：kind=tool 默认 TIER_RECENT，但若调用方标记为摘要则应传 TIER_SUMMARY。
 * 本函数对 tool 返回 TIER_RECENT，调用方可通过显式 priorityTier 覆盖。
 */
export function derivePriorityTier(
  kind: FragmentKind,
  scope?: FragmentScope,
): FragmentPriorityTier {
  switch (kind) {
    case "system":
    case "agent_instruction":
      return FRAGMENT_PRIORITY_TIERS.TIER_MANDATORY;
    case "user":
      return FRAGMENT_PRIORITY_TIERS.TIER_RECENT;
    case "tool":
      return FRAGMENT_PRIORITY_TIERS.TIER_RECENT;
    case "file":
    case "knowledge":
    case "memory":
    case "skill":
      return FRAGMENT_PRIORITY_TIERS.TIER_RELATED;
    default:
      // 历史压缩摘要等未列出的 kind → 最低优先级
      return FRAGMENT_PRIORITY_TIERS.TIER_HISTORY;
  }
}

// ─── 内容 hash 工具 ─────────────────────────────────────────

/**
 * 计算 Fragment 正文内容 hash（sha256: 前缀）。
 *
 * 用于 source hash 校验：候选 Fragment 的 contentHash 必须与来源实际 hash 一致。
 * 规范化：递归排序对象 key 后取 sha256。
 */
export function computeFragmentContentHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Context 统一 Token 估算，所有 Provider 与运行时守卫使用同一实现。 */
export function estimateFragmentTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3));
}

/** 校验 contentHash 是否符合 sha256: 前缀格式。 */
export function isValidFragmentContentHash(hash: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(hash);
}

/**
 * 校验 Fragment 正文与 contentHash 是否一致。
 * @returns true 一致；false 不一致（调用方应触发 CONTEXT_SOURCE_HASH_MISMATCH 或对应错误）。
 */
export function verifyFragmentContentHash(text: string, expectedHash: string): boolean {
  return computeFragmentContentHash(text) === expectedHash;
}

/**
 * 在 Fragment 进入预算与序列化边界前执行 fail-closed 校验。
 * 类型只能约束编译期；数据库内容、Provider 返回和 JSON 均须经过此运行时守卫。
 */
export function assertContextFragment(fragment: ContextFragment): void {
  if (!isKnownFragmentKind(fragment.kind)) {
    throw new Error(`Fragment kind 非法: ${String(fragment.kind)}`);
  }
  if (
    fragment.trust === "instruction" &&
    fragment.kind !== "system" &&
    fragment.kind !== "agent_instruction"
  ) {
    throw new Error(`Fragment instruction trust 不允许用于 kind=${fragment.kind}`);
  }
  if (
    fragment.sensitivity === "restricted" &&
    (fragment.text !== undefined || fragment.contentRef === undefined)
  ) {
    throw new Error("restricted Fragment 只能携带受控引用，禁止携带正文");
  }
  if (!fragment.sourceRef?.type || !fragment.sourceRef.id) {
    throw new Error("Fragment sourceRef 不完整");
  }
  if (!isValidFragmentContentHash(fragment.contentHash)) {
    throw new Error("Fragment contentHash 格式非法");
  }
  if (
    fragment.text !== undefined &&
    !verifyFragmentContentHash(fragment.text, fragment.contentHash)
  ) {
    throw new Error("Fragment contentHash 与正文不一致");
  }
  if (!Number.isInteger(fragment.tokenEstimate) || fragment.tokenEstimate < 0) {
    throw new Error("Fragment tokenEstimate 必须是非负整数");
  }
  if (
    fragment.text !== undefined &&
    fragment.tokenEstimate !== estimateFragmentTokens(fragment.text)
  ) {
    throw new Error("Fragment tokenEstimate 与正文不一致");
  }
  if (!(fragment.freshness.updatedAt instanceof Date) || !fragment.selectionReason) {
    throw new Error("Fragment freshness/reason 不完整");
  }
}
