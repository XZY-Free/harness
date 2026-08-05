/**
 * V11 风险差异分析器（阶段 6 S06-C05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §5（能力变化与审核）
 * - ../v11-agentkit-platform/12-capability-and-collaboration-api.md §3.2（TOOL_SCHEMA_CHANGED）
 *
 * 职责：
 * - compareSchemaRevisions：对比新旧 SchemaRevision 的 riskMetadataJson，输出 RiskDiffResult。
 * - isAutoEffective：判断差异是否可自动生效（无需集中审核）。
 * - requiresCentralReview：判断差异是否必须集中审核（§5.2 列表命中）。
 *
 * 风险差异类型（RiskDiffType）：
 * - read_to_write：从只读变为可写
 * - new_destructive_op：新增破坏性操作
 * - network_expanded：网络范围扩大
 * - data_destination_expanded：数据目的地扩大
 * - new_credential：新增凭证需求
 * - new_permission_scope：新增权限范围
 * - env_test_to_prod：从测试环境扩展到生产环境
 * - lost_idempotency：丢失幂等性
 * - compatible_change：兼容性变更（不触发审核）
 * - no_change：无变化
 *
 * riskMetadataJson 字段（与 lib/persistence/schema/tool.ts ToolSchemaRevision 对齐）：
 * - effect：read_only / write / destructive
 * - data_class：public / internal / confidential / restricted
 * - network_scope：none / internal / external / public
 * - data_destinations：string[]（数据写入目的地列表）
 * - credential_required：boolean
 * - permission_scope：string[]（权限范围列表）
 * - env：test / staging / prod
 * - idempotent：boolean
 * - side_effects：boolean
 * - destructive：boolean
 */
import type { CapabilityReviewResourceType } from "@/lib/persistence/schema/tool-call";

// ─── 常量 ──────────────────────────────────────────────────

/** 风险差异类型全集（与 §5.2 列表对齐）。 */
export const RISK_DIFF_TYPES = [
  "read_to_write",
  "new_destructive_op",
  "network_expanded",
  "data_destination_expanded",
  "new_credential",
  "new_permission_scope",
  "env_test_to_prod",
  "lost_idempotency",
  "compatible_change",
  "no_change",
] as const;

export type RiskDiffType = (typeof RISK_DIFF_TYPES)[number];

/**
 * 必须集中审核的差异类型集合（§5.2 列表命中）。
 * - 任意一个命中 → requiresCentralReview=true，isAutoEffective=false。
 * - compatible_change / no_change → 可自动生效，无需审核。
 */
const CENTRAL_REVIEW_REQUIRED_DIFF_TYPES: ReadonlySet<RiskDiffType> = new Set([
  "read_to_write",
  "new_destructive_op",
  "network_expanded",
  "data_destination_expanded",
  "new_credential",
  "new_permission_scope",
  "env_test_to_prod",
  "lost_idempotency",
]);

/**
 * ToolSchemaRevision.riskMetadataJson 的结构化表示。
 *
 * 字段均可空（首次发布时旧版为空对象）；缺失字段按 null 处理（不影响比对）。
 */
export interface RiskMetadata {
  /** 操作效果：read_only / write / destructive。 */
  effect?: "read_only" | "write" | "destructive" | null;
  /** 数据分类：public / internal / confidential / restricted。 */
  data_class?: "public" | "internal" | "confidential" | "restricted" | null;
  /** 网络范围：none / internal / external / public。 */
  network_scope?: "none" | "internal" | "external" | "public" | null;
  /** 数据写入目的地列表（URL / service / namespace 等）。 */
  data_destinations?: string[] | null;
  /** 是否需要凭证。 */
  credential_required?: boolean | null;
  /** 权限范围列表（如 read:user / write:repo）。 */
  permission_scope?: string[] | null;
  /** 环境范围：test / staging / prod。 */
  env?: "test" | "staging" | "prod" | null;
  /** 是否幂等。 */
  idempotent?: boolean | null;
  /** 是否有副作用。 */
  side_effects?: boolean | null;
  /** 是否破坏性（不可逆）。 */
  destructive?: boolean | null;
}

