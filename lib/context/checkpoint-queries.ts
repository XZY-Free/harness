/**
 * Context Checkpoint 仓储。
 *
 * 事实源：
 * - docs/architecture/persistence.md （context_checkpoint 表）。
 * - docs/architecture/context-memory-and-knowledge.md §6（压缩）、§15（失败与恢复）。
 * - docs/architecture/memory-and-job-api.md §3（Context Checkpoint API）。
 * - docs/architecture/context-memory-and-knowledge.md 。
 *
 * 职责：
 * - createContextCheckpoint：原子写入 Checkpoint + 幂等记录（同事务）。
 * - getContextCheckpointById：按 id 查询（跨租户隔离）。
 * - getContextCheckpointsByInvocation：列出 Invocation 的 Checkpoint（按 createdAt 升序）。
 * - computeSourceRangesHash：规范化 sourceRanges 后 sha256，含算法前缀。
 *
 * 边界：
 * - Checkpoint 不删除原始 Item/Event，不写 Memory，不保存 Credential/隐藏思维链。
 * - summaryRef 与 summaryRedacted 至少一个非空（本仓储不强制，由 route 层校验）。
 * - source_ranges_hash 由本模块计算，调用方不能自报。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
 type CheckpointType,
 type ContextCheckpoint,
 type SourceRange,
 contextCheckpoint,
} from "@/lib/persistence/schema/context-checkpoint";
import { and, asc, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 计算来源范围 hash。
 *
 * 规范化：
 * - 对 sourceRanges 数组按 type/fromSequence/toSequence/resourceIds 排序后 JSON.stringify。
 * - 拼接后 sha256，返回 `sha256:<hex>`。
 *
 * 不同顺序的 sourceRanges 产生相同 hash（保证幂等重放可匹配）。
 */
export function computeSourceRangesHash(sourceRanges: SourceRange[]): string {
 const normalized = sourceRanges.map(normalizeSourceRange).sort((a, b) => {
 const aStr = JSON.stringify(a);
 const bStr = JSON.stringify(b);
 return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
 });
 const payload = JSON.stringify(normalized);
 return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/** 规范化单个 SourceRange（排序 resourceIds、补全 null 字段）。 */
function normalizeSourceRange(range: SourceRange): SourceRange {
 return {
 type: range.type,
 fromSequence: range.fromSequence ?? null,
 toSequence: range.toSequence ?? null,
 resourceIds: range.resourceIds ? [...range.resourceIds].sort() : undefined,
 rangeHash: range.rangeHash,
 };
}

/**
 * 创建 Context Checkpoint。
 *
 * 事务内：
 * 1. INSERT ContextCheckpoint。
 *
 * 调用方负责在同事务内完成幂等记录写入（completeRecord/failRecord）。
 *
 * @throws sourceRangesHash 已存在（同 Invocation + 同 checkpointType + 同 ranges）时，
 * MySQL ER_DUP_ENTRY；调用方应捕获后查询已有 Checkpoint 返回（幂等重放）。
 */
export async function createContextCheckpoint(params: {
 tenantId: string;
 invocationId: string;
 checkpointType: CheckpointType;
 sourceRanges: SourceRange[];
 summaryRef?: string | null;
 summaryRedacted?: string | null;
 summaryHash: string;
 tokenAccounting: { input: number; retained: number; compressed: number };
 expiresAt?: Date;
 tx?: Tx;
}): Promise<ContextCheckpoint> {
 const id = randomUUID();
 const now = new Date();
 const expiresAt = params.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
 const sourceRangesHash = computeSourceRangesHash(params.sourceRanges);

 const client = params.tx ?? db;
 await client.insert(contextCheckpoint).values({
 id,
 tenantId: params.tenantId,
 invocationId: params.invocationId,
 checkpointType: params.checkpointType,
 sourceRangesJson: params.sourceRanges,
 sourceRangesHash,
 summaryRef: params.summaryRef ?? null,
 summaryRedacted: params.summaryRedacted ?? null,
 summaryHash: params.summaryHash,
 inputTokens: params.tokenAccounting.input,
 retainedTokens: params.tokenAccounting.retained,
 compressedTokens: params.tokenAccounting.compressed,
 createdAt: now,
 expiresAt,
 });

 const [row] = await client
 .select()
 .from(contextCheckpoint)
 .where(eq(contextCheckpoint.id, id))
 .limit(1);
 if (!row) {
 throw new Error(`createContextCheckpoint: 行未找到（id=${id}）`);
 }
 return row;
}

/**
 * 按 (tenantId, invocationId, checkpointType, sourceRangesHash) 查找已存在 Checkpoint。
 *
 * 用于幂等重放：同 Idempotency-Key 重放时，若 Checkpoint 已存在则直接返回。
 * 不存在返回 null。
 */
export async function findContextCheckpointByUniqueKey(params: {
 tenantId: string;
 invocationId: string;
 checkpointType: CheckpointType;
 sourceRanges: SourceRange[];
}): Promise<ContextCheckpoint | null> {
 const sourceRangesHash = computeSourceRangesHash(params.sourceRanges);
 const [row] = await db
 .select()
 .from(contextCheckpoint)
 .where(
 and(
 eq(contextCheckpoint.tenantId, params.tenantId),
 eq(contextCheckpoint.invocationId, params.invocationId),
 eq(contextCheckpoint.checkpointType, params.checkpointType),
 eq(contextCheckpoint.sourceRangesHash, sourceRangesHash),
 ),
 )
 .limit(1);
 return row ?? null;
}

/** 按 id 查询 Checkpoint（跨租户隔离）。不存在返回 null。 */
export async function getContextCheckpointById(
 tenantId: string,
 checkpointId: string,
): Promise<ContextCheckpoint | null> {
 const [row] = await db
 .select()
 .from(contextCheckpoint)
 .where(and(eq(contextCheckpoint.tenantId, tenantId), eq(contextCheckpoint.id, checkpointId)))
 .limit(1);
 return row ?? null;
}

/** 列出 Invocation 的 Checkpoint（按 createdAt 升序）。 */
export async function getContextCheckpointsByInvocation(
 tenantId: string,
 invocationId: string,
): Promise<ContextCheckpoint[]> {
 const rows = await db
 .select()
 .from(contextCheckpoint)
 .where(
 and(
 eq(contextCheckpoint.tenantId, tenantId),
 eq(contextCheckpoint.invocationId, invocationId),
 ),
 )
 .orderBy(asc(contextCheckpoint.createdAt));
 return rows;
}

/**
 * 校验 summary hash 格式（sha256: 前缀 + 64 hex）。
 */
export function isValidSummaryHash(hash: string): boolean {
 return /^sha256:[0-9a-f]{64}$/.test(hash);
}

/**
 * 计算 summary hash（对摘要正文 sha256，含算法前缀）。
 *
 * 调用方应先脱敏后计算 hash，保证 hash 不泄露敏感内容。
 */
export function computeSummaryHash(summaryText: string): string {
 return `sha256:${createHash("sha256").update(summaryText, "utf8").digest("hex")}`;
}
