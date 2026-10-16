/**
 * Knowledge 证据检索服务（capm 为知识权威）。
 *
 * 事实源：capability-market（capm）——`POST /knowledge-search/hybrid`（三路召回+重排）
 * 与 `GET /knowledge-bases`（目录）；本仓不再持有知识存储（知识库/文档/修订/分块/索引
 * 五表已退役）。
 *
 * 职责：
 * - searchKnowledgeEvidence：分作用域证据检索（tenant + 可选 knowledgeBaseIds 过滤）。
 * - listDiscoverableKnowledgeBases：可发现知识库目录，供 Capability Catalog 冻结 scope。
 *
 * 边界：
 * - 数据源为 capm；租户/可见性过滤由 capm access-filter 按调用方平台 token 身份完成。
 * - 权限拒绝、服务不可达、索引未就绪、确实无结果必须区分（分别为
 *   denied / degraded / unavailable / empty）。
 */
import {
  type CapmHybridItem,
  type CapmKnowledgeBaseItem,
  CapmKnowledgeNotConfiguredError,
  CapmKnowledgeRequestError,
  capmHybridSearch,
  capmListKnowledgeBases,
} from "@/lib/context/capm-knowledge-client";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";

/**
 * 列出可发现的知识库（供 Capability Catalog 冻结 scope）。
 *
 * 数据源：capm `GET /knowledge-bases`（capm 为 KB 权威）。
 * **直接返回 capm 目录项（CapmKnowledgeBaseItem），不做字段适配**——
 * 消费方直接读 capm 字段（id / display_name / description / updated_at）。
 * 租户/可见性过滤在检索时由 capm access-filter 按平台 token 身份完成。
 *
 * 失败语义：capm 不可达/未配置 → 抛错（由 catalog 组装侧决定降级与否）。
 */
export async function listDiscoverableKnowledgeBases(params: {
  tenantId: string;
  executionSubject: ExecutionSubject;
  limit?: number;
}): Promise<CapmKnowledgeBaseItem[]> {
  if (
    !params.executionSubject ||
    params.executionSubject.tenantId !== params.tenantId ||
    !params.executionSubject.subjectId ||
    (params.executionSubject.subjectType !== "user" &&
      params.executionSubject.subjectType !== "service")
  ) {
    return [];
  }
  const list = await capmListKnowledgeBases({
    activeOnly: true,
    limit: params.limit ?? 500,
  });
  return list.items;
}

// ─── 证据检索 ─────────────────────────────────────────────

/**
 * 单条证据检索结果（字段映射自 capm HybridSearchResult）。
 *
 * 数据源：capability-market `POST /knowledge-search/hybrid`。
 * 只保留 nexharness 运行时实际消费的字段；capm 无对应的字段已移除（详见 07 §8.2③）。
 */
export interface KnowledgeEvidenceHit {
  /** Chunk id（证据片段稳定身份）← capm `chunk_id`。 */
  chunkId: string;
  /** Chunk contentHash（用于 CapabilityUse 记录实际引用）← capm `citation.content_hash`。 */
  chunkHash: string;
  /** Chunk 正文（如非 restricted）← capm `snippet`。 */
  chunkText: string | null;
  /** Chunk contentRef（受限内容访问；capm 无对应时为 null）。 */
  chunkContentRef: string | null;
  /**
   * 所属 Revision id（审计溯源旁注）。
   * capm 无 revision 概念 → 暂用 `citation.document_version` 兜底，无则为 null。
   * 待与 capm 讨论版本概念后再定是否强约束（用户 2026-10-16）。
   */
  revisionId: string | null;
  /** 内容更新时间（时效信息）← capm `citation.updated_at`。 */
  revisionPublishedAt: Date | null;
  /** 所属 Document id ← capm `document_id`。 */
  documentId: string;
  /** Document 标题 ← capm `citation.document_title`。 */
  documentTitle: string;
  /** 所属 KnowledgeBase id ← capm `knowledge_base_id`。 */
  knowledgeBaseId: string;
  /** 检索分数 ← capm `score`。 */
  score: number;
  /** 选择原因（capm `sources` 合并，如 "fulltext+vector" / "graph"）。 */
  selectionReason: string;
}

/**
 * 证据检索结果状态。
 *
 * - ok：检索成功，返回零或多个 hit。
 * - empty：确实无结果（数据存在但无匹配）。
 * - denied：权限拒绝（capm access-filter 判定调用方无权访问该知识库范围）。
 * - unavailable：**索引未就绪**等真不可用（不伪装为 empty）。
 * - degraded：**capm 服务不可达**（连不上/超时）——只读可降级继续，
 *   observation 标注 knowledge_unavailable，模型明确知道「没查到是因为服务不可达」。
 *   （E1-b：与 unavailable 分开，语义不同——unavailable=真不可用，degraded=服务不可达）
 */
export const KNOWLEDGE_SEARCH_STATUSES = [
  "ok",
  "empty",
  "denied",
  "unavailable",
  "degraded",
] as const;
export type KnowledgeSearchStatus = (typeof KNOWLEDGE_SEARCH_STATUSES)[number];

/** 证据检索结果。 */
export interface KnowledgeSearchResult {
  status: KnowledgeSearchStatus;
  hits: KnowledgeEvidenceHit[];
  reasonCode?: string;
  detail?: string;
}

