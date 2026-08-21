/**
 * Skill 仓储（阶段 6 S06-C01）。
 *
 * 事实源：lib/persistence/schema/skill.ts、阶段 6 Skill/Capability 模型。
 *
 * 职责：
 * - createSkill：创建稳定 Skill 身份（租户内 skillKey 唯一 + 正则校验）。
 * - getSkillById / getSkillByKey：跨租户隔离查询。
 * - listSkills：分页 + lifecycle / visibility 过滤。
 * - updateSkill：更新元数据（乐观锁 + lifecycle 状态机校验）。
 * - createSkillVersion：创建不可变 SkillVersion（versionNo 单调递增 + contentHash 校验）。
 * - getSkillVersionById / listSkillVersions / getCurrentSkillVersion：版本查询。
 * - publishSkillVersion：draft → published + 旧 published → withdrawn + Skill.currentVersionId 更新（事务）。
 *
 * 关键约束：
 * - skillKey 正则：`^[a-z0-9]+(-[a-z0-9]+)*$`，1-64 字符。
 * - lifecycleState 状态机：draft → enabled → disabled → retired（retired 终态不可恢复）。
 * - revisionState 状态机：draft → published → withdrawn（withdrawn 终态）。
 * - contentHash 必须以 `sha256:` 开头。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { createHash, randomUUID } from "node:crypto";
import { isValidContentHash } from "@/lib/capability/content-cache";
import { listActiveSyncLocalSkillIds } from "@/lib/capability/skill-sync-queries";
import { db } from "@/lib/db/client";
import {
  type Skill,
  type SkillLifecycleState,
  type SkillRevisionState,
  type SkillSourceType,
  type SkillVersion,
  type SkillVisibilityScope,
  skillTable,
  skillVersionTable,
} from "@/lib/persistence/schema/skill";
import { and, asc, desc, eq, gt, inArray, isNull, max, or } from "drizzle-orm";

// ─── 常量 ──────────────────────────────────────────────────

/** skillKey 正则：1-64 字符，`^[a-z0-9]+(-[a-z0-9]+)*$`。 */
export const SKILL_KEY_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_KEY_MAX_LENGTH = 64;

/** lifecycle 状态机：合法迁移映射。 */
const LIFECYCLE_TRANSITIONS: Record<SkillLifecycleState, readonly SkillLifecycleState[]> = {
  draft: ["enabled", "disabled", "retired"],
  enabled: ["disabled", "retired"],
  disabled: ["enabled", "retired"],
  retired: [], // 终态
};

// ─── 错误类 ────────────────────────────────────────────────

/** Skill 校验错误（skillKey 正则 / contentHash 格式 / 参数非法）。 */
export class SkillValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillValidationError";
  }
}

/** Skill 不存在（或跨租户不可见）。 */
export class SkillNotFoundError extends Error {
  constructor(public readonly skillId: string) {
    super(`Skill 不存在或跨租户不可见: ${skillId}`);
    this.name = "SkillNotFoundError";
  }
}

/** SkillVersion 不存在（或跨租户不可见）。 */
export class SkillVersionNotFoundError extends Error {
  constructor(public readonly skillVersionId: string) {
    super(`SkillVersion 不存在或跨租户不可见: ${skillVersionId}`);
    this.name = "SkillVersionNotFoundError";
  }
}

/** SkillVersion 乐观锁/唯一约束冲突（versionNo 并发分配冲突）。 */
export class SkillVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillVersionConflictError";
  }
}

/** Skill lifecycle / revision 状态机错误。 */
export class SkillLifecycleError extends Error {
  constructor(
    public readonly skillId: string,
    public readonly kind: "lifecycle" | "revision",
    public readonly fromState: string,
    public readonly toState: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillLifecycleError";
  }
}

// ─── Skill 仓储 ────────────────────────────────────────────

