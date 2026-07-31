import {
  appendThreadEvent,
  getMemoryRow,
  listEmbeddingRowsByMemory,
  listMemoryRows,
  upsertEmbeddingRow,
} from "@/lib/db/queries";
import type {
  MemoryEmbedding,
  MemoryEntry,
  MemoryProvenanceEntry,
  MemoryScope,
} from "@/lib/db/schema";
import { type EmbeddingProvider, embedMemoryTextWith, resolveEmbeddingProvider } from "./embedding";
import { hashMemoryText } from "./text";

/**
 * V3.3b Stage B：MemoryEmbedding 索引编排。
 *
 * 用户硬约束：embedding 必须在 memory 写入时生成（createMemory 后触发 indexMemory），
 * 对 normalized text 生成 embedding 并 upsert 到 MemoryEmbedding 表；text 变化时标记 stale 并重建。
 * 不能只建表不填数据。
 *
 * provider disabled/error 时 memory 仍可创建，但 semanticStatus 诚实记录 disabled/error，
 * **不静默伪装成功**（V3.3b §1）。indexMemory 失败不抛——memory 写入优先于索引。
 *
 * status 语义：MemoryEmbedding.status 用 `active/stale/error`（schema）；
 * 对外 semanticStatus 用 `ready/stale/error/disabled`（表内 active = ready）。
 */

export type IndexStatus = "ready" | "stale" | "error" | "disabled" | "skipped";

export type IndexMemoryResult = {
  status: IndexStatus;
  provider: string;
  model: string;
  dimension?: number;
  errorCode?: string;
};

/** 从 memory 取 threadId（发射事件用）：provenance 首条 threadId，否则 thread scope 的 scopeRef。 */
function threadIdOf(memory: MemoryEntry): string | null {
  const prov = (memory.provenance as MemoryProvenanceEntry[]) ?? [];
  return (
    prov.find((p) => p.threadId)?.threadId ?? (memory.scope === "thread" ? memory.scopeRef : null)
  );
}

/**
 * 为一条 memory 生成/更新 embedding。
 * - revoked/不存在 → skipped，不索引。
 * - provider disabled → disabled，不写 embedding 行、不发事件（memory 仍可创建）。
 * - provider error / 维度不匹配 → 写 status=error 行 + 发 memory.reindexed(errorCode)。
 * - 成功 → upsert status=active + 发 memory.reindexed(status=ready, dimension)。
 *
 * 失败不抛（返回 status=error），调用方据此填 semanticStatus。
 */
export async function indexMemory(
  memoryId: string,
  opts: { provider?: EmbeddingProvider } = {},
): Promise<IndexMemoryResult> {
  const provider = opts.provider ?? resolveEmbeddingProvider();

  const memory = await getMemoryRow(memoryId);
  if (!memory || memory.status === "revoked") {
    return { status: "skipped", provider: provider.name, model: provider.model };
  }

  // provider disabled → 不写 embedding 行（memory 仍存在，retrieve 走 lexical fallback + disabled 可观测）。
  if (!provider.isReady()) {
    return { status: "disabled", provider: provider.name, model: provider.model };
  }

  const normalized = memory.text; // store 已在写入时 normalize；此处直接用
  const contentHash = hashMemoryText(normalized);
  const er = await embedMemoryTextWith(provider, normalized);

  const threadId = threadIdOf(memory);

  if (er.status !== "ready" || er.vector.length === 0) {
    // provider 调用失败 → 写 error 行（保留诊断，不含 secret）+ 发事件。不抛。
    await upsertEmbeddingRow({
      memoryId,
      provider: provider.name,
      model: provider.model,
      vector: [],
      dim: 0,
      status: "error",
      errorMessage: er.error ?? "unknown embedding error",
    });
    if (threadId) {
      await appendThreadEvent(threadId, "memory.reindexed", {
        memoryId,
        provider: provider.name,
        model: provider.model,
        status: "error",
        errorCode: er.error ?? "unknown",
      });
    }
    return {
      status: "error",
      provider: provider.name,
      model: provider.model,
      errorCode: er.error,
    };
  }

  await upsertEmbeddingRow({
    memoryId,
    provider: provider.name,
    model: provider.model,
    vector: er.vector,
    dim: er.dim,
    status: "active",
    errorMessage: null,
  });
  if (threadId) {
    await appendThreadEvent(threadId, "memory.reindexed", {
      memoryId,
      provider: provider.name,
      model: provider.model,
      status: "ready",
      dimension: er.dim,
    });
  }
  return {
    status: "ready",
    provider: provider.name,
    model: provider.model,
    dimension: er.dim,
  };
}

/**
 * 标记某 memory 的 embedding 为 stale（text/confidence/scope 变化时）。
 * 供 Studio reindex 与未来 update 接口；本阶段 store 去重命中走 indexMemory 重建，不单独 stale。
 */
export async function markEmbeddingStale(memoryId: string, reason: string): Promise<void> {
  const rows = await listEmbeddingRowsByMemory(memoryId);
  for (const row of rows) {
    await upsertEmbeddingRow({
      memoryId: row.memoryId,
      provider: row.provider,
      model: row.model,
      vector: row.vector as number[],
      dim: row.dim,
      status: "stale",
      errorMessage: reason,
    });
  }
}

export type ReindexSummary = {
  processed: number;
  ready: number;
  error: number;
  skipped: number;
};

/**
 * 批量重建 embedding（Studio reindex / 后台 backfill 用）。
 * 本阶段同步小批量：遍历 scope 下 active memory，逐个 indexMemory。
 * status 过滤：reindex 指定 status 的 embedding 对应的 memory（默认 stale+error）。
 */
export async function reindexMemories(
  opts: {
    scope?: MemoryScope;
    scopeRef?: string | null;
    status?: "stale" | "error" | "all";
    provider?: EmbeddingProvider;
  } = {},
): Promise<ReindexSummary> {
  const summary: ReindexSummary = { processed: 0, ready: 0, error: 0, skipped: 0 };
  const memories = opts.scope
    ? await listMemoryRows({
        scope: opts.scope,
        scopeRef: opts.scopeRef ?? null,
        status: "active",
      })
    : [];
  // 审计修复：实际使用 opts.status 过滤参数。原实现忽略该参数，始终重新索引全部 active 记忆，
  // 导致 admin 请求 status="stale"（默认）时不必要地对已有 active embedding 的记忆重新调用
  // embedding API（额外成本、延迟、rate limit）。
  const statusFilter = opts.status ?? "stale";
  const targetMemories =
    statusFilter === "all" ? memories : await filterByEmbeddingStatus(memories, statusFilter);
  for (const m of targetMemories) {
    const r = await indexMemory(m.id, { provider: opts.provider });
    summary.processed += 1;
    if (r.status === "ready") summary.ready += 1;
    else if (r.status === "error") summary.error += 1;
    else summary.skipped += 1;
  }
  return summary;
}

/** 过滤记忆列表：仅保留 embedding 状态匹配 targetStatus 的记忆。 */
async function filterByEmbeddingStatus(
  memories: MemoryEntry[],
  targetStatus: "stale" | "error",
): Promise<MemoryEntry[]> {
  const out: MemoryEntry[] = [];
  for (const m of memories) {
    const embRows = await listEmbeddingRowsByMemory(m.id);
    if (embRows.length === 0) {
      // 无 embedding 的记忆视为需要 reindex
      out.push(m);
      continue;
    }
    const hasTarget = embRows.some((e) => e.status === targetStatus);
    if (hasTarget) out.push(m);
  }
  return out;
}

export type { MemoryEmbedding };
