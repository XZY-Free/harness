import { acceptEnterpriseProfileObservation } from "@/lib/identity/accept-enterprise-profile-observation";
import type {
  EnterpriseProfileSource,
  EnterpriseProfileSourceResult,
} from "@/lib/identity/enterprise-profile-source";
import type { EnterpriseAttributeKey, JsonValue } from "@/lib/identity/enterprise-user";
import {
  type EnterpriseUserAccessPolicy,
  EnterpriseUserContextRequirementError,
  type EnterpriseUserPublicContext,
} from "@/lib/identity/enterprise-user-access-policy";
import {
  attributesFromRows,
  getEnterpriseUserProfileFacts,
  recordEnterpriseProfileSyncFailure,
} from "@/lib/identity/enterprise-user-profile-queries";
import { getTenantById } from "@/lib/identity/tenant-queries";
import { getUserIdentityForTenant } from "@/lib/identity/user-identity-queries";

export interface EnterpriseProfileQualityInput {
  now: Date;
  lastVerifiedAt: Date;
  freshUntil: Date;
  staleUntil: Date;
  maxFreshAgeMs: number;
  maxStaleAgeMs: number;
}

export type EnterpriseProfileQuality = "fresh" | "stale" | "expired";

export function classifyEnterpriseProfileQuality(
  input: EnterpriseProfileQualityInput,
): EnterpriseProfileQuality {
  const freshUntil = Math.min(
    input.freshUntil.getTime(),
    input.lastVerifiedAt.getTime() + input.maxFreshAgeMs,
  );
  const staleUntil = Math.min(input.staleUntil.getTime(), freshUntil + input.maxStaleAgeMs);
  if (input.now.getTime() < freshUntil) return "fresh";
  if (input.now.getTime() < staleUntil) return "stale";
  return "expired";
}

const inFlightRefreshes = new Map<string, Promise<EnterpriseProfileSourceResult>>();
const REFRESH_FAILURE_BACKOFF_MS = 30_000;

export function shouldBackoffEnterpriseProfileRefresh(params: {
  lastSyncErrorCode: string | null;
  updatedAt: Date;
  now: Date;
}): boolean {
  return (
    params.lastSyncErrorCode !== null &&
    params.now.getTime() - params.updatedAt.getTime() < REFRESH_FAILURE_BACKOFF_MS
  );
}

export async function prepareEnterpriseUserContext(params: {
  tenantId: string;
  tenantKey?: string;
  userIdentityId: string;
  policy: EnterpriseUserAccessPolicy;
  source?: EnterpriseProfileSource;
  now?: Date;
  signal?: AbortSignal;
}): Promise<EnterpriseUserPublicContext | null> {
  if (params.policy.profileRequirement === "none") return null;
  if (!params.source?.trusted) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "当前部署没有受信企业资料来源",
    );
  }

  const source = params.source;
  const now = params.now ?? new Date();
  const signal = params.signal ?? new AbortController().signal;
  const identity = await getUserIdentityForTenant(params.userIdentityId, params.tenantId);
  if (!identity || identity.status === "disabled") {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_disabled",
      "当前用户身份不可用于企业资料访问",
    );
  }
  const first = await readProfile(params, source, now);
  if (first && isAcceptable(first.quality, params.policy.profileRequirement)) {
    return project(params.policy, first.attributes, first.quality, first.lastVerifiedAt);
  }

  if (
    first?.syncState &&
    shouldBackoffEnterpriseProfileRefresh({
      lastSyncErrorCode: first.syncState.lastSyncErrorCode,
      updatedAt: first.syncState.updatedAt,
      now,
    })
  ) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业资料来源暂不可用",
    );
  }

  if (!source.refresh) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业资料已缺失或过期，请重新登录后再试",
    );
  }
  if (signal.aborted) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业资料准备已取消",
    );
  }

  const tenant = params.tenantKey
    ? { key: params.tenantKey }
    : await getTenantById(params.tenantId);
  if (!tenant) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业资料对应的租户不存在",
    );
  }
  const key = `${params.tenantId}:${params.userIdentityId}:${source.sourceSystem}`;
  let refresh = inFlightRefreshes.get(key);
  if (!refresh) {
    refresh = source
      .refresh({
        subject: {
          tenantId: params.tenantId,
          tenantKey: tenant.key,
          externalSubject: identity.externalSubject,
        },
        signal,
        now,
        trustedAuthenticationClaims: {},
      })
      .finally(() => {
        if (inFlightRefreshes.get(key) === refresh) inFlightRefreshes.delete(key);
      });
    inFlightRefreshes.set(key, refresh);
  }
  let refreshResult: EnterpriseProfileSourceResult;
  try {
    refreshResult = await refresh;
  } catch (error) {
    await recordEnterpriseProfileSyncFailure(
      params.tenantId,
      params.userIdentityId,
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "enterprise_profile_refresh_failed",
    );
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业资料来源暂不可用",
    );
  }
  if (signal.aborted) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业资料准备已取消",
    );
  }
  if (refreshResult.status === "observed") {
    await acceptEnterpriseProfileObservation({
      observation: refreshResult.observation,
      source,
      now,
    });
  }
  if (refreshResult.status === "unavailable") {
    await recordEnterpriseProfileSyncFailure(
      params.tenantId,
      params.userIdentityId,
      refreshResult.code ?? "enterprise_profile_source_unavailable",
    );
  }
  const afterRefresh = await readProfile(params, source, now);
  if (afterRefresh && isAcceptable(afterRefresh.quality, params.policy.profileRequirement)) {
    return project(
      params.policy,
      afterRefresh.attributes,
      afterRefresh.quality,
      afterRefresh.lastVerifiedAt,
    );
  }
  throw new EnterpriseUserContextRequirementError(
    "enterprise_user_context_unavailable",
    refreshResult.status === "unavailable"
      ? "企业资料来源暂不可用"
      : "企业资料刷新后仍不满足当前 Agent 要求",
  );
}