/** 校验 skillKey 格式（正则 + 长度）。 */
function assertValidSkillKey(skillKey: string): void {
  if (
    typeof skillKey !== "string" ||
    skillKey.length === 0 ||
    skillKey.length > SKILL_KEY_MAX_LENGTH ||
    !SKILL_KEY_REGEX.test(skillKey)
  ) {
    throw new SkillValidationError(
      "invalid_skill_key",
      `skillKey 非法（必须匹配 ${SKILL_KEY_REGEX.source}，1-${SKILL_KEY_MAX_LENGTH} 字符）: ${skillKey}`,
    );
  }
}

/** 校验 contentHash 格式（sha256: 前缀）。 */
function assertValidContentHash(contentHash: string): void {
  if (!isValidContentHash(contentHash)) {
    throw new SkillValidationError(
      "invalid_content_hash",
      `contentHash 必须以 sha256: 开头并跟随 64 hex: ${contentHash}`,
    );
  }
}

/** 校验 visibilityScope / sourceType 在已知枚举内。 */
function assertValidVisibilityScope(scope: string): asserts scope is SkillVisibilityScope {
  if (!["tenant", "internal", "owner"].includes(scope)) {
    throw new SkillValidationError("invalid_visibility_scope", `visibilityScope 非法: ${scope}`);
  }
}

function assertValidSourceType(source: string): asserts source is SkillSourceType {
  if (!["local", "capability_market", "external"].includes(source)) {
    throw new SkillValidationError("invalid_source_type", `sourceType 非法: ${source}`);
  }
}

