import { acceptEnterpriseProfileObservation } from "@/lib/identity/accept-enterprise-profile-observation";
import type { EnterpriseProfileSource } from "@/lib/identity/enterprise-profile-source";
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

export const ENTERPRISE_PROFILE_REFRESH_WAIT_MAX_MS = 10_000;
export const ENTERPRISE_PROFILE_REFRESH_FAILURE_BACKOFF_MS = 30_000;

interface SharedRefreshOperation {
  readonly key: string;
  readonly controller: AbortController;
  readonly startedAt: Date;
  readonly deadlineAt: Date;
  readonly waiters: Set<symbol>;
  promise: Promise<void>;
  timeout: ReturnType<typeof setTimeout> | null;
  phase: "refreshing" | "accepting" | "settled";
  discarded: boolean;
}

const inFlightRefreshes = new Map<string, SharedRefreshOperation>();
const missingSyncFailureUntil = new Map<string, number>();

export function shouldBackoffEnterpriseProfileRefresh(params: {
  lastSyncErrorCode: string | null;
  updatedAt: Date;
  now: Date;
}): boolean {
  return (
    params.lastSyncErrorCode !== null &&
    params.now.getTime() - params.updatedAt.getTime() <
      ENTERPRISE_PROFILE_REFRESH_FAILURE_BACKOFF_MS
  );
}

/** 测试隔离用；生产代码不应调用。 */
export function resetEnterpriseProfileRefreshStateForTest(): void {
  for (const operation of inFlightRefreshes.values()) {
    operation.discarded = true;
    operation.controller.abort(new RefreshOperationAbandonedError("测试重置"));
  }
  inFlightRefreshes.clear();
  missingSyncFailureUntil.clear();
}

export async function prepareEnterpriseUserContext(params: {
  tenantId: string;
  tenantKey?: string;
  userIdentityId: string;
  policy: EnterpriseUserAccessPolicy;
  source?: EnterpriseProfileSource;
  /** 上游已知的绝对截止；未提供时每位等待者仍受 10 秒本地上限保护。 */
  deadlineAt?: Date;
  /** 只供受控测试推进时钟；生产调用不传，跨 await 始终读取真实当前时间。 */
  clock?: () => Date;
  /** 只供受控测试缩短固定的 10 秒上限；生产调用不传。 */
  refreshWaitMaxMs?: number;
  now?: Date;
  signal?: AbortSignal;
}): Promise<EnterpriseUserContextCandidate | null> {
  if (params.policy.profileRequirement === "none") return null;
  if (!params.source?.trusted) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "当前部署没有受信企业资料来源",
    );
  }

  const source = params.source;
  const clock = params.clock ?? (() => params.now ?? new Date());
  const signal = params.signal;
  const waitMaxMs = params.refreshWaitMaxMs ?? ENTERPRISE_PROFILE_REFRESH_WAIT_MAX_MS;
  if (!Number.isFinite(waitMaxMs) || waitMaxMs <= 0) {
    throw new Error("enterprise profile refresh wait max 必须为正数");
  }
  throwIfWaiterFinished(signal, deadlineForWaiter(clock(), params.deadlineAt, waitMaxMs), clock());
  const identity = await getUserIdentityForTenant(params.userIdentityId, params.tenantId);
  if (!identity || identity.status === "disabled") {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_disabled",
      "当前用户身份不可用于企业资料访问",
    );
  }
  const first = await readProfile(params, source, clock());
  if (first && isAcceptable(first.quality, params.policy.profileRequirement)) {
    clearMissingSyncBackoff(
      refreshKey(params.tenantId, params.userIdentityId, source.sourceSystem),
    );
    return buildCandidate(params, source, first);
  }

  if (
    first?.syncState &&
    shouldBackoffEnterpriseProfileRefresh({
      lastSyncErrorCode: first.syncState.lastSyncErrorCode,
      updatedAt: first.syncState.updatedAt,
      now: clock(),
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
  const tenant = params.tenantKey
    ? { key: params.tenantKey }
    : await getTenantById(params.tenantId);
  if (!tenant) {
    throw new EnterpriseUserContextRequirementError(
      "enterprise_user_context_unavailable",
      "企业资料对应的租户不存在",
    );
  }
  const key = refreshKey(params.tenantId, params.userIdentityId, source.sourceSystem);
  const currentNow = clock();
  const waiterDeadline = deadlineForWaiter(currentNow, params.deadlineAt, waitMaxMs);
  throwIfWaiterFinished(signal, waiterDeadline, currentNow);
  if (isMissingSyncBackoffActive(key, currentNow)) {
    throw unavailable("企业资料来源暂不可用");
  }

  const operation = getOrStartSharedRefresh({
    key,
    tenantId: params.tenantId,
    tenantKey: tenant.key,
    userIdentityId: params.userIdentityId,
    identity,
    source,
    requirement: params.policy.profileRequirement,
    hadSyncState: Boolean(first?.syncState),
    clock,
    waitMaxMs,
  });
  const waiter = Symbol("enterprise-profile-waiter");
  operation.waiters.add(waiter);
  try {
    await waitForSharedRefresh(operation.promise, signal, waiterDeadline, clock);
    throwIfWaiterFinished(signal, waiterDeadline, clock());
    const afterRefresh = await readProfile(params, source, clock());
    if (afterRefresh && isAcceptable(afterRefresh.quality, params.policy.profileRequirement)) {
      clearMissingSyncBackoff(key);
      return buildCandidate(params, source, afterRefresh);
    }
    throw unavailable("企业资料刷新后仍不满足当前 Agent 要求");
  } finally {
    operation.waiters.delete(waiter);
    if (operation.waiters.size === 0 && operation.phase === "refreshing" && !operation.discarded) {
      operation.discarded = true;
      operation.controller.abort(new RefreshOperationAbandonedError("所有等待者已离开"));
    }
  }
}

function getOrStartSharedRefresh(params: {
  key: string;
  tenantId: string;
  tenantKey: string;
  userIdentityId: string;
  identity: NonNullable<Awaited<ReturnType<typeof getUserIdentityForTenant>>>;
  source: EnterpriseProfileSource;
  requirement: EnterpriseUserAccessPolicy["profileRequirement"];
  hadSyncState: boolean;
  clock: () => Date;
  waitMaxMs: number;
}): SharedRefreshOperation {
  const existing = inFlightRefreshes.get(params.key);
  if (existing) return existing;

  const startedAt = params.clock();
  const controller = new AbortController();
  let startWork: (() => void) | undefined;
  const work = new Promise<void>((resolve, reject) => {
    startWork = () => {
      void runSharedRefresh(params, operation).then(resolve, reject);
    };
  });
  const operation: SharedRefreshOperation = {
    key: params.key,
    controller,
    startedAt,
    deadlineAt: new Date(startedAt.getTime() + params.waitMaxMs),
    waiters: new Set(),
    promise: Promise.resolve(),
    timeout: null,
    phase: "refreshing",
    discarded: false,
  };
  const abort = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason ?? new RefreshOperationAbandonedError("刷新已取消")),
      { once: true },
    );
  });
  operation.promise = Promise.race([work, abort]).finally(() => {
    operation.phase = "settled";
    if (operation.timeout) clearTimeout(operation.timeout);
    if (inFlightRefreshes.get(operation.key) === operation) {
      inFlightRefreshes.delete(operation.key);
    }
  });
  // source 即使无视 AbortSignal 也可能很晚才结束；显式观察尾部异常，且 runSharedRefresh
  // 会在接纳前检查 discarded，不能回到成功写入路径。
  void work.catch(() => undefined);
  inFlightRefreshes.set(params.key, operation);
  startWork?.();
  operation.timeout = setTimeout(() => {
    // observed 已进入本地接纳后无法安全撤销数据库事务；等待者仍按各自期限结束，
    // 但共享槽位必须保留到接纳 settle，防止同键打开第二次刷新窗口。
    if (operation.discarded || operation.phase === "accepting") return;
    operation.discarded = true;
    controller.abort(new RefreshOperationAbandonedError("共享刷新已超过固定等待上限"));
  }, params.waitMaxMs);
  operation.timeout.unref?.();
  return operation;
}

