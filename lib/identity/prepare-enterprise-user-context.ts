import {
  AuthCenterUnavailableError,
  EnterpriseContextRpcError,
  type WireEnterpriseUserContextCandidate,
  fetchEnterpriseUserContext,
} from "@/lib/identity-client";
/**
 * 企业用户上下文装配（薄壳——消费方模型 v4）。
 *
 * 装配能力（读企业资料 / 新鲜度判定 / 刷新编排 / 等待与回退）由 auth-center
 * 统一承担（`POST /api/enterprise/user-context`；权威实现见 auth-center
 * `lib/identity/prepare-enterprise-user-context.ts`）——本仓不再持有企业资料表读写、
 * 资料来源适配与同步状态。
 *
 * 本文件保留两类本地职责：
 * 1. `prepareEnterpriseUserContext`：执行链入口薄壳（签名兼容），转调 identity-client；
 *    错误映射保持既有语义（unavailable / disabled / not_fresh；不可达 fail-closed）。
 * 2. `finalizeEnterpriseUserContextCandidate`：绑定创建事务内的**本地终稿复核**——
 *    纯函数（用候选证据中的时间戳与当前时间比较，无 IO、无跨服务调用），防止装配与
 *    绑定落库之间的时间窗口使资料失效。
 */
import {
  type EnterpriseUserAccessPolicy,
  EnterpriseUserContextRequirementError,
  type EnterpriseUserPublicContext,
} from "@/lib/identity/enterprise-user-access-policy";

/** 仅在本地进程内随新建候选传递的期限证据；不得持久化或外发。 */
export interface EnterpriseUserContextCandidateEvidence {
  tenantId: string;
  userIdentityId: string;
  profileRequirement: EnterpriseUserAccessPolicy["profileRequirement"];
  sourceSystem: string;
  profileFingerprint: string | null;
  lastVerifiedAt: Date;
  freshUntil: Date;
  staleUntil: Date;
  maxFreshAgeMs: number;
  maxStaleAgeMs: number;
}

export interface EnterpriseUserContextCandidate {
  publicContext: EnterpriseUserPublicContext;
  evidence: EnterpriseUserContextCandidateEvidence;
}

interface EnterpriseProfileQualityInput {
  now: Date;
  lastVerifiedAt: Date;
  freshUntil: Date;
  staleUntil: Date;
  maxFreshAgeMs: number;
  maxStaleAgeMs: number;
}

type EnterpriseProfileQuality = "fresh" | "stale" | "expired";

/** 本地终稿判定（与 auth-center 评测语义一致；纯函数）。 */
function classifyEnterpriseProfileQuality(
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

function isAcceptable(
  quality: EnterpriseProfileQuality,
  requirement: EnterpriseUserAccessPolicy["profileRequirement"],
): quality is "fresh" | "stale" {
  return quality === "fresh" || (quality === "stale" && requirement === "stale_allowed");
}

/**
 * 装配企业用户上下文候选（执行链入口）。
 *
 * 语义与迁移前本地实现对齐：
 * - profileRequirement=none → null（调用方通常直接跳过）。
 * - 服务主体（"service-subject"）无企业资料通道 → unavailable（与既有行为一致：
 *   原实现该分支恒因无资料来源抛错）。
 * - auth-center 不可达 / 会话凭证缺失 → unavailable（fail-closed）。
 * - 其余权威错误（disabled / not_fresh / 资料不可用）按码透传。
 *
 * 注：`signal` 不穿透 HTTP（等待上限由 auth-center 的 10s 本地上限与客户端请求
 * 超时约束；执行链在调用前后各自检查取消）。
 */
export async function prepareEnterpriseUserContext(params: {
  tenantId: string;
  userIdentityId: string;
  policy: EnterpriseUserAccessPolicy;
  deadlineAt?: Date;
  signal?: AbortSignal;
}): Promise<EnterpriseUserContextCandidate | null> {
  if (params.policy.profileRequirement === "none") return null;
  if (params.userIdentityId === "service-subject") {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "当前部署没有受信企业资料来源",
    );
  }
  let wire: WireEnterpriseUserContextCandidate | null;
  try {
    wire = await fetchEnterpriseUserContext({
      tenantId: params.tenantId,
      userIdentityId: params.userIdentityId,
      profileRequirement: params.policy.profileRequirement,
      allowedFields: params.policy.allowedFields,
      deadlineAt: params.deadlineAt,
    });
  } catch (error) {
    throw mapEnterpriseContextError(error);
  }
  return wire ? reviveCandidate(wire) : null;
}

/** auth-center 错误 → 既有 RequirementError 语义（fail-closed；未知错误原样上抛）。 */
function mapEnterpriseContextError(error: unknown): unknown {
  if (error instanceof EnterpriseContextRpcError) {
    const codeByRemote: Record<string, EnterpriseUserContextRequirementError["code"]> = {
      ENTERPRISE_USER_CONTEXT_DISABLED: "enterprise_user_context_disabled",
      ENTERPRISE_USER_CONTEXT_NOT_FRESH: "enterprise_user_context_not_fresh",
      ENTERPRISE_USER_CONTEXT_UNAVAILABLE: "enterprise_user_context_unavailable",
    };
    return new EnterpriseUserContextRequirementError(
      codeByRemote[error.code] ?? "enterprise_user_context_unavailable",
      error.message,
    );
  }
  if (error instanceof AuthCenterUnavailableError) {
    return new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "统一身份中心不可达，无法装配企业用户资料",
    );
  }
  return error;
}

/** 线上候选 → 内核类型（字段逐个还原；fields 为 JSON 往返值，形状由服务端投影保证）。 */
function reviveCandidate(wire: WireEnterpriseUserContextCandidate): EnterpriseUserContextCandidate {
  return {
    publicContext: {
      context_version: "1",
      profile_status: wire.publicContext.profile_status as "fresh" | "stale",
      last_verified_at: wire.publicContext.last_verified_at,
      fields: wire.publicContext.fields as EnterpriseUserPublicContext["fields"],
    },
    evidence: {
      tenantId: wire.evidence.tenantId,
      userIdentityId: wire.evidence.userIdentityId,
      profileRequirement: wire.evidence
        .profileRequirement as EnterpriseUserAccessPolicy["profileRequirement"],
      sourceSystem: wire.evidence.sourceSystem,
      profileFingerprint: wire.evidence.profileFingerprint,
      lastVerifiedAt: new Date(wire.evidence.lastVerifiedAt),
      freshUntil: new Date(wire.evidence.freshUntil),
      staleUntil: new Date(wire.evidence.staleUntil),
      maxFreshAgeMs: wire.evidence.maxFreshAgeMs,
      maxStaleAgeMs: wire.evidence.maxStaleAgeMs,
    },
  };
}

/**
 * 绑定创建事务内的终稿复核（纯函数）。
 *
 * 复核候选证据的时间戳在当前时刻仍满足要求，并归一 profile_status；
 * 不一致/已失效 → unavailable（fail-closed）。
 */
export function finalizeEnterpriseUserContextCandidate(
  candidate: EnterpriseUserContextCandidate,
  now: Date,
): EnterpriseUserPublicContext {
  const quality = classifyEnterpriseProfileQuality({ now, ...candidate.evidence });
  if (!isAcceptable(quality, candidate.evidence.profileRequirement)) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业资料候选在 AgentCallBinding 创建前已失效",
    );
  }
  if (
    candidate.publicContext.last_verified_at !== candidate.evidence.lastVerifiedAt.toISOString()
  ) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业资料候选与公开投影不一致",
    );
  }
  return { ...candidate.publicContext, profile_status: quality };
}