/** 创建 Skill（事务内校验 skillKey 唯一 + 正则）。 */
export async function createSkill(params: {
  tenantId: string;
  skillKey: string;
  displayName: string;
  description?: string | null;
  ownerUserId: string;
  visibilityScope?: SkillVisibilityScope;
  sourceType?: SkillSourceType;
  createdBy: string;
}): Promise<Skill> {
  assertValidSkillKey(params.skillKey);
  if (!params.displayName || params.displayName.length === 0) {
    throw new SkillValidationError("invalid_display_name", "displayName 不能为空");
  }
  if (!params.ownerUserId) {
    throw new SkillValidationError("invalid_owner", "ownerUserId 不能为空");
  }
  const visibilityScope = params.visibilityScope ?? "tenant";
  assertValidVisibilityScope(visibilityScope);
  const sourceType = params.sourceType ?? "local";
  assertValidSourceType(sourceType);

  // 提前查重，给出更友好的错误（DB UNIQUE 兜底并发竞态）。
  const existing = await getSkillByKey({
    tenantId: params.tenantId,
    skillKey: params.skillKey,
  });
  if (existing) {
    throw new SkillValidationError("skill_key_exists", `skillKey 已存在: ${params.skillKey}`);
  }

  const id = randomUUID();
  try {
    await db.insert(skillTable).values({
      id,
      tenantId: params.tenantId,
      skillKey: params.skillKey,
      displayName: params.displayName,
      description: params.description ?? null,
      ownerUserId: params.ownerUserId,
      lifecycleState: "draft",
      visibilityScope,
      sourceType,
    });
  } catch (err) {
    // 并发竞态下 UNIQUE(tenantId, skillKey) 冲突 → 友好错误。
    if (isDuplicateEntryError(err)) {
      throw new SkillValidationError("skill_key_exists", `skillKey 已存在: ${params.skillKey}`);
    }
    throw err;
  }

  const [row] = await db.select().from(skillTable).where(eq(skillTable.id, id)).limit(1);
  if (!row) {
    throw new Error(`createSkill: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 Skill（跨租户隔离）。不存在返回 null。 */
export async function getSkillById(params: {
  tenantId: string;
  skillId: string;
}): Promise<Skill | null> {
  const [row] = await db
    .select()
    .from(skillTable)
    .where(and(eq(skillTable.tenantId, params.tenantId), eq(skillTable.id, params.skillId)))
    .limit(1);
  return row ?? null;
}

/** 按 skillKey 获取 Skill（跨租户隔离）。不存在返回 null。 */
export async function getSkillByKey(params: {
  tenantId: string;
  skillKey: string;
}): Promise<Skill | null> {
  const [row] = await db
    .select()
    .from(skillTable)
    .where(and(eq(skillTable.tenantId, params.tenantId), eq(skillTable.skillKey, params.skillKey)))
    .limit(1);
  return row ?? null;
}

/** 列出 Skill（分页 + lifecycle / visibility 过滤；不含软删）。 */
export async function listSkills(params: {
  tenantId: string;
  lifecycleStates?: readonly SkillLifecycleState[];
  visibilityScopes?: readonly SkillVisibilityScope[];
  limit?: number;
  cursor?: string | null;
}): Promise<{ items: Skill[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conditions = [eq(skillTable.tenantId, params.tenantId), isNull(skillTable.deletedAt)];
  if (params.lifecycleStates && params.lifecycleStates.length > 0) {
    conditions.push(inArray(skillTable.lifecycleState, [...params.lifecycleStates]));
  }
  if (params.visibilityScopes && params.visibilityScopes.length > 0) {
    conditions.push(inArray(skillTable.visibilityScope, [...params.visibilityScopes]));
  }

  // cursor 为 updatedAt（升序）+ id（升序）的复合编码：`${updatedAtIso}|${id}`。
  // 简化为基于 updatedAt 升序 + id 升序的不透明 cursor。
  // 不透明 cursor：base64url(JSON({updatedAt, id}))。
  // 排序：(updatedAt asc, id asc)。
  // 游标条件：(updatedAt > cursor.updatedAt) OR (updatedAt = cursor.updatedAt AND id > cursor.id)
  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    if (decoded) {
      const cursorDate = new Date(decoded.updatedAt);
      const cursorCondition = or(
        gt(skillTable.updatedAt, cursorDate),
        and(eq(skillTable.updatedAt, cursorDate), gt(skillTable.id, decoded.id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
  }

  const rows = await db
    .select()
    .from(skillTable)
    .where(and(...conditions))
    .orderBy(asc(skillTable.updatedAt), asc(skillTable.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastItem = items[items.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? encodeCursor({
          updatedAt: lastItem.updatedAt.toISOString(),
          id: lastItem.id,
        })
      : null;

  return { items, nextCursor };
}

/** 更新 Skill 元数据（乐观锁 + lifecycle 状态机校验）。 */
export async function updateSkill(params: {
  tenantId: string;
  skillId: string;
  displayName?: string;
  description?: string | null;
  visibilityScope?: SkillVisibilityScope;
  lifecycleState?: SkillLifecycleState;
  expectedVersionNo: number;
}): Promise<Skill> {
  const current = await getSkillById({
    tenantId: params.tenantId,
    skillId: params.skillId,
  });
  if (!current) {
    throw new SkillNotFoundError(params.skillId);
  }

  // lifecycle 状态机校验
  if (params.lifecycleState && params.lifecycleState !== current.lifecycleState) {
    const allowed = LIFECYCLE_TRANSITIONS[current.lifecycleState];
    if (!allowed.includes(params.lifecycleState)) {
      throw new SkillLifecycleError(
        params.skillId,
        "lifecycle",
        current.lifecycleState,
        params.lifecycleState,
        `Skill lifecycle 不允许 ${current.lifecycleState} → ${params.lifecycleState}`,
      );
    }
  }

  // 乐观锁冲突
  if (current.versionNo !== params.expectedVersionNo) {
    throw new SkillVersionConflictError(
      `Skill ${params.skillId} versionNo 不匹配（期望 ${params.expectedVersionNo}, 实际 ${current.versionNo}）`,
    );
  }

  if (params.displayName !== undefined && params.displayName.length === 0) {
    throw new SkillValidationError("invalid_display_name", "displayName 不能为空");
  }
  if (params.visibilityScope !== undefined) {
    assertValidVisibilityScope(params.visibilityScope);
  }

  const updates: Record<string, unknown> = {
    versionNo: current.versionNo + 1,
    updatedAt: new Date(),
  };
  if (params.displayName !== undefined) updates.displayName = params.displayName;
  if (params.description !== undefined) updates.description = params.description;
  if (params.visibilityScope !== undefined) updates.visibilityScope = params.visibilityScope;
  if (params.lifecycleState !== undefined) updates.lifecycleState = params.lifecycleState;

  const result = await db
    .update(skillTable)
    .set(updates)
    .where(
      and(
        eq(skillTable.tenantId, params.tenantId),
        eq(skillTable.id, params.skillId),
        eq(skillTable.versionNo, params.expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) {
    throw new SkillVersionConflictError(
      `Skill ${params.skillId} 乐观锁冲突：update 未命中（期望 versionNo=${params.expectedVersionNo}）`,
    );
  }

  const updated = await getSkillById({
    tenantId: params.tenantId,
    skillId: params.skillId,
  });
  if (!updated) {
    throw new SkillNotFoundError(params.skillId);
  }
  return updated;
}

// ─── SkillVersion 仓储 ─────────────────────────────────────

/** 创建 SkillVersion（事务内分配 versionNo + 校验 Skill lifecycle）。 */
export async function createSkillVersion(params: {
  tenantId: string;
  skillId: string;
  contentRef: string;
  contentHash: string;
  manifestJson?: unknown;
  sourceType?: SkillSourceType;
  sourceRef?: string | null;
  createdBy: string;
}): Promise<SkillVersion> {
  if (!params.contentRef || params.contentRef.length === 0) {
    throw new SkillValidationError("invalid_content_ref", "contentRef 不能为空");
  }
  assertValidContentHash(params.contentHash);
  if (!params.createdBy) {
    throw new SkillValidationError("invalid_created_by", "createdBy 不能为空");
  }
  const sourceType = params.sourceType ?? "local";
  assertValidSourceType(sourceType);

  // 校验 Skill 存在 + 跨租户隔离 + 未 retired
  const skill = await getSkillById({
    tenantId: params.tenantId,
    skillId: params.skillId,
  });
  if (!skill) {
    throw new SkillNotFoundError(params.skillId);
  }
  if (skill.lifecycleState === "retired") {
    throw new SkillLifecycleError(
      params.skillId,
      "lifecycle",
      skill.lifecycleState,
      skill.lifecycleState,
      "Skill 已 retired，不能创建新版本",
    );
  }

  const versionNo = await nextVersionNo(params.skillId);
  const id = randomUUID();
  try {
    await db.insert(skillVersionTable).values({
      id,
      skillId: params.skillId,
      versionNo,
      contentRef: params.contentRef,
      contentHash: params.contentHash,
      manifestJson: params.manifestJson ?? null,
      revisionState: "draft",
      sourceType,
      sourceRef: params.sourceRef ?? null,
      createdBy: params.createdBy,
    });
  } catch (err) {
    if (isDuplicateEntryError(err)) {
      throw new SkillVersionConflictError(
        `SkillVersion 并发冲突：versionNo=${versionNo} 已被占用 (skillId=${params.skillId})`,
      );
    }
    throw err;
  }

  const [row] = await db
    .select()
    .from(skillVersionTable)
    .where(eq(skillVersionTable.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`createSkillVersion: 行未找到（id=${id}）`);
  }
  return row;
}

/** 获取 SkillVersion（跨租户隔离：通过 join Skill 校验 tenantId）。 */
export async function getSkillVersionById(params: {
  tenantId: string;
  skillVersionId: string;
}): Promise<SkillVersion | null> {
  const [row] = await db
    .select({ version: skillVersionTable, skill: skillTable })
    .from(skillVersionTable)
    .innerJoin(skillTable, eq(skillVersionTable.skillId, skillTable.id))
    .where(
      and(
        eq(skillTable.tenantId, params.tenantId),
        eq(skillVersionTable.id, params.skillVersionId),
      ),
    )
    .limit(1);
  return row?.version ?? null;
}

/** 列出 Skill 的版本（按 versionNo 降序）。 */
export async function listSkillVersions(params: {
  tenantId: string;
  skillId: string;
  revisionStates?: readonly SkillRevisionState[];
  limit?: number;
}): Promise<SkillVersion[]> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  // 先校验 skillId 属于 tenantId
  const skill = await getSkillById({
    tenantId: params.tenantId,
    skillId: params.skillId,
  });
  if (!skill) {
    throw new SkillNotFoundError(params.skillId);
  }

  const conditions = [eq(skillVersionTable.skillId, params.skillId)];
  if (params.revisionStates && params.revisionStates.length > 0) {
    conditions.push(inArray(skillVersionTable.revisionState, [...params.revisionStates]));
  }

  return db
    .select()
    .from(skillVersionTable)
    .where(and(...conditions))
    .orderBy(desc(skillVersionTable.versionNo))
    .limit(limit);
}

/** 获取当前生效版本（currentVersionId 对应的 SkillVersion）。 */
export async function getCurrentSkillVersion(params: {
  tenantId: string;
  skillId: string;
}): Promise<SkillVersion | null> {
  const skill = await getSkillById({
    tenantId: params.tenantId,
    skillId: params.skillId,
  });
  if (!skill || !skill.currentVersionId) return null;

  return getSkillVersionById({
    tenantId: params.tenantId,
    skillVersionId: skill.currentVersionId,
  });
}

/**
 * 发布 SkillVersion（事务内：draft → published + 旧 published → withdrawn + Skill.currentVersionId 更新）。
 *
 * @throws SkillVersionNotFoundError SkillVersion 不存在或跨租户
 * @throws SkillLifecycleError revisionState 状态机非法（非 draft 不能 publish）
 */
export async function publishSkillVersion(params: {
  tenantId: string;
  skillVersionId: string;
  publishedBy: string;
}): Promise<{ skill: Skill; version: SkillVersion }> {
  const version = await getSkillVersionById({
    tenantId: params.tenantId,
    skillVersionId: params.skillVersionId,
  });
  if (!version) {
    throw new SkillVersionNotFoundError(params.skillVersionId);
  }

  // revision 状态机校验
  if (version.revisionState !== "draft") {
    throw new SkillLifecycleError(
      params.skillVersionId,
      "revision",
      version.revisionState,
      "published",
      `SkillVersion 状态为 ${version.revisionState}，只有 draft 状态可发布`,
    );
  }

  // 加载 Skill（用于回填 currentVersionId + 乐观锁）
  const skill = await getSkillById({
    tenantId: params.tenantId,
    skillId: version.skillId,
  });
  if (!skill) {
    throw new SkillNotFoundError(version.skillId);
  }

  const now = new Date();
  const expectedVersionNo = skill.versionNo;

  // 事务：1) 旧 published → withdrawn；2) 新版本 draft → published；3) Skill.currentVersionId 更新。
  // 顺序很重要：必须先将旧 published 置为 withdrawn，再将新版本置为 published，
  // 否则 step 2 的 WHERE revisionState=published 会把刚 publish 的新版本一并 withdraw。
  await db.transaction(async (tx) => {
    // 1. 旧 published → withdrawn（除当前正在发布的版本外）
    if (skill.currentVersionId && skill.currentVersionId !== params.skillVersionId) {
      await tx
        .update(skillVersionTable)
        .set({ revisionState: "withdrawn" })
        .where(
          and(
            eq(skillVersionTable.skillId, skill.id),
            eq(skillVersionTable.revisionState, "published"),
          ),
        );
    }

    // 2. 新版本 draft → published
    const publishResult = await tx
      .update(skillVersionTable)
      .set({ revisionState: "published", publishedAt: now })
      .where(eq(skillVersionTable.id, params.skillVersionId));
    if (publishResult[0].affectedRows === 0) {
      throw new SkillVersionConflictError(
        `publishSkillVersion: 更新 SkillVersion=${params.skillVersionId} 为 published 失败`,
      );
    }

    // 3. Skill.currentVersionId 更新（乐观锁）
    const skillUpdateResult = await tx
      .update(skillTable)
      .set({
        currentVersionId: params.skillVersionId,
        versionNo: expectedVersionNo + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(skillTable.tenantId, params.tenantId),
          eq(skillTable.id, skill.id),
          eq(skillTable.versionNo, expectedVersionNo),
        ),
      );
    if (skillUpdateResult[0].affectedRows === 0) {
      throw new SkillVersionConflictError(
        `publishSkillVersion: Skill=${skill.id} 乐观锁冲突（期望 versionNo=${expectedVersionNo}）`,
      );
    }
  });

  // 回查返回最新状态
  const updatedVersion = await getSkillVersionById({
    tenantId: params.tenantId,
    skillVersionId: params.skillVersionId,
  });
  if (!updatedVersion) {
    throw new SkillVersionNotFoundError(params.skillVersionId);
  }
  const updatedSkill = await getSkillById({
    tenantId: params.tenantId,
    skillId: skill.id,
  });
  if (!updatedSkill) {
    throw new SkillNotFoundError(skill.id);
  }
  return { skill: updatedSkill, version: updatedVersion };
}

// ─── 02-4：Studio / sync / provider 补充查询 ────────────────

/**
 * 由 git commit sha 派生正式 contentHash（关口02 02-4 映射约定）。
 *
 * 正式 SkillVersion.contentHash 要求 `sha256:` + 64 hex；Studio / sync 流程以
 * skills/ git repo 的 commit sha 作为内容身份。git sha 本身是 40 hex，不能直接使用，
 * 故取其 sha256（64 hex）作为确定性内容身份 hash：新 commit → 新 hash → 变化可检测；
 * 同一 commit 恒等；格式满足正式不变量。运行时（gateway content）只回传 contentHash，
 * 不做内容重哈希校验，故该映射不破坏运行路径。
 */
export function contentHashFromGitSha(commitSha: string): string {
  const digest = createHash("sha256").update(commitSha).digest("hex");
  return `sha256:${digest}`;
}

/**
 * 将 Skill.currentVersionId 指向既有版本并发布（Studio create / versions / publish / rollback 共用）。
 *
 * - CAS（P1-14）：expectedCurrentVersionId 提供时，仅当 skill.currentVersionId 与之匹配才切换；
 *   不匹配返回 false（调用方回 409），防并发 publish/rollback 互覆盖。
 * - 若目标版本为 draft，一并置为 published（与 publishSkillVersion 语义一致；Studio 流程
 *   createSkillVersion 默认 draft，经此发布）。
 * - 目标版本必须属于该 skill（跨租户隔离）。
 *
 * @returns true=已切换；false=currentVersionId CAS 冲突（未切换）。
 */
export async function setCurrentSkillVersion(params: {
  tenantId: string;
  skillId: string;
  skillVersionId: string;
  expectedCurrentVersionId?: string | null;
}): Promise<boolean> {
  const skill = await getSkillById({
    tenantId: params.tenantId,
    skillId: params.skillId,
  });
  if (!skill) {
    throw new SkillNotFoundError(params.skillId);
  }
  // CAS：currentVersionId 不匹配 → 冲突，不切换
  if (
    params.expectedCurrentVersionId !== undefined &&
    skill.currentVersionId !== params.expectedCurrentVersionId
  ) {
    return false;
  }
  // 校验目标版本存在且属于该 skill（跨租户隔离）
  const target = await getSkillVersionById({
    tenantId: params.tenantId,
    skillVersionId: params.skillVersionId,
  });
  if (!target || target.skillId !== params.skillId) {
    throw new SkillVersionNotFoundError(params.skillVersionId);
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    // CAS 落库：WHERE currentVersionId = expectedCurrentVersionId（未提供 CAS 时用 IS NULL 兜底）
    const casClause =
      params.expectedCurrentVersionId === undefined
        ? undefined
        : params.expectedCurrentVersionId === null
          ? isNull(skillTable.currentVersionId)
          : eq(skillTable.currentVersionId, params.expectedCurrentVersionId);
    const result = await tx
      .update(skillTable)
      .set({ currentVersionId: params.skillVersionId, updatedAt: now })
      .where(
        and(
          eq(skillTable.tenantId, params.tenantId),
          eq(skillTable.id, params.skillId),
          ...(casClause ? [casClause] : []),
        ),
      );
    if (result[0].affectedRows === 0) {
      throw new SkillVersionConflictError(
        `setCurrentSkillVersion: currentVersionId CAS 冲突（skillId=${params.skillId}）`,
      );
    }
    // draft → published
    if (target.revisionState === "draft") {
      await tx
        .update(skillVersionTable)
        .set({ revisionState: "published", publishedAt: now })
        .where(eq(skillVersionTable.id, params.skillVersionId));
    }
  });
  return true;
}

/** 按 contentRef（git commit sha）取 SkillVersion（sync 去重用）。 */
export async function getSkillVersionByContentRef(params: {
  tenantId: string;
  skillId: string;
  contentRef: string;
}): Promise<SkillVersion | null> {
  const skill = await getSkillById({
    tenantId: params.tenantId,
    skillId: params.skillId,
  });
  if (!skill) {
    throw new SkillNotFoundError(params.skillId);
  }
  const [row] = await db
    .select()
    .from(skillVersionTable)
    .where(
      and(
        eq(skillVersionTable.skillId, params.skillId),
        eq(skillVersionTable.contentRef, params.contentRef),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 运行时匹配候选（LocalDbSkillProvider 事实源）。
 *
 * 对应 legacy listActiveSkillsForMatching 的正式等价：
 * - lifecycleState=enabled（legacy status=active）
 * - visibilityScope ∈ {tenant, internal}（legacy visibility=public）
 * - sourceType=local，或存在 syncState=active 的 SkillSyncBinding（同步镜像仅 active 时进入候选）
 * - 有当前生效版本（currentVersionId 非空，无版本无法被 Resolver 选用）
 */
export async function listSkillsForMatching(tenantId: string): Promise<Skill[]> {
  const activeSyncedIds = new Set(await listActiveSyncLocalSkillIds(tenantId));
  const rows = await db
    .select()
    .from(skillTable)
    .where(
      and(
        eq(skillTable.tenantId, tenantId),
        eq(skillTable.lifecycleState, "enabled"),
        inArray(skillTable.visibilityScope, ["tenant", "internal"]),
        or(eq(skillTable.sourceType, "local"), inArray(skillTable.id, [...activeSyncedIds])),
      ),
    )
    .orderBy(asc(skillTable.createdAt));
  return rows.filter((s) => s.currentVersionId !== null);
}

// ─── 内部工具 ──────────────────────────────────────────────

/** 计算 Skill 内下一个 versionNo（max +1）。并发冲突由 UNIQUE 约束 fail-loud。 */
async function nextVersionNo(skillId: string): Promise<number> {
  const [row] = await db
    .select({ maxNo: max(skillVersionTable.versionNo) })
    .from(skillVersionTable)
    .where(eq(skillVersionTable.skillId, skillId));
  const currentMax = row?.maxNo;
  if (currentMax === null || currentMax === undefined) return 1;
  return currentMax + 1;
}

/** 判断 MySQL 错误是否为唯一约束冲突（ER_DUP_ENTRY, code 1062）。 */
function isDuplicateEntryError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; errno?: number };
  return e.code === "ER_DUP_ENTRY" || e.errno === 1062;
}

/** 编码不透明 cursor（base64url(JSON)）。 */
function encodeCursor(payload: { updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

/** 解码不透明 cursor。非法返回 null。 */
function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as { updatedAt?: string; id?: string };
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") return null;
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return null;
  }
}

// ─── Re-exports ────────────────────────────────────────────

export type {
  SkillLifecycleState,
  SkillRevisionState,
  SkillSourceType,
  SkillVisibilityScope,
  Skill,
  SkillVersion,
} from "@/lib/persistence/schema/skill";
