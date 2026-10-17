/**
 * Memory 仓储 + Policy 服务。
 *
 * 事实源：
 * - docs/architecture/persistence.md （memory_candidate / memory_entry / memory_source / memory_index）。
 * - docs/architecture/context-memory-and-knowledge.md §8（作用域）、§9（挂载与检索）、
 * §10（写入路径）、§11（禁止内容与用户控制）。
 * - docs/architecture/domain-model.md （Memory 域模型边界）。
 * - docs/architecture/memory-and-job-api.md §2（Memory Candidate API）。
 * - docs/architecture/context-memory-and-knowledge.md 。
 *
 * 职责：
 * - computeCandidateKey：规范化 sha256(invocation_id|source_type|source_id|content_hash|scope_type|scope_ref-or-empty)。
 * - evaluateMemoryPolicy：评估来源/作用域/敏感度/敏感内容 → accepted/rejected/needs_review。
 * - detectSensitiveContent：扫描 Secret/Token/Cookie/私钥模式。
 * - createMemoryCandidateWithEntry：accepted 路径，同事务写 candidate + entry + source。
 * - resolveMemoryCandidate：管理员复核 needs_review → accepted/rejected，SELECT FOR UPDATE 防并发。
 * - getMemoryCandidateById / findByCandidateKey：跨租户隔离查询。
 *
 * 边界：
 * - Secret/Token/Cookie/私钥直接 rejected，正文销毁，响应不回显。
 * - Organization scope 一律 needs_review。
 * - accepted 与 MemoryEntry upsert 同事务；MemorySource 关联同事务；索引异步。
 * - 管理员复核只能缩小 scope，不能扩大（route 层校验 scope 收窄方向）。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  type CandidateState,
  type MemoryCandidate,
  type MemoryCategory,
  type MemoryEntry,
  type MemoryScopeType,
  type MemorySource,
  type MemorySourceType,
  type SensitivityClass,
  memoryCandidate,
  memoryEntry,
  memorySource,
} from "@/lib/persistence/schema/memory";
import { and, eq, sql } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 数据库或事务句柄（INSERT/SELECT 通用接口）。 */
type DbOrTx = typeof db | Tx;

// ─── Hash / Key 计算 ──────────────────────────────────────

/**
 * 计算内容 hash（sha256: 前缀 + 64 hex）。
 *
 * 调用方应先脱敏后计算 hash，保证 hash 不泄露敏感内容。
 */
export function computeMemoryContentHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** 校验内容 hash 格式（sha256: 前缀 + 64 hex）。 */
export function isValidMemoryContentHash(hash: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(hash);
}

/** 校验内容 hash 与文本一致。 */
export function verifyMemoryContentHash(text: string, hash: string): boolean {
  return computeMemoryContentHash(text) === hash;
}

/**
 * 从 candidate 字段推导来源类型与来源 id。
 *
 * 规则（route 层保证恰一个非空）：
 * - sourceItemId 非空 → { sourceType: "thread_item", sourceId: sourceItemId }
 * - sourceJobId 非空 → { sourceType: "job", sourceId: sourceJobId }
 * - sourceArtifactId 非空 → { sourceType: "artifact", sourceId: sourceArtifactId }
 *
 * @throws Error 三个字段都为空或多个非空
 */
export function deriveSourceFromCandidate(params: {
  sourceItemId?: string | null;
  sourceJobId?: string | null;
  sourceArtifactId?: string | null;
  sourceExtractionRunId?: string | null;
}): { sourceType: MemorySourceType; sourceId: string } {
  const { sourceItemId, sourceJobId, sourceArtifactId, sourceExtractionRunId } = params;
  const nonEmpty = [sourceItemId, sourceJobId, sourceArtifactId, sourceExtractionRunId].filter(
    (v) => v != null && v !== "",
  );
  if (nonEmpty.length !== 1) {
    throw new Error(
      `deriveSourceFromCandidate: source_item_id/source_job_id/source_artifact_id/source_extraction_run_id 恰一个非空（实际 ${nonEmpty.length} 个非空）`,
    );
  }
  if (sourceItemId) return { sourceType: "thread_item", sourceId: sourceItemId };
  if (sourceJobId) return { sourceType: "job", sourceId: sourceJobId };
  if (sourceExtractionRunId)
    return { sourceType: "extraction_run", sourceId: sourceExtractionRunId };
  // sourceArtifactId 一定非空（上方校验保证恰一个非空）
  return { sourceType: "artifact", sourceId: sourceArtifactId as string };
}

/**
 * 计算 candidate_key。
 *
 * 规范化：sha256(invocation_id|source_type|source_id|content_hash|scope_type|scope_ref-or-empty)
 * - 各字段以 `|` 分隔。
 * - scope_ref 为 null/空时使用空字符串。
 *
 * 返回 `sha256:<hex>`。
 */
