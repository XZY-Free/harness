import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAdminPrincipalAsync: vi.fn(),
  requireAdminActionScope: vi.fn(),
  createRequestHostedProvisioning: vi.fn(),
  projectHostedProvisioningRequest: vi.fn(),
  mysqlStoreGetById: vi.fn(),
  mysqlStoreInsert: vi.fn(),
}));

vi.mock("@/lib/admin/route-helpers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/admin/route-helpers")>();
  return {
    ...original,
    resolveAdminPrincipalAsync: mocks.resolveAdminPrincipalAsync,
    requireAdminActionScope: mocks.requireAdminActionScope,
  };
});
vi.mock("@/lib/runtime/provisioning/request-hosted-provisioning", () => ({
  createRequestHostedProvisioning: mocks.createRequestHostedProvisioning,
}));
vi.mock("@/lib/runtime/application/hosted-provisioning-admin-projection", () => ({
  projectHostedProvisioningRequest: mocks.projectHostedProvisioningRequest,
}));
vi.mock("@/lib/runtime/persistence/mysql-hosted-provisioning-request-store", () => ({
  mysqlHostedProvisioningRequestStore: {
    getById: mocks.mysqlStoreGetById,
    insert: mocks.mysqlStoreInsert,
  },
}));

import { POST } from "./route";

const RUNTIME_ONLY_DTO = {
  id: "request-1",
  tenant_id: "tenant-1",
  requester_id: "requester-1",
  route_scope_key: "prod",
  state: "pending",
  current_step: null,
  last_completed_step: null,
  attempt_count: 0,
  next_attempt_at: null,
  last_attempt_at: null,
  lease_expires_at: null,
  last_error: null,
  runtime_id: null,
  runtime_revision_id_checkpoint: null,
  runtime_artifact_id: null,
  runtime_attestation_ids: null,
  conformance_run_id: null,
  runtime_publication_record_id: null,
  route_set_id: null,
  route_set_version_no: null,
  route_id: null,
  route_revision_id: null,
  route_activation_id: null,
  projection_version_no: null,
  workflow_version: "3.0",
  created_at: "2026-08-11T00:00:00.000Z",
  updated_at: "2026-08-11T00:00:00.000Z",
};

/** 工厂返回成功：捕获 deps 与 command。 */
function mockFactorySuccess() {
  const factory = vi.fn(async (command: Record<string, unknown>) => ({
    requestId: "request-1",
    state: "pending",
    retryAfterMs: 5000,
  }));
  mocks.createRequestHostedProvisioning.mockImplementation((deps: unknown) => {
    return factory;
  });
  return { factory, depsOf: mocks.createRequestHostedProvisioning.mock.calls[0]?.[0] };
}

/** SSO 管理员主体：requesterId = principal.userIdentityId。 */
function ssoPrincipal() {
  return { tenantId: "tenant-1", userIdentityId: "user-1" };
}

