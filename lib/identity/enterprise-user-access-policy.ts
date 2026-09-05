/**
 * Agent Revision 的企业用户资料要求与安全投影。
 *
 * 该策略读取 exact AgentRevision.agentInterfaceRequirementsJson；发布后通过
 * AgentCallBinding 的不可变上下文快照冻结。企业目录连接器不属于此模块。
 */
import { db } from "@/lib/db/client";
import {
  ENTERPRISE_ATTRIBUTE_CATALOG,
  type EnterpriseAttributeKey,
  type JsonValue,
} from "@/lib/identity/enterprise-user";
import { getEnterpriseUserProfileFacts } from "@/lib/identity/enterprise-user-profile-queries";
import { attributesFromRows } from "@/lib/identity/enterprise-user-sync";
import { getUserIdentityForTenant } from "@/lib/identity/user-identity-queries";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { and, eq } from "drizzle-orm";

export const ENTERPRISE_PROFILE_REQUIREMENTS = ["none", "stale_allowed", "fresh_required"] as const;
export type EnterpriseProfileRequirement = (typeof ENTERPRISE_PROFILE_REQUIREMENTS)[number];

export interface EnterpriseUserAccessPolicy {
  profileRequirement: EnterpriseProfileRequirement;
  allowedFields: EnterpriseAttributeKey[];
}

export interface EnterpriseUserPublicContext {
  context_version: "1";
  profile_status: "fresh" | "stale";
  last_verified_at: string;
  fields: Record<string, string | number | boolean | JsonValue>;
}

export type CurrentEnterpriseUserProfile = {
  profileStatus: "fresh" | "stale" | "unavailable" | "disabled";
  lastVerifiedAt: Date | null;
  attributes: Record<string, string | number | boolean | JsonValue>;
};

export class EnterpriseUserAccessPolicyError extends Error {
  readonly code = "enterprise_user_access_policy_invalid";

  constructor(message: string) {
    super(`企业用户资料要求无效：${message}`);
    this.name = "EnterpriseUserAccessPolicyError";
  }
}

export class EnterpriseUserContextRequirementError extends Error {
  constructor(
    public readonly code:
      | "enterprise_user_context_unavailable"
      | "enterprise_user_context_disabled"
      | "enterprise_user_context_not_fresh",
    message: string,
  ) {
    super(message);
    this.name = "EnterpriseUserContextRequirementError";
  }
}

/** 未声明 enterprise_user_context 时默认为 none，兼容标准开源 Agent。 */
export function parseEnterpriseUserAccessPolicy(raw: unknown): EnterpriseUserAccessPolicy {
  if (!isRecord(raw))
    throw new EnterpriseUserAccessPolicyError("agentInterfaceRequirements 必须是对象");
  const block = raw.enterprise_user_context;
  if (block === undefined) return { profileRequirement: "none", allowedFields: [] };
  if (!isRecord(block))
    throw new EnterpriseUserAccessPolicyError("enterprise_user_context 必须是对象");

  const extraKeys = Object.keys(block).filter(
    (key) => key !== "profile_requirement" && key !== "allowed_fields",
  );
  if (extraKeys.length > 0) {
    throw new EnterpriseUserAccessPolicyError(`含未知键：${extraKeys.join(", ")}`);
  }
  const profileRequirement = block.profile_requirement;
  if (
    !ENTERPRISE_PROFILE_REQUIREMENTS.includes(profileRequirement as EnterpriseProfileRequirement)
  ) {
    throw new EnterpriseUserAccessPolicyError("profile_requirement 不是允许值");
  }
  const rawFields = block.allowed_fields ?? [];
  if (!Array.isArray(rawFields) || rawFields.some((field) => typeof field !== "string")) {
    throw new EnterpriseUserAccessPolicyError("allowed_fields 必须是字符串数组");
  }
  const allowedFields = rawFields.map((field) => field as string);
  if (new Set(allowedFields).size !== allowedFields.length) {
    throw new EnterpriseUserAccessPolicyError("allowed_fields 不得重复");
  }
  for (const field of allowedFields) {
    if (!(field in ENTERPRISE_ATTRIBUTE_CATALOG)) {
      throw new EnterpriseUserAccessPolicyError(`字段未登记：${field}`);
    }
    const descriptor = ENTERPRISE_ATTRIBUTE_CATALOG[field as EnterpriseAttributeKey];
    if (!descriptor.agentProjectionAllowed) {
      throw new EnterpriseUserAccessPolicyError(`字段禁止对外投影：${field}`);
    }
  }
  if (profileRequirement === "none" && allowedFields.length > 0) {
    throw new EnterpriseUserAccessPolicyError(
      "profile_requirement=none 时 allowed_fields 必须为空",
    );
  }
  return {
    profileRequirement: profileRequirement as EnterpriseProfileRequirement,
    allowedFields: [...allowedFields].sort() as EnterpriseAttributeKey[],
  };
}

