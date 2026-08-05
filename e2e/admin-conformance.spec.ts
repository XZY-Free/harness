/**
 * S11-W08 端到端管理一致性测试。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md
 *   S11-W08：「管理操作一致性与实际验证」
 *
 * 职责：
 * - 验证 Admin API 在真实 Next.js dev server + MySQL 环境下的安全边界一致性。
 * - 覆盖 6+ 场景：无权限 401、跨租户 404、幂等键守卫、If-Match 守卫、Trace 缺失 404、
 *   无 audience 头 401、Action Scope 拒绝。
 *
 * 不覆盖：
 * - 完整的 If-Match 412 ETAG_MISMATCH 和幂等重放 200 场景 —— 需要预置 action binding +
 *   真实资源（Route/Revision/Export），由单元测试覆盖：
 *   - lib/control-plane/admin-routes.test.ts（If-Match 412 + 幂等重放）
 *   - lib/v11/admin/export-queries.test.ts（导出 CRUD + 审计）
 *   - lib/v11/admin/export-runner.test.ts（导出执行 + 脱敏 + NDJSON）
 * - e2e 环境使用 dev 认证（APP_ENV=test → SNOW_AUTH_MODE=dev），默认用户无 V11 action binding，
 *   action scope 校验返回 403；header 守卫（If-Match/Idempotency-Key）在 action scope 之前校验。
 *
 * 运行：
 *   pnpm test:e2e
 */
import { expect, test } from "@playwright/test";

const ADMIN_BASE = "/admin/api/v1";
const REQUEST_ID_HEADER = "x-request-id";
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const IF_MATCH_HEADER = "if-match";

/** 不存在的 UUID（全零）。用于 404 测试。 */
const NON_EXISTENT_UUID = "00000000-0000-4000-8000-000000000000";

/** V11 错误响应体类型。 */
interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    request_id: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

/**
 * 构造 Workload Token（base64url(JSON)），与 lib/v11/identity/workload-token.ts 的
 * issueWorkloadToken 一致。仅供 e2e 测试构造错误 audience 的 token；生产 token 由
 * 网关 / Invocation Dispatcher 颁发。
 */
function issueWorkloadToken(claims: {
  type: "runtime" | "gateway" | "service";
  tenantId: string;
  audience: string;
  serviceId?: string;
  invocationId?: string;
  runtimeRevisionId?: string;
  expiresAt: number;
}): string {
  const full = { ...claims, issuedAt: Date.now() };
  return Buffer.from(JSON.stringify(full), "utf-8").toString("base64url");
}

/** 从响应解析 V11 错误体。 */
async function parseErrorBody(response: { json: () => Promise<unknown> }): Promise<ApiErrorResponse> {
  return (await response.json()) as ApiErrorResponse;
}

