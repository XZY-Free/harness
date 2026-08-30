/**
 * CapabilityUse 仓储（阶段 6 S06-C04）。
 *
 * 事实源：lib/persistence/schema/capability-use.ts、
 * docs/architecture/persistence.md （capability_use）、
 * docs/architecture/capability-and-collaboration-api.md §3（Runtime Capability API）。
 *
 * 职责：
 * - computeCapabilityUseKey：计算幂等键 sha256(type|id|revision|content-hash|schema-hash)。
 * - recordCapabilityUse：幂等写入能力使用账本（UNIQUE(invocationId, capabilityUseKey) 兜底）。
 * - listCapabilityUseByInvocation：列出某 Invocation 的全部能力使用记录。
 * - getCapabilityUseByKey：按 (invocationId, capabilityUseKey) 查询单条记录。
 *
 * 关键约束：
 * - 幂等性：同一 Invocation + 同一能力修订只写一次；重复写忽略（返回已存在行）。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - capabilityUseKey 是稳定 hash，相同能力修订产生相同 key。
 */
import { createHash, randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import {
  type CapabilityUse,
  type CapabilityUseSourceType,
  type CapabilityUseType,
  capabilityUseTable,
} from "@/lib/persistence/schema/capability-use";
import { and, asc, eq } from "drizzle-orm";

// ─── 错误类 ────────────────────────────────────────────────

/** CapabilityUse 校验错误（参数非法）。 */
export class CapabilityUseValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityUseValidationError";
  }
}

// ─── 常量校验 ─────────────────────────────────────────────

const VALID_CAPABILITY_USE_TYPES = new Set<string>([
  "skill",
  "tool",
  "knowledge_document",
  "memory",
  "agent",
  "model",
]);

const VALID_CAPABILITY_USE_SOURCE_TYPES = new Set<string>([
  "default",
  "dynamic_discovery",
  "user_selected",
  "policy",
  "gateway",
]);

function assertValidCapabilityType(value: string): asserts value is CapabilityUseType {
  if (!VALID_CAPABILITY_USE_TYPES.has(value)) {
    throw new CapabilityUseValidationError(
      "invalid_capability_type",
      `capabilityType 非法: ${value}`,
    );
  }
}

function assertValidSourceType(value: string): asserts value is CapabilityUseSourceType {
  if (!VALID_CAPABILITY_USE_SOURCE_TYPES.has(value)) {
    throw new CapabilityUseValidationError("invalid_source_type", `sourceType 非法: ${value}`);
  }
}

// ─── computeCapabilityUseKey ──────────────────────────────

/**
 * 计算能力使用幂等键。
 *
 * 公式：sha256(type|id|revision-or-empty|content-hash-or-empty|schema-hash-or-empty)
 *
 * - 同一 Invocation 内同 type+id+revision+content-hash+schema-hash 视为同一能力修订，
 * UNIQUE(invocationId, capabilityUseKey) 兜底防重复写。
 * - revision/content-hash/schema-hash 任一为空时填空字符串占位。
 *
 * @returns 64 hex（不带前缀）；存储为 varchar(128) 留扩展余量。
 */
export function computeCapabilityUseKey(params: {
  capabilityType: string;
  capabilityId: string;
  revisionId?: string | null;
  contentHash?: string | null;
  schemaHash?: string | null;
}): string {
  if (!params.capabilityType) {
    throw new CapabilityUseValidationError("invalid_capability_type", "capabilityType 不能为空");
  }
  if (!params.capabilityId) {
    throw new CapabilityUseValidationError("invalid_capability_id", "capabilityId 不能为空");
  }
  const payload = [
    params.capabilityType,
    params.capabilityId,
    params.revisionId ?? "",
    params.contentHash ?? "",
    params.schemaHash ?? "",
  ].join("|");
  return createHash("sha256").update(payload, "utf-8").digest("hex");
}

// ─── recordCapabilityUse ─────────────────────────────────

/** recordCapabilityUse 入参。 */
export interface RecordCapabilityUseParams {
  tenantId: string;
  invocationId: string;
  capabilityType: CapabilityUseType;
  capabilityId: string;
  /** 实际修订 id（如 ToolSchemaRevision.id / SkillVersion.id）；可空。 */
  revisionId?: string | null;
  /** 实际内容 hash（sha256: 前缀，Skill 内容）；可空。 */
  contentHash?: string | null;
  /** 实际 Schema hash（sha256: 前缀，Tool Schema）；可空。 */
  schemaHash?: string | null;
  /** 来源类型；默认 dynamic_discovery。 */
  sourceType?: CapabilityUseSourceType;
  /** 来源引用（如搜索 query / 用户选择路径）；可空。 */
  sourceRef?: string | null;
  /** 选择理由代码（如 query_match / explicit_select / policy_required）；可空。 */
  selectionReasonCode?: string | null;
}

