/**
 * 初始压缩材料受控读取源（T33）。
 *
 * 事实源：docs/topic02/nexharness-topic02-closure/repairs/10-topic03-interfaces.md（T33）、
 * 11-schema-and-contract-delta.md §5。
 *
 * 职责：
 * - 把 `ExecutionBinding.initialContextCheckpointId` 读取一次，核验
 *   存在性 / tenant / 用途=compression / 摘要与来源 Hash / 有效期 / 来源访问权限；
 * - 输出「已验证描述」（checkpointId + summaryHash + sourceRangesHash），供
 *   ExecutionBinding.configHash 与 ContextHandle.common.initialCompression 使用；
 * - 转换为带来源的低权限 summary 片段，经现有 `assembleContextView` 预算进入模型端口。
 *
 * 关键不变量：
 * - 只接受已在库的 compression Checkpoint；不存在「取最新 Checkpoint」或降级路径。
 * - `selector` 只认 ContextHandle 暴露的受控引用与内容 digest，不接受任意可替换对象。
 * - summary 是低权威数据（trust=untrusted_external），不因来自平台 Checkpoint 而提升为指令。
 * - 本模块不进入 Attempt.resumeAnchor / FilesystemCheckpoint / Ownership / producerSequence，
 *   与本包的执行恢复语义完全隔离。
 * - 无受管摘要读取端口时，只有 inline `summaryRedacted` 的 Checkpoint 可被读取；
 *   ref-only Checkpoint 明确失败，绝不静默改用另一个来源。
 */
import {
  computeSourceRangesHash,
  computeSummaryHash,
  getContextCheckpointById,
  isValidSummaryHash,
} from "@/lib/context/checkpoint-queries";
import {
  type ContextFragment,
  FRAGMENT_PRIORITY_TIERS,
  type FragmentScope,
  assertContextFragment,
  estimateFragmentTokens,
} from "@/lib/context/fragment";
import type {
  ContextQueryContext,
  SourceQueryResult,
  SourceResolver,
} from "@/lib/context/source-resolvers";
import { db } from "@/lib/db/client";
import type { InitialContextCompression } from "@/lib/executions/domain/execution-binding";
import type { ContextCheckpoint } from "@/lib/persistence/schema/context-checkpoint";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import { and, eq } from "drizzle-orm";

/** Context 来源标识：初始压缩材料。不由模型按 `sources` 请求，由 Binding 冻结事实驱动。 */
export const INITIAL_CHECKPOINT_SOURCE_TYPE = "initial_checkpoint";

/** Checkpoint 用途：只有 compression 可作为 Invocation 初始压缩材料。 */
export const INITIAL_COMPRESSION_CHECKPOINT_TYPE = "compression" as const;

// ─── 失败分类（明确失败，不降级）─────────────────────────────

export const INITIAL_COMPRESSION_FAILURES = [
  /** Checkpoint 不存在于该 tenant。 */
  "not_found",
  /** Checkpoint 用途不是 compression。 */
  "wrong_type",
  /** Checkpoint 已过期。 */
  "expired",
  /** summaryRef 与 summaryRedacted 都为空（内容无效）。 */
  "summary_missing",
  /** 有 summaryRef 但没有受管摘要读取端口（不可回读）。 */
  "summary_unreadable",
  /** 摘要正文与 summaryHash 不一致（损坏/被替换）。 */
  "summary_hash_mismatch",
  /** sourceRangesJson 与 sourceRangesHash 不一致（损坏/被替换）。 */
  "source_ranges_hash_mismatch",
  /** summaryRef 与 summaryRedacted 同时存在但内容不一致。 */
  "summary_conflict",
  /** 来源 Invocation / 其 ExecutionBinding 不存在（来源范围不可恢复）。 */
  "source_unavailable",
  /** 来源 Scope 与请求 Principal 不一致（撤权 / 跨 Principal 复用）。 */
  "access_denied",
] as const;
export type InitialCompressionFailure = (typeof INITIAL_COMPRESSION_FAILURES)[number];

export class InitialCompressionError extends Error {
  constructor(
    readonly failure: InitialCompressionFailure,
    message: string,
  ) {
    super(message);
    this.name = "InitialCompressionError";
  }
}

