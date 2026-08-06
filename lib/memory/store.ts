import {
 appendThreadEvent,
 createMemoryRow,
 findDuplicateMemory,
 getMemoryRow,
 listMemoryRows,
 updateMemoryRow,
} from "@/lib/db/queries";
import type {
 MemoryConfidence,
 MemoryEntry,
 MemoryKind,
 MemoryProvenanceEntry,
 MemoryScope,
} from "@/lib/db/schema";
import { type EmbeddingProvider, resolveEmbeddingProvider } from "./embedding";
import { type IndexStatus, indexMemory, markEmbeddingStale } from "./index";
import { normalizeProvenance, summarizeProvenance, validateProvenance } from "./provenance";
// re-export text 工具：抽到 text.ts 打破 store↔index 循环依赖；保持 `from "./store"` 不破坏。
export { hashMemoryText, normalizeMemoryText } from "./text";
import { hashMemoryText, normalizeMemoryText } from "./text";

/**
 * 长期记忆 store（facade over queries）。
 *
 * 职责：text 规范化 + 去重 + provenance 校验 + soft delete + 事件落库 + 触发 embedding 索引。
 * 不自动写入：所有 create 经 rememberFact 工具或 Studio curate（provenance 必填）。
 *
 * 去重：同 scope + kind + textHash 的 active 记忆 → update（合并 provenance、confidence 取较高），
 * 不新建行。soft delete：revoke 置 status=revoked，保留审计行。
 *
 * createMemory 末尾触发 indexMemory（去重命中也触发），对 normalized text 生成
 * embedding 并 upsert MemoryEmbedding。provider disabled/error 时 memory 仍创建，semanticStatus 诚实
 * 记录 disabled/error（不静默伪装成功）。indexMemory 失败不阻断记忆创建。
 */

const CONFIDENCE_RANK: Record<MemoryConfidence, number> = { low: 1, medium: 2, high: 3 };