export function computeCandidateKey(params: {
  invocationId: string;
  sourceType: MemorySourceType;
  sourceId: string;
  contentHash: string;
  scopeType: MemoryScopeType;
  scopeRef?: string | null;
}): string {
  const scopeRef = params.scopeRef ?? "";
  const payload = [
    params.invocationId,
    params.sourceType,
    params.sourceId,
    params.contentHash,
    params.scopeType,
    scopeRef,
  ].join("|");
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

// ─── 敏感内容检测 ──────────────────────────────────────────

/**
 * 敏感内容模式（Secret/Token/Cookie/私钥）。
 *
 * 命中任一模式即判定为敏感内容，直接 rejected，正文销毁。
 * 这是基线检测；生产环境可扩展为更完善的检测器。
 */
const SENSITIVE_CONTENT_PATTERNS: readonly RegExp[] = [
  // 私钥（PEM 格式）
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/i,
  // AWS Access Key ID（AKIA + 16 字符）
  /AKIA[0-9A-Z]{16}/,
  // AWS Secret Access Key
  /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i,
  // Bearer Token
  /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/i,
  // JWT（eyJ 开头的三段式）
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  // password=... / password: ...
  /(?:password|passwd|pwd)\s*[=:]\s*['"]?[^\s'"]{4,}['"]?/i,
  // secret=... / secret: ...
  /secret\s*[=:]\s*['"]?[^\s'"]{4,}['"]?/i,
  // token=... / token: ...
  /token\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/i,
  // Set-Cookie / cookie=...
  /(?:set-cookie|cookie)\s*[=:]\s*['"]?[^\s'"]{4,}['"]?/i,
  // api_key=... / apikey=... / api-key=...
  /api[_-]?key\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/i,
];

/**
 * 检测文本是否包含敏感内容（Secret/Token/Cookie/私钥）。
 *
 * @returns true 表示检测到敏感内容
 */
export function detectSensitiveContent(text: string): boolean {
  if (!text || text.length === 0) return false;
  for (const pattern of SENSITIVE_CONTENT_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ─── Policy 服务 ──────────────────────────────────────────

/** Policy 评估结果。 */
export interface MemoryPolicyDecision {
  /** 决策：accepted（接受，创建 Entry）/ rejected（拒绝，销毁内容）/ needs_review（需管理员复核）。 */
  decision: "accepted" | "rejected" | "needs_review";
  /** 决策原因码（如 ["organization_scope_requires_review"]）。 */
  reasonCodes: string[];
}

/**
 * 评估 Memory Candidate 写入策略。
 *
 * 规则（§10、§11）：
 * 1. 敏感内容（Secret/Token/Cookie/私钥）→ rejected（reasonCode: sensitive_content_detected）。
 * 2. Organization scope → needs_review（reasonCode: organization_scope_requires_review）。
 * 3. 其他 → accepted（restricted sensitivity 仅影响检索过滤，不触发复核）。
 *
 * 来源/作用域合法性校验（MEMORY_SOURCE_NOT_ALLOWED / MEMORY_SCOPE_NOT_ALLOWED）
 * 由 route 层在调用本函数前完成（返回 403 错误响应，不进入 Policy 评估）。
 */
export function evaluateMemoryPolicy(params: {
  contentRedacted?: string | null;
  proposedScopeType: MemoryScopeType;
  sensitivityClass: SensitivityClass;
}): MemoryPolicyDecision {
  // 1. 敏感内容检测（仅当有正文时可检测；content_ref only 时无法检测）
  if (params.contentRedacted && detectSensitiveContent(params.contentRedacted)) {
    return {
      decision: "rejected",
      reasonCodes: ["sensitive_content_detected"],
    };
  }

  // 2. Organization scope 一律 needs_review
  if (params.proposedScopeType === "organization") {
    return {
      decision: "needs_review",
      reasonCodes: ["organization_scope_requires_review"],
    };
  }

  // 3. 其他 → accepted
  return { decision: "accepted", reasonCodes: [] };
}

// ─── 仓储：MemoryCandidate ─────────────────────────────────

/**
 * 按 candidateKey 查找已存在 Candidate（幂等去重）。
 * 跨租户隔离：candidateKey 全局唯一（含 invocationId），但仍按 tenantId 过滤。
 */
export async function findMemoryCandidateByCandidateKey(
  tenantId: string,
  candidateKey: string,
): Promise<MemoryCandidate | null> {
  const [row] = await db
    .select()
    .from(memoryCandidate)
    .where(
      and(eq(memoryCandidate.tenantId, tenantId), eq(memoryCandidate.candidateKey, candidateKey)),
    )
    .limit(1);
  return row ?? null;
}

/** 按 id 查询 Candidate（跨租户隔离）。不存在返回 null。 */
export async function getMemoryCandidateById(
  tenantId: string,
  candidateId: string,
): Promise<MemoryCandidate | null> {
  const [row] = await db
    .select()
    .from(memoryCandidate)
    .where(and(eq(memoryCandidate.tenantId, tenantId), eq(memoryCandidate.id, candidateId)))
    .limit(1);
  return row ?? null;
}

/**
 * 按 id + invocationId 查询 Candidate（Gateway GET 用）。
 * Gateway Token 绑定 invocationId，必须同时匹配 candidate 的 invocationId。
 */
export async function getMemoryCandidateByIdAndInvocation(
  tenantId: string,
  candidateId: string,
  invocationId: string,
): Promise<MemoryCandidate | null> {
  const [row] = await db
    .select()
    .from(memoryCandidate)
    .where(
      and(
        eq(memoryCandidate.tenantId, tenantId),
        eq(memoryCandidate.id, candidateId),
        eq(memoryCandidate.invocationId, invocationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 创建 MemoryCandidate（不含 Entry/Source；调用方负责同事务关联）。 */
export async function insertMemoryCandidate(params: {
  tenantId: string;
  invocationId: string;
  sourceThreadId?: string | null;
  sourceTurnId?: string | null;
  sourceItemId?: string | null;
  sourceJobId?: string | null;
  sourceArtifactId?: string | null;
  sourceExtractionRunId?: string | null;
  proposedScopeType: MemoryScopeType;
  proposedScopeRef?: string | null;
  memoryType: string;
  contentRef?: string | null;
  contentRedacted?: string | null;
  contentHash: string;
  candidateKey: string;
  sensitivityClass: SensitivityClass;
  candidateState: CandidateState;
  decisionReasonCodesJson?: string[] | null;
  resolvedMemoryEntryId?: string | null;
  /** 来源事实自身的 hash（平台回读来源后校验，不信任 Runtime）。 */
  sourceHash: string;
  /** 提交理由码（USER_EXPLICIT/REPEATED_PREFERENCE/PROJECT_FACT/TASK_DECISION 等）。 */
  rationaleCode: string;
  tx?: DbOrTx;
}): Promise<MemoryCandidate> {
  const id = randomUUID();
  const now = new Date();
  const client = params.tx ?? db;

  // rejected 时销毁正文（不存储敏感内容）
  const contentRedacted =
    params.candidateState === "rejected" ? null : (params.contentRedacted ?? null);

  await client.insert(memoryCandidate).values({
    id,
    tenantId: params.tenantId,
    invocationId: params.invocationId,
    sourceThreadId: params.sourceThreadId ?? null,
    sourceTurnId: params.sourceTurnId ?? null,
    sourceItemId: params.sourceItemId ?? null,
    sourceJobId: params.sourceJobId ?? null,
    sourceArtifactId: params.sourceArtifactId ?? null,
    sourceExtractionRunId: params.sourceExtractionRunId ?? null,
    proposedScopeType: params.proposedScopeType,
    proposedScopeRef: params.proposedScopeRef ?? null,
    memoryType: params.memoryType,
    contentRef: params.candidateState === "rejected" ? null : (params.contentRef ?? null),
    contentRedacted,
    contentHash: params.contentHash,
    candidateKey: params.candidateKey,
    sensitivityClass: params.sensitivityClass,
    candidateState: params.candidateState,
    decisionReasonCodesJson: params.decisionReasonCodesJson ?? null,
    resolvedMemoryEntryId: params.resolvedMemoryEntryId ?? null,
    sourceHash: params.sourceHash,
    rationaleCode: params.rationaleCode,
    proposedAt: now,
    resolvedAt:
      params.candidateState === "accepted" ||
      params.candidateState === "rejected" ||
      params.candidateState === "needs_review"
        ? now
        : null,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await client
    .select()
    .from(memoryCandidate)
    .where(eq(memoryCandidate.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`insertMemoryCandidate: 行未找到（id=${id}）`);
  }
  return row;
}

/**
 * 创建 MemoryCandidate + MemoryEntry + MemorySource（accepted 路径，同事务）。
 *
 * 事务内：
 * 1. INSERT memory_candidate（state=accepted, resolvedMemoryEntryId=entry.id）。
 * 2. INSERT memory_entry（state=active）。
 * 3. INSERT memory_source（关联 entry 与 candidate）。
 *
 * 调用方负责幂等记录写入（completeRecord/failRecord）。
 */
export async function createMemoryCandidateWithEntry(params: {
  tenantId: string;
  invocationId: string;
  sourceThreadId?: string | null;
  sourceTurnId?: string | null;
  sourceItemId?: string | null;
  sourceJobId?: string | null;
  sourceArtifactId?: string | null;
  /** 来源提取批次（自动提取路径）。 */
  sourceExtractionRunId?: string | null;
  proposedScopeType: MemoryScopeType;
  proposedScopeRef?: string | null;
  memoryType: string;
  /** 记忆分类（受控值；缺省 project）。决定 TTL 与检索过滤。 */
  memoryCategory?: string | null;
  contentRef?: string | null;
  contentRedacted?: string | null;
  contentHash: string;
  candidateKey: string;
  sensitivityClass: SensitivityClass;
  decisionReasonCodesJson?: string[] | null;
  /** 来源事实自身的 hash（平台回读来源后校验，不信任 Runtime）。 */
  sourceHash: string;
  /** 提交理由码（USER_EXPLICIT/REPEATED_PREFERENCE/PROJECT_FACT/TASK_DECISION 等）。 */
  rationaleCode: string;
  tx?: DbOrTx;
}): Promise<{ candidate: MemoryCandidate; entry: MemoryEntry; source: MemorySource }> {
  const client = params.tx ?? db;
  const now = new Date();
  const { sourceType, sourceId } = deriveSourceFromCandidate({
    sourceItemId: params.sourceItemId,
    sourceJobId: params.sourceJobId,
    sourceArtifactId: params.sourceArtifactId,
    sourceExtractionRunId: params.sourceExtractionRunId,
  });

  // 1. 创建 MemoryEntry（计算 entryKey 用于规范化去重）
  const entryId = randomUUID();
  const entryKey = computeMemoryEntryKey({
    tenantId: params.tenantId,
    scopeType: params.proposedScopeType,
    scopeRef: params.proposedScopeRef ?? null,
    memoryType: params.memoryType,
    contentHash: params.contentHash,
  });
  await client.insert(memoryEntry).values({
    id: entryId,
    tenantId: params.tenantId,
    entryKey,
    scopeType: params.proposedScopeType,
    scopeRef: params.proposedScopeRef ?? null,
    memoryType: params.memoryType,
    memoryCategory: (params.memoryCategory ?? "project") as MemoryCategory,
    contentRef: params.contentRef ?? null,
    contentRedacted: params.contentRedacted ?? null,
    contentHash: params.contentHash,
    sensitivityClass: params.sensitivityClass,
    memoryState: "active",
    validFrom: now,
    // TTL：按分类取默认策略（feedback/decision 有时效；user/project/reference 不过期）
    expiresAt: resolveMemoryTtl(params.memoryCategory ?? "project", now),
    createdAt: now,
    updatedAt: now,
  });

  // 2. 创建 MemoryCandidate（state=accepted，关联 entry）
  const candidate = await insertMemoryCandidate({
    tenantId: params.tenantId,
    invocationId: params.invocationId,
    sourceThreadId: params.sourceThreadId,
    sourceTurnId: params.sourceTurnId,
    sourceItemId: params.sourceItemId,
    sourceJobId: params.sourceJobId,
    sourceArtifactId: params.sourceArtifactId,
    proposedScopeType: params.proposedScopeType,
    proposedScopeRef: params.proposedScopeRef,
    memoryType: params.memoryType,
    contentRef: params.contentRef,
    contentRedacted: params.contentRedacted,
    contentHash: params.contentHash,
    candidateKey: params.candidateKey,
    sensitivityClass: params.sensitivityClass,
    candidateState: "accepted",
    decisionReasonCodesJson: params.decisionReasonCodesJson ?? null,
    resolvedMemoryEntryId: entryId,
    sourceExtractionRunId: params.sourceExtractionRunId,
    sourceHash: params.sourceHash,
    rationaleCode: params.rationaleCode,
    tx: client,
  });

  // 3. 创建 MemorySource（关联 entry 与 candidate）
  const sourceId2 = randomUUID();
  await client.insert(memorySource).values({
    id: sourceId2,
    memoryEntryId: entryId,
    memoryCandidateId: candidate.id,
    sourceType,
    sourceId,
    sourceHash: params.contentHash,
    createdAt: now,
  });

  const [entry] = await client
    .select()
    .from(memoryEntry)
    .where(eq(memoryEntry.id, entryId))
    .limit(1);
  if (!entry) {
    throw new Error(`createMemoryCandidateWithEntry: entry 行未找到（id=${entryId}）`);
  }

  const [source] = await client
    .select()
    .from(memorySource)
    .where(eq(memorySource.id, sourceId2))
    .limit(1);
  if (!source) {
    throw new Error(`createMemoryCandidateWithEntry: source 行未找到（id=${sourceId2}）`);
  }

  return { candidate, entry, source };
}

// ─── 仓储：MemoryEntry ────────────────────────────────────

/** 按 id 查询 MemoryEntry（跨租户隔离）。不存在返回 null。 */
export async function getMemoryEntryById(
  tenantId: string,
  entryId: string,
): Promise<MemoryEntry | null> {
  const [row] = await db
    .select()
    .from(memoryEntry)
    .where(and(eq(memoryEntry.tenantId, tenantId), eq(memoryEntry.id, entryId)))
    .limit(1);
  return row ?? null;
}

// ─── 仓储：管理员复核 ──────────────────────────────────────

/**
 * 管理员复核 MemoryCandidate（needs_review → accepted/rejected）。
 *
 * 流程（同事务）：
 * 1. SELECT candidate FOR UPDATE（锁行，防并发复核）。
 * 2. 校验 candidate 当前状态为 needs_review（否则 MEMORY_CANDIDATE_ALREADY_RESOLVED）。
 * 3. accept：
 * - 创建 MemoryEntry + MemorySource（scope 可由管理员收窄）。
 * - 更新 candidate: state=accepted, resolvedMemoryEntryId, resolvedAt。
 * 4. reject：
 * - 更新 candidate: state=rejected, contentRedacted=null（销毁正文）, resolvedAt。
 *
 * @throws Error candidate 不存在 / 非 needs_review 状态
 */
export async function resolveMemoryCandidate(params: {
  tenantId: string;
  candidateId: string;
  decision: "accept" | "reject";
  /** accept 时可收窄 scope（organization → workspace/agent；workspace → agent）；null 表示使用 proposed scope。 */
  resolvedScopeType?: MemoryScopeType | null;
  resolvedScopeRef?: string | null;
  reasonCodes?: string[] | null;
  reviewerNotes?: string | null;
}): Promise<{
  candidate: MemoryCandidate;
  entry?: MemoryEntry;
  source?: MemorySource;
}> {
  return db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE（锁行）
    const [locked] = await tx
      .select()
      .from(memoryCandidate)
      .where(
        and(
          eq(memoryCandidate.tenantId, params.tenantId),
          eq(memoryCandidate.id, params.candidateId),
        ),
      )
      .for("update")
      .limit(1);

    if (!locked) {
      throw new Error(`resolveMemoryCandidate: candidate 不存在（id=${params.candidateId}）`);
    }

    // 2. 校验状态
    if (locked.candidateState !== "needs_review") {
      throw new MemoryCandidateAlreadyResolvedError(locked.id, locked.candidateState);
    }

    const now = new Date();
    const reasonCodes = params.reasonCodes ?? null;

    if (params.decision === "reject") {
      // 3b. reject：销毁正文，更新状态
      await tx
        .update(memoryCandidate)
        .set({
          candidateState: "rejected",
          decisionReasonCodesJson: reasonCodes,
          contentRedacted: null,
          contentRef: null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(memoryCandidate.id, locked.id));

      const [updated] = await tx
        .select()
        .from(memoryCandidate)
        .where(eq(memoryCandidate.id, locked.id))
        .limit(1);

      if (!updated) {
        throw new Error(`resolveMemoryCandidate: reject 后行未找到（id=${locked.id}）`);
      }
      return { candidate: updated };
    }

    // 3a. accept：创建 Entry + Source，更新 candidate
    const scopeType = params.resolvedScopeType ?? locked.proposedScopeType;
    const scopeRef = params.resolvedScopeRef ?? locked.proposedScopeRef;

    const { sourceType, sourceId } = deriveSourceFromCandidate({
      sourceItemId: locked.sourceItemId,
      sourceJobId: locked.sourceJobId,
      sourceArtifactId: locked.sourceArtifactId,
    });

    const entryId = randomUUID();
    const entryKey = computeMemoryEntryKey({
      tenantId: params.tenantId,
      scopeType,
      scopeRef: scopeRef ?? null,
      memoryType: locked.memoryType,
      contentHash: locked.contentHash,
    });
    await tx.insert(memoryEntry).values({
      id: entryId,
      tenantId: params.tenantId,
      entryKey,
      scopeType,
      scopeRef: scopeRef ?? null,
      memoryType: locked.memoryType,
      memoryCategory: categoryFromMemoryType(locked.memoryType),
      contentRef: locked.contentRef,
      contentRedacted: locked.contentRedacted,
      contentHash: locked.contentHash,
      sensitivityClass: locked.sensitivityClass,
      memoryState: "active",
      validFrom: now,
      expiresAt: resolveMemoryTtl(categoryFromMemoryType(locked.memoryType), now),
      createdAt: now,
      updatedAt: now,
    });

    const sourceId2 = randomUUID();
    await tx.insert(memorySource).values({
      id: sourceId2,
      memoryEntryId: entryId,
      memoryCandidateId: locked.id,
      sourceType,
      sourceId,
      sourceHash: locked.contentHash,
      createdAt: now,
    });

    await tx
      .update(memoryCandidate)
      .set({
        candidateState: "accepted",
        decisionReasonCodesJson: reasonCodes,
        resolvedMemoryEntryId: entryId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(memoryCandidate.id, locked.id));

    const [updatedCandidate] = await tx
      .select()
      .from(memoryCandidate)
      .where(eq(memoryCandidate.id, locked.id))
      .limit(1);

    const [updatedEntry] = await tx
      .select()
      .from(memoryEntry)
      .where(eq(memoryEntry.id, entryId))
      .limit(1);

    const [updatedSource] = await tx
      .select()
      .from(memorySource)
      .where(eq(memorySource.id, sourceId2))
      .limit(1);

    if (!updatedCandidate || !updatedEntry || !updatedSource) {
      throw new Error(`resolveMemoryCandidate: accept 后行未找到（candidate=${locked.id}）`);
    }

    return { candidate: updatedCandidate, entry: updatedEntry, source: updatedSource };
  });
}

/** Candidate 已被复核（非 needs_review 状态）。 */
export class MemoryCandidateAlreadyResolvedError extends Error {
  constructor(
    public readonly candidateId: string,
    public readonly currentState: CandidateState,
  ) {
    super(`MemoryCandidate 已被复核（id=${candidateId}, currentState=${currentState}）`);
  }
}

// ─── 作用域校验 ────────────────────────────────────────────

/**
 * 校验管理员复核时的 scope 收窄方向是否合法。
 *
 * 规则（§10）：管理员只能缩小 scope，不能扩大。
 * - organization → workspace / agent / user_preference / thread（收窄）
 * - workspace → agent / thread（收窄）
 * - agent → thread（收窄）
 * - user_preference → 不允许收窄（已是用户级）
 * - thread → 不允许收窄（最小范围）
 *
 * 同 scope type 视为合法（不收窄，但允许）。
 *
 * @returns true 表示收窄方向合法
 */
export function isScopeNarrowingValid(
  proposed: MemoryScopeType,
  resolved: MemoryScopeType,
): boolean {
  if (proposed === resolved) return true;

  const scopeRank: Record<MemoryScopeType, number> = {
    organization: 5,
    workspace: 4,
    agent: 3,
    user_preference: 2,
    thread: 1,
  };

  // 收窄 = resolved rank < proposed rank
  return scopeRank[resolved] < scopeRank[proposed];
}

/**
 * 校验 scope type 是否在 memory.review action 允许的 resource scope types 内。
 *
 * memory.review 允许: workspace / agent / organization（见 action-codes.ts）。
 * thread / user_preference 不需要管理员复核（Policy 自动接受或拒绝）。
 */
export function isReviewableScopeType(scopeType: MemoryScopeType): boolean {
  return scopeType === "workspace" || scopeType === "agent" || scopeType === "organization";
}

// ─── 仓储：MemoryEntry 检索（S07-C04 分作用域检索） ────────

/**
 * 按作用域列表查询 active MemoryEntry（§9 挂载与检索）。
 *
 * 每个 Agent/Thread 只挂载当前任务允许的 Memory Store。本函数接收多个 scope 元组，
 * 返回所有匹配的 active 状态 MemoryEntry，供 MemoryResolver 转换为 Fragment。
 *
 * 不变量：
 * - 跨租户隔离（tenantId 必须匹配）。
 * - 只返回 memoryState=active 的 Entry（archived/superseded 不参与检索）。
 * - 未过期的 Entry（expiresAt 为 null 或 > now）。
 * - 结果按 updatedAt 降序（最近更新的优先）。
 */
export async function listActiveMemoryEntriesByScopes(
  tenantId: string,
  scopes: ReadonlyArray<{
    scopeType: MemoryScopeType;
    /** scopeRef 为 null 表示该 scope 类型不绑定具体 ref（如 user_preference/organization）。 */
    scopeRef?: string | null;
  }>,
  options?: {
    limit?: number;
    /** 需要排除的条目 id（capm 语义召回已覆盖的，避免重复）。 */
    excludeIds?: ReadonlyArray<string>;
    /** 只取这些分类（缺省不限）。 */
    categories?: ReadonlyArray<string>;
  },
): Promise<MemoryEntry[]> {
  if (scopes.length === 0) return [];

  const limit = options?.limit ?? 20;
  const now = new Date();
  const conditions = scopes.map((s) => {
    const base = and(
      eq(memoryEntry.tenantId, tenantId),
      eq(memoryEntry.scopeType, s.scopeType),
      eq(memoryEntry.memoryState, "active"),
    );
    if (base === null) {
      // 理论不可达：and() 至少有 3 个条件
      throw new Error("listActiveMemoryEntriesByScopes: base 条件构造失败");
    }
    if (s.scopeRef !== undefined && s.scopeRef !== null) {
      return and(base, eq(memoryEntry.scopeRef, s.scopeRef));
    }
    // scopeRef 为 null 的 scope（user_preference/organization）：scopeRef IS NULL
    return and(base, sql`${memoryEntry.scopeRef} IS NULL`);
  });

  const first = conditions[0];
  if (first === undefined) {
    // 理论不可达：上方已校验 scopes.length > 0
    throw new Error("listActiveMemoryEntriesByScopes: conditions 为空");
  }
  const orCondition = conditions.length === 1 ? first : sql.join(conditions, sql` OR `);

  // 时效：未过期；且未被取代（invalidAt 为空）——已失效的历史条目退出检索
  const extra: ReturnType<typeof sql>[] = [
    sql`(${memoryEntry.expiresAt} IS NULL OR ${memoryEntry.expiresAt} > ${now})`,
    sql`${memoryEntry.invalidAt} IS NULL`,
  ];
  if (options?.excludeIds && options.excludeIds.length > 0) {
    extra.push(sql`${memoryEntry.id} NOT IN ${options.excludeIds}`);
  }
  if (options?.categories && options.categories.length > 0) {
    extra.push(sql`${memoryEntry.memoryCategory} IN ${options.categories}`);
  }

  const rows = await db
    .select()
    .from(memoryEntry)
    .where(and(orCondition, ...extra))
    .orderBy(sql`${memoryEntry.updatedAt} DESC`)
    .limit(limit);
  return rows;
}

/**
 * 按 id 批量取 active 记忆（供 capm 语义召回结果回填结构化字段）。
 *
 * 只返回仍 active 的条目（capm 命中但本地已归档的会被过滤）。
 */
export async function listActiveMemoryEntriesByIds(
  tenantId: string,
  ids: ReadonlyArray<string>,
): Promise<MemoryEntry[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(memoryEntry)
    .where(
      and(
        eq(memoryEntry.tenantId, tenantId),
        eq(memoryEntry.memoryState, "active"),
        sql`${memoryEntry.id} IN ${ids}`,
      ),
    );
}

/**
 * 记录一次检索命中（retrievalCount++ / lastRetrievedAt=now）。
 *
 * 对标 Mem0 retrieval_count，用于晋升/降权。批量、失败不抛（统计非关键）。
 */
export async function recordMemoryRetrieval(
  tenantId: string,
  ids: ReadonlyArray<string>,
): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date();
  await db
    .update(memoryEntry)
    .set({ retrievalCount: sql`${memoryEntry.retrievalCount} + 1`, lastRetrievedAt: now })
    .where(and(eq(memoryEntry.tenantId, tenantId), sql`${memoryEntry.id} IN ${ids}`))
    .catch(() => undefined);
}

// ─── 仓储：用户控制（S07-C04 §11 用户控制） ────────────────

/**
 * 按 (tenantId, scopeType, scopeRef) 列出 MemoryEntry（含所有状态）。
 *
 * 用户查看自己的记忆时使用：
 * - user_preference scope：按 tenantId 过滤（用户级，跨 Agent）。
 * - thread scope：按 tenantId + scopeRef=threadId 过滤。
 * - workspace scope：按 tenantId + scopeRef=workspaceId 过滤。
 * - agent scope：按 tenantId + scopeRef=agentId 过滤。
 * - organization scope：按 tenantId 过滤（scopeRef=null）。
 *
 * @returns MemoryEntry 列表（按 updatedAt 降序）。
 */
export async function listMemoryEntriesByScope(
  tenantId: string,
  scopeType: MemoryScopeType,
  scopeRef?: string | null,
  options?: { limit?: number; includeArchived?: boolean },
): Promise<MemoryEntry[]> {
  const limit = options?.limit ?? 50;
  const conditions = [eq(memoryEntry.tenantId, tenantId), eq(memoryEntry.scopeType, scopeType)];
  if (!options?.includeArchived) {
    conditions.push(eq(memoryEntry.memoryState, "active"));
  }
  if (scopeRef !== undefined && scopeRef !== null) {
    conditions.push(eq(memoryEntry.scopeRef, scopeRef));
  } else {
    conditions.push(sql`${memoryEntry.scopeRef} IS NULL`);
  }

  const rows = await db
    .select()
    .from(memoryEntry)
    .where(and(...conditions))
    .orderBy(sql`${memoryEntry.updatedAt} DESC`)
    .limit(limit);
  return rows;
}

/**
 * 归档 MemoryEntry（memoryState: active → archived）。
 *
 * 用户删除记忆时不物理删除，而是归档（保留历史，不再参与检索）。
 * 归档后 MemoryResolver 不再返回该 Entry。
 *
 * @returns 归档后的 MemoryEntry；不存在返回 null。
 */
export async function archiveMemoryEntry(
  tenantId: string,
  entryId: string,
): Promise<MemoryEntry | null> {
  await db
    .update(memoryEntry)
    .set({
      memoryState: "archived",
      updatedAt: new Date(),
    })
    .where(and(eq(memoryEntry.tenantId, tenantId), eq(memoryEntry.id, entryId)));

  // MySQL 不支持 .returning()，需重新查询
  return getMemoryEntryById(tenantId, entryId);
}

/**
 * 更新 MemoryEntry 内容和/或过期时间（用户修改记忆）。
 *
 * 用户明确修改优先于自动提取（§11）。更新后 contentHash 重新计算，
 * memoryState 重置为 active（从 archived 恢复），updatedAt 刷新。
 *
 * @returns 更新后的 MemoryEntry；不存在返回 null。
 */
export async function updateMemoryEntry(
  tenantId: string,
  entryId: string,
  params: {
    contentRedacted?: string;
    contentRef?: string;
    expiresAt?: Date | null;
  },
): Promise<MemoryEntry | null> {
  // 先查询现有 Entry（contentRedacted 变更时需要 scopeType/scopeRef/memoryType 重算 entryKey）
  const existingEntry = await getMemoryEntryById(tenantId, entryId);
  if (!existingEntry) return null;

  const updates: Partial<MemoryEntry> = { updatedAt: new Date() };
  if (params.contentRedacted !== undefined) {
    updates.contentRedacted = params.contentRedacted;
    updates.contentHash = computeMemoryContentHash(params.contentRedacted);
    // entryKey 依赖 contentHash，内容变更后需重算以保持去重一致性
    updates.entryKey = computeMemoryEntryKey({
      tenantId,
      scopeType: existingEntry.scopeType,
      scopeRef: existingEntry.scopeRef,
      memoryType: existingEntry.memoryType,
      contentHash: updates.contentHash,
    });
  }
  if (params.contentRef !== undefined) {
    updates.contentRef = params.contentRef;
  }
  if (params.expiresAt !== undefined) {
    updates.expiresAt = params.expiresAt;
  }
  // 内容更新后重置为 active（从 archived 恢复）
  if (params.contentRedacted !== undefined || params.contentRef !== undefined) {
    updates.memoryState = "active";
  }

  await db
    .update(memoryEntry)
    .set(updates)
    .where(and(eq(memoryEntry.tenantId, tenantId), eq(memoryEntry.id, entryId)));

  // MySQL 不支持 .returning()，需重新查询
  return getMemoryEntryById(tenantId, entryId);
}

/**
 * 计算 MemoryEntry 的规范化去重键 entryKey。
 *
 * entryKey = sha256(tenantId|scopeType|scopeRef-or-empty|memoryType|contentHash)。
 * UNIQUE(entryKey) 保证同租户同 scope 同类型同内容不重复落库。
 */
export function computeMemoryEntryKey(params: {
  tenantId: string;
  scopeType: MemoryScopeType;
  scopeRef?: string | null;
  memoryType: string;
  contentHash: string;
}): string {
  const parts = [
    params.tenantId,
    params.scopeType,
    params.scopeRef ?? "",
    params.memoryType,
    params.contentHash,
  ];
  const raw = parts.join("|");
  return `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

// ─── 演化：双时态取代（对标 Graphiti）────────────────────────

/**
 * 双时态取代：旧记忆不物理删，标记失效并由新记忆接管。
 *
 * 对标 Graphiti 的 temporal edge invalidation——矛盾信息不删除，而是：
 * - 旧条目：memoryState=superseded + invalidAt（事件时间：现实世界失效）+ expiredAt（系统时间：系统知悉）；
 * - 新条目：supersedesEntryId 指向旧条目；
 * - 旧条目：supersededByEntryId 指向新条目。
 *
 * 时间语义：
 * - `invalidAt` 取新条目 validFrom（事实从新条目生效之时起不再为真）；
 *   调用方可显式传入（如新事实明确声明了旧事实的结束时间）。
 * - `expiredAt` 恒为 now（系统此刻标记失效）——与 invalidAt 是两回事。
 *
 * @returns 更新后的旧条目；任一条目不存在返回 null。
 */
export async function supersedeMemoryEntry(params: {
  tenantId: string;
  oldEntryId: string;
  newEntryId: string;
  /** 事件时间（现实世界失效时刻）；缺省取新条目 validFrom。 */
  invalidAt?: Date | null;
  tx?: DbOrTx;
}): Promise<MemoryEntry | null> {
  // 已有事务句柄则复用，否则自开（避免嵌套事务）
  const run = async (tx: Tx): Promise<MemoryEntry | null> => {
    const now = new Date();
    const [oldEntry] = await tx
      .select()
      .from(memoryEntry)
      .where(and(eq(memoryEntry.tenantId, params.tenantId), eq(memoryEntry.id, params.oldEntryId)))
      .for("update")
      .limit(1);
    const [newEntry] = await tx
      .select()
      .from(memoryEntry)
      .where(and(eq(memoryEntry.tenantId, params.tenantId), eq(memoryEntry.id, params.newEntryId)))
      .limit(1);
    if (!oldEntry || !newEntry) return null;

    // 事件时间：事实在现实世界失效的时刻（缺省 = 新条目开始为真之时）
    const invalidAt = params.invalidAt ?? newEntry.validFrom;

    // 旧条目：标记取代（不物理删）
    await tx
      .update(memoryEntry)
      .set({
        memoryState: "superseded",
        invalidAt,
        expiredAt: now,
        supersededByEntryId: params.newEntryId,
        updatedAt: now,
      })
      .where(eq(memoryEntry.id, oldEntry.id));

    // 新条目：记录它取代了谁
    await tx
      .update(memoryEntry)
      .set({ supersedesEntryId: params.oldEntryId, updatedAt: now })
      .where(eq(memoryEntry.id, newEntry.id));

    const [updated] = await tx
      .select()
      .from(memoryEntry)
      .where(eq(memoryEntry.id, oldEntry.id))
      .limit(1);
    return updated ?? null;
  };

  if (params.tx) return run(params.tx as Tx);
  return db.transaction(run);
}

/**
 * 事后撤销：把一条被取代 / 归档的记忆恢复为 active（D5「事后可撤销」）。
 *
 * 对标 Graphiti 的反向失效——发现自动沉淀或演化错了，能撤回而不必删。
 *
 * 行为：
 * - archived → active（清 expiredAt）。
 * - superseded → active，并**对称地**把取代它的那条重新标记为 superseded
 *   （撤销取代，避免两条同时 active 出现矛盾）；同时断开互指。
 *
 * @returns 恢复后的条目；不存在返回 null。
 */
export async function restoreMemoryEntry(
  tenantId: string,
  entryId: string,
): Promise<MemoryEntry | null> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(memoryEntry)
      .where(and(eq(memoryEntry.tenantId, tenantId), eq(memoryEntry.id, entryId)))
      .for("update")
      .limit(1);
    if (!entry) return null;

    // 若被某条取代：对称失效取代者，避免矛盾并存
    if (entry.supersededByEntryId) {
      await tx
        .update(memoryEntry)
        .set({
          memoryState: "superseded",
          invalidAt: now,
          expiredAt: now,
          updatedAt: now,
        })
        .where(eq(memoryEntry.id, entry.supersededByEntryId));
    }

    await tx
      .update(memoryEntry)
      .set({
        memoryState: "active",
        invalidAt: null,
        expiredAt: null,
        supersededByEntryId: null,
        updatedAt: now,
      })
      .where(eq(memoryEntry.id, entry.id));

    const [updated] = await tx
      .select()
      .from(memoryEntry)
      .where(eq(memoryEntry.id, entry.id))
      .limit(1);
    return updated ?? null;
  });
}

/**
 * 沿演化链追溯某条记忆的完整历史（从最旧到最新）。
 *
 * 反向走 supersedesEntryId（本条取代了谁），再正向补出后续取代它的条目。
 */
export async function getMemoryEvolutionChain(
  tenantId: string,
  entryId: string,
): Promise<MemoryEntry[]> {
  const chain: MemoryEntry[] = [];
  const seen = new Set<string>();

  // 反向：一直向上找"被取代者"
  let cursorId: string | null = entryId;
  while (cursorId && !seen.has(cursorId)) {
    seen.add(cursorId);
    const [row] = await db
      .select()
      .from(memoryEntry)
      .where(and(eq(memoryEntry.tenantId, tenantId), eq(memoryEntry.id, cursorId)))
      .limit(1);
    if (!row) break;
    chain.unshift(row);
    cursorId = row.supersedesEntryId;
  }

  // 正向：从起点一直向下找"取代者"
  let forwardId: string | null = chain.length > 0 ? (chain[chain.length - 1]?.id ?? null) : entryId;
  while (forwardId) {
    const [row] = await db
      .select()
      .from(memoryEntry)
      .where(and(eq(memoryEntry.tenantId, tenantId), eq(memoryEntry.id, forwardId)))
      .limit(1);
    if (!row?.supersededByEntryId || seen.has(row.supersededByEntryId)) break;
    seen.add(row.supersededByEntryId);
    const [next] = await db
      .select()
      .from(memoryEntry)
      .where(and(eq(memoryEntry.tenantId, tenantId), eq(memoryEntry.id, row.supersededByEntryId)))
      .limit(1);
    if (!next) break;
    chain.push(next);
    forwardId = next.id;
  }

  return chain;
}

// ─── 遗忘：TTL 到期归档（对标 Mem0 整合遗忘）────────────────

/**
 * 归档一条到期记忆（memoryState: active → archived）。
 *
 * 到期不物理删除：保留历史，仅退出检索。与 archiveMemoryEntry 的区别是本函数
 * 面向「系统按 TTL 自动归档」，archiveMemoryEntry 面向「用户主动删除」。
 */
export async function expireMemoryEntry(
  tenantId: string,
  entryId: string,
): Promise<MemoryEntry | null> {
  const now = new Date();
  await db
    .update(memoryEntry)
    .set({ memoryState: "archived", expiredAt: now, updatedAt: now })
    .where(and(eq(memoryEntry.tenantId, tenantId), eq(memoryEntry.id, entryId)));
  return getMemoryEntryById(tenantId, entryId);
}

/**
 * 批量归档已到期记忆（TTL 扫描；由定时任务调用）。
 *
 * 只归档 active 且 expiresAt 已过期的条目；返回归档条数。
 * 幂等：重复执行不会重复归档（已 archived 的不再匹配）。
 */
export async function archiveExpiredMemoryEntries(params?: {
  tenantId?: string;
  limit?: number;
}): Promise<number> {
  const now = new Date();
  const limit = params?.limit ?? 500;
  const conditions = [
    eq(memoryEntry.memoryState, "active"),
    sql`${memoryEntry.expiresAt} IS NOT NULL AND ${memoryEntry.expiresAt} <= ${now}`,
  ];
  if (params?.tenantId) conditions.push(eq(memoryEntry.tenantId, params.tenantId));

  // 先查出待归档 id（MySQL 不支持 UPDATE ... LIMIT + JOIN 的通用写法）
  const rows = await db
    .select({ id: memoryEntry.id })
    .from(memoryEntry)
    .where(and(...conditions))
    .limit(limit);
  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r.id);
  await db
    .update(memoryEntry)
    .set({ memoryState: "archived", expiredAt: now, updatedAt: now })
    .where(sql`${memoryEntry.id} IN ${ids}`);
  return ids.length;
}

/**
 * 由旧 memoryType（自由字符串）推导记忆分类（受控值）。
 *
 * 兼容历史数据：无法识别时归 project（长期有效，不过期）。
 */
export function categoryFromMemoryType(memoryType: string): MemoryCategory {
  const map: Record<string, MemoryCategory> = {
    preference: "user",
    user_preference: "user",
    profile: "user",
    feedback: "feedback",
    correction: "feedback",
    skill_usage: "feedback",
    decision: "decision",
    task_decision: "decision",
    project_fact: "project",
    project: "project",
    reference: "reference",
  };
  return map[memoryType] ?? "project";
}

/**
 * 记忆 TTL 策略（按分类，对标 Mem0 整合遗忘）。
 *
 * - feedback / skill_usage：短（30 天）——反馈时效性强。
 * - decision：中（180 天）——技术决策有效期较长。
 * - user / project / reference：不过期（null）——稳定偏好与在办工作长期有效。
 *
 * @param category 记忆分类
 * @returns 有效的过期时刻；null 表示不过期。
 */
export function resolveMemoryTtl(category: string, from: Date = new Date()): Date | null {
  const DAY = 24 * 60 * 60 * 1000;
  const ttlDaysByCategory: Record<string, number | null> = {
    feedback: 30,
    decision: 180,
    user: null,
    project: null,
    reference: null,
    // 旧 memoryType 兼容（未收敛分类的历史数据）
    skill_usage: 30,
  };
  const days = ttlDaysByCategory[category];
  if (days === undefined || days === null) return null;
  return new Date(from.getTime() + days * DAY);
}