/** 风险差异分析结果。 */
export interface RiskDiffResult {
  /** 差异类型（10 选 1）。 */
  diffType: RiskDiffType;
  /** 是否必须集中审核（§5.2 列表命中则 true）。 */
  requiresReview: boolean;
  /** 人类可读的差异描述。 */
  description: string;
  /** 受影响的 Agent id 列表（调用方传入，分析器不解析）。 */
  affectedAgents: string[];
  /** 资源类型（skill/tool）。 */
  resourceType: CapabilityReviewResourceType;
  /** 旧修订 id（首次发布时为 null）。 */
  oldRevisionId: string | null;
  /** 新修订 id。 */
  newRevisionId: string;
}

/** compareSchemaRevisions 入参。 */
export interface CompareSchemaRevisionsParams {
  /** 资源类型（skill/tool）。 */
  resourceType: CapabilityReviewResourceType;
  /** 资源稳定 id。 */
  resourceId: string;
  /** 旧修订 id（首次发布时为 null）。 */
  oldRevisionId: string | null;
  /** 新修订 id。 */
  newRevisionId: string;
  /** 旧修订 riskMetadataJson（首次发布时为 null/空对象）。 */
  oldRiskMetadata: RiskMetadata | null;
  /** 新修订 riskMetadataJson。 */
  newRiskMetadata: RiskMetadata;
  /** 受影响的 Agent id 列表（由调用方根据 Agent 绑定计算）。 */
  affectedAgents?: string[];
}

// ─── 工具：规范化 RiskMetadata ─────────────────────────────

/** 把任意 unknown 规范化为 RiskMetadata（容错解析，非法字段忽略）。 */
export function normalizeRiskMetadata(raw: unknown): RiskMetadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const result: RiskMetadata = {};

  if (
    typeof obj.effect === "string" &&
    ["read_only", "write", "destructive"].includes(obj.effect)
  ) {
    result.effect = obj.effect as RiskMetadata["effect"];
  }
  if (
    typeof obj.data_class === "string" &&
    ["public", "internal", "confidential", "restricted"].includes(obj.data_class)
  ) {
    result.data_class = obj.data_class as RiskMetadata["data_class"];
  }
  if (
    typeof obj.network_scope === "string" &&
    ["none", "internal", "external", "public"].includes(obj.network_scope)
  ) {
    result.network_scope = obj.network_scope as RiskMetadata["network_scope"];
  }
  if (
    Array.isArray(obj.data_destinations) &&
    obj.data_destinations.every((d) => typeof d === "string")
  ) {
    result.data_destinations = obj.data_destinations as string[];
  }
  if (typeof obj.credential_required === "boolean") {
    result.credential_required = obj.credential_required;
  }
  if (
    Array.isArray(obj.permission_scope) &&
    obj.permission_scope.every((p) => typeof p === "string")
  ) {
    result.permission_scope = obj.permission_scope as string[];
  }
  if (typeof obj.env === "string" && ["test", "staging", "prod"].includes(obj.env)) {
    result.env = obj.env as RiskMetadata["env"];
  }
  if (typeof obj.idempotent === "boolean") {
    result.idempotent = obj.idempotent;
  }
  if (typeof obj.side_effects === "boolean") {
    result.side_effects = obj.side_effects;
  }
  if (typeof obj.destructive === "boolean") {
    result.destructive = obj.destructive;
  }
  return result;
}

// ─── 工具：权限/网络/环境范围等级 ─────────────────────────

const NETWORK_SCOPE_LEVEL: Record<NonNullable<RiskMetadata["network_scope"]>, number> = {
  none: 0,
  internal: 1,
  external: 2,
  public: 3,
};

const ENV_LEVEL: Record<NonNullable<RiskMetadata["env"]>, number> = {
  test: 0,
  staging: 1,
  prod: 2,
};

const EFFECT_LEVEL: Record<NonNullable<RiskMetadata["effect"]>, number> = {
  read_only: 0,
  write: 1,
  destructive: 2,
};

/** 判断 old → new 是否为风险升级（从低到高）。 */
function isRiskUpgrade<T extends string | number>(
  oldVal: T | null | undefined,
  newVal: T | null | undefined,
  levelMap: Record<T, number>,
): boolean {
  if (oldVal === null || oldVal === undefined) {
    // 旧版无此字段，新版有任何值都视为新增（具体差异类型由调用方判断）。
    return newVal !== null && newVal !== undefined;
  }
  if (newVal === null || newVal === undefined) {
    return false; // 新版无此字段，不算升级
  }
  return levelMap[newVal] > levelMap[oldVal];
}

