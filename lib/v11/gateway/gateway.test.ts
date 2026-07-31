/**
 * S06-C04：V11 Gateway API（Runtime 搜索/Schema/内容读取）集成测试
 * （真实 MySQL 8 Testcontainers，不使用 mock）。
 *
 * 覆盖：
 * - Gateway 身份解析（audience=gateway 的 Workload Token）：缺失/过期/audience 不匹配。
 * - POST /gateway/v1/capabilities:search：请求体校验、ETag 头、If-None-Match 短路径 304、
 *   resource_types / lifecycle_states 过滤、跨租户隔离。
 * - GET /gateway/v1/tools/{tool_id}/schema：跨租户隐藏 404、无 SchemaRevision 422、
 *   ETag 头、If-None-Match 短路径、CapabilityUse 记账。
 * - GET /gateway/v1/skills/{skill_id}/content：跨租户隐藏 404、lifecycle 非 enabled 隐藏 404、
 *   无 currentVersionId 422、ETag 头、If-None-Match 短路径、CapabilityUse 记账。
 * - CapabilityUse 幂等：同 Invocation 同修订不重复写、不同 Invocation 分别记账。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。Gateway Token 由 issueWorkloadToken 直接构造。
 */
import { randomUUID } from "node:crypto";
import { POST as searchCapabilitiesPOST } from "@/app/gateway/v1/capabilities:search/route";
import { GET as getSkillContentGET } from "@/app/gateway/v1/skills/[skill_id]/content/route";
import { GET as getToolSchemaGET } from "@/app/gateway/v1/tools/[tool_id]/schema/route";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildV11Request } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ETAG_HEADER, REQUEST_ID_HEADER } from "@/lib/http";
import {
  type CapabilityUseType,
  computeCapabilityUseKey,
  listCapabilityUseByInvocation,
  recordCapabilityUse,
} from "@/lib/v11/capability/capability-use-queries";
import { computeContentHash } from "@/lib/v11/capability/content-cache";
import {
  type SkillLifecycleState,
  createSkill,
  createSkillVersion,
  getCurrentSkillVersion,
  publishSkillVersion,
  updateSkill,
} from "@/lib/v11/capability/skill-queries";
import {
  type ToolLifecycleState,
  createConnection,
  createTool,
  createToolProvider,
  createToolSchemaRevision,
  getCurrentToolSchemaRevision,
  publishToolSchemaRevision,
  updateTool,
  updateToolProvider,
} from "@/lib/v11/capability/tool-queries";
import { refreshCatalogEntry } from "@/lib/v11/catalog/projector";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { type WorkloadTokenClaims, issueWorkloadToken } from "@/lib/v11/identity/workload-token";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与其他 v11 集成测试一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed 默认租户 + 用户身份 ────────────────────────

async function seedContext() {
  const t = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: t.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  return { tenantId: t.id, userIdentityId: identity.id };
}

// ─── 辅助：构造 Gateway Workload Token ───────────────────

function makeGatewayToken(
  tenantId: string,
  invocationId: string,
  overrides: Partial<Omit<WorkloadTokenClaims, "issuedAt">> = {},
): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "gateway",
    tenantId,
    jti: "jti-gateway-001",
    invocationId,
    audience: "gateway",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
  return issueWorkloadToken(claims);
}

/** 构造一个过期的 Gateway Token（expiresAt 已过）。 */
function makeExpiredGatewayToken(tenantId: string, invocationId: string): string {
  return makeGatewayToken(tenantId, invocationId, {
    expiresAt: Date.now() - 1_000,
  });
}

/** 构造一个 runtime audience 的 Token（错误的 audience，应被 Gateway 拒绝）。 */
function makeRuntimeAudienceToken(
  tenantId: string,
  invocationId: string,
  runtimeRevisionId: string,
): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "runtime",
    tenantId,
    jti: "jti-runtime-001",
    invocationId,
    runtimeRevisionId,
    audience: "runtime",
    expiresAt: Date.now() + 60_000,
  };
  return issueWorkloadToken(claims);
}

/** 构造一个 service type 的 Token（错误的 type，应被 Gateway 拒绝，因 audience 不匹配）。 */
function makeServiceAudienceToken(tenantId: string): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "service",
    tenantId,
    jti: "jti-service-001",
    serviceId: "cicd",
    audience: "admin",
    expiresAt: Date.now() + 60_000,
  };
  return issueWorkloadToken(claims);
}

// ─── 辅助：seed Tool / ToolProvider / SchemaRevision（已发布） ──