/** 从 exact AgentRevision 读取发布/调用时使用的企业资料要求。 */
export async function loadEnterpriseUserAccessPolicy(
  tenantId: string,
  agentRevisionId: string,
): Promise<EnterpriseUserAccessPolicy> {
  const [row] = await db
    .select({ requirements: agentRevisionTable.agentInterfaceRequirementsJson })
    .from(agentRevisionTable)
    .innerJoin(agentTable, eq(agentTable.id, agentRevisionTable.agentId))
    .where(and(eq(agentRevisionTable.id, agentRevisionId), eq(agentTable.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new EnterpriseUserAccessPolicyError("AgentRevision 不存在或不属于当前租户");
  return parseEnterpriseUserAccessPolicy(row.requirements);
}

/** 读取当前用户的最新可信企业资料状态；不接受客户端字段。 */
export async function loadCurrentEnterpriseUserProfile(
  tenantId: string,
  userIdentityId: string,
): Promise<CurrentEnterpriseUserProfile> {
  const identity = await getUserIdentityForTenant(userIdentityId, tenantId);
  if (!identity) return { profileStatus: "unavailable", lastVerifiedAt: null, attributes: {} };
  const facts = await getEnterpriseUserProfileFacts(tenantId, identity.id);
  const profileStatus =
    identity.status === "disabled"
      ? "disabled"
      : facts?.syncState === null || !facts?.syncState
        ? "unavailable"
        : facts.syncState.stale
          ? "stale"
          : "fresh";
  return {
    profileStatus,
    lastVerifiedAt: facts?.syncState?.lastVerifiedAt ?? null,
    attributes: attributesFromRows(facts?.attributes ?? []),
  };
}

/** 按 exact Revision 的 allowlist 生成可冻结、可公开的企业用户上下文。 */
export function buildEnterpriseUserContext(
  policy: EnterpriseUserAccessPolicy,
  profile: CurrentEnterpriseUserProfile,
): EnterpriseUserPublicContext | null {
  if (policy.profileRequirement === "none") return null;
  if (profile.profileStatus === "disabled") {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_disabled",
      "企业用户已停用，禁止向外部 Agent 发送企业资料",
    );
  }
  if (profile.profileStatus === "unavailable") {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业用户资料尚未成功验证",
    );
  }
  if (policy.profileRequirement === "fresh_required" && profile.profileStatus !== "fresh") {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_not_fresh",
      "外部 Agent 要求 fresh 企业用户资料",
    );
  }
  if (!profile.lastVerifiedAt || Number.isNaN(profile.lastVerifiedAt.getTime())) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业用户资料缺少最近可信验证时间",
    );
  }

  const fields: EnterpriseUserPublicContext["fields"] = {};
  for (const field of policy.allowedFields) {
    const value = profile.attributes[field];
    if (value !== undefined) fields[field] = value;
  }
  return {
    context_version: "1",
    profile_status: profile.profileStatus,
    last_verified_at: profile.lastVerifiedAt.toISOString(),
    fields,
  };
}

/** AgentCallBinding 读回时验证冻结上下文，防止 JSON 列变成自由 payload。 */
export function assertEnterpriseUserPublicContext(
  value: unknown,
): asserts value is EnterpriseUserPublicContext {
  if (!isRecord(value)) throw new EnterpriseUserAccessPolicyError("冻结企业上下文必须是对象");
  if (value.context_version !== "1")
    throw new EnterpriseUserAccessPolicyError("冻结企业上下文版本非法");
  if (value.profile_status !== "fresh" && value.profile_status !== "stale") {
    throw new EnterpriseUserAccessPolicyError("冻结企业上下文状态非法");
  }
  if (
    typeof value.last_verified_at !== "string" ||
    Number.isNaN(Date.parse(value.last_verified_at))
  ) {
    throw new EnterpriseUserAccessPolicyError("冻结企业上下文验证时间非法");
  }
  if (!isRecord(value.fields)) throw new EnterpriseUserAccessPolicyError("冻结企业上下文字段非法");
  for (const key of Object.keys(value.fields)) {
    if (!(key in ENTERPRISE_ATTRIBUTE_CATALOG)) {
      throw new EnterpriseUserAccessPolicyError(`冻结上下文字段未登记：${key}`);
    }
    if (!ENTERPRISE_ATTRIBUTE_CATALOG[key as EnterpriseAttributeKey].agentProjectionAllowed) {
      throw new EnterpriseUserAccessPolicyError(`冻结上下文字段禁止外发：${key}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