/** 判断数组是否新增了元素（old → new，new 有 old 没有的元素）。 */
function hasArrayExpanded(
  oldArr: string[] | null | undefined,
  newArr: string[] | null | undefined,
): {
  expanded: boolean;
  added: string[];
} {
  const oldSet = new Set(oldArr ?? []);
  const newArrSafe = newArr ?? [];
  const added = newArrSafe.filter((item) => !oldSet.has(item));
  return { expanded: added.length > 0, added };
}

// ─── compareSchemaRevisions ───────────────────────────────

/**
 * 对比新旧 SchemaRevision 的 riskMetadataJson，输出 RiskDiffResult。
 *
 * 判定优先级（按 §5.2 列表顺序）：
 * 1. read_to_write：effect 从 read_only 升级到 write/destructive。
 * 2. new_destructive_op：destructive 从 false → true，或 effect 升级到 destructive。
 * 3. network_expanded：network_scope 等级提升。
 * 4. data_destination_expanded：data_destinations 新增目的地。
 * 5. new_credential：credential_required 从 false → true。
 * 6. new_permission_scope：permission_scope 新增范围。
 * 7. env_test_to_prod：env 从 test/staging 升级到 prod。
 * 8. lost_idempotency：idempotent 从 true → false。
 * 9. compatible_change：其他非空变更（如 data_class 调整），不触发审核。
 * 10. no_change：完全无变化。
 *
 * @returns RiskDiffResult（含 diffType / requiresReview / description / affectedAgents）
 */
export function compareSchemaRevisions(params: CompareSchemaRevisionsParams): RiskDiffResult {
  const oldMeta = params.oldRiskMetadata ?? {};
  const newMeta = params.newRiskMetadata;
  const affectedAgents = params.affectedAgents ?? [];

  // 1. read_to_write：effect 从 read_only → write/destructive
  if (
    oldMeta.effect === "read_only" &&
    (newMeta.effect === "write" || newMeta.effect === "destructive")
  ) {
    return buildResult(
      params,
      "read_to_write",
      `effect 从 read_only 升级到 ${newMeta.effect}（从只读变为可写）`,
      affectedAgents,
    );
  }
  // 首次发布且新版 effect 非 read_only → 也视为 read_to_write（无旧版基线时新增写操作）
  if (
    (oldMeta.effect === null || oldMeta.effect === undefined) &&
    (newMeta.effect === "write" || newMeta.effect === "destructive")
  ) {
    return buildResult(
      params,
      "read_to_write",
      `首次发布 effect=${newMeta.effect}（新增写操作）`,
      affectedAgents,
    );
  }

  // 2. new_destructive_op：destructive 从 false → true，或 effect 升级到 destructive
  if (oldMeta.destructive !== true && newMeta.destructive === true) {
    return buildResult(
      params,
      "new_destructive_op",
      "destructive 从 false 变为 true（新增破坏性操作）",
      affectedAgents,
    );
  }
  if (
    oldMeta.effect !== "destructive" &&
    newMeta.effect === "destructive" &&
    oldMeta.effect !== "read_only" // 已被 1 命中
  ) {
    return buildResult(
      params,
      "new_destructive_op",
      "effect 升级到 destructive（新增破坏性操作）",
      affectedAgents,
    );
  }

  // 3. network_expanded：network_scope 等级提升
  if (
    isRiskUpgrade(oldMeta.network_scope, newMeta.network_scope, NETWORK_SCOPE_LEVEL) &&
    newMeta.network_scope !== undefined &&
    newMeta.network_scope !== null
  ) {
    return buildResult(
      params,
      "network_expanded",
      `network_scope 从 ${oldMeta.network_scope ?? "none"} 扩大到 ${newMeta.network_scope}`,
      affectedAgents,
    );
  }

  // 4. data_destination_expanded：data_destinations 新增目的地
  const destDiff = hasArrayExpanded(oldMeta.data_destinations, newMeta.data_destinations);
  if (destDiff.expanded) {
    return buildResult(
      params,
      "data_destination_expanded",
      `data_destinations 新增: ${destDiff.added.join(", ")}`,
      affectedAgents,
    );
  }

  // 5. new_credential：credential_required 从 false → true
  if (oldMeta.credential_required !== true && newMeta.credential_required === true) {
    return buildResult(
      params,
      "new_credential",
      "credential_required 从 false 变为 true（新增凭证需求）",
      affectedAgents,
    );
  }

  // 6. new_permission_scope：permission_scope 新增范围
  const permDiff = hasArrayExpanded(oldMeta.permission_scope, newMeta.permission_scope);
  if (permDiff.expanded) {
    return buildResult(
      params,
      "new_permission_scope",
      `permission_scope 新增: ${permDiff.added.join(", ")}`,
      affectedAgents,
    );
  }

  // 7. env_test_to_prod：env 从 test/staging 升级到 prod，或首次发布 env=prod
  //    外层条件已确保 oldMeta.env 不是 prod，故无需再内层判断。
  if (
    (oldMeta.env === "test" ||
      oldMeta.env === "staging" ||
      oldMeta.env === null ||
      oldMeta.env === undefined) &&
    newMeta.env === "prod"
  ) {
    return buildResult(
      params,
      "env_test_to_prod",
      `env 从 ${oldMeta.env ?? "test"} 扩大到 prod（首次发布到生产环境）`,
      affectedAgents,
    );
  }

  // 8. lost_idempotency：idempotent 从 true → false
  if (oldMeta.idempotent === true && newMeta.idempotent === false) {
    return buildResult(
      params,
      "lost_idempotency",
      "idempotent 从 true 变为 false（丢失幂等性）",
      affectedAgents,
    );
  }

  // 9. compatible_change：其他非空变更（data_class 调整、effect 降级等）
  if (hasAnyChange(oldMeta, newMeta)) {
    return buildResult(params, "compatible_change", "兼容性变更（不触发集中审核）", affectedAgents);
  }

  // 10. no_change：完全无变化
  return buildResult(params, "no_change", "无风险元数据变化", affectedAgents);
}

