/**
 * 记忆语义索引客户端（capm）。
 *
 * 分层（D2/§2.4）：**记忆的语义检索设施归 capm**，nexharness 不建向量索引。
 * 本模块把本地 MemoryEntry **投影**到 capm 知识资产：
 * - 一个专用知识库（`nexharness-memory`）承载所有租户记忆；
 * - 一个 MemoryEntry → 一个 knowledge document；
 * - 记忆正文 → 一个 chunk（text_content）。
 * 检索时走 capm `POST /knowledge-search/hybrid`（三路召回 + 重排），
 * 返回的 chunk 引用再回填本地结构化字段。
 *
 * 鉴权：写入用 admin token（catalogToken）；检索用平台 token（searchToken）。
 * 失败语义：网络/非 2xx → 抛 CapmMemoryIndexError，调用方映射为 degraded。
 */
import { capmAuthHeaders } from "@/lib/capability-market/auth";
import { capabilityMarketConfig } from "@/lib/config";

/** 记忆知识库名（capm 侧唯一标识）。 */
export const MEMORY_KNOWLEDGE_BASE_NAME = "nexharness-memory";

/** 索引操作失败。 */
export class CapmMemoryIndexError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "CapmMemoryIndexError";
  }
}

/** 记忆知识库缓存（进程级；避免每次请求都查）。 */
let cachedKbId: string | null = null;

function requireEndpoint(): string {
  const endpoint = capabilityMarketConfig.endpoint;
  if (!endpoint) {
    throw new CapmMemoryIndexError("capability-market 未配置（NEX_CAPABILITY_MARKET_ENDPOINT）");
  }
  return endpoint;
}

/** 通用 JSON 请求（admin token）。 */
async function adminJson<T>(
  path: string,
  init: { method: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const endpoint = requireEndpoint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`${endpoint}${path}`, {
      method: init.method,
      headers: {
        ...capmAuthHeaders(capabilityMarketConfig.catalogToken),
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CapmMemoryIndexError(
        `capm ${init.method} ${path} 失败（${res.status}）：${text.slice(0, 200)}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 确保记忆知识库存在，返回其 id。
 *
 * 幂等：先按名查（list），无则创建。结果进程级缓存。
 */
export async function ensureMemoryKnowledgeBase(): Promise<string> {
  if (cachedKbId) return cachedKbId;
  const endpoint = requireEndpoint();

  // 查（按名过滤）
  const list = await adminJson<{ items?: Array<{ id: string; name: string }> }>(
    `/knowledge-bases?q=${encodeURIComponent(MEMORY_KNOWLEDGE_BASE_NAME)}&limit=50`,
    { method: "GET" },
  );
  const existing = list.items?.find((k) => k.name === MEMORY_KNOWLEDGE_BASE_NAME);
  if (existing) {
    cachedKbId = existing.id;
    return existing.id;
  }

  // 建（public 可见性由 capm access-filter 保证仅在平台口径可达；记忆按 scope 在本地过滤）
  const created = await adminJson<{ id: string }>("/knowledge-bases", {
    method: "POST",
    body: {
      name: MEMORY_KNOWLEDGE_BASE_NAME,
      display_name: "NexHarness 记忆",
      description: "nexharness 记忆子系统的语义索引（由 nexharness 自动维护）",
      owner_team: "platform",
      visibility: "internal",
    },
  });
  void endpoint;
  cachedKbId = created.id;
  return created.id;
}

/**
 * 把一条记忆索引进 capm（document + chunk）。
 *
 * 幂等：document 用 content_hash 去重（capm 侧同标题同内容返回既有文档）。
 *
 * @returns capm 侧 `document_id`（供 MemoryEntry.indexedRevisionRef 记录）
 */
export async function indexMemoryEntry(params: {
  entryId: string;
  tenantId: string;
  content: string;
  contentHash: string;
  category: string;
  scopeType: string;
  scopeRef: string | null;
}): Promise<string> {
  const kbId = await ensureMemoryKnowledgeBase();

  // 1. 建文档（title 用 entryId 便于幂等回查）
  const doc = await adminJson<{ document_id?: string; id?: string }>(
    `/knowledge-bases/${kbId}/documents`,
    {
      method: "POST",
      body: {
        title: `memory:${params.entryId}`,
        document_type: "memory",
        content_hash: params.contentHash,
        source_uri: `nexharness://memory/${params.entryId}`,
      },
    },
  );
  const documentId = doc.document_id ?? doc.id;
  if (!documentId) throw new CapmMemoryIndexError("capm 创建记忆文档未返回 document_id");

  // 2. 建 chunk（正文 + 元数据，供检索过滤/回填）
  await adminJson(`/knowledge-bases/${kbId}/documents/${documentId}/chunks`, {
    method: "POST",
    body: {
      chunk_index: 0,
      content_hash: params.contentHash,
      text_content: params.content,
      metadata: {
        memory_entry_id: params.entryId,
        tenant_id: params.tenantId,
        memory_category: params.category,
        scope_type: params.scopeType,
        scope_ref: params.scopeRef,
      },
    },
  });

  return documentId;
}

/** 语义检索命中（含 capm 引用与得分）。 */
export interface MemorySemanticHit {
  memoryEntryId: string;
  documentId: string;
  chunkId?: string;
  score: number;
  snippet?: string;
}

/**
 * 语义召回：调 capm hybrid 检索，返回命中的 MemoryEntry id + 得分。
 *
 * @param query 检索查询
 * @param limit top-k
 */
export async function searchMemorySemantic(params: {
  query: string;
  limit?: number;
  /** 只在这些 entryId 中检索（capm document_ids 过滤）。 */
  restrictToEntryIds?: ReadonlyArray<string>;
}): Promise<MemorySemanticHit[]> {
  const endpoint = requireEndpoint();
  const kbId = await ensureMemoryKnowledgeBase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${endpoint}/knowledge-search/hybrid`, {
      method: "POST",
      headers: {
        ...capmAuthHeaders(capabilityMarketConfig.searchToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: params.query,
        knowledge_base_ids: [kbId],
        document_ids: params.restrictToEntryIds
          ? params.restrictToEntryIds.map((id) => `memory:${id}`)
          : undefined,
        top_k: params.limit ?? 10,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CapmMemoryIndexError(
        `capm knowledge-search/hybrid 失败（${res.status}）：${text.slice(0, 200)}`,
        res.status,
      );
    }
    const body = (await res.json()) as {
      items?: Array<{
        score?: number;
        snippet?: string;
        citation?: { document_id?: string; chunk_id?: string; document_title?: string };
        metadata?: Record<string, unknown>;
      }>;
    };
    // entryId 解析：优先 chunk metadata（若 capm 返回），否则从 document_title 前缀
    // `memory:<entryId>` 解析（本模块写入时固定该约定）。
    const entryIdFromTitle = (title: string | undefined): string =>
      title && title.startsWith("memory:") ? title.slice("memory:".length) : "";
    return (body.items ?? [])
      .map((it) => {
        const fromMeta =
          typeof it.metadata?.memory_entry_id === "string"
            ? (it.metadata.memory_entry_id as string)
            : "";
        const entryId = fromMeta || entryIdFromTitle(it.citation?.document_title);
        return {
          memoryEntryId: entryId,
          documentId: it.citation?.document_id ?? "",
          chunkId: it.citation?.chunk_id,
          score: it.score ?? 0,
          snippet: it.snippet,
        };
      })
      .filter((h) => h.memoryEntryId);
  } finally {
    clearTimeout(timer);
  }
}