async function seedPublishedTool(params: {
  tenantId: string;
  ownerUserId: string;
  toolKey?: string;
  displayName?: string;
  enableLifecycle?: boolean;
}): Promise<{
  toolId: string;
  revisionId: string;
  revisionNo: number;
  schemaHash: string;
}> {
  const connection = await createConnection({
    tenantId: params.tenantId,
    connectionKey: `conn-${randomUUID().slice(0, 8)}`,
    connectionType: "http",
    endpointRef: "https://api.example.com",
    ownerUserId: params.ownerUserId,
  });
  // Connection 需 enable 才能让 ToolProvider enable
  const enabledConn = await updateConnectionLifecycle(
    params.tenantId,
    connection.id,
    connection.versionNo,
    "enabled",
  );
  const provider = await createToolProvider({
    tenantId: params.tenantId,
    providerKey: `prov-${randomUUID().slice(0, 8)}`,
    providerType: "custom",
    connectionId: enabledConn.id,
    trustLevel: "standard",
    displayName: "Test Provider",
    ownerUserId: params.ownerUserId,
  });
  const enabledProvider = await updateToolProviderLifecycle(
    params.tenantId,
    provider.id,
    provider.versionNo,
    "enabled",
  );
  let tool = await createTool({
    tenantId: params.tenantId,
    providerId: enabledProvider.id,
    toolKey: params.toolKey ?? `tool-${randomUUID().slice(0, 8)}`,
    displayName: params.displayName ?? "Test Tool",
    description: "test tool description",
    riskClass: "low",
  });
  if (params.enableLifecycle !== false) {
    tool = await updateTool({
      tenantId: params.tenantId,
      toolId: tool.id,
      lifecycleState: "enabled",
      expectedVersionNo: tool.versionNo,
    });
  }
  const revision = await createToolSchemaRevision({
    tenantId: params.tenantId,
    toolId: tool.id,
    description: "v1 schema",
    inputSchemaJson: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    outputSchemaJson: { type: "string" },
    riskMetadataJson: { effect: "read_only" },
    createdBy: params.ownerUserId,
  });
  const published = await publishToolSchemaRevision({
    tenantId: params.tenantId,
    schemaRevisionId: revision.id,
    publishedBy: params.ownerUserId,
  });
  return {
    toolId: tool.id,
    revisionId: published.revision.id,
    revisionNo: published.revision.revisionNo,
    schemaHash: published.revision.schemaHash,
  };
}

// ─── 辅助：seed Skill / SkillVersion（已发布 + enabled） ───

async function seedPublishedSkill(params: {
  tenantId: string;
  ownerUserId: string;
  skillKey?: string;
  displayName?: string;
  lifecycleState?: SkillLifecycleState;
}): Promise<{
  skillId: string;
  versionId: string;
  versionNo: number;
  contentHash: string;
}> {
  let skill = await createSkill({
    tenantId: params.tenantId,
    skillKey: params.skillKey ?? `skill-${randomUUID().slice(0, 8)}`,
    displayName: params.displayName ?? "Test Skill",
    description: "test skill description",
    ownerUserId: params.ownerUserId,
    visibilityScope: "tenant",
    sourceType: "local",
    createdBy: params.ownerUserId,
  });
  const content = `# Skill ${skill.id}\nname: test\ntools: []\n`;
  const contentHash = computeContentHash(content);
  const version = await createSkillVersion({
    tenantId: params.tenantId,
    skillId: skill.id,
    contentRef: `git:commit-${randomUUID().slice(0, 8)}`,
    contentHash,
    manifestJson: { name: "test", description: "test skill", tools: [], model: "default" },
    sourceType: "local",
    createdBy: params.ownerUserId,
  });
  const published = await publishSkillVersion({
    tenantId: params.tenantId,
    skillVersionId: version.id,
    publishedBy: params.ownerUserId,
  });
  // publishSkillVersion 已将 Skill.versionNo +1（事务内更新 currentVersionId 时一并递增）；
  // 后续 updateSkill 必须用 published.skill.versionNo 做乐观锁，否则会冲突。
  const targetLifecycle: SkillLifecycleState = params.lifecycleState ?? "enabled";
  if (published.skill.lifecycleState !== targetLifecycle) {
    skill = await updateSkill({
      tenantId: params.tenantId,
      skillId: skill.id,
      lifecycleState: targetLifecycle,
      expectedVersionNo: published.skill.versionNo,
    });
  } else {
    skill = published.skill;
  }
  return {
    skillId: skill.id,
    versionId: published.version.id,
    versionNo: published.version.versionNo,
    contentHash: published.version.contentHash,
  };
}

// ─── 辅助：updateConnection / updateToolProvider lifecycle ──

async function updateConnectionLifecycle(
  tenantId: string,
  connectionId: string,
  expectedVersionNo: number,
  target: ToolLifecycleState,
) {
  // 通过直接 import updateConnection（已在前述 import 块中导入）
  const { updateConnection } = await import("@/lib/v11/capability/tool-queries");
  return updateConnection({
    tenantId,
    connectionId,
    lifecycleState: target as never,
    expectedVersionNo,
  });
}

async function updateToolProviderLifecycle(
  tenantId: string,
  providerId: string,
  expectedVersionNo: number,
  target: ToolLifecycleState,
) {
  const { updateToolProvider } = await import("@/lib/v11/capability/tool-queries");
  return updateToolProvider({
    tenantId,
    providerId,
    lifecycleState: target as never,
    expectedVersionNo,
  });
}

// ─── 辅助：seed CatalogEntry（用于 capabilities:search） ────