// ─── 摘要读取端口 ───────────────────────────────────────────

/**
 * 受管摘要正文读取端口。
 *
 * `ContextCheckpoint.summaryRef` 是对象存储引用，平台必须经受管端口读取；
 * 未配置端口时不猜测内容，直接判定 `summary_unreadable`。
 */
export interface ContextSummaryStore {
  readSummaryText(ref: string): Promise<string | null>;
}

// ─── 验证结果 ───────────────────────────────────────────────

/** 请求方 Principal（Binding 冻结的 principalType/principalId）。 */
export interface InitialCompressionRequester {
  type: "user" | "service";
  id: string;
}

export interface ResolveInitialCompressionInput {
  tenantId: string;
  checkpointId: string;
  requester: InitialCompressionRequester;
  /** 允许注入时钟（测试）。 */
  now?: Date;
  /** 受管摘要读取端口；null = 未配置（ref-only Checkpoint 明确失败）。 */
  summaryStore?: ContextSummaryStore | null;
  /** 允许注入读取实现（事务内/测试）；默认走仓储。 */
  loadCheckpoint?: (tenantId: string, checkpointId: string) => Promise<ContextCheckpoint | null>;
  /** 允许注入来源访问核验实现（测试）；默认查 Invocation + ExecutionBinding。 */
  verifySourceAccess?: (
    tenantId: string,
    sourceInvocationId: string,
    requester: InitialCompressionRequester,
  ) => Promise<void>;
}