test.describe("S11-W08 管理操作一致性", () => {
  // ─── 1. 无权限 401 — 畸形 Bearer Token ───────────────────

  test("无权限 401：畸形 Bearer Token → AUTHENTICATION_REQUIRED", async ({ request }) => {
    const response = await request.post(`${ADMIN_BASE}/exports`, {
      headers: {
        authorization: "Bearer malformed-token",
        "content-type": "application/json",
        [IDEMPOTENCY_KEY_HEADER]: "idem-e2e-malformed-bearer",
      },
      data: { export_kind: "audit_events" },
    });

    expect(response.status()).toBe(401);
    const body = await parseErrorBody(response);
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.retryable).toBe(false);
    // X-Request-ID header 应同时透传
    const requestIdHeader = response.headers()[REQUEST_ID_HEADER];
    expect(requestIdHeader).toBeTruthy();
    expect(requestIdHeader).toBe(body.error.request_id);
  });

  // ─── 2. 无 audience 头 401 — 错误 audience Bearer Token ───

  test("无 audience 头 401：错误 audience Bearer Token → AUTHENTICATION_REQUIRED", async ({
    request,
  }) => {
    // 颁发 audience=employee 的 service token，发送到 admin 端点 → audience_mismatch
    const token = issueWorkloadToken({
      type: "service",
      tenantId: NON_EXISTENT_UUID,
      audience: "employee",
      serviceId: "cicd",
      expiresAt: Date.now() + 600_000,
    });

    const response = await request.post(`${ADMIN_BASE}/exports`, {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [IDEMPOTENCY_KEY_HEADER]: "idem-e2e-wrong-audience",
      },
      data: { export_kind: "audit_events" },
    });

    expect(response.status()).toBe(401);
    const body = await parseErrorBody(response);
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.retryable).toBe(false);
  });

  // ─── 3. Trace 缺失 404 ───────────────────────────────────

  test("Trace 缺失 404：不存在的 Trace → RESOURCE_NOT_FOUND", async ({ request }) => {
    const response = await request.get(`${ADMIN_BASE}/traces/${NON_EXISTENT_UUID}`);

    expect(response.status()).toBe(404);
    const body = await parseErrorBody(response);
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.retryable).toBe(false);
  });

  // ─── 4. 跨租户 404 — 不存在的 Span（隐藏式 404）──────────

  test("跨租户 404：不存在的 Span（隐藏式 404）→ RESOURCE_NOT_FOUND", async ({ request }) => {
    const response = await request.get(`${ADMIN_BASE}/spans/${NON_EXISTENT_UUID}`);

    expect(response.status()).toBe(404);
    const body = await parseErrorBody(response);
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.retryable).toBe(false);
  });

  // ─── 5. If-Match 一致性 — 缺少 If-Match ──────────────────

  test("If-Match 守卫：PUT deployment-routes 缺少 If-Match → REQUEST_SCHEMA_INVALID", async ({
    request,
  }) => {
    const response = await request.put(`${ADMIN_BASE}/deployment-routes/${NON_EXISTENT_UUID}`, {
      headers: {
        "content-type": "application/json",
        [IDEMPOTENCY_KEY_HEADER]: "idem-e2e-missing-ifmatch",
      },
      data: {
        route_set_id: NON_EXISTENT_UUID,
        agent_revision_id: NON_EXISTENT_UUID,
        runtime_revision_id: NON_EXISTENT_UUID,
        traffic_weight: 10000,
        priority_no: 1,
        route_state: "enabled",
      },
    });

    expect(response.status()).toBe(400);
    const body = await parseErrorBody(response);
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.retryable).toBe(false);
  });

  // ─── 6. If-Match 格式校验 — 畸形 ETag ────────────────────

  test("If-Match 格式校验：畸形 ETag → REQUEST_SCHEMA_INVALID", async ({ request }) => {
    const response = await request.put(`${ADMIN_BASE}/deployment-routes/${NON_EXISTENT_UUID}`, {
      headers: {
        "content-type": "application/json",
        [IDEMPOTENCY_KEY_HEADER]: "idem-e2e-malformed-ifmatch",
        [IF_MATCH_HEADER]: '"invalid-etag-format"',
      },
      data: {
        route_set_id: NON_EXISTENT_UUID,
        agent_revision_id: NON_EXISTENT_UUID,
        runtime_revision_id: NON_EXISTENT_UUID,
        traffic_weight: 10000,
        priority_no: 1,
        route_state: "enabled",
      },
    });

    expect(response.status()).toBe(400);
    const body = await parseErrorBody(response);
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.retryable).toBe(false);
  });

  // ─── 7. 幂等键一致性 — 缺少 Idempotency-Key ──────────────

  test("幂等键守卫：PUT deployment-routes 缺少 Idempotency-Key → REQUEST_SCHEMA_INVALID", async ({
    request,
  }) => {
    const response = await request.put(`${ADMIN_BASE}/deployment-routes/${NON_EXISTENT_UUID}`, {
      headers: {
        "content-type": "application/json",
        [IF_MATCH_HEADER]: '"route-set-1"',
      },
      data: {
        route_set_id: NON_EXISTENT_UUID,
        agent_revision_id: NON_EXISTENT_UUID,
        runtime_revision_id: NON_EXISTENT_UUID,
        traffic_weight: 10000,
        priority_no: 1,
        route_state: "enabled",
      },
    });

    expect(response.status()).toBe(400);
    const body = await parseErrorBody(response);
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.retryable).toBe(false);
  });

  // ─── 8. Action Scope 一致性 — POST exports → 403 ─────────

  test("Action Scope 一致性：POST exports 缺少 action binding → ACTION_SCOPE_DENIED", async ({
    request,
  }) => {
    // dev 认证（无 Authorization header）→ 默认用户无 admin.export.create action binding
    const response = await request.post(`${ADMIN_BASE}/exports`, {
      headers: {
        "content-type": "application/json",
        [IDEMPOTENCY_KEY_HEADER]: "idem-e2e-action-scope-post",
      },
      data: { export_kind: "audit_events" },
    });

    expect(response.status()).toBe(403);
    const body = await parseErrorBody(response);
    expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.retryable).toBe(false);
  });

  // ─── 9. Action Scope 一致性 — GET exports → 403 ──────────

  test("Action Scope 一致性：GET exports 缺少 action binding → ACTION_SCOPE_DENIED", async ({
    request,
  }) => {
    const response = await request.get(`${ADMIN_BASE}/exports`);

    expect(response.status()).toBe(403);
    const body = await parseErrorBody(response);
    expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.retryable).toBe(false);
  });
});
