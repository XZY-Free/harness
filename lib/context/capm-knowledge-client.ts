/**
 * capability-market 知识检索 HTTP 客户端。
 *
 * 运行时（resolver / harness-loop knowledge.search）通过本模块访问 capm 的
 * 知识检索与目录端点；本模块只做 HTTP 与字段映射，不做权限判断
 * （租户过滤由 capm 的 access-filter 按调用方身份完成）。
 *
 * 端点与鉴权（实测 2026-10-16）：
 * - `POST {endpoint}/knowledge-search/hybrid` —— 三路召回 + 重排；
 *   走 PlatformTokenAuthGuard，用 `searchToken`（平台 client token）。
 * - `GET  {endpoint}/knowledge-bases` —— 知识库目录；
 *   走 AdminTokenGuard，用 `catalogToken`（admin token）。
 *   两套鉴权待 auth-center 联调统一（用户 2026-10-16 定）。
 *
 * 失败语义：网络/非 2xx/超时 → 抛 CapmKnowledgeError，由调用方映射为
 * unavailable（索引未就绪等真不可用）或 degraded（服务不可达，只读可降级）。
 */

import { capabilityMarketConfig } from "@/lib/config";

/** capm 检索端点未配置。 */
export class CapmKnowledgeNotConfiguredError extends Error {
  constructor() {
    super("capability-market 知识检索未配置（NEX_CAPABILITY_MARKET_ENDPOINT / *_SEARCH_TOKEN）");
    this.name = "CapmKnowledgeNotConfiguredError";
  }
}

/** capm 检索请求失败（网络/超时/非 2xx/响应非法）。 */
export class CapmKnowledgeRequestError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码；网络层失败为 undefined。 */
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "CapmKnowledgeRequestError";
  }
}

/** capm `citation` 溯源对象（字段为 snake_case）。 */
export interface CapmCitation {
  chunk_id?: string;
  document_id?: string;
  document_title?: string;
  chunk_index?: number;
  entity_id?: string;
  relation_id?: string;
  evidence_id?: string;
  source_entity_id?: string;
  target_entity_id?: string;
  /** 文档级内容 hash（chunk 类结果有值）。 */
  content_hash?: string;
  /** 文档版本（capm 无 revision 概念，作版本的兜底来源）。 */
  document_version?: string;
  source_uri?: string;
  updated_at?: string;
}

/** capm 混合召回结果项。 */
export interface CapmHybridItem {
  result_type: "chunk" | "entity" | "relation" | "evidence";
  chunk_id?: string;
  document_id?: string;
  entity_id?: string;
  relation_id?: string;
  evidence_id?: string;
  knowledge_base_id: string;
  name?: string;
  entity_type?: string;
  relation_type?: string;
  snippet: string;
  score: number;
  via?: "match" | "hop" | "community";
  sources: string[];
  source_scores: Record<string, number>;
  citation: CapmCitation;
}

/** capm 混合检索响应。 */
export interface CapmHybridResponse {
  query: string;
  items: CapmHybridItem[];
  total: number;
  reranked: boolean;
}

/** 检索请求参数。 */
export interface CapmSearchParams {
  query: string;
  knowledgeBaseIds: readonly string[];
  topK?: number;
  rerank?: boolean;
}

function requireEndpoint(): string {
  const endpoint = capabilityMarketConfig.endpoint;
  if (!endpoint) throw new CapmKnowledgeNotConfiguredError();
  return endpoint.replace(/\/+$/, "");
}

/**
 * 三路混合检索。返回原始 items（调用方负责映射为 KnowledgeEvidenceHit）。
 *
 * 鉴权：`NEX_CAPABILITY_MARKET_SEARCH_TOKEN`（平台 client token）。
 * 未配置 endpoint 或 token 时抛 CapmKnowledgeNotConfiguredError。
 */
export async function capmHybridSearch(params: CapmSearchParams): Promise<CapmHybridResponse> {
  const endpoint = requireEndpoint();
  const token = capabilityMarketConfig.searchToken;
  if (!token) throw new CapmKnowledgeNotConfiguredError();

  const url = `${endpoint}/knowledge-search/hybrid`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: params.query,
        knowledge_base_ids: [...params.knowledgeBaseIds],
        ...(params.topK !== undefined ? { top_k: params.topK } : {}),
        ...(params.rerank !== undefined ? { rerank: params.rerank } : {}),
      }),
      signal: AbortSignal.timeout(capabilityMarketConfig.searchTimeoutMs),
    });
  } catch (err) {
    // 网络层失败（连不上 capm）——服务不可达
    throw new CapmKnowledgeRequestError(
      `capm 检索请求失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!resp.ok) {
    throw new CapmKnowledgeRequestError(
      `capm 检索返回 ${resp.status}：${resp.statusText}`,
      resp.status,
    );
  }

  const body = (await resp.json().catch(() => null)) as CapmHybridResponse | null;
  if (!body || !Array.isArray(body.items)) {
    throw new CapmKnowledgeRequestError("capm 检索响应非法（缺 items）");
  }
  return body;
}

/** capm 知识库目录项（GET /knowledge-bases 返回元素）。 */
export interface CapmKnowledgeBaseItem {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  owner_team: string | null;
  category: string | null;
  lifecycle_state: string;
  visibility: string;
  quality_state: string;
  permission_policy: string | null;
  document_count: number;
  entity_count: number;
  relation_count: number;
  created_at: string;
  updated_at: string;
}

/** capm 知识库目录响应。 */
export interface CapmKnowledgeBaseList {
  items: CapmKnowledgeBaseItem[];
  total: number;
}

/** 目录查询参数。 */
export interface CapmCatalogParams {
  /** 只取 active 生命周期的知识库（默认 true）。 */
  activeOnly?: boolean;
  limit?: number;
}

/**
 * 查询 capm 知识库目录（GET /knowledge-bases）。
 *
 * 鉴权：`NEX_CAPABILITY_MARKET_CATALOG_TOKEN`（admin token）——
 * capm 目录端点走 AdminTokenGuard，与检索的平台 token 是两套鉴权
 * （待 auth-center 联调统一）。
 *
 * 注意：capm 目录端点按 admin 特权返回**全量**（不做租户过滤）；租户/可见性
 * 过滤在检索时由 access-filter 按平台 token 身份完成。
 */
export async function capmListKnowledgeBases(
  params: CapmCatalogParams = {},
): Promise<CapmKnowledgeBaseList> {
  const endpoint = requireEndpoint();
  const token = capabilityMarketConfig.catalogToken;
  if (!token) throw new CapmKnowledgeNotConfiguredError();

  const query = new URLSearchParams();
  if (params.activeOnly !== false) query.set("lifecycle_state", "active");
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const url = `${endpoint}/knowledge-bases${query.size > 0 ? `?${query}` : ""}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(capabilityMarketConfig.searchTimeoutMs),
    });
  } catch (err) {
    throw new CapmKnowledgeRequestError(
      `capm 目录请求失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!resp.ok) {
    throw new CapmKnowledgeRequestError(
      `capm 目录返回 ${resp.status}：${resp.statusText}`,
      resp.status,
    );
  }

  const body = (await resp.json().catch(() => null)) as CapmKnowledgeBaseList | null;
  if (!body || !Array.isArray(body.items)) {
    throw new CapmKnowledgeRequestError("capm 目录响应非法（缺 items）");
  }
  return body;
}