/** 在 AgentCallBinding 落库前只复核本地事实，不触发第二次刷新。 */
export async function assertEnterpriseUserContextStillAcceptable(params: {
  tenantId: string;
  userIdentityId: string;
  policy: EnterpriseUserAccessPolicy;
  source?: EnterpriseProfileSource;
  now?: Date;
}): Promise<void> {
  if (params.policy.profileRequirement === "none") return;
  if (!params.source?.trusted) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "当前部署没有受信企业资料来源",
    );
  }
  const identity = await getUserIdentityForTenant(params.userIdentityId, params.tenantId);
  if (!identity || identity.status === "disabled") {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_disabled",
      "当前用户身份不可用于企业资料访问",
    );
  }
  const profile = await readProfile(params, params.source, params.now ?? new Date());
  if (!profile || !isAcceptable(profile.quality, params.policy.profileRequirement)) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业资料在 AgentCallBinding 创建前已失效",
    );
  }
}

async function readProfile(
  params: { tenantId: string; userIdentityId: string },
  source: EnterpriseProfileSource,
  now: Date,
) {
  const facts = await getEnterpriseUserProfileFacts(params.tenantId, params.userIdentityId);
  const state = facts?.syncState;
  if (!state || !facts || !source.trusted || state.sourceSystem !== source.sourceSystem)
    return null;
  return {
    quality: classifyEnterpriseProfileQuality({
      now,
      lastVerifiedAt: state.lastVerifiedAt,
      freshUntil: state.freshUntil,
      staleUntil: state.staleUntil,
      maxFreshAgeMs: source.maxFreshAgeMs,
      maxStaleAgeMs: source.maxStaleAgeMs,
    }),
    lastVerifiedAt: state.lastVerifiedAt,
    syncState: state,
    attributes: attributesFromRows(facts.attributes),
  };
}

function isAcceptable(
  quality: EnterpriseProfileQuality,
  requirement: EnterpriseUserAccessPolicy["profileRequirement"],
): quality is "fresh" | "stale" {
  return quality === "fresh" || (quality === "stale" && requirement === "stale_allowed");
}

function project(
  policy: EnterpriseUserAccessPolicy,
  attributes: Record<string, string | number | boolean | JsonValue>,
  quality: Exclude<EnterpriseProfileQuality, "expired">,
  lastVerifiedAt: Date,
): EnterpriseUserPublicContext {
  const fields: EnterpriseUserPublicContext["fields"] = {};
  for (const field of policy.allowedFields) {
    const value = attributes[field as EnterpriseAttributeKey];
    if (value !== undefined) fields[field] = value;
  }
  return {
    context_version: "1",
    profile_status: quality,
    last_verified_at: lastVerifiedAt.toISOString(),
    fields,
  };
}