/** 已验证的初始压缩材料。字段全部来自受控读取与 Hash 核对，不接受调用方自报。 */
export interface VerifiedInitialCompression {
  checkpointId: string;
  summaryHash: string;
  sourceRangesHash: string;
  sourceInvocationId: string;
  /** 与 summaryHash 核对一致的摘要正文。 */
  summaryText: string;
  summaryRef: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/** 取 digest 形态（进入 ExecutionBinding.configHash 与 ContextHandle）。 */
export function toInitialContextCompression(
  verified: VerifiedInitialCompression,
): InitialContextCompression {
  return {
    checkpointId: verified.checkpointId,
    summaryHash: verified.summaryHash,
    sourceRangesHash: verified.sourceRangesHash,
  };
}

// ─── 受控读取 ───────────────────────────────────────────────

/**
 * 读取并核验初始压缩材料。
 *
 * 顺序：存在性 → 用途 → 有效期 → 内容可读 → 摘要 Hash → 来源 Hash → 来源访问权限。
 * 任一失败抛 `InitialCompressionError`；不存在「部分可用」返回形态。
 */
export async function resolveInitialCompression(
  input: ResolveInitialCompressionInput,
): Promise<VerifiedInitialCompression> {
  const loadCheckpoint = input.loadCheckpoint ?? getContextCheckpointById;
  const checkpoint = await loadCheckpoint(input.tenantId, input.checkpointId);
  if (!checkpoint) {
    throw new InitialCompressionError(
      "not_found",
      `初始压缩 Checkpoint 不存在或不属于该租户：${input.checkpointId}`,
    );
  }
  if (checkpoint.checkpointType !== INITIAL_COMPRESSION_CHECKPOINT_TYPE) {
    throw new InitialCompressionError(
      "wrong_type",
      `初始压缩材料必须是 compression Checkpoint，实际为 ${checkpoint.checkpointType}`,
    );
  }
  const now = input.now ?? new Date();
  if (checkpoint.expiresAt.getTime() <= now.getTime()) {
    throw new InitialCompressionError(
      "expired",
      `初始压缩 Checkpoint 已过期：${checkpoint.expiresAt.toISOString()}`,
    );
  }

  const summaryText = await resolveSummaryText(checkpoint, input.summaryStore ?? null);

  if (!isValidSummaryHash(checkpoint.summaryHash)) {
    throw new InitialCompressionError("summary_hash_mismatch", "summaryHash 格式非法");
  }
  if (computeSummaryHash(summaryText) !== checkpoint.summaryHash) {
    throw new InitialCompressionError(
      "summary_hash_mismatch",
      "摘要正文与 summaryHash 不一致（禁止静默替换）",
    );
  }

  const recomputedRangesHash = computeSourceRangesHash(checkpoint.sourceRangesJson ?? []);
  if (recomputedRangesHash !== checkpoint.sourceRangesHash) {
    throw new InitialCompressionError(
      "source_ranges_hash_mismatch",
      "sourceRanges 与 sourceRangesHash 不一致（禁止静默替换）",
    );
  }

  const verifySourceAccess = input.verifySourceAccess ?? defaultVerifySourceAccess;
  await verifySourceAccess(input.tenantId, checkpoint.invocationId, input.requester);

  return {
    checkpointId: checkpoint.id,
    summaryHash: checkpoint.summaryHash,
    sourceRangesHash: checkpoint.sourceRangesHash,
    sourceInvocationId: checkpoint.invocationId,
    summaryText,
    summaryRef: checkpoint.summaryRef ?? null,
    createdAt: checkpoint.createdAt,
    expiresAt: checkpoint.expiresAt,
  };
}

/**
 * 解析摘要正文。
 *
 * - summaryRef 与 summaryRedacted 都存在 → 必须一致，否则 `summary_conflict`。
 * - 只有 summaryRef → 必须经受管端口读到内容，否则 `summary_unreadable`（不降级）。
 * - 只有 summaryRedacted → 直接使用。
 * - 都没有 → `summary_missing`。
 */
async function resolveSummaryText(
  checkpoint: ContextCheckpoint,
  summaryStore: ContextSummaryStore | null,
): Promise<string> {
  const inline = checkpoint.summaryRedacted ?? null;
  const ref = checkpoint.summaryRef ?? null;
  if (!inline && !ref) {
    throw new InitialCompressionError("summary_missing", "Checkpoint 既无 summaryRef 也无正文");
  }
  if (ref) {
    if (!summaryStore) {
      throw new InitialCompressionError(
        "summary_unreadable",
        "摘要为对象存储引用但没有配置受管摘要读取端口（不猜测内容，不降级为 inline 正文）",
      );
    }
    const fromRef = await summaryStore.readSummaryText(ref);
    if (fromRef === null) {
      throw new InitialCompressionError("summary_unreadable", `摘要正文不可回读：${ref}`);
    }
    if (inline !== null && inline !== fromRef) {
      throw new InitialCompressionError(
        "summary_conflict",
        "summaryRef 正文与 summaryRedacted 不一致（不允许任选一个）",
      );
    }
    return fromRef;
  }
  return inline as string;
}

/**
 * 默认来源访问核验。
 *
 * 规则：来源 Invocation 必须存在，且其 ExecutionBinding 冻结的 Principal 必须与
 * 请求 Principal 一致。这样既支持「同一 Principal 的前序 Invocation 压缩材料」作为
 * 新 Invocation 输入，也拒绝跨 Principal 复用（撤权场景），且天然禁止跨 tenant。
 */
async function defaultVerifySourceAccess(
  tenantId: string,
  sourceInvocationId: string,
  requester: InitialCompressionRequester,
): Promise<void> {
  const [row] = await db
    .select({
      invocationId: invocationTable.id,
      principalType: executionBindingTable.principalType,
      principalId: executionBindingTable.principalId,
    })
    .from(invocationTable)
    .innerJoin(
      executionBindingTable,
      and(
        eq(executionBindingTable.tenantId, invocationTable.tenantId),
        eq(executionBindingTable.invocationId, invocationTable.id),
      ),
    )
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, sourceInvocationId)))
    .limit(1);
  if (!row) {
    throw new InitialCompressionError(
      "source_unavailable",
      `初始压缩材料来源 Invocation 不可恢复：${sourceInvocationId}`,
    );
  }
  if (row.principalType !== requester.type || row.principalId !== requester.id) {
    throw new InitialCompressionError(
      "access_denied",
      "初始压缩材料来源 Principal 与当前执行 Principal 不一致",
    );
  }
}

// ─── 低权限 summary 片段 ────────────────────────────────────

