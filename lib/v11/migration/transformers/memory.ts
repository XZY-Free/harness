/**
 * S13-C03 memory 域迁移转换器。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §memory
 * - ../v11-agentkit-platform/10-core-data-model.md §7.5（Memory 与知识索引表）
 *
 * 映射：
 * - MemoryEntry → V11MemoryEntry + V11MemoryCandidate
 *   - scope→scopeType（user→user_preference / project→workspace / thread→thread / skill→agent）
 *   - kind→memoryType（直接保留）
 *   - status→memoryState（active→active / revoked→archived）
 *   - scopeRef 为空入异常队列
 * - MemoryEmbedding → V11MemoryIndex
 *   - vector 为不可迁字段，用 indexRef 引用代替
 *   - provider→indexProvider / model→embeddingModelRef
 *   - memoryId 对应的 V11MemoryEntry 不存在入异常队列
 *
 * 迁移原则：
 * - 只迁可证明事实；scopeRef 为空或 memoryId 对应 Entry 不存在入异常队列，不猜测。
 * - 跨表依赖按域顺序保证：MemoryEntry → MemoryEmbedding。
 * - 保留源 id 作为 V11MemoryEntry / V11MemoryIndex 的 id，便于跨表关联追溯。
 * - V11MemoryCandidate 用新 id（非主目标），sourceItemId 使用源 id 保证 candidateKey 唯一。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { computeCandidateKey, computeMemoryEntryKey } from "@/lib/v11/context/memory-queries";
import { DEFAULT_TENANT_ID } from "@/lib/v11/identity/tenant-queries";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import type { MemoryScopeType, MemoryState } from "@/lib/v11/schema/memory";
import { memoryEntry as v11MemoryEntryTable } from "@/lib/v11/schema/memory";
import { eq } from "drizzle-orm";

// ─── 旧→新枚举映射 ─────────────────────────────────────────

/** 旧 scope → V11 scopeType 映射。 */
const SCOPE_TO_SCOPE_TYPE: ReadonlyMap<string, MemoryScopeType> = new Map([
  ["user", "user_preference"],
  ["project", "workspace"],
  ["thread", "thread"],
  ["skill", "agent"],
]);

/** 旧 MemoryEntry.status → V11 memoryState 映射。 */
const STATUS_TO_MEMORY_STATE: ReadonlyMap<string, MemoryState> = new Map([
  ["active", "active"],
  ["revoked", "archived"],
]);

/** 迁移占位 invocationId（旧数据无 Invocation 概念）。 */
const LEGACY_INVOCATION_ID = "legacy-migration";

/** 迁移占位 rationaleCode。 */
const LEGACY_RATIONALE_CODE = "legacy_migration";

// ─── MemoryEntry → V11MemoryEntry + V11MemoryCandidate ────

const memoryEntryTransformer: MigrationTransformer = (record) => {
  const id = String(record.id ?? "");
  const scope = String(record.scope ?? "");
  const scopeRef = record.scopeRef != null ? String(record.scopeRef) : "";
  const kind = String(record.kind ?? "");
  const textHash = String(record.textHash ?? "");
  const status = String(record.status ?? "active");

  // scopeRef 为空入异常队列（无法确定作用域绑定）
  if (!scopeRef) {
    return { targets: [], anomalyReason: "scopeRef 为空（无法确定作用域绑定）" };
  }

  // scope → scopeType
  const scopeType = SCOPE_TO_SCOPE_TYPE.get(scope);
  if (!scopeType) {
    return { targets: [], anomalyReason: `scope "${scope}" 无对应 V11 scopeType` };
  }

  // status → memoryState
  const memoryState = STATUS_TO_MEMORY_STATE.get(status);
  if (!memoryState) {
    return { targets: [], anomalyReason: `status "${status}" 无对应 V11 memoryState` };
  }

  // textHash 为空入异常队列（contentHash 无法构造）
  if (!textHash) {
    return { targets: [], anomalyReason: "textHash 为空（无法构造 contentHash）" };
  }

  const memoryType = kind;
  // V11 contentHash 格式：sha256: 前缀 + 64 hex（旧 textHash 为 64 hex 无前缀）
  const contentHash = `sha256:${textHash}`;
  const contentRedacted = record.text != null ? String(record.text) : null;

  // 计算 entryKey（规范化去重键：tenant|scope|scopeRef|memoryType|contentHash）
  const entryKey = computeMemoryEntryKey({
    tenantId: DEFAULT_TENANT_ID,
    scopeType,
    scopeRef,
    memoryType,
    contentHash,
  });

  // 计算 candidateKey（sha256(invocation_id|source_type|source_id|content_hash|scope_type|scope_ref)）
  const candidateKey = computeCandidateKey({
    invocationId: LEGACY_INVOCATION_ID,
    sourceType: "thread_item",
    sourceId: id,
    contentHash,
    scopeType,
    scopeRef,
  });

  return {
    targets: [
      {
        table: "V11MemoryEntry",
        data: {
          id,
          tenantId: DEFAULT_TENANT_ID,
          entryKey,
          scopeType,
          scopeRef,
          memoryType,
          contentRef: null,
          contentRedacted,
          contentHash,
          sensitivityClass: "internal",
          memoryState,
          expiresAt: record.expiresAt ?? null,
        },
      },
      {
        table: "V11MemoryCandidate",
        data: {
          id: randomUUID(),
          tenantId: DEFAULT_TENANT_ID,
          invocationId: LEGACY_INVOCATION_ID,
          sourceItemId: id,
          sourceJobId: null,
          sourceArtifactId: null,
          sourceHash: contentHash,
          proposedScopeType: scopeType,
          proposedScopeRef: scopeRef,
          memoryType,
          rationaleCode: LEGACY_RATIONALE_CODE,
          contentRef: null,
          contentRedacted,
          contentHash,
          candidateKey,
          sensitivityClass: "internal",
          candidateState: "accepted",
          resolvedMemoryEntryId: id,
        },
      },
    ],
  };
};

// ─── MemoryEmbedding → V11MemoryIndex ─────────────────────

const memoryEmbeddingTransformer: MigrationTransformer = async (record) => {
  const id = String(record.id ?? "");
  const memoryId = String(record.memoryId ?? "");
  const provider = String(record.provider ?? "");
  const model = String(record.model ?? "");

  // 查询 V11MemoryEntry（须先迁移 MemoryEntry）
  const [entry] = await db
    .select({ contentHash: v11MemoryEntryTable.contentHash })
    .from(v11MemoryEntryTable)
    .where(eq(v11MemoryEntryTable.id, memoryId))
    .limit(1);
  if (!entry) {
    return {
      targets: [],
      anomalyReason: `memoryId ${memoryId} 对应的 V11MemoryEntry 不存在（须先迁移 MemoryEntry）`,
    };
  }

  // vector 为不可迁字段，用 indexRef 引用代替（指向旧表行）
  const indexRef = `legacy-vector://MemoryEmbedding/${id}`;

  return {
    targets: [
      {
        table: "V11MemoryIndex",
        data: {
          id,
          memoryEntryId: memoryId,
          indexProvider: provider,
          indexRef,
          embeddingModelRef: model,
          contentHash: entry.contentHash,
        },
      },
    ],
  };
};

// ─── 导出 memory 域转换器注册表 ────────────────────────────

/** 创建 memory 域的全部转换器（key = 物理表名）。 */
export function createMemoryTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ["MemoryEntry", memoryEntryTransformer],
    ["MemoryEmbedding", memoryEmbeddingTransformer],
  ]);
}