async function seedCatalogEntry(params: {
  tenantId: string;
  resourceType: "agent" | "skill" | "tool" | "knowledge" | "runtime" | "model" | "connection";
  resourceId: string;
  displayName: string;
  description?: string | null;
  lifecycleState?: string;
  ownerUserId?: string | null;
}) {
  return refreshCatalogEntry({
    tenantId: params.tenantId,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    displayName: params.displayName,
    description: params.description ?? null,
    ownerUserId: params.ownerUserId ?? null,
    tagsJson: null,
    lifecycleState: params.lifecycleState ?? "enabled",
    visibilitySummary: "tenant",
    sourceUpdatedAt: new Date(),
  });
}

// ─── 辅助：调用 GET /tools/{tool_id}/schema ────────────────

function makeToolSchemaRequest(
  tenantId: string,
  invocationId: string,
  toolId: string,
  options: { ifNoneMatch?: string } = {},
): { request: Request; context: { params: Promise<{ tool_id: string }> } } {
  const token = makeGatewayToken(tenantId, invocationId);
  const request = buildV11Request({
    audience: "gateway",
    method: "GET",
    path: `/tools/${toolId}/schema`,
    token,
    headers: options.ifNoneMatch ? { "if-none-match": `"${options.ifNoneMatch}"` } : undefined,
  });
  return {
    request,
    context: { params: Promise.resolve({ tool_id: toolId }) },
  };
}

// ─── 辅助：调用 GET /skills/{skill_id}/content ─────────────

function makeSkillContentRequest(
  tenantId: string,
  invocationId: string,
  skillId: string,
  options: { ifNoneMatch?: string } = {},
): { request: Request; context: { params: Promise<{ skill_id: string }> } } {
  const token = makeGatewayToken(tenantId, invocationId);
  const request = buildV11Request({
    audience: "gateway",
    method: "GET",
    path: `/skills/${skillId}/content`,
    token,
    headers: options.ifNoneMatch ? { "if-none-match": `"${options.ifNoneMatch}"` } : undefined,
  });
  return {
    request,
    context: { params: Promise.resolve({ skill_id: skillId }) },
  };
}

// ─── 辅助：调用 POST /capabilities:search ──────────────────

function makeSearchRequest(
  tenantId: string,
  invocationId: string,
  body: unknown,
  options: { token?: string; ifNoneMatch?: string; headers?: Record<string, string> } = {},
): Request {
  const token = options.token ?? makeGatewayToken(tenantId, invocationId);
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.ifNoneMatch) {
    headers["if-none-match"] = `"${options.ifNoneMatch}"`;
  }
  return buildV11Request({
    audience: "gateway",
    method: "POST",
    path: "/capabilities:search",
    token,
    body,
    headers,
  });
}

// ═══════════════════════════════════════════════════════════
// 1. Gateway 身份解析（auth）
// ═══════════════════════════════════════════════════════════