/** 把已验证材料转换为带来源的低权限 summary Fragment。 */
export function initialCompressionToFragment(
  verified: VerifiedInitialCompression,
  options: { scope: FragmentScope; selectionReason?: string },
): ContextFragment {
  const fragment: ContextFragment = {
    id: `frag-initial-compression-${verified.checkpointId}`,
    kind: "summary",
    sourceRef: {
      type: "context_checkpoint",
      id: verified.checkpointId,
      revisionId: verified.sourceInvocationId,
      hash: verified.summaryHash,
    },
    scope: options.scope,
    // 平台 Checkpoint 不提升来源权威：压缩材料是数据，不是指令。
    trust: "untrusted_external",
    sensitivity: "internal",
    contentHash: verified.summaryHash,
    tokenEstimate: estimateFragmentTokens(verified.summaryText),
    freshness: {
      updatedAt: verified.createdAt,
      expiresAt: verified.expiresAt,
      needsRefresh: false,
    },
    selectionReason: options.selectionReason ?? "initial_context_compression",
    // 冻结的初始材料不能在预算里被当作「更早历史」静默丢弃。
    priorityTier: FRAGMENT_PRIORITY_TIERS.TIER_RECENT,
    text: verified.summaryText,
  };
  assertContextFragment(fragment);
  return fragment;
}

// ─── 现有 Context 装配的解析器 ──────────────────────────────

export interface InitialCompressionResolverInput {
  tenantId: string;
  requester: InitialCompressionRequester;
  /** 来自 ContextHandle.common.initialCompression 的受控引用与内容 digest。 */
  initialCompression: InitialContextCompression;
  scope: FragmentScope;
  now?: () => Date;
  summaryStore?: ContextSummaryStore | null;
}

/**
 * 构造初始压缩材料解析器，注册进现有 Context 装配（预算 + 模型端口）。
 *
 * 与其它源一样返回 ok/denied/unavailable 三态：
 * - 访问权限失败 → denied（路由层显式 403，不降级）；
 * - 其余核验失败 → unavailable + 具体 failure 作为 reasonCode（不伪装 empty）。
 */
export function createInitialCompressionResolver(
  input: InitialCompressionResolverInput,
): SourceResolver {
  const now = input.now ?? (() => new Date());
  return {
    sourceType: INITIAL_CHECKPOINT_SOURCE_TYPE,
    async resolve(ctx: ContextQueryContext): Promise<SourceQueryResult> {
      if (ctx.allowedSources && !ctx.allowedSources.includes(INITIAL_CHECKPOINT_SOURCE_TYPE)) {
        return {
          sourceType: INITIAL_CHECKPOINT_SOURCE_TYPE,
          status: "denied",
          fragments: [],
          reasonCode: "source_not_authorized",
        };
      }
      if (ctx.tenantId !== input.tenantId) {
        return {
          sourceType: INITIAL_CHECKPOINT_SOURCE_TYPE,
          status: "denied",
          fragments: [],
          reasonCode: "access_denied",
          detail: "初始压缩材料不可跨租户复用",
        };
      }
      try {
        const verified = await resolveInitialCompression({
          tenantId: input.tenantId,
          checkpointId: input.initialCompression.checkpointId,
          requester: input.requester,
          now: now(),
          summaryStore: input.summaryStore ?? null,
        });
        assertInitialCompressionUnchanged(input.initialCompression, verified);
        return {
          sourceType: INITIAL_CHECKPOINT_SOURCE_TYPE,
          status: "ok",
          fragments: [initialCompressionToFragment(verified, { scope: input.scope })],
        };
      } catch (error) {
        if (!(error instanceof InitialCompressionError)) throw error;
        return {
          sourceType: INITIAL_CHECKPOINT_SOURCE_TYPE,
          status: error.failure === "access_denied" ? "denied" : "unavailable",
          fragments: [],
          reasonCode: error.failure,
          detail: error.message,
        };
      }
    },
  };
}

/**
 * 冻结一致性：ContextHandle 中冻结的 summaryHash/sourceRangesHash 必须与
 * 本次受控读取结果一致。不一致意味着材料已被替换，必须显式失败。
 */
export function assertInitialCompressionUnchanged(
  frozen: InitialContextCompression,
  verified: VerifiedInitialCompression,
): void {
  if (
    frozen.summaryHash !== verified.summaryHash ||
    frozen.sourceRangesHash !== verified.sourceRangesHash
  ) {
    throw new InitialCompressionError(
      "summary_hash_mismatch",
      "初始压缩材料与 Binding 冻结的内容摘要不一致（已冻结的初始材料不可被替换）",
    );
  }
}