function higherConfidence(a: MemoryConfidence, b: MemoryConfidence): MemoryConfidence {
 return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

/** 合并 provenance：按 kind+refId 去重，保留旧 + 新。 */
function mergeProvenance(
 oldP: MemoryProvenanceEntry[],
 newP: MemoryProvenanceEntry[],
): MemoryProvenanceEntry[] {
 const seen = new Set(oldP.map((p) => `${p.kind}#${p.refId}`));
 const out = [...oldP];
 for (const p of newP) {
 const key = `${p.kind}#${p.refId}`;
 if (!seen.has(key)) {
 seen.add(key);
 out.push(p);
 }
 }
 return out;
}

export type CreateMemoryArgs = {
 scope: MemoryScope;
 scopeRef?: string | null;
 kind: MemoryKind;
 text: string;
 provenance: MemoryProvenanceEntry[] | unknown[];
 confidence?: MemoryConfidence;
 expiresAt?: Date | null;
 createdByToolRunId?: string | null;
 /** 测试注入 deterministic fake；生产默认 undefined → resolveEmbeddingProvider()。 */
 embeddingProvider?: EmbeddingProvider;
};

export type CreateMemoryResult = {
 memory: MemoryEntry;
 deduplicated: boolean;
 /** embedding 索引结果（诚实反映 disabled/stale/ready/error，不静默伪装）。 */
 semanticStatus: IndexStatus;
};

/**
 * 创建一条记忆（带去重 + provenance 校验）。
 * - 命中同 scope+kind+textHash 的 active 记忆 → 合并 provenance、confidence 取较高，deduplicated=true。
 * - 否则新建 + 追加 memory.created 事件，deduplicated=false。
 * provenance 非法（空/缺 refId）→ 抛错（调用方工具据此返回 ok:false）。
 *
 * 写入/去重后触发 indexMemory（去重命中也触发——confidence 可能升高，
 * 重 index 保证 provider/model 最新）。indexMemory 失败不阻断记忆创建（memory 写入优先）。
 */
export async function createMemory(args: CreateMemoryArgs): Promise<CreateMemoryResult> {
 const provenance = normalizeProvenance(args.provenance);
 validateProvenance(provenance);
 const text = normalizeMemoryText(args.text);
 const textHash = hashMemoryText(text);
 const confidence = args.confidence ?? "medium";
 const scopeRef = args.scopeRef ?? null;

 let memory: MemoryEntry;
 let deduplicated: boolean;
 const dup = await findDuplicateMemory({ scope: args.scope, scopeRef, kind: args.kind, textHash });
 if (dup) {
 const merged = mergeProvenance((dup.provenance as MemoryProvenanceEntry[]) ?? [], provenance);
 const updated = await updateMemoryRow(dup.id, {
 provenance: merged,
 confidence: higherConfidence(dup.confidence as MemoryConfidence, confidence),
 });
 memory = updated ?? dup;
 deduplicated = true;
 } else {
 memory = await createMemoryRow({
 scope: args.scope,
 scopeRef,
 kind: args.kind,
 text,
 textHash,
 provenance,
 confidence,
 expiresAt: args.expiresAt ?? null,
 createdByToolRunId: args.createdByToolRunId ?? null,
 });
 // memory.created 事件：threadId 取 provenance 首条的 threadId（若有），否则 scopeRef（thread scope）。
 const threadId =
 provenance.find((p) => p.threadId)?.threadId ??
 (args.scope === "thread" && scopeRef ? scopeRef : null);
 if (threadId) {
 await appendThreadEvent(threadId, "memory.created", {
 memoryId: memory.id,
 scope: args.scope,
 kind: args.kind,
 textHash,
 confidence,
 provenanceSummary: summarizeProvenance(provenance),
 toolRunId: args.createdByToolRunId ?? null,
 });
 }
 deduplicated = false;
 }

 // 触发 embedding 索引（去重命中也触发）。失败不阻断——返回 semanticStatus。
 let semanticStatus: IndexStatus = "disabled";
 try {
 const idx = await indexMemory(memory.id, { provider: args.embeddingProvider });
 semanticStatus = idx.status;
 } catch {
 // indexMemory 内部已吞 provider 错误；此处仅防未预期异常，记忆创建不受影响。
 semanticStatus = "error";
 }
 return { memory, deduplicated, semanticStatus };
}

export async function getMemory(id: string): Promise<MemoryEntry | null> {
 return getMemoryRow(id);
}

export type ListMemoriesFilter = {
 scope: MemoryScope;
 scopeRef?: string | null;
 kind?: MemoryKind;
 status?: "active" | "revoked";
};

export async function listMemories(filter: ListMemoriesFilter): Promise<MemoryEntry[]> {
 return listMemoryRows({
 scope: filter.scope,
 scopeRef: filter.scopeRef ?? null,
 kind: filter.kind,
 status: filter.status ?? "active",
 });
}

/** 撤销记忆（soft delete：status=revoked，保留审计行）+ memory.revoked 事件。 */
export async function revokeMemory(
 id: string,
 opts: { reason?: string; revokedBy?: string } = {},
): Promise<MemoryEntry | null> {
 const existing = await getMemoryRow(id);
 if (!existing) return null;
 const updated = await updateMemoryRow(id, { status: "revoked" });
 const threadId =
 ((existing.provenance as MemoryProvenanceEntry[]) ?? []).find((p) => p.threadId)?.threadId ??
 (existing.scope === "thread" ? existing.scopeRef : null);
 if (threadId) {
 await appendThreadEvent(threadId, "memory.revoked", {
 memoryId: id,
 reason: opts.reason ?? null,
 revokedBy: opts.revokedBy ?? null,
 });
 }
 return updated ?? existing;
}

/** 更新置信度（不删历史，更新 updatedAt）。 */
export async function updateConfidence(
 id: string,
 confidence: MemoryConfidence,
): Promise<MemoryEntry | null> {
 return updateMemoryRow(id, { confidence });
}

/**
 * 更新 memory text（agent 写错时无需 revoke + 重建，保留 provenance 链）。
 *
 * 接通 markEmbeddingStale——text 变化时先标 stale 再 reindex，
 * 让 markEmbeddingStale 不再是孤儿函数。reindex 失败不阻断 text 更新（返回 semanticStatus）。
 */
export async function updateMemoryText(
 id: string,
 text: string,
 opts: { embeddingProvider?: EmbeddingProvider } = {},
): Promise<{ memory: MemoryEntry | null; semanticStatus: IndexStatus }> {
 const existing = await getMemoryRow(id);
 if (!existing) return { memory: null, semanticStatus: "skipped" };
 const normalized = normalizeMemoryText(text);
 const textHash = hashMemoryText(normalized);
 // 审计修复：检查更新后的 text 是否与另一条 active memory 重复（同 scope/kind/textHash）。
 // 原实现直接更新，绕过了 createMemory 强制执行的去重不变量，导致同一
 // (scope, scopeRef, kind, textHash) 下出现两条 active memory。
 if (textHash !== existing.textHash) {
 const dup = await findDuplicateMemory({
 scope: existing.scope as MemoryScope,
 scopeRef: existing.scopeRef,
 kind: existing.kind as MemoryKind,
 textHash,
 });
 if (dup && dup.id !== id) {
 // 与已有记忆冲突：合并 provenance 到已有记忆，撤销当前记忆（保留审计行）
 const merged = mergeProvenance(
 (dup.provenance as MemoryProvenanceEntry[]) ?? [],
 (existing.provenance as MemoryProvenanceEntry[]) ?? [],
 );
 await updateMemoryRow(dup.id, {
 provenance: merged,
 confidence: higherConfidence(
 dup.confidence as MemoryConfidence,
 existing.confidence as MemoryConfidence,
 ),
 });
 await updateMemoryRow(id, { status: "revoked" });
 let semanticStatus: IndexStatus = "disabled";
 try {
 const idx = await indexMemory(dup.id, { provider: opts.embeddingProvider });
 semanticStatus = idx.status;
 } catch {
 semanticStatus = "error";
 }
 const revoked = await getMemoryRow(id);
 return { memory: revoked, semanticStatus };
 }
 }
 // text 变化 → 标 stale（接通 markEmbeddingStale）+ 更新 text/textHash
 await markEmbeddingStale(id, "text_updated");
 const memory = await updateMemoryRow(id, { text: normalized, textHash });
 // reindex 重建 embedding（新 text）
 let semanticStatus: IndexStatus = "disabled";
 try {
 const idx = await indexMemory(id, { provider: opts.embeddingProvider });
 semanticStatus = idx.status;
 } catch {
 semanticStatus = "error";
 }
 return { memory, semanticStatus };
}

export async function findDuplicate(
 scope: MemoryScope,
 scopeRef: string | null,
 kind: MemoryKind,
 textHash: string,
): Promise<MemoryEntry | null> {
 return findDuplicateMemory({ scope, scopeRef, kind, textHash });
}