/**
 * 分作用域证据检索（先目录后证据 / 检索失败区分）。
 *
 * 流程：调 capm `POST /knowledge-search/hybrid`（三路召回 + 重排），
 * 权限过滤由 capm access-filter 按平台 token 身份完成。
 *
 * 不变量：
 * - executionSubject 自身非法 → denied（scope 非法/空 → denied/empty）。
 * - 服务不可达 → degraded（不伪装为 empty）。
 * - 索引未就绪/显式 4xx5xx → unavailable（不伪装为 empty）。
 * - 无匹配 → empty（确实无结果，非服务故障）。
 *
 * @returns KnowledgeSearchResult
 */
export async function searchKnowledgeEvidence(params: {
  tenantId: string;
  executionSubject: ExecutionSubject;
  allowedKnowledgeBaseIds: readonly string[];
  query: string;
  limit?: number;
}): Promise<KnowledgeSearchResult> {
  if (
    !params.executionSubject ||
    params.executionSubject.tenantId !== params.tenantId ||
    !params.executionSubject.subjectId ||
    (params.executionSubject.subjectType !== "user" &&
      params.executionSubject.subjectType !== "service")
  ) {
    return { status: "denied", hits: [], reasonCode: "knowledge_subject_invalid" };
  }
  if (
    !Array.isArray(params.allowedKnowledgeBaseIds) ||
    params.allowedKnowledgeBaseIds.some((id) => typeof id !== "string" || id.trim().length === 0)
  ) {
    return { status: "denied", hits: [], reasonCode: "knowledge_scope_invalid" };
  }
  if (params.allowedKnowledgeBaseIds.length === 0) {
    return { status: "empty", hits: [], reasonCode: "no_authorized_knowledge_scope" };
  }
  const trimmedQuery = params.query?.trim();
  if (!trimmedQuery) {
    return {
      status: "empty",
      hits: [],
      reasonCode: "empty_query",
    };
  }

  try {
    const limit = Math.max(1, Math.min(params.limit ?? 20, 100));

    // 调 capm 三路混合检索（fulltext + vector + graph → 重排）。
    // 权限过滤由 capm access-filter 按平台 token 身份完成；nexharness 侧只传范围。
    const response = await capmHybridSearch({
      query: trimmedQuery,
      knowledgeBaseIds: params.allowedKnowledgeBaseIds,
      topK: limit,
    });

    const hits = response.items.map((item) => capmItemToEvidenceHit(item));

    if (hits.length === 0) {
      return { status: "empty", hits: [], reasonCode: "no_query_match" };
    }

    // capm 已按 score 排序（重排后）；此处不再重排，仅截断。
    const top = hits.slice(0, limit);
    return { status: "ok", hits: top, reasonCode: "evidence_loaded" };
  } catch (err) {
    // 未配置（缺少 endpoint/token）→ 服务不可达（degraded，只读可降级）
    if (err instanceof CapmKnowledgeNotConfiguredError) {
      return {
        status: "degraded",
        hits: [],
        reasonCode: "knowledge_not_configured",
        detail: err.message,
      };
    }
    // 请求失败：区分「服务不可达」与「索引未就绪」——
    // 显式 4xx/5xx 视为真不可用（unavailable）；网络层失败视为服务不可达（degraded）。
    if (err instanceof CapmKnowledgeRequestError) {
      if (err.httpStatus !== undefined) {
        return {
          status: "unavailable",
          hits: [],
          reasonCode: "knowledge_search_failed",
          detail: `${err.message}（HTTP ${err.httpStatus}）`,
        };
      }
      return {
        status: "degraded",
        hits: [],
        reasonCode: "knowledge_unavailable",
        detail: err.message,
      };
    }
    return {
      status: "unavailable",
      hits: [],
      reasonCode: "knowledge_search_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 把 capm HybridSearchResult 映射为 KnowledgeEvidenceHit。
 *
 * 字段映射（07 §8.2③）：chunkId←chunk_id、chunkHash←citation.content_hash、
 * documentId←document_id、documentTitle←citation.document_title、
 * knowledgeBaseId←knowledge_base_id、score←score、
 * revisionId←citation.document_version（capm 无 revision，暂兜底）、
 * revisionPublishedAt←citation.updated_at、selectionReason←sources 合并。
 *
 * 非 chunk 类结果（entity/relation/evidence）暂不产出证据 hit（无 chunkId）；跳过。
 */
function capmItemToEvidenceHit(item: CapmHybridItem): KnowledgeEvidenceHit {
  const updatedAt = item.citation.updated_at ? new Date(item.citation.updated_at) : null;
  return {
    chunkId: item.chunk_id ?? item.evidence_id ?? item.entity_id ?? item.relation_id ?? "",
    chunkHash: item.citation.content_hash ?? "",
    chunkText: item.snippet ?? null,
    chunkContentRef: null,
    revisionId: item.citation.document_version ?? null,
    revisionPublishedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
    documentId: item.document_id ?? item.citation.document_id ?? "",
    documentTitle: item.citation.document_title ?? item.name ?? "",
    knowledgeBaseId: item.knowledge_base_id,
    score: item.score,
    selectionReason: item.sources.join("+") || item.result_type,
  };
}