async function runSharedRefresh(
  params: {
    key: string;
    tenantId: string;
    tenantKey: string;
    userIdentityId: string;
    identity: NonNullable<Awaited<ReturnType<typeof getUserIdentityForTenant>>>;
    source: EnterpriseProfileSource;
    requirement: EnterpriseUserAccessPolicy["profileRequirement"];
    hadSyncState: boolean;
    clock: () => Date;
    waitMaxMs: number;
  },
  operation: SharedRefreshOperation,
): Promise<void> {
  try {
    const refresh = params.source.refresh;
    if (!refresh) {
      throw new RefreshSourceError("enterprise_profile_source_unavailable");
    }
    const current = await readProfile(params, params.source, params.clock());
    if (current && isAcceptable(current.quality, params.requirement)) {
      clearMissingSyncBackoff(params.key);
      return;
    }
    assertSharedRefreshMayProceed(operation, params.clock());
    const result = await refresh({
      subject: {
        tenantId: params.tenantId,
        tenantKey: params.tenantKey,
        externalSubject: params.identity.externalSubject,
      },
      signal: operation.controller.signal,
      deadlineAt: operation.deadlineAt,
      now: params.clock(),
      currentIdentity: {
        email: params.identity.email,
        displayName: params.identity.displayName,
      },
      trustedAuthenticationClaims: {},
    });
    assertSharedRefreshMayProceed(operation, params.clock());
    if (result.status === "observed") {
      operation.phase = "accepting";
      await acceptEnterpriseProfileObservation({
        observation: result.observation,
        source: params.source,
        expectedSubject: {
          tenantId: params.tenantId,
          userIdentityId: params.userIdentityId,
          externalSubject: params.identity.externalSubject,
        },
        now: params.clock(),
      });
      clearMissingSyncBackoff(params.key);
      return;
    }
    if (result.status === "unavailable") {
      throw new RefreshSourceError(result.code ?? "enterprise_profile_source_unavailable");
    }
  } catch (error) {
    if (operation.discarded || error instanceof RefreshOperationAbandonedError) {
      throw error;
    }
    const code = refreshFailureCode(error);
    if (params.hadSyncState) {
      await recordEnterpriseProfileSyncFailure(params.tenantId, params.userIdentityId, code);
    } else {
      rememberMissingSyncFailure(params.key, params.clock());
    }
    throw unavailable("企业资料来源暂不可用");
  }
}