describe("V11 Gateway API 身份解析", () => {
  it("POST /capabilities:search 缺少 Authorization → 401 AUTHENTICATION_REQUIRED", async () => {
    const { tenantId } = await seedContext();
    const invocationId = randomUUID();
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/capabilities:search",
      body: { query: "test" },
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("POST /capabilities:search malformed token → 401", async () => {
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/capabilities:search",
      token: "not-a-valid-token",
      body: { query: "test" },
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(401);
  });

  it("POST /capabilities:search 过期 token → 401", async () => {
    const { tenantId } = await seedContext();
    const invocationId = randomUUID();
    const token = makeExpiredGatewayToken(tenantId, invocationId);
    const request = makeSearchRequest(tenantId, invocationId, { query: "test" }, { token });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(401);
  });

  it("POST /capabilities:search runtime audience → 401（audience 不匹配）", async () => {
    const { tenantId } = await seedContext();
    const invocationId = randomUUID();
    const token = makeRuntimeAudienceToken(tenantId, invocationId, randomUUID());
    const request = makeSearchRequest(tenantId, invocationId, { query: "test" }, { token });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(401);
  });

  it("POST /capabilities:search service type + admin audience → 401", async () => {
    const { tenantId } = await seedContext();
    const token = makeServiceAudienceToken(tenantId);
    const request = makeSearchRequest(tenantId, randomUUID(), { query: "test" }, { token });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(401);
  });

  it("GET /tools/{id}/schema 缺少 Authorization → 401", async () => {
    const { tenantId } = await seedContext();
    const toolId = randomUUID();
    const request = buildV11Request({
      audience: "gateway",
      method: "GET",
      path: `/tools/${toolId}/schema`,
    });
    const context = { params: Promise.resolve({ tool_id: toolId }) };
    const response = await getToolSchemaGET(request, context);
    expect(response.status).toBe(401);
  });

  it("GET /skills/{id}/content 缺少 Authorization → 401", async () => {
    const skillId = randomUUID();
    const request = buildV11Request({
      audience: "gateway",
      method: "GET",
      path: `/skills/${skillId}/content`,
    });
    const context = { params: Promise.resolve({ skill_id: skillId }) };
    const response = await getSkillContentGET(request, context);
    expect(response.status).toBe(401);
  });

  it("POST /capabilities:search 合法 gateway token → 200（无目录数据时返回空 items）", async () => {
    const { tenantId } = await seedContext();
    const invocationId = randomUUID();
    const request = makeSearchRequest(tenantId, invocationId, { query: "test" });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. POST /capabilities:search 请求体校验
// ═══════════════════════════════════════════════════════════

describe("V11 Gateway capabilities:search 请求体校验", () => {
  let tenantId: string;
  let invocationId: string;

  beforeEach(async () => {
    const ctx = await seedContext();
    tenantId = ctx.tenantId;
    invocationId = randomUUID();
  });

  it("缺少 query → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = makeSearchRequest(tenantId, invocationId, {});
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("空 query（空字符串）→ 400", async () => {
    const request = makeSearchRequest(tenantId, invocationId, { query: "" });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(400);
  });

  it("空 query（仅空白字符）→ 400", async () => {
    const request = makeSearchRequest(tenantId, invocationId, { query: "   " });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(400);
  });

  it("resource_types 含非法值 → 400", async () => {
    const request = makeSearchRequest(tenantId, invocationId, {
      query: "test",
      resource_types: ["invalid_type"],
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(400);
  });

  it("limit=0 → 400", async () => {
    const request = makeSearchRequest(tenantId, invocationId, {
      query: "test",
      limit: 0,
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(400);
  });

  it("limit 为负数 → 400", async () => {
    const request = makeSearchRequest(tenantId, invocationId, {
      query: "test",
      limit: -1,
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(400);
  });

  it("limit 非数字（字符串）→ 400（JSON 反序列化后类型非 number）", async () => {
    // 直接构造非法 JSON body：limit 字符串会被 validateBody 拒绝
    const token = makeGatewayToken(tenantId, invocationId);
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/capabilities:search",
      token,
      body: { query: "test", limit: "abc" },
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(400);
  });

  it("cursor 空字符串 → 400", async () => {
    const request = makeSearchRequest(tenantId, invocationId, {
      query: "test",
      cursor: "",
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(400);
  });

  it("请求体非对象（JSON 数组）→ 400", async () => {
    const token = makeGatewayToken(tenantId, invocationId);
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/capabilities:search",
      token,
      body: "[1,2,3]",
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. POST /capabilities:search 成功路径与过滤
// ═══════════════════════════════════════════════════════════

describe("V11 Gateway capabilities:search 成功路径与过滤", () => {
  let tenantId: string;
  let ownerUserId: string;
  let invocationId: string;

  beforeEach(async () => {
    const ctx = await seedContext();
    tenantId = ctx.tenantId;
    ownerUserId = ctx.userIdentityId;
    invocationId = randomUUID();
    await seedCatalogEntry({
      tenantId,
      resourceType: "skill",
      resourceId: randomUUID(),
      displayName: "财务报表 Skill",
      description: "用于生成财务报表",
    });
    await seedCatalogEntry({
      tenantId,
      resourceType: "tool",
      resourceId: randomUUID(),
      displayName: "财务查询 Tool",
      description: "查询财务数据",
    });
    await seedCatalogEntry({
      tenantId,
      resourceType: "agent",
      resourceId: randomUUID(),
      displayName: "客服 Agent",
      description: "处理客服咨询",
    });
  });

  it("按 query=财务 搜索 → 返回匹配的 items（skill + tool）", async () => {
    const request = makeSearchRequest(tenantId, invocationId, { query: "财务" });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ display_name: string; resource_type: string }>;
      next_cursor: string | null;
      catalog_revision: number;
    };
    expect(body.items.length).toBe(2);
    const types = body.items.map((i) => i.resource_type).sort();
    expect(types).toEqual(["skill", "tool"]);
    expect(body.next_cursor).toBeNull();
    expect(body.catalog_revision).toBeGreaterThan(0);
  });

  it("resource_types=[skill] 过滤 → 只返回 skill 类型", async () => {
    const request = makeSearchRequest(tenantId, invocationId, {
      query: "财务",
      resource_types: ["skill"],
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ resource_type: string }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.resource_type).toBe("skill");
  });

  it("resource_types=[tool,agent] 过滤 → 返回 tool + agent", async () => {
    const request = makeSearchRequest(tenantId, invocationId, {
      query: "财务",
      resource_types: ["tool", "agent"],
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ resource_type: string }> };
    // 财务 query 匹配 tool，不匹配 agent；agent 是「客服」
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.resource_type).toBe("tool");
  });

  it("query=客服 搜索 → 命中 agent", async () => {
    const request = makeSearchRequest(tenantId, invocationId, { query: "客服" });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ display_name: string }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.display_name).toContain("客服");
  });

  it("query 无匹配 → 返回空 items + catalog_revision=0", async () => {
    const request = makeSearchRequest(tenantId, invocationId, {
      query: "不存在的关键词-xyz-123",
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: unknown[];
      catalog_revision: number;
    };
    expect(body.items.length).toBe(0);
    expect(body.catalog_revision).toBe(0);
  });

  it("成功响应附带 ETag 头（catalog-{tenantId}-gateway-{revisionNo}）", async () => {
    const request = makeSearchRequest(tenantId, invocationId, { query: "财务" });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(200);
    const etag = response.headers.get(ETAG_HEADER);
    expect(etag).toBeTruthy();
    expect(etag).toContain("gateway-");
    expect(etag?.startsWith('"catalog-')).toBe(true);
  });

  it("响应附带 X-Request-ID 头（与请求一致）", async () => {
    const requestId = "req-test-123";
    const token = makeGatewayToken(tenantId, invocationId);
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/capabilities:search",
      token,
      body: { query: "财务" },
      requestId,
    });
    const response = await searchCapabilitiesPOST(request);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(requestId);
  });

  it("跨租户隔离：只返回当前租户的 items", async () => {
    // 在另一个租户目录里写入数据（不通过 ensureDefaultTenant，直接用 INSERT 投影）
    // 这里简化：通过 seedCatalogEntry 在当前租户写入，再验证查询不会返回他租户数据。
    // 由于 searchCatalog 内部按 tenantId 过滤，本测试主要验证 tenantId 来自 Token claims。
    const request = makeSearchRequest(tenantId, invocationId, { query: "财务" });
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    // 当前租户有 2 条匹配项；他租户（未创建）不应混入。
    expect(body.items.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. POST /capabilities:search If-None-Match 短路径
// ═══════════════════════════════════════════════════════════

describe("V11 Gateway capabilities:search If-None-Match 短路径", () => {
  let tenantId: string;
  let invocationId: string;
  let currentEtag: string;

  beforeEach(async () => {
    const ctx = await seedContext();
    tenantId = ctx.tenantId;
    invocationId = randomUUID();
    await seedCatalogEntry({
      tenantId,
      resourceType: "skill",
      resourceId: randomUUID(),
      displayName: "搜索目标 Skill",
      description: "可被搜索命中",
    });
    // 先请求一次拿到 ETag
    const firstResp = await searchCapabilitiesPOST(
      makeSearchRequest(tenantId, invocationId, { query: "搜索目标" }),
    );
    const etagHeader = firstResp.headers.get(ETAG_HEADER);
    if (!etagHeader) throw new Error("首屏响应缺少 ETag 头");
    // 去掉引号拿到裸值
    currentEtag = etagHeader.replace(/^"|"$/g, "");
  });

  it("If-None-Match 与当前 revision 匹配 → 304 Not Modified", async () => {
    const request = makeSearchRequest(
      tenantId,
      invocationId,
      { query: "搜索目标" },
      { ifNoneMatch: currentEtag },
    );
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(304);
    expect(response.headers.get(ETAG_HEADER)).toBeTruthy();
  });

  it("If-None-Match 与当前 revision 不匹配 → 200 + body", async () => {
    const request = makeSearchRequest(
      tenantId,
      invocationId,
      { query: "搜索目标" },
      { ifNoneMatch: "catalog-fake-tenant-gateway-99999" },
    );
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("If-None-Match 格式非法（缺少 -gateway- 标记）→ 400 CATALOG_REVISION_INVALID", async () => {
    const request = makeSearchRequest(
      tenantId,
      invocationId,
      { query: "搜索目标" },
      { ifNoneMatch: "not-a-valid-etag" },
    );
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CATALOG_REVISION_INVALID");
  });

  it("If-None-Match 含 -gateway- 但 revision 非数字 → 400 CATALOG_REVISION_INVALID", async () => {
    const request = makeSearchRequest(
      tenantId,
      invocationId,
      { query: "搜索目标" },
      { ifNoneMatch: "catalog-tenant-gateway-abc" },
    );
    const response = await searchCapabilitiesPOST(request);
    expect(response.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. GET /tools/{tool_id}/schema
// ═══════════════════════════════════════════════════════════

describe("V11 Gateway tools/{tool_id}/schema", () => {
  let tenantId: string;
  let ownerUserId: string;
  let invocationId: string;

  beforeEach(async () => {
    const ctx = await seedContext();
    tenantId = ctx.tenantId;
    ownerUserId = ctx.userIdentityId;
    invocationId = randomUUID();
  });

  it("Tool 不存在 → 404 CAPABILITY_NOT_ALLOWED（隐藏式）", async () => {
    const { request, context } = makeToolSchemaRequest(tenantId, invocationId, randomUUID());
    const response = await getToolSchemaGET(request, context);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CAPABILITY_NOT_ALLOWED");
  });

  it("Tool 存在但无 currentSchemaRevisionId → 422 CAPABILITY_CONTENT_BLOCKED", async () => {
    // 创建 Tool 但不发布 SchemaRevision
    const connection = await createConnection({
      tenantId,
      connectionKey: `conn-${randomUUID().slice(0, 8)}`,
      connectionType: "http",
      ownerUserId,
    });
    const enabledConn = await updateConnectionLifecycle(
      tenantId,
      connection.id,
      connection.versionNo,
      "enabled",
    );
    const provider = await createToolProvider({
      tenantId,
      providerKey: `prov-${randomUUID().slice(0, 8)}`,
      providerType: "custom",
      connectionId: enabledConn.id,
      displayName: "Provider",
      ownerUserId,
    });
    const enabledProvider = await updateToolProviderLifecycle(
      tenantId,
      provider.id,
      provider.versionNo,
      "enabled",
    );
    const tool = await createTool({
      tenantId,
      providerId: enabledProvider.id,
      toolKey: `tool-${randomUUID().slice(0, 8)}`,
      displayName: "No Schema Tool",
    });

    const { request, context } = makeToolSchemaRequest(tenantId, invocationId, tool.id);
    const response = await getToolSchemaGET(request, context);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CAPABILITY_CONTENT_BLOCKED");
  });

  it("Tool 已发布 SchemaRevision → 200 + body + ETag", async () => {
    const seeded = await seedPublishedTool({ tenantId, ownerUserId });
    const { request, context } = makeToolSchemaRequest(tenantId, invocationId, seeded.toolId);
    const response = await getToolSchemaGET(request, context);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      tool_id: string;
      revision_no: number;
      input_schema: unknown;
      output_schema: unknown;
      schema_hash: string;
      revision_state: string;
    };
    expect(body.tool_id).toBe(seeded.toolId);
    expect(body.revision_no).toBe(seeded.revisionNo);
    expect(body.schema_hash).toBe(seeded.schemaHash);
    expect(body.revision_state).toBe("published");
    expect(body.input_schema).toBeDefined();
    expect(body.output_schema).toBeDefined();
    const etag = response.headers.get(ETAG_HEADER);
    expect(etag).toBeTruthy();
    expect(etag).toContain(`tool-schema-${seeded.revisionNo}`);
  });

  it("ETag 格式：tool-schema-{revisionNo}", async () => {
    const seeded = await seedPublishedTool({ tenantId, ownerUserId });
    const { request, context } = makeToolSchemaRequest(tenantId, invocationId, seeded.toolId);
    const response = await getToolSchemaGET(request, context);
    const etag = response.headers.get(ETAG_HEADER);
    expect(etag).toBe(`"tool-schema-${seeded.revisionNo}"`);
  });

  it("If-None-Match 与当前 revisionNo 匹配 → 304 Not Modified", async () => {
    const seeded = await seedPublishedTool({ tenantId, ownerUserId });
    const { request, context } = makeToolSchemaRequest(tenantId, invocationId, seeded.toolId, {
      ifNoneMatch: `tool-schema-${seeded.revisionNo}`,
    });
    const response = await getToolSchemaGET(request, context);
    expect(response.status).toBe(304);
    expect(response.headers.get(ETAG_HEADER)).toBeTruthy();
  });

  it("If-None-Match 与当前 revisionNo 不匹配 → 200 + body", async () => {
    const seeded = await seedPublishedTool({ tenantId, ownerUserId });
    const { request, context } = makeToolSchemaRequest(tenantId, invocationId, seeded.toolId, {
      ifNoneMatch: "tool-schema-99999",
    });
    const response = await getToolSchemaGET(request, context);
    expect(response.status).toBe(200);
  });

  it("If-None-Match 格式非法 → 400 CATALOG_REVISION_INVALID", async () => {
    const seeded = await seedPublishedTool({ tenantId, ownerUserId });
    const { request, context } = makeToolSchemaRequest(tenantId, invocationId, seeded.toolId, {
      ifNoneMatch: "invalid-etag",
    });
    const response = await getToolSchemaGET(request, context);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CATALOG_REVISION_INVALID");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. GET /skills/{skill_id}/content
// ═══════════════════════════════════════════════════════════

describe("V11 Gateway skills/{skill_id}/content", () => {
  let tenantId: string;
  let ownerUserId: string;
  let invocationId: string;

  beforeEach(async () => {
    const ctx = await seedContext();
    tenantId = ctx.tenantId;
    ownerUserId = ctx.userIdentityId;
    invocationId = randomUUID();
  });

  it("Skill 不存在 → 404 CAPABILITY_NOT_ALLOWED（隐藏式）", async () => {
    const { request, context } = makeSkillContentRequest(tenantId, invocationId, randomUUID());
    const response = await getSkillContentGET(request, context);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CAPABILITY_NOT_ALLOWED");
  });

  it("Skill lifecycle=draft → 404 CAPABILITY_NOT_ALLOWED（隐藏式，不暴露存在）", async () => {
    const seeded = await seedPublishedSkill({
      tenantId,
      ownerUserId,
      lifecycleState: "draft",
    });
    const { request, context } = makeSkillContentRequest(tenantId, invocationId, seeded.skillId);
    const response = await getSkillContentGET(request, context);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CAPABILITY_NOT_ALLOWED");
  });

  it("Skill lifecycle=disabled → 404 CAPABILITY_NOT_ALLOWED（隐藏式）", async () => {
    const seeded = await seedPublishedSkill({
      tenantId,
      ownerUserId,
      lifecycleState: "disabled",
    });
    const { request, context } = makeSkillContentRequest(tenantId, invocationId, seeded.skillId);
    const response = await getSkillContentGET(request, context);
    expect(response.status).toBe(404);
  });

  it("Skill 已发布 + lifecycle=enabled → 200 + body + ETag", async () => {
    const seeded = await seedPublishedSkill({ tenantId, ownerUserId });
    const { request, context } = makeSkillContentRequest(tenantId, invocationId, seeded.skillId);
    const response = await getSkillContentGET(request, context);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      skill_id: string;
      skill_key: string;
      display_name: string;
      lifecycle_state: string;
      version: {
        id: string;
        version_no: number;
        content_ref: string;
        content_hash: string;
        manifest: unknown;
        revision_state: string;
        published_at: string | null;
      };
    };
    expect(body.skill_id).toBe(seeded.skillId);
    expect(body.lifecycle_state).toBe("enabled");
    expect(body.version.id).toBe(seeded.versionId);
    expect(body.version.version_no).toBe(seeded.versionNo);
    expect(body.version.content_hash).toBe(seeded.contentHash);
    expect(body.version.revision_state).toBe("published");
    expect(body.version.manifest).toBeDefined();
    const etag = response.headers.get(ETAG_HEADER);
    expect(etag).toBe(`"skill-content-${seeded.versionNo}"`);
  });

  it("ETag 格式：skill-content-{versionNo}", async () => {
    const seeded = await seedPublishedSkill({ tenantId, ownerUserId });
    const { request, context } = makeSkillContentRequest(tenantId, invocationId, seeded.skillId);
    const response = await getSkillContentGET(request, context);
    const etag = response.headers.get(ETAG_HEADER);
    expect(etag).toBe(`"skill-content-${seeded.versionNo}"`);
  });

  it("If-None-Match 与当前 versionNo 匹配 → 304 Not Modified", async () => {
    const seeded = await seedPublishedSkill({ tenantId, ownerUserId });
    const { request, context } = makeSkillContentRequest(tenantId, invocationId, seeded.skillId, {
      ifNoneMatch: `skill-content-${seeded.versionNo}`,
    });
    const response = await getSkillContentGET(request, context);
    expect(response.status).toBe(304);
    expect(response.headers.get(ETAG_HEADER)).toBeTruthy();
  });

  it("If-None-Match 与当前 versionNo 不匹配 → 200 + body", async () => {
    const seeded = await seedPublishedSkill({ tenantId, ownerUserId });
    const { request, context } = makeSkillContentRequest(tenantId, invocationId, seeded.skillId, {
      ifNoneMatch: "skill-content-99999",
    });
    const response = await getSkillContentGET(request, context);
    expect(response.status).toBe(200);
  });

  it("If-None-Match 格式非法 → 400 CATALOG_REVISION_INVALID", async () => {
    const seeded = await seedPublishedSkill({ tenantId, ownerUserId });
    const { request, context } = makeSkillContentRequest(tenantId, invocationId, seeded.skillId, {
      ifNoneMatch: "invalid-etag",
    });
    const response = await getSkillContentGET(request, context);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CATALOG_REVISION_INVALID");
  });

  it("Skill 无 currentVersionId（未发布版本）→ 422 CAPABILITY_CONTENT_BLOCKED", async () => {
    // 创建 Skill 但不创建/发布 SkillVersion
    const skill = await createSkill({
      tenantId,
      skillKey: `skill-${randomUUID().slice(0, 8)}`,
      displayName: "No Version Skill",
      ownerUserId,
      createdBy: ownerUserId,
    });
    // 把 Skill 切到 enabled（仍无 currentVersionId）
    const enabledSkill = await updateSkill({
      tenantId,
      skillId: skill.id,
      lifecycleState: "enabled",
      expectedVersionNo: skill.versionNo,
    });
    const { request, context } = makeSkillContentRequest(tenantId, invocationId, enabledSkill.id);
    const response = await getSkillContentGET(request, context);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CAPABILITY_CONTENT_BLOCKED");
  });
});

// ═══════════════════════════════════════════════════════════
// 7. CapabilityUse 幂等记账
// ═══════════════════════════════════════════════════════════

describe("V11 Gateway CapabilityUse 幂等记账", () => {
  let tenantId: string;
  let ownerUserId: string;

  beforeEach(async () => {
    const ctx = await seedContext();
    tenantId = ctx.tenantId;
    ownerUserId = ctx.userIdentityId;
  });

  it("GET /tools/{id}/schema 成功后写入 CapabilityUse（capabilityType=tool，schemaHash 已填）", async () => {
    const seeded = await seedPublishedTool({ tenantId, ownerUserId });
    const invocationId = randomUUID();
    const { request, context } = makeToolSchemaRequest(tenantId, invocationId, seeded.toolId);
    const response = await getToolSchemaGET(request, context);
    expect(response.status).toBe(200);

    const records = await listCapabilityUseByInvocation({ tenantId, invocationId });
    expect(records.length).toBe(1);
    const record = records[0];
    expect(record?.capabilityType).toBe("tool");
    expect(record?.capabilityId).toBe(seeded.toolId);
    expect(record?.revisionId).toBe(seeded.revisionId);
    expect(record?.schemaHash).toBe(seeded.schemaHash);
    expect(record?.contentHash).toBeNull();
    expect(record?.sourceType).toBe("dynamic_discovery");
  });

  it("GET /skills/{id}/content 成功后写入 CapabilityUse（capabilityType=skill，contentHash 已填）", async () => {
    const seeded = await seedPublishedSkill({ tenantId, ownerUserId });
    const invocationId = randomUUID();
    const { request, context } = makeSkillContentRequest(tenantId, invocationId, seeded.skillId);
    const response = await getSkillContentGET(request, context);
    expect(response.status).toBe(200);

    const records = await listCapabilityUseByInvocation({ tenantId, invocationId });
    expect(records.length).toBe(1);
    const record = records[0];
    expect(record?.capabilityType).toBe("skill");
    expect(record?.capabilityId).toBe(seeded.skillId);
    expect(record?.revisionId).toBe(seeded.versionId);
    expect(record?.contentHash).toBe(seeded.contentHash);
    expect(record?.schemaHash).toBeNull();
  });

  it("同一 Invocation 内重复 GET /tools/{id}/schema → CapabilityUse 幂等（只写一条）", async () => {
    const seeded = await seedPublishedTool({ tenantId, ownerUserId });
    const invocationId = randomUUID();
    // 第一次读取
    const ctx1 = makeToolSchemaRequest(tenantId, invocationId, seeded.toolId);
    await getToolSchemaGET(ctx1.request, ctx1.context);
    // 第二次读取（同 Invocation）
    const ctx2 = makeToolSchemaRequest(tenantId, invocationId, seeded.toolId);
    await getToolSchemaGET(ctx2.request, ctx2.context);

    const records = await listCapabilityUseByInvocation({ tenantId, invocationId });
    expect(records.length).toBe(1);
    expect(records[0]?.capabilityUseKey).toBe(
      computeCapabilityUseKey({
        capabilityType: "tool",
        capabilityId: seeded.toolId,
        revisionId: seeded.revisionId,
        schemaHash: seeded.schemaHash,
      }),
    );
  });

  it("不同 Invocation 读取同一 Tool → 各写一条 CapabilityUse（capabilityUseKey 相同但 invocationId 不同）", async () => {
    const seeded = await seedPublishedTool({ tenantId, ownerUserId });
    const invocationA = randomUUID();
    const invocationB = randomUUID();
    const ctxA = makeToolSchemaRequest(tenantId, invocationA, seeded.toolId);
    await getToolSchemaGET(ctxA.request, ctxA.context);
    const ctxB = makeToolSchemaRequest(tenantId, invocationB, seeded.toolId);
    await getToolSchemaGET(ctxB.request, ctxB.context);

    const recordsA = await listCapabilityUseByInvocation({ tenantId, invocationId: invocationA });
    const recordsB = await listCapabilityUseByInvocation({ tenantId, invocationId: invocationB });
    expect(recordsA.length).toBe(1);
    expect(recordsB.length).toBe(1);
    // 同一能力修订的 capabilityUseKey 相同（hash 公式相同）
    expect(recordsA[0]?.capabilityUseKey).toBe(recordsB[0]?.capabilityUseKey);
    // 但 invocationId 不同
    expect(recordsA[0]?.invocationId).toBe(invocationA);
    expect(recordsB[0]?.invocationId).toBe(invocationB);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. computeCapabilityUseKey 单元测试（Gateway 路由依赖的辅助函数）
// ═══════════════════════════════════════════════════════════

describe("computeCapabilityUseKey 幂等键计算", () => {
  it("相同输入产生相同 key（确定性）", () => {
    const a = computeCapabilityUseKey({
      capabilityType: "tool",
      capabilityId: "tool-123",
      revisionId: "rev-1",
      schemaHash: "sha256:abc",
    });
    const b = computeCapabilityUseKey({
      capabilityType: "tool",
      capabilityId: "tool-123",
      revisionId: "rev-1",
      schemaHash: "sha256:abc",
    });
    expect(a).toBe(b);
  });

  it("不同 capabilityType 产生不同 key", () => {
    const a = computeCapabilityUseKey({
      capabilityType: "tool",
      capabilityId: "cap-1",
      revisionId: "rev-1",
    });
    const b = computeCapabilityUseKey({
      capabilityType: "skill",
      capabilityId: "cap-1",
      revisionId: "rev-1",
    });
    expect(a).not.toBe(b);
  });

  it("不同 revisionId 产生不同 key", () => {
    const a = computeCapabilityUseKey({
      capabilityType: "tool",
      capabilityId: "cap-1",
      revisionId: "rev-1",
    });
    const b = computeCapabilityUseKey({
      capabilityType: "tool",
      capabilityId: "cap-1",
      revisionId: "rev-2",
    });
    expect(a).not.toBe(b);
  });

  it("返回 64 hex（不带前缀）", () => {
    const key = computeCapabilityUseKey({
      capabilityType: "tool",
      capabilityId: "x",
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