/**
 * 幂等写入能力使用账本。
 *
 * - 计算 capabilityUseKey = sha256(type|id|revision|content-hash|schema-hash)。
 * - 若 (invocationId, capabilityUseKey) 已存在 → 返回已有行（幂等）。
 * - 否则 INSERT 新行，返回新记录。
 *
 * UNIQUE(invocationId, capabilityUseKey) 兜底并发竞态；
 * 并发冲突时回查返回已存在行（不抛错，符合幂等语义）。
 */
export async function recordCapabilityUse(
  params: RecordCapabilityUseParams,
): Promise<CapabilityUse> {
  return recordCapabilityUseInSession(db, params);
}

/** 在调用方提供的 transaction/session 内原子写入 CapabilityUse。 */
export async function recordCapabilityUseInSession(
  source: DbOrTx,
  params: RecordCapabilityUseParams,
): Promise<CapabilityUse> {
  assertValidCapabilityType(params.capabilityType);
  const sourceType = params.sourceType ?? "dynamic_discovery";
  assertValidSourceType(sourceType);
  if (!params.tenantId) {
    throw new CapabilityUseValidationError("invalid_tenant_id", "tenantId 不能为空");
  }
  if (!params.invocationId) {
    throw new CapabilityUseValidationError("invalid_invocation_id", "invocationId 不能为空");
  }
  if (!params.capabilityId) {
    throw new CapabilityUseValidationError("invalid_capability_id", "capabilityId 不能为空");
  }

  const capabilityUseKey = computeCapabilityUseKey({
    capabilityType: params.capabilityType,
    capabilityId: params.capabilityId,
    revisionId: params.revisionId ?? null,
    contentHash: params.contentHash ?? null,
    schemaHash: params.schemaHash ?? null,
  });

  // 先查重：避免不必要的 INSERT（同 Invocation 同 key 已记录则返回原行）。
  const existing = await getCapabilityUseByKeyInSession(source, {
    tenantId: params.tenantId,
    invocationId: params.invocationId,
    capabilityUseKey,
  });
  if (existing) {
    return existing;
  }

  const id = randomUUID();
  try {
    await source.insert(capabilityUseTable).values({
      id,
      tenantId: params.tenantId,
      invocationId: params.invocationId,
      capabilityType: params.capabilityType,
      capabilityId: params.capabilityId,
      revisionId: params.revisionId ?? null,
      contentHash: params.contentHash ?? null,
      schemaHash: params.schemaHash ?? null,
      sourceType,
      sourceRef: params.sourceRef ?? null,
      selectionReasonCode: params.selectionReasonCode ?? null,
      capabilityUseKey,
    });
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) {
      // 并发竞态：UNIQUE(invocationId, capabilityUseKey) 冲突 → 回查返回已存在行。
      const retried = await getCapabilityUseByKeyInSession(source, {
        tenantId: params.tenantId,
        invocationId: params.invocationId,
        capabilityUseKey,
      });
      if (retried) return retried;
    }
    throw err;
  }

  const [row] = await source
    .select()
    .from(capabilityUseTable)
    .where(eq(capabilityUseTable.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`recordCapabilityUse: 行未找到（id=${id}）`);
  }
  return row;
}

// ─── 查询 ─────────────────────────────────────────────────

/** 按 (invocationId, capabilityUseKey) 查询单条记录（跨租户隔离）。不存在返回 null。 */
export async function getCapabilityUseByKey(params: {
  tenantId: string;
  invocationId: string;
  capabilityUseKey: string;
}): Promise<CapabilityUse | null> {
  return getCapabilityUseByKeyInSession(db, params);
}

async function getCapabilityUseByKeyInSession(
  source: DbOrTx,
  params: {
    tenantId: string;
    invocationId: string;
    capabilityUseKey: string;
  },
): Promise<CapabilityUse | null> {
  const [row] = await source
    .select()
    .from(capabilityUseTable)
    .where(
      and(
        eq(capabilityUseTable.tenantId, params.tenantId),
        eq(capabilityUseTable.invocationId, params.invocationId),
        eq(capabilityUseTable.capabilityUseKey, params.capabilityUseKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 列出某 Invocation 的全部能力使用记录（按 firstUsedAt 升序 + id 升序）。 */
export async function listCapabilityUseByInvocation(params: {
  tenantId: string;
  invocationId: string;
}): Promise<CapabilityUse[]> {
  return db
    .select()
    .from(capabilityUseTable)
    .where(
      and(
        eq(capabilityUseTable.tenantId, params.tenantId),
        eq(capabilityUseTable.invocationId, params.invocationId),
      ),
    )
    .orderBy(asc(capabilityUseTable.firstUsedAt), asc(capabilityUseTable.id));
}

// ─── 内部工具 ──────────────────────────────────────────────

// ─── Re-exports ────────────────────────────────────────────

export type {
  CapabilityUseSourceType,
  CapabilityUseType,
  CapabilityUse,
} from "@/lib/persistence/schema/capability-use";