/** Service Workload 主体：requesterId = principal.serviceId。 */
function servicePrincipal(serviceId: string | null) {
  return {
    tenantId: "tenant-1",
    callerType: "service",
    claims: { tenantId: "tenant-1", type: "service" },
    serviceId,
  };
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/admin/api/v1/hosted-provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

/** 创建后 getById 返回的 runtime-only 行。 */
function runtimeOnlyRow() {
  const now = new Date("2026-08-11T00:00:00.000Z");
  return {
    id: "request-1",
    tenantId: "tenant-1",
    requesterId: "user-1",
    routeScopeKey: "prod",
    state: "pending",
    currentStep: null,
    attemptCount: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    lastAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    stepRuntimeId: null,
    stepRuntimeRevisionId: null,
    stepRuntimeArtifactId: null,
    stepRuntimeAttestationIds: null,
    stepRuntimePublicationRecordId: null,
    stepConformanceRunId: null,
    stepRouteSetId: null,
    stepRouteSetVersionNo: null,
    stepRouteId: null,
    stepRouteRevisionId: null,
    stepRouteActivationId: null,
    stepProjectionVersionNo: null,
    workflowVersion: "3.0",
    lastCompletedStep: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminActionScope.mockResolvedValue({ ok: true });
  mocks.projectHostedProvisioningRequest.mockReturnValue(RUNTIME_ONLY_DTO);
  mocks.mysqlStoreGetById.mockResolvedValue(runtimeOnlyRow());
  mocks.mysqlStoreInsert.mockResolvedValue(runtimeOnlyRow());
});

describe("POST /admin/api/v1/hosted-provisioning（runtime-only）", () => {
  it("SSO 有效 body 到达 auth environment scope、工厂依赖 {store}、命令精确 requester/tenant/scope、202 runtime-only DTO", async () => {
    mocks.resolveAdminPrincipalAsync.mockResolvedValue(ssoPrincipal());
    const { factory } = mockFactorySuccess();

    const response = await post({ route_scope_key: "prod" });

    // 工厂依赖只有 { store }；不含 revisionValidator 或其它。
    expect(mocks.createRequestHostedProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ store: expect.any(Object) }),
    );
    const deps = mocks.createRequestHostedProvisioning.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(deps).sort()).toEqual(["store"]);

    // auth scope：environment scope，id = route_scope_key。
    expect(mocks.requireAdminActionScope).toHaveBeenCalledWith(
      ssoPrincipal(),
      "route.update",
      { type: "environment", id: "prod" },
      expect.any(String),
    );

    // 命令精确：tenantId/requesterId/routeScopeKey；requesterId 来自 SSO userIdentityId。
    expect(factory).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      requesterId: "user-1",
      routeScopeKey: "prod",
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { data?: unknown };
    expect(body.data ?? body).toMatchObject(RUNTIME_ONLY_DTO);
  });

  it("Service 主体用 serviceId 作为 requesterId", async () => {
    mocks.resolveAdminPrincipalAsync.mockResolvedValue(servicePrincipal("svc-1"));
    const { factory } = mockFactorySuccess();

    const response = await post({ route_scope_key: "prod" });

    expect(mocks.requireAdminActionScope).toHaveBeenCalledWith(
      servicePrincipal("svc-1"),
      "route.update",
      { type: "environment", id: "prod" },
      expect.any(String),
    );
    expect(factory).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      requesterId: "svc-1",
      routeScopeKey: "prod",
    });
    expect(response.status).toBe(202);
  });

  it("额外 Agent/runtime/requester key 在 provisioning 调用前返回 schema 错误", async () => {
    mocks.resolveAdminPrincipalAsync.mockResolvedValue(ssoPrincipal());
    const { factory } = mockFactorySuccess();

    for (const extra of [
      { route_scope_key: "prod", agent_id: "a1" },
      { route_scope_key: "prod", agent_revision_id: "ar1" },
      { route_scope_key: "prod", desired_runtime_key: "builtin-hosted" },
      { route_scope_key: "prod", requester_id: "attacker" },
    ]) {
      const response = await post(extra);
      expect(response.status).toBe(400);
      expect(factory).not.toHaveBeenCalled();
    }
  });

  it("空/空白 route_scope_key 在 provisioning 调用前返回 schema 错误", async () => {
    mocks.resolveAdminPrincipalAsync.mockResolvedValue(ssoPrincipal());
    const { factory } = mockFactorySuccess();

    for (const body of [{ route_scope_key: "" }, { route_scope_key: "   " }]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(factory).not.toHaveBeenCalled();
    }
  });

  it("Service 主体 serviceId 为空/空白在 provisioning 前 fail closed", async () => {
    for (const serviceId of [null, "", "   "]) {
      vi.clearAllMocks();
      mocks.requireAdminActionScope.mockResolvedValue({ ok: true });
      mocks.projectHostedProvisioningRequest.mockReturnValue(RUNTIME_ONLY_DTO);
      mocks.resolveAdminPrincipalAsync.mockResolvedValue(servicePrincipal(serviceId));
      const { factory } = mockFactorySuccess();

      const response = await post({ route_scope_key: "prod" });

      // 无有效 requesterId，必须 fail closed（不调用 provisioning 工厂）。
      expect(factory).not.toHaveBeenCalled();
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
});
