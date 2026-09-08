import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { acceptEnterpriseProfileObservation } from "@/lib/identity/accept-enterprise-profile-observation";
import type {
  EnterpriseProfileObservation,
  EnterpriseProfileSource,
  EnterpriseProfileSourceContext,
  EnterpriseProfileSourceResult,
} from "@/lib/identity/enterprise-profile-source";
import { getEnterpriseUserProfileFacts } from "@/lib/identity/enterprise-user-profile-queries";
import {
  prepareEnterpriseUserContext,
  resetEnterpriseProfileRefreshStateForTest,
} from "@/lib/identity/prepare-enterprise-user-context";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { userIdentity } from "@/lib/persistence/schema/identity";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

const policy = {
  profileRequirement: "fresh_required" as const,
  allowedFields: ["employeeNo", "departmentCode"] as ("employeeNo" | "departmentCode")[],
};

const source: EnterpriseProfileSource = {
  sourceSystem: "directory",
  trusted: true,
  maxFreshAgeMs: 60 * 60_000,
  maxStaleAgeMs: 2 * 60 * 60_000,
};

async function seedIdentity(status: "active" | "disabled" = "active") {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: `employee-context-${status}`,
    email: "employee@example.test",
    displayName: "员工",
  });
  // 测试仅用状态做 setup：普通创建后，用测试专用的 DB 状态更新把身份标记为 disabled。
  // （普通创建路径不拥有 status 写权限。）
  if (status === "disabled") {
    await db
      .update(userIdentity)
      .set({ status: "disabled" })
      .where(eq(userIdentity.id, identity.id));
  }
  return { tenant, identity };
}

function observation(
  tenantId: string,
  externalSubject: string,
  time: string,
): EnterpriseProfileObservation {
  const verifiedAt = new Date(time);
  return {
    tenantId,
    externalSubject,
    sourceSystem: source.sourceSystem,
    attributes: { employeeNo: "E-1", departmentCode: "D-1" },
    verifiedAt,
    freshUntil: new Date(verifiedAt.getTime() + 60 * 60_000),
    staleUntil: new Date(verifiedAt.getTime() + 3 * 60 * 60_000),
  };
}