/** 构造 RiskDiffResult，requiresReview 由 diffType 决定。 */
function buildResult(
  params: CompareSchemaRevisionsParams,
  diffType: RiskDiffType,
  description: string,
  affectedAgents: string[],
): RiskDiffResult {
  return {
    diffType,
    requiresReview: requiresCentralReview(diffType),
    description,
    affectedAgents,
    resourceType: params.resourceType,
    oldRevisionId: params.oldRevisionId,
    newRevisionId: params.newRevisionId,
  };
}

/** 判断两个 RiskMetadata 是否有任何差异（用于 compatible_change 判定）。 */
function hasAnyChange(oldMeta: RiskMetadata, newMeta: RiskMetadata): boolean {
  if (oldMeta.effect !== newMeta.effect) return true;
  if (oldMeta.data_class !== newMeta.data_class) return true;
  if (oldMeta.network_scope !== newMeta.network_scope) return true;
  if (oldMeta.credential_required !== newMeta.credential_required) return true;
  if (oldMeta.env !== newMeta.env) return true;
  if (oldMeta.idempotent !== newMeta.idempotent) return true;
  if (oldMeta.side_effects !== newMeta.side_effects) return true;
  if (oldMeta.destructive !== newMeta.destructive) return true;

  const oldDest = oldMeta.data_destinations ?? [];
  const newDest = newMeta.data_destinations ?? [];
  if (oldDest.length !== newDest.length || !oldDest.every((d) => newDest.includes(d))) {
    return true;
  }

  const oldPerm = oldMeta.permission_scope ?? [];
  const newPerm = newMeta.permission_scope ?? [];
  if (oldPerm.length !== newPerm.length || !oldPerm.every((p) => newPerm.includes(p))) {
    return true;
  }

  return false;
}

// ─── isAutoEffective / requiresCentralReview ─────────────

/**
 * 判断差异是否可自动生效（无需集中审核）。
 *
 * - no_change / compatible_change → 可自动生效。
 * - 其他 8 类差异 → 必须集中审核，不能自动生效。
 */
export function isAutoEffective(diffType: RiskDiffType): boolean {
  return diffType === "no_change" || diffType === "compatible_change";
}

/**
 * 判断差异是否必须集中审核（§5.2 列表命中）。
 *
 * - 8 类高风险差异 → true。
 * - no_change / compatible_change → false。
 */
export function requiresCentralReview(diffType: RiskDiffType): boolean {
  return CENTRAL_REVIEW_REQUIRED_DIFF_TYPES.has(diffType);
}