function assertSharedRefreshMayProceed(operation: SharedRefreshOperation, now: Date): void {
  if (
    operation.discarded ||
    operation.controller.signal.aborted ||
    operation.waiters.size === 0 ||
    now.getTime() >= operation.deadlineAt.getTime()
  ) {
    operation.discarded = true;
    if (!operation.controller.signal.aborted) {
      operation.controller.abort(new RefreshOperationAbandonedError("共享刷新不再有有效等待者"));
    }
    throw new RefreshOperationAbandonedError("共享刷新不再有接纳许可");
  }
}

function waitForSharedRefresh(
  refresh: Promise<void>,
  signal: AbortSignal | undefined,
  deadlineAt: Date,
  clock: () => Date,
): Promise<void> {
  const remainingMs = deadlineAt.getTime() - clock().getTime();
  if (remainingMs <= 0) return Promise.reject(unavailable("企业资料准备已超时"));
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(unavailable("企业资料准备已超时")), remainingMs);
    const onAbort = () => finish(unavailable("企业资料准备已取消"));
    const finish = (error?: unknown) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    void refresh.then(() => finish(), finish);
  });
}

function deadlineForWaiter(now: Date, parentDeadline: Date | undefined, waitMaxMs: number): Date {
  const local = new Date(now.getTime() + waitMaxMs);
  return parentDeadline && parentDeadline < local ? parentDeadline : local;
}

function throwIfWaiterFinished(signal: AbortSignal | undefined, deadlineAt: Date, now: Date): void {
  if (signal?.aborted) throw unavailable("企业资料准备已取消");
  if (now.getTime() >= deadlineAt.getTime()) throw unavailable("企业资料准备已超时");
}

function refreshKey(tenantId: string, userIdentityId: string, sourceSystem: string): string {
  return JSON.stringify([tenantId, userIdentityId, sourceSystem]);
}

function isMissingSyncBackoffActive(key: string, now: Date): boolean {
  const until = missingSyncFailureUntil.get(key);
  if (!until) return false;
  if (now.getTime() >= until) {
    missingSyncFailureUntil.delete(key);
    return false;
  }
  return true;
}

function rememberMissingSyncFailure(key: string, now: Date): void {
  const until = now.getTime() + ENTERPRISE_PROFILE_REFRESH_FAILURE_BACKOFF_MS;
  missingSyncFailureUntil.set(key, until);
  const cleanup = setTimeout(() => {
    if (missingSyncFailureUntil.get(key) === until) missingSyncFailureUntil.delete(key);
  }, ENTERPRISE_PROFILE_REFRESH_FAILURE_BACKOFF_MS);
  cleanup.unref?.();
}

function clearMissingSyncBackoff(key: string): void {
  missingSyncFailureUntil.delete(key);
}

function unavailable(message: string): EnterpriseUserContextRequirementError {
  return new EnterpriseUserContextRequirementError("enterprise_user_context_unavailable", message);
}

function refreshFailureCode(error: unknown): string {
  if (error instanceof RefreshSourceError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return "enterprise_profile_refresh_failed";
  }
  return "enterprise_profile_refresh_failed";
}

class RefreshSourceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

class RefreshOperationAbandonedError extends Error {}

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

/** 最终新建分支只复核同一候选的本地期限，不读取更新后的数据库资料。 */
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

function buildCandidate(
  params: {
    tenantId: string;
    userIdentityId: string;
    policy: EnterpriseUserAccessPolicy;
  },
  source: EnterpriseProfileSource,
  profile: NonNullable<Awaited<ReturnType<typeof readProfile>>>,
): EnterpriseUserContextCandidate {
  return {
    publicContext: project(
      params.policy,
      profile.attributes,
      profile.quality as Exclude<EnterpriseProfileQuality, "expired">,
      profile.lastVerifiedAt,
    ),
    evidence: {
      tenantId: params.tenantId,
      userIdentityId: params.userIdentityId,
      profileRequirement: params.policy.profileRequirement,
      sourceSystem: profile.syncState.sourceSystem,
      profileFingerprint: profile.syncState.profileFingerprint,
      lastVerifiedAt: profile.lastVerifiedAt,
      freshUntil: profile.syncState.freshUntil,
      staleUntil: profile.syncState.staleUntil,
      maxFreshAgeMs: source.maxFreshAgeMs,
      maxStaleAgeMs: source.maxStaleAgeMs,
    },
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