describe("prepareEnterpriseUserContext", () => {
  afterEach(() => {
    resetEnterpriseProfileRefreshStateForTest();
    vi.restoreAllMocks();
  });

  it("fresh 命中和 stale_allowed 命中都不刷新企业来源", async () => {
    const { tenant, identity } = await seedIdentity();
    const accepted = observation(tenant.id, identity.externalSubject, "2026-09-07T00:00:00.000Z");
    await acceptEnterpriseProfileObservation({
      observation: accepted,
      source,
      expectedSubject: {
        tenantId: tenant.id,
        userIdentityId: identity.id,
        externalSubject: identity.externalSubject,
      },
      now: accepted.verifiedAt,
    });
    const refresh = vi.fn();
    const sourceWithRefresh = { ...source, refresh };

    const fresh = await prepareEnterpriseUserContext({
      tenantId: tenant.id,
      userIdentityId: identity.id,
      policy,
      source: sourceWithRefresh,
      now: new Date("2026-09-07T00:30:00.000Z"),
    });
    expect(fresh?.publicContext).toMatchObject({
      profile_status: "fresh",
      fields: { employeeNo: "E-1" },
    });
    expect(refresh).not.toHaveBeenCalled();

    const staleAllowed = await prepareEnterpriseUserContext({
      tenantId: tenant.id,
      userIdentityId: identity.id,
      policy: { profileRequirement: "stale_allowed", allowedFields: policy.allowedFields },
      source: sourceWithRefresh,
      now: new Date("2026-09-07T01:30:00.000Z"),
    });
    expect(staleAllowed?.publicContext.profile_status).toBe("stale");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("fresh_required 过期时只刷新一次并接纳新观察", async () => {
    const { tenant, identity } = await seedIdentity();
    const old = observation(tenant.id, identity.externalSubject, "2026-09-06T00:00:00.000Z");
    await acceptEnterpriseProfileObservation({
      observation: old,
      source,
      expectedSubject: {
        tenantId: tenant.id,
        userIdentityId: identity.id,
        externalSubject: identity.externalSubject,
      },
      now: old.verifiedAt,
    });
    const refreshed = observation(tenant.id, identity.externalSubject, "2026-09-07T00:30:00.000Z");
    const refresh = vi.fn().mockResolvedValue({ status: "observed", observation: refreshed });
    const context = await prepareEnterpriseUserContext({
      tenantId: tenant.id,
      userIdentityId: identity.id,
      policy,
      source: { ...source, refresh },
      now: new Date("2026-09-07T00:30:00.000Z"),
    });

    expect(context?.publicContext).toMatchObject({
      profile_status: "fresh",
      fields: { employeeNo: "E-1" },
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("停用身份在刷新前 fail closed", async () => {
    const { tenant, identity } = await seedIdentity("disabled");
    const refresh = vi.fn();
    await expect(
      prepareEnterpriseUserContext({
        tenantId: tenant.id,
        userIdentityId: identity.id,
        policy,
        source: { ...source, refresh },
      }),
    ).rejects.toMatchObject({ code: "enterprise_user_context_disabled" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("F06 一个等待者取消不误伤同键另一等待者，资料只刷新和接纳一次", async () => {
    const { tenant, identity } = await seedIdentity();
    const deferred = deferredResult<EnterpriseProfileSourceResult>();
    const refresh = vi.fn(async (_context: EnterpriseProfileSourceContext) => deferred.promise);
    const sourceWithRefresh = { ...source, refresh };
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = prepareEnterpriseUserContext({
      tenantId: tenant.id,
      userIdentityId: identity.id,
      policy,
      source: sourceWithRefresh,
      signal: firstController.signal,
      refreshWaitMaxMs: 200,
    });
    const second = prepareEnterpriseUserContext({
      tenantId: tenant.id,
      userIdentityId: identity.id,
      policy,
      source: sourceWithRefresh,
      signal: secondController.signal,
      refreshWaitMaxMs: 200,
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    firstController.abort(new DOMException("first cancelled", "AbortError"));
    await expect(first).rejects.toMatchObject({ code: "enterprise_user_context_unavailable" });
    const refreshContext = refresh.mock.calls[0]?.[0];
    expect(refreshContext?.signal.aborted).toBe(false);

    const verifiedAt = new Date();
    deferred.resolve({
      status: "observed",
      observation: {
        tenantId: tenant.id,
        externalSubject: identity.externalSubject,
        sourceSystem: source.sourceSystem,
        attributes: { employeeNo: "F06-ONE" },
        verifiedAt,
        freshUntil: new Date(verifiedAt.getTime() + 60_000),
        staleUntil: new Date(verifiedAt.getTime() + 120_000),
      },
    });

    await expect(second).resolves.toMatchObject({
      publicContext: { fields: { employeeNo: "F06-ONE" } },
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("F06 所有等待者在接纳前离开时，忽略 abort 的晚到 observed 不得写入资料", async () => {
    const { tenant, identity } = await seedIdentity();
    const deferred = deferredResult<EnterpriseProfileSourceResult>();
    const refresh = vi.fn(async (_context: EnterpriseProfileSourceContext) => deferred.promise);
    const sourceWithRefresh = { ...source, refresh };
    const controller = new AbortController();
    const pending = prepareEnterpriseUserContext({
      tenantId: tenant.id,
      userIdentityId: identity.id,
      policy,
      source: sourceWithRefresh,
      signal: controller.signal,
      refreshWaitMaxMs: 200,
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ code: "enterprise_user_context_unavailable" });
    expect(refresh.mock.calls[0]?.[0].signal.aborted).toBe(true);

    const verifiedAt = new Date();
    deferred.resolve({
      status: "observed",
      observation: {
        tenantId: tenant.id,
        externalSubject: identity.externalSubject,
        sourceSystem: source.sourceSystem,
        attributes: { employeeNo: "LATE-WRITE-FORBIDDEN" },
        verifiedAt,
        freshUntil: new Date(verifiedAt.getTime() + 60_000),
        staleUntil: new Date(verifiedAt.getTime() + 120_000),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const facts = await getEnterpriseUserProfileFacts(tenant.id, identity.id);
    expect(facts?.attributes ?? []).toEqual([]);
    expect(facts?.syncState).toBeNull();
  });

  it("F06 无同步行失败进入 30 秒进程退避，不造假同步行且到期后只允许一次新刷新", async () => {
    const { tenant, identity } = await seedIdentity();
    let now = new Date("2026-09-07T00:00:00.000Z");
    const refresh = vi.fn(async (_context: EnterpriseProfileSourceContext) => {
      throw new Error("directory unavailable");
    });
    const sourceWithRefresh = { ...source, refresh };
    const request = () =>
      prepareEnterpriseUserContext({
        tenantId: tenant.id,
        userIdentityId: identity.id,
        policy,
        source: sourceWithRefresh,
        clock: () => now,
        refreshWaitMaxMs: 100,
      });

    await expect(request()).rejects.toMatchObject({ code: "enterprise_user_context_unavailable" });
    expect(refresh).toHaveBeenCalledTimes(1);
    const afterFailure = await getEnterpriseUserProfileFacts(tenant.id, identity.id);
    expect(afterFailure?.syncState).toBeNull();

    now = new Date("2026-09-07T00:00:29.999Z");
    await expect(request()).rejects.toMatchObject({ code: "enterprise_user_context_unavailable" });
    expect(refresh).toHaveBeenCalledTimes(1);

    now = new Date("2026-09-07T00:00:30.000Z");
    await expect(request()).rejects.toMatchObject({ code: "enterprise_user_context_unavailable" });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("F06 已有失败退避不能阻断并发写入的有效 B，B 仍优先返回且不刷新", async () => {
    const { tenant, identity } = await seedIdentity();
    let now = new Date("2026-09-07T00:00:00.000Z");
    const refresh = vi.fn(async (_context: EnterpriseProfileSourceContext) => {
      throw new Error("directory unavailable");
    });
    const sourceWithRefresh = { ...source, refresh };
    const request = () =>
      prepareEnterpriseUserContext({
        tenantId: tenant.id,
        userIdentityId: identity.id,
        policy,
        source: sourceWithRefresh,
        clock: () => now,
        refreshWaitMaxMs: 100,
      });

    await expect(request()).rejects.toMatchObject({ code: "enterprise_user_context_unavailable" });
    await acceptEnterpriseProfileObservation({
      observation: {
        tenantId: tenant.id,
        externalSubject: identity.externalSubject,
        sourceSystem: source.sourceSystem,
        attributes: { employeeNo: "B-WINS" },
        verifiedAt: now,
        freshUntil: new Date(now.getTime() + 60_000),
        staleUntil: new Date(now.getTime() + 120_000),
      },
      source,
      expectedSubject: {
        tenantId: tenant.id,
        userIdentityId: identity.id,
        externalSubject: identity.externalSubject,
      },
      now,
    });

    now = new Date("2026-09-07T00:00:01.000Z");
    await expect(request()).resolves.toMatchObject({
      publicContext: { fields: { employeeNo: "B-WINS" } },
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("F06 DB-09 刷新 X 失败时允许明确失败，不以并发提交的 B 伪造 X 成功", async () => {
    const { tenant, identity } = await seedIdentity();
    const old = observation(tenant.id, identity.externalSubject, "2026-09-06T00:00:00.000Z");
    await acceptEnterpriseProfileObservation({
      observation: old,
      source,
      expectedSubject: {
        tenantId: tenant.id,
        userIdentityId: identity.id,
        externalSubject: identity.externalSubject,
      },
      now: old.verifiedAt,
    });
    const deferred = deferredResult<EnterpriseProfileSourceResult>();
    const refresh = vi.fn(async (_context: EnterpriseProfileSourceContext) => deferred.promise);
    const pending = prepareEnterpriseUserContext({
      tenantId: tenant.id,
      userIdentityId: identity.id,
      policy,
      source: { ...source, refresh },
      now: new Date("2026-09-07T00:30:00.000Z"),
      refreshWaitMaxMs: 200,
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    const bTime = new Date("2026-09-07T00:30:00.000Z");
    await acceptEnterpriseProfileObservation({
      observation: {
        tenantId: tenant.id,
        externalSubject: identity.externalSubject,
        sourceSystem: source.sourceSystem,
        attributes: { employeeNo: "B-VALID" },
        verifiedAt: bTime,
        freshUntil: new Date(bTime.getTime() + 60_000),
        staleUntil: new Date(bTime.getTime() + 120_000),
      },
      source,
      expectedSubject: {
        tenantId: tenant.id,
        userIdentityId: identity.id,
        externalSubject: identity.externalSubject,
      },
      now: bTime,
    });
    deferred.reject(new Error("X failed"));

    await expect(pending).rejects.toMatchObject({ code: "enterprise_user_context_unavailable" });
    const facts = await getEnterpriseUserProfileFacts(tenant.id, identity.id);
    expect(
      facts?.attributes.map((attribute) => [attribute.attributeKey, attribute.stringValue]),
    ).toEqual(expect.arrayContaining([["employeeNo", "B-VALID"]]));
    expect(facts?.syncState?.freshUntil).toEqual(new Date(bTime.getTime() + 60_000));
  });

  it("F06 每位等待者受自己的父截止限制，未到共享 10 秒上限也必须结束", async () => {
    const { tenant, identity } = await seedIdentity();
    const never = new Promise<never>(() => undefined);
    const refresh = vi.fn(async (_context: EnterpriseProfileSourceContext) => never);
    const deadlineAt = new Date(Date.now() + 20);

    await expect(
      prepareEnterpriseUserContext({
        tenantId: tenant.id,
        userIdentityId: identity.id,
        policy,
        source: { ...source, refresh },
        deadlineAt,
        refreshWaitMaxMs: 200,
      }),
    ).rejects.toMatchObject({ code: "enterprise_user_context_unavailable" });
    expect(refresh).toHaveBeenCalledOnce();
  });
});

function deferredResult<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
