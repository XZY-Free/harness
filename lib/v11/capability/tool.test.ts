import {
  GET as getConnectionGET,
  PATCH as patchConnectionPATCH,
} from "@/app/admin/api/v1/connections/[connection_id]/route";
import {
  POST as createConnectionPOST,
  GET as listConnectionsGET,
} from "@/app/admin/api/v1/connections/route";
import {
  GET as getProviderGET,
  PATCH as patchProviderPATCH,
} from "@/app/admin/api/v1/tool-providers/[provider_id]/route";
import {
  POST as createProviderPOST,
  GET as listProvidersGET,
} from "@/app/admin/api/v1/tool-providers/route";
import {
  GET as getToolGET,
  PATCH as patchToolPATCH,
} from "@/app/admin/api/v1/tools/[tool_id]/route";
import { POST as createSchemaRevisionPOST } from "@/app/admin/api/v1/tools/[tool_id]/schema-revisions/route";
import { POST as createToolPOST, GET as listToolsGET } from "@/app/admin/api/v1/tools/route";
/**
 * S06-C02：V11 Tool / ToolProvider / Connection / CredentialRef / ToolSchemaRevision
 * 仓储与 Admin API 集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - computeSchemaHash 工具。
 * - Connection 仓储：createConnection / getConnectionById / getConnectionByKey /
 *   listConnections / updateConnection。
 * - CredentialRef 仓储：createCredentialRef / getCredentialRefsByConnection / revokeCredentialRef。
 * - ToolProvider 仓储：createToolProvider / getToolProviderById / getToolProviderByKey /
 *   listToolProviders / updateToolProvider。
 * - Tool 仓储：createTool / getToolById / getToolByKey / listTools / updateTool。
 * - ToolSchemaRevision 仓储：createToolSchemaRevision / getToolSchemaRevisionById /
 *   listToolSchemaRevisions / getCurrentToolSchemaRevision / publishToolSchemaRevision。
 * - Admin API：
 *   - POST /admin/api/v1/connections
 *   - GET /admin/api/v1/connections
 *   - GET / PATCH /admin/api/v1/connections/{connection_id}
 *   - POST /admin/api/v1/tool-providers
 *   - GET /admin/api/v1/tool-providers
 *   - GET / PATCH /admin/api/v1/tool-providers/{provider_id}
 *   - POST /admin/api/v1/tools
 *   - GET /admin/api/v1/tools
 *   - GET / PATCH /admin/api/v1/tools/{tool_id}
 *   - POST /admin/api/v1/tools/{tool_id}/schema-revisions
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。Admin API 测试需 SNOW_AUTH_MODE=dev +
 * grantActionBinding 绑定 connection.create/connection.update/tool.provider.create/
 * tool.provider.update/tool.create/tool.update。
 */
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { assertCrossTenantHidden, buildV11Request } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { computeContentHash } from "@/lib/v11/capability/content-cache";
import {
  type ConnectionLifecycleState,
  TOOL_KEY_REGEX,
  ToolLifecycleError,
  type ToolLifecycleState,
  ToolNotFoundError,
  type ToolProviderLifecycleState,
  ToolValidationError,
  ToolVersionConflictError,
  computeSchemaHash,
  createConnection,
  createCredentialRef,
  createTool,
  createToolProvider,
  createToolSchemaRevision,
  getConnectionById,
  getConnectionByKey,
  getCredentialRefsByConnection,
  getCurrentToolSchemaRevision,
  getToolById,
  getToolByKey,
  getToolProviderById,
  getToolProviderByKey,
  getToolSchemaRevisionById,
  listConnections,
  listToolProviders,
  listToolSchemaRevisions,
  listTools,
  publishToolSchemaRevision,
  revokeCredentialRef,
  updateConnection,
  updateTool,
  updateToolProvider,
} from "@/lib/v11/capability/tool-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 skill.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed admin 用户 + tool action bindings ─────────

async function seedAdminWithToolBindings() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  // connection.create：tenant wildcard（创建本租户内 Connection）。
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "connection.create",
    resourceScope: { type: "tenant", wildcard: true },
  });
  // connection.update：connection wildcard（更新本租户内所有 Connection）。
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "connection.update",
    resourceScope: { type: "connection", wildcard: true },
  });
  // tool.provider.create：tenant wildcard。
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "tool.provider.create",
    resourceScope: { type: "tenant", wildcard: true },
  });
  // tool.provider.update：provider wildcard。
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "tool.provider.update",
    resourceScope: { type: "provider", wildcard: true },
  });
  // tool.create：provider wildcard（在任意 provider 下创建 Tool）。
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "tool.create",
    resourceScope: { type: "provider", wildcard: true },
  });
  // tool.update：tool wildcard（更新本租户内所有 Tool）。
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "tool.update",
    resourceScope: { type: "tool", wildcard: true },
  });
  return { tenantId: tenant.id, userIdentityId: identity.id };
}

/** 构造一个合法的 sha256: hash（用于 CredentialRef.fingerprint）。 */
function buildValidFingerprint(content: string): string {
  return computeContentHash(content);
}

/** 构造一个合法的 input schema 对象。 */
function buildInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
    },
    required: ["query"],
  };
}

// ═══════════════════════════════════════════════════════════
// 1. computeSchemaHash 工具
// ═══════════════════════════════════════════════════════════

describe("V11 computeSchemaHash 工具", () => {
  it("computeSchemaHash 返回 sha256: 前缀 + 64 hex", () => {
    const hash = computeSchemaHash({
      inputSchemaJson: buildInputSchema(),
      outputSchemaJson: null,
      riskMetadataJson: null,
    });
    expect(hash.startsWith("sha256:")).toBe(true);
    const hex = hash.slice("sha256:".length);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex.length).toBe(64);
  });

  it("computeSchemaHash 相同输入产生相同 hash", () => {
    const input = buildInputSchema();
    const a = computeSchemaHash({
      inputSchemaJson: input,
      outputSchemaJson: null,
      riskMetadataJson: null,
    });
    const b = computeSchemaHash({
      inputSchemaJson: input,
      outputSchemaJson: null,
      riskMetadataJson: null,
    });
    expect(a).toBe(b);
  });

  it("computeSchemaHash 不同输入产生不同 hash", () => {
    const a = computeSchemaHash({
      inputSchemaJson: { type: "object" },
      outputSchemaJson: null,
      riskMetadataJson: null,
    });
    const b = computeSchemaHash({
      inputSchemaJson: { type: "string" },
      outputSchemaJson: null,
      riskMetadataJson: null,
    });
    expect(a).not.toBe(b);
  });

  it("TOOL_KEY_REGEX 校验：合法 key", () => {
    expect(TOOL_KEY_REGEX.test("a")).toBe(true);
    expect(TOOL_KEY_REGEX.test("a-b")).toBe(true);
    expect(TOOL_KEY_REGEX.test("abc-123-def")).toBe(true);
  });

  it("TOOL_KEY_REGEX 校验：非法 key", () => {
    expect(TOOL_KEY_REGEX.test("A")).toBe(false);
    expect(TOOL_KEY_REGEX.test("a_b")).toBe(false);
    expect(TOOL_KEY_REGEX.test("-a")).toBe(false);
    expect(TOOL_KEY_REGEX.test("a--b")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Connection 仓储：createConnection / get
// ═══════════════════════════════════════════════════════════

describe("V11 Connection 仓储：createConnection", () => {
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
  });

  it("createConnection 成功：默认 lifecycle=draft, authMethod=none, versionNo=1", async () => {
    const conn = await createConnection({
      tenantId,
      connectionKey: "http-conn-1",
      connectionType: "http",
      endpointRef: "https://api.example.com",
      ownerUserId: ownerId,
    });

    expect(conn.id).toEqual(expect.any(String));
    expect(conn.tenantId).toBe(tenantId);
    expect(conn.connectionKey).toBe("http-conn-1");
    expect(conn.connectionType).toBe("http");
    expect(conn.endpointRef).toBe("https://api.example.com");
    expect(conn.authMethod).toBe("none");
    expect(conn.ownerUserId).toBe(ownerId);
    expect(conn.lifecycleState).toBe("draft");
    expect(conn.versionNo).toBe(1);
    expect(conn.deletedAt).toBeNull();
  });

  it("createConnection 支持 authMethod=bearer", async () => {
    const conn = await createConnection({
      tenantId,
      connectionKey: "bearer-conn",
      connectionType: "http",
      authMethod: "bearer",
      ownerUserId: ownerId,
    });
    expect(conn.authMethod).toBe("bearer");
  });

  it("createConnection connectionKey 非法（含大写）→ ToolValidationError", async () => {
    await expect(
      createConnection({
        tenantId,
        connectionKey: "Invalid-Key",
        connectionType: "http",
        ownerUserId: ownerId,
      }),
    ).rejects.toThrow(ToolValidationError);
  });

  it("createConnection connectionType 非法 → ToolValidationError", async () => {
    await expect(
      createConnection({
        tenantId,
        connectionKey: "bad-type",
        connectionType: "invalid-type" as never,
        ownerUserId: ownerId,
      }),
    ).rejects.toThrow(ToolValidationError);
  });

  it("createConnection ownerUserId 为空 → ToolValidationError", async () => {
    await expect(
      createConnection({
        tenantId,
        connectionKey: "no-owner",
        connectionType: "http",
        ownerUserId: "",
      }),
    ).rejects.toThrow(ToolValidationError);
  });

  it("createConnection connectionKey 重复 → ToolValidationError", async () => {
    await createConnection({
      tenantId,
      connectionKey: "dup-key",
      connectionType: "http",
      ownerUserId: ownerId,
    });

    await expect(
      createConnection({
        tenantId,
        connectionKey: "dup-key",
        connectionType: "http",
        ownerUserId: ownerId,
      }),
    ).rejects.toThrow(ToolValidationError);
  });
});

describe("V11 Connection 仓储：get / list 跨租户隔离", () => {
  let tenantId: string;
  let ownerId: string;
  let connectionId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const conn = await createConnection({
      tenantId,
      connectionKey: "iso-conn",
      connectionType: "http",
      ownerUserId: ownerId,
    });
    connectionId = conn.id;
  });

  it("getConnectionById 命中本租户 → 返回 Connection", async () => {
    const found = await getConnectionById({ tenantId, connectionId });
    expect(found?.id).toBe(connectionId);
  });

  it("getConnectionById 跨租户 → 返回 null", async () => {
    const found = await getConnectionById({
      tenantId: "11111111-1111-4111-8111-111111111111",
      connectionId,
    });
    expect(found).toBeNull();
  });

  it("getConnectionByKey 命中本租户 → 返回 Connection", async () => {
    const found = await getConnectionByKey({ tenantId, connectionKey: "iso-conn" });
    expect(found?.id).toBe(connectionId);
  });

  it("getConnectionByKey 跨租户 → 返回 null", async () => {
    const found = await getConnectionByKey({
      tenantId: "11111111-1111-4111-8111-111111111111",
      connectionKey: "iso-conn",
    });
    expect(found).toBeNull();
  });

  it("listConnections 默认返回全部", async () => {
    await createConnection({
      tenantId,
      connectionKey: "list-a",
      connectionType: "http",
      ownerUserId: ownerId,
    });
    const { items } = await listConnections({ tenantId });
    expect(items).toHaveLength(2);
  });

  it("listConnections 按 lifecycle=draft 过滤", async () => {
    const { items } = await listConnections({
      tenantId,
      lifecycleStates: ["draft"] as readonly ConnectionLifecycleState[],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.lifecycleState).toBe("draft");
  });

  it("listConnections 跨租户 → 返回空", async () => {
    const { items } = await listConnections({
      tenantId: "11111111-1111-4111-8111-111111111111",
    });
    expect(items).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. updateConnection 乐观锁 + lifecycle 状态机
// ═══════════════════════════════════════════════════════════

describe("V11 Connection 仓储：updateConnection 乐观锁与状态机", () => {
  let tenantId: string;
  let ownerId: string;
  let connectionId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const conn = await createConnection({
      tenantId,
      connectionKey: "update-test",
      connectionType: "http",
      ownerUserId: ownerId,
    });
    connectionId = conn.id;
  });

  it("updateConnection 更新 endpointRef + versionNo 递增", async () => {
    const updated = await updateConnection({
      tenantId,
      connectionId,
      endpointRef: "https://new.example.com",
      expectedVersionNo: 1,
    });
    expect(updated.endpointRef).toBe("https://new.example.com");
    expect(updated.versionNo).toBe(2);
  });

  it("updateConnection 乐观锁 versionNo 不匹配 → ToolVersionConflictError", async () => {
    await expect(
      updateConnection({
        tenantId,
        connectionId,
        endpointRef: "https://stale.example.com",
        expectedVersionNo: 999,
      }),
    ).rejects.toThrow(ToolVersionConflictError);
  });

  it("updateConnection lifecycle draft → enabled → disabled → enabled 合法", async () => {
    const enabled = await updateConnection({
      tenantId,
      connectionId,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    expect(enabled.lifecycleState).toBe("enabled");

    const disabled = await updateConnection({
      tenantId,
      connectionId,
      lifecycleState: "disabled",
      expectedVersionNo: 2,
    });
    expect(disabled.lifecycleState).toBe("disabled");

    const reEnabled = await updateConnection({
      tenantId,
      connectionId,
      lifecycleState: "enabled",
      expectedVersionNo: 3,
    });
    expect(reEnabled.lifecycleState).toBe("enabled");
  });

  it("updateConnection lifecycle retired → enabled 终态不可恢复 → ToolLifecycleError", async () => {
    await updateConnection({
      tenantId,
      connectionId,
      lifecycleState: "retired",
      expectedVersionNo: 1,
    });
    await expect(
      updateConnection({
        tenantId,
        connectionId,
        lifecycleState: "enabled",
        expectedVersionNo: 2,
      }),
    ).rejects.toThrow(ToolLifecycleError);
  });

  it("updateConnection 跨租户 → ToolNotFoundError", async () => {
    await expect(
      updateConnection({
        tenantId: "11111111-1111-4111-8111-111111111111",
        connectionId,
        endpointRef: "https://cross.example.com",
        expectedVersionNo: 1,
      }),
    ).rejects.toThrow(ToolNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. CredentialRef 仓储
// ═══════════════════════════════════════════════════════════

describe("V11 CredentialRef 仓储", () => {
  let tenantId: string;
  let ownerId: string;
  let connectionId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const conn = await createConnection({
      tenantId,
      connectionKey: "cred-conn",
      connectionType: "http",
      ownerUserId: ownerId,
    });
    connectionId = conn.id;
  });

  it("createCredentialRef 成功：默认 lifecycle=active", async () => {
    const ref = await createCredentialRef({
      tenantId,
      connectionId,
      provider: "vault",
      vaultRef: "secret/data/api-key",
      fingerprint: buildValidFingerprint("api-key-123"),
      scopeJson: ["read:api"],
    });

    expect(ref.id).toEqual(expect.any(String));
    expect(ref.tenantId).toBe(tenantId);
    expect(ref.connectionId).toBe(connectionId);
    expect(ref.provider).toBe("vault");
    expect(ref.vaultRef).toBe("secret/data/api-key");
    expect(ref.fingerprint.startsWith("sha256:")).toBe(true);
    expect(ref.lifecycleState).toBe("active");
  });

  it("createCredentialRef fingerprint 格式非法 → ToolValidationError", async () => {
    await expect(
      createCredentialRef({
        tenantId,
        connectionId,
        provider: "vault",
        vaultRef: "secret/data/bad",
        fingerprint: "not-a-hash",
      }),
    ).rejects.toThrow(ToolValidationError);
  });

  it("createCredentialRef connectionId 跨租户 → ToolNotFoundError", async () => {
    await expect(
      createCredentialRef({
        tenantId,
        connectionId: "99999999-9999-4999-8999-999999999999",
        provider: "vault",
        vaultRef: "secret/data/x",
        fingerprint: buildValidFingerprint("x"),
      }),
    ).rejects.toThrow(ToolNotFoundError);
  });

  it("getCredentialRefsByConnection 返回关联的 CredentialRef 列表", async () => {
    await createCredentialRef({
      tenantId,
      connectionId,
      provider: "vault",
      vaultRef: "secret/data/a",
      fingerprint: buildValidFingerprint("a"),
    });
    await createCredentialRef({
      tenantId,
      connectionId,
      provider: "env",
      vaultRef: "env:API_KEY",
      fingerprint: buildValidFingerprint("b"),
    });

    const refs = await getCredentialRefsByConnection({ tenantId, connectionId });
    expect(refs).toHaveLength(2);
  });

  it("revokeCredentialRef active → revoked 终态", async () => {
    const ref = await createCredentialRef({
      tenantId,
      connectionId,
      provider: "vault",
      vaultRef: "secret/data/revoke",
      fingerprint: buildValidFingerprint("revoke"),
    });

    const revoked = await revokeCredentialRef({ tenantId, credentialRefId: ref.id });
    expect(revoked.lifecycleState).toBe("revoked");
  });

  it("revokeCredentialRef 重复撤销 → ToolLifecycleError", async () => {
    const ref = await createCredentialRef({
      tenantId,
      connectionId,
      provider: "vault",
      vaultRef: "secret/data/dup",
      fingerprint: buildValidFingerprint("dup"),
    });
    await revokeCredentialRef({ tenantId, credentialRefId: ref.id });

    await expect(revokeCredentialRef({ tenantId, credentialRefId: ref.id })).rejects.toThrow(
      ToolLifecycleError,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 5. ToolProvider 仓储
// ═══════════════════════════════════════════════════════════

describe("V11 ToolProvider 仓储：createToolProvider", () => {
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
  });

  it("createToolProvider 成功：默认 lifecycle=draft, trustLevel=standard, versionNo=1", async () => {
    const provider = await createToolProvider({
      tenantId,
      providerKey: "search-provider",
      providerType: "http_openapi",
      displayName: "Search Provider",
      description: "外部搜索能力",
      ownerUserId: ownerId,
    });

    expect(provider.id).toEqual(expect.any(String));
    expect(provider.tenantId).toBe(tenantId);
    expect(provider.providerKey).toBe("search-provider");
    expect(provider.providerType).toBe("http_openapi");
    expect(provider.connectionId).toBeNull();
    expect(provider.trustLevel).toBe("standard");
    expect(provider.displayName).toBe("Search Provider");
    expect(provider.lifecycleState).toBe("draft");
    expect(provider.versionNo).toBe(1);
  });

  it("createToolProvider providerKey 非法 → ToolValidationError", async () => {
    await expect(
      createToolProvider({
        tenantId,
        providerKey: "Invalid_Key",
        providerType: "builtin",
        displayName: "X",
        ownerUserId: ownerId,
      }),
    ).rejects.toThrow(ToolValidationError);
  });

  it("createToolProvider providerType 非法 → ToolValidationError", async () => {
    await expect(
      createToolProvider({
        tenantId,
        providerKey: "bad-type",
        providerType: "invalid" as never,
        displayName: "X",
        ownerUserId: ownerId,
      }),
    ).rejects.toThrow(ToolValidationError);
  });

  it("createToolProvider providerKey 重复 → ToolValidationError", async () => {
    await createToolProvider({
      tenantId,
      providerKey: "dup-provider",
      providerType: "builtin",
      displayName: "First",
      ownerUserId: ownerId,
    });

    await expect(
      createToolProvider({
        tenantId,
        providerKey: "dup-provider",
        providerType: "builtin",
        displayName: "Second",
        ownerUserId: ownerId,
      }),
    ).rejects.toThrow(ToolValidationError);
  });

  it("createToolProvider 关联不存在的 connectionId → ToolNotFoundError", async () => {
    await expect(
      createToolProvider({
        tenantId,
        providerKey: "no-conn",
        providerType: "mcp",
        connectionId: "99999999-9999-4999-8999-999999999999",
        displayName: "X",
        ownerUserId: ownerId,
      }),
    ).rejects.toThrow(ToolNotFoundError);
  });
});

describe("V11 ToolProvider 仓储：get / list / update", () => {
  let tenantId: string;
  let ownerId: string;
  let providerId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const provider = await createToolProvider({
      tenantId,
      providerKey: "iso-provider",
      providerType: "builtin",
      displayName: "ISO Provider",
      ownerUserId: ownerId,
    });
    providerId = provider.id;
  });

  it("getToolProviderById 跨租户 → 返回 null", async () => {
    const found = await getToolProviderById({
      tenantId: "11111111-1111-4111-8111-111111111111",
      providerId,
    });
    expect(found).toBeNull();
  });

  it("getToolProviderByKey 命中本租户 → 返回 Provider", async () => {
    const found = await getToolProviderByKey({ tenantId, providerKey: "iso-provider" });
    expect(found?.id).toBe(providerId);
  });

  it("listToolProviders 默认返回全部", async () => {
    const { items } = await listToolProviders({ tenantId });
    expect(items).toHaveLength(1);
  });

  it("updateToolProvider 更新 displayName + trustLevel + versionNo 递增", async () => {
    const updated = await updateToolProvider({
      tenantId,
      providerId,
      displayName: "Updated Provider",
      trustLevel: "high",
      expectedVersionNo: 1,
    });
    expect(updated.displayName).toBe("Updated Provider");
    expect(updated.trustLevel).toBe("high");
    expect(updated.versionNo).toBe(2);
  });

  it("updateToolProvider lifecycle draft → enabled 合法", async () => {
    const updated = await updateToolProvider({
      tenantId,
      providerId,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    expect(updated.lifecycleState).toBe("enabled");
  });

  it("updateToolProvider lifecycle retired → enabled 终态 → ToolLifecycleError", async () => {
    await updateToolProvider({
      tenantId,
      providerId,
      lifecycleState: "retired",
      expectedVersionNo: 1,
    });
    await expect(
      updateToolProvider({
        tenantId,
        providerId,
        lifecycleState: "enabled" as ToolProviderLifecycleState,
        expectedVersionNo: 2,
      }),
    ).rejects.toThrow(ToolLifecycleError);
  });

  it("updateToolProvider 乐观锁不匹配 → ToolVersionConflictError", async () => {
    await expect(
      updateToolProvider({
        tenantId,
        providerId,
        displayName: "Stale",
        expectedVersionNo: 999,
      }),
    ).rejects.toThrow(ToolVersionConflictError);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Tool 仓储
// ═══════════════════════════════════════════════════════════

describe("V11 Tool 仓储：createTool", () => {
  let tenantId: string;
  let ownerId: string;
  let providerId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const provider = await createToolProvider({
      tenantId,
      providerKey: "tool-host",
      providerType: "builtin",
      displayName: "Tool Host",
      ownerUserId: ownerId,
    });
    // Provider 必须 enabled 才能 createTool
    await updateToolProvider({
      tenantId,
      providerId: provider.id,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    providerId = provider.id;
  });

  it("createTool 成功：默认 lifecycle=draft, riskClass=medium, versionNo=1", async () => {
    const tool = await createTool({
      tenantId,
      providerId,
      toolKey: "search-tool",
      displayName: "Search Tool",
      description: "执行搜索",
    });

    expect(tool.id).toEqual(expect.any(String));
    expect(tool.tenantId).toBe(tenantId);
    expect(tool.providerId).toBe(providerId);
    expect(tool.toolKey).toBe("search-tool");
    expect(tool.displayName).toBe("Search Tool");
    expect(tool.riskClass).toBe("medium");
    expect(tool.lifecycleState).toBe("draft");
    expect(tool.currentSchemaRevisionId).toBeNull();
    expect(tool.versionNo).toBe(1);
  });

  it("createTool 支持 riskClass=critical", async () => {
    const tool = await createTool({
      tenantId,
      providerId,
      toolKey: "critical-tool",
      displayName: "Critical",
      riskClass: "critical",
    });
    expect(tool.riskClass).toBe("critical");
  });

  it("createTool toolKey 非法 → ToolValidationError", async () => {
    await expect(
      createTool({
        tenantId,
        providerId,
        toolKey: "Invalid_Key",
        displayName: "X",
      }),
    ).rejects.toThrow(ToolValidationError);
  });

  it("createTool provider 不存在 → ToolNotFoundError", async () => {
    await expect(
      createTool({
        tenantId,
        providerId: "99999999-9999-4999-8999-999999999999",
        toolKey: "orphan",
        displayName: "Orphan",
      }),
    ).rejects.toThrow(ToolNotFoundError);
  });

  it("createTool provider 未 enabled → ToolLifecycleError", async () => {
    // 创建一个未启用的 provider
    const draftProvider = await createToolProvider({
      tenantId,
      providerKey: "draft-host",
      providerType: "builtin",
      displayName: "Draft Host",
      ownerUserId: ownerId,
    });
    await expect(
      createTool({
        tenantId,
        providerId: draftProvider.id,
        toolKey: "in-draft",
        displayName: "In Draft",
      }),
    ).rejects.toThrow(ToolLifecycleError);
  });

  it("createTool toolKey 重复（同 provider）→ ToolValidationError", async () => {
    await createTool({
      tenantId,
      providerId,
      toolKey: "dup-tool",
      displayName: "First",
    });
    await expect(
      createTool({
        tenantId,
        providerId,
        toolKey: "dup-tool",
        displayName: "Second",
      }),
    ).rejects.toThrow(ToolValidationError);
  });
});

describe("V11 Tool 仓储：get / list / update", () => {
  let tenantId: string;
  let ownerId: string;
  let providerId: string;
  let toolId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const provider = await createToolProvider({
      tenantId,
      providerKey: "tool-host",
      providerType: "builtin",
      displayName: "Tool Host",
      ownerUserId: ownerId,
    });
    await updateToolProvider({
      tenantId,
      providerId: provider.id,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    providerId = provider.id;
    const tool = await createTool({
      tenantId,
      providerId,
      toolKey: "iso-tool",
      displayName: "ISO Tool",
    });
    toolId = tool.id;
  });

  it("getToolById 跨租户 → 返回 null", async () => {
    const found = await getToolById({
      tenantId: "11111111-1111-4111-8111-111111111111",
      toolId,
    });
    expect(found).toBeNull();
  });

  it("getToolByKey 命中 → 返回 Tool", async () => {
    const found = await getToolByKey({ tenantId, providerId, toolKey: "iso-tool" });
    expect(found?.id).toBe(toolId);
  });

  it("listTools 默认返回全部", async () => {
    const { items } = await listTools({ tenantId, providerId });
    expect(items).toHaveLength(1);
  });

  it("listTools 跨租户 → 返回空", async () => {
    const { items } = await listTools({
      tenantId: "11111111-1111-4111-8111-111111111111",
      providerId,
    });
    expect(items).toHaveLength(0);
  });

  it("updateTool 更新 displayName + riskClass + versionNo 递增", async () => {
    const updated = await updateTool({
      tenantId,
      toolId,
      displayName: "Updated Tool",
      riskClass: "high",
      expectedVersionNo: 1,
    });
    expect(updated.displayName).toBe("Updated Tool");
    expect(updated.riskClass).toBe("high");
    expect(updated.versionNo).toBe(2);
  });

  it("updateTool lifecycle draft → enabled 合法", async () => {
    const updated = await updateTool({
      tenantId,
      toolId,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    expect(updated.lifecycleState).toBe("enabled");
  });

  it("updateTool lifecycle retired → enabled 终态 → ToolLifecycleError", async () => {
    await updateTool({
      tenantId,
      toolId,
      lifecycleState: "retired",
      expectedVersionNo: 1,
    });
    await expect(
      updateTool({
        tenantId,
        toolId,
        lifecycleState: "enabled" as ToolLifecycleState,
        expectedVersionNo: 2,
      }),
    ).rejects.toThrow(ToolLifecycleError);
  });

  it("updateTool 乐观锁不匹配 → ToolVersionConflictError", async () => {
    await expect(
      updateTool({
        tenantId,
        toolId,
        displayName: "Stale",
        expectedVersionNo: 999,
      }),
    ).rejects.toThrow(ToolVersionConflictError);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. ToolSchemaRevision 仓储
// ═══════════════════════════════════════════════════════════

describe("V11 ToolSchemaRevision 仓储：createToolSchemaRevision", () => {
  let tenantId: string;
  let ownerId: string;
  let toolId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const provider = await createToolProvider({
      tenantId,
      providerKey: "rev-host",
      providerType: "builtin",
      displayName: "Rev Host",
      ownerUserId: ownerId,
    });
    await updateToolProvider({
      tenantId,
      providerId: provider.id,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    const tool = await createTool({
      tenantId,
      providerId: provider.id,
      toolKey: "rev-tool",
      displayName: "Rev Tool",
    });
    toolId = tool.id;
  });

  it("createToolSchemaRevision 首次 revisionNo=1, revisionState=draft", async () => {
    const revision = await createToolSchemaRevision({
      tenantId,
      toolId,
      description: "v1 schema",
      inputSchemaJson: buildInputSchema(),
      outputSchemaJson: { type: "string" },
      riskMetadataJson: { effect: "read_only" },
      createdBy: ownerId,
    });

    expect(revision.toolId).toBe(toolId);
    expect(revision.revisionNo).toBe(1);
    expect(revision.revisionState).toBe("draft");
    expect(revision.publishedAt).toBeNull();
    expect(revision.schemaHash.startsWith("sha256:")).toBe(true);
    expect(revision.inputSchemaJson).toEqual(buildInputSchema());
    expect(revision.description).toBe("v1 schema");
  });

  it("createToolSchemaRevision 第二次 revisionNo=2 单调递增", async () => {
    await createToolSchemaRevision({
      tenantId,
      toolId,
      inputSchemaJson: buildInputSchema(),
      createdBy: ownerId,
    });
    const v2 = await createToolSchemaRevision({
      tenantId,
      toolId,
      inputSchemaJson: { type: "object", properties: { q: { type: "string" } } },
      createdBy: ownerId,
    });
    expect(v2.revisionNo).toBe(2);
  });

  it("createToolSchemaRevision inputSchemaJson 非对象（数组）→ ToolValidationError", async () => {
    await expect(
      createToolSchemaRevision({
        tenantId,
        toolId,
        inputSchemaJson: [1, 2, 3],
        createdBy: ownerId,
      }),
    ).rejects.toThrow(ToolValidationError);
  });

  it("createToolSchemaRevision inputSchemaJson null → ToolValidationError", async () => {
    await expect(
      createToolSchemaRevision({
        tenantId,
        toolId,
        inputSchemaJson: null,
        createdBy: ownerId,
      }),
    ).rejects.toThrow(ToolValidationError);
  });

  it("createToolSchemaRevision createdBy 空 → ToolValidationError", async () => {
    await expect(
      createToolSchemaRevision({
        tenantId,
        toolId,
        inputSchemaJson: buildInputSchema(),
        createdBy: "",
      }),
    ).rejects.toThrow(ToolValidationError);
  });

  it("createToolSchemaRevision Tool 不存在 / 跨租户 → ToolNotFoundError", async () => {
    await expect(
      createToolSchemaRevision({
        tenantId: "11111111-1111-4111-8111-111111111111",
        toolId,
        inputSchemaJson: buildInputSchema(),
        createdBy: ownerId,
      }),
    ).rejects.toThrow(ToolNotFoundError);
  });

  it("createToolSchemaRevision Tool 已 retired → ToolLifecycleError", async () => {
    await updateTool({ tenantId, toolId, lifecycleState: "retired", expectedVersionNo: 1 });
    await expect(
      createToolSchemaRevision({
        tenantId,
        toolId,
        inputSchemaJson: buildInputSchema(),
        createdBy: ownerId,
      }),
    ).rejects.toThrow(ToolLifecycleError);
  });
});

describe("V11 ToolSchemaRevision 仓储：list / getCurrent", () => {
  let tenantId: string;
  let ownerId: string;
  let toolId: string;
  let revisionId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const provider = await createToolProvider({
      tenantId,
      providerKey: "list-rev-host",
      providerType: "builtin",
      displayName: "List Rev Host",
      ownerUserId: ownerId,
    });
    await updateToolProvider({
      tenantId,
      providerId: provider.id,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    const tool = await createTool({
      tenantId,
      providerId: provider.id,
      toolKey: "list-rev-tool",
      displayName: "List Rev Tool",
    });
    toolId = tool.id;
    const revision = await createToolSchemaRevision({
      tenantId,
      toolId,
      inputSchemaJson: buildInputSchema(),
      createdBy: ownerId,
    });
    revisionId = revision.id;
  });

  it("getToolSchemaRevisionById 命中 → 返回 Revision", async () => {
    const found = await getToolSchemaRevisionById({ tenantId, schemaRevisionId: revisionId });
    expect(found?.id).toBe(revisionId);
    expect(found?.revisionNo).toBe(1);
  });

  it("getToolSchemaRevisionById 跨租户 → 返回 null", async () => {
    const found = await getToolSchemaRevisionById({
      tenantId: "11111111-1111-4111-8111-111111111111",
      schemaRevisionId: revisionId,
    });
    expect(found).toBeNull();
  });

  it("listToolSchemaRevisions 按 revisionNo 降序返回", async () => {
    await createToolSchemaRevision({
      tenantId,
      toolId,
      inputSchemaJson: { type: "object" },
      createdBy: ownerId,
    });
    await createToolSchemaRevision({
      tenantId,
      toolId,
      inputSchemaJson: { type: "string" },
      createdBy: ownerId,
    });

    const list = await listToolSchemaRevisions({ tenantId, toolId });
    expect(list).toHaveLength(3);
    expect(list[0]?.revisionNo).toBe(3);
    expect(list[1]?.revisionNo).toBe(2);
    expect(list[2]?.revisionNo).toBe(1);
  });

  it("getCurrentToolSchemaRevision 未发布 → 返回 null", async () => {
    const current = await getCurrentToolSchemaRevision({ tenantId, toolId });
    expect(current).toBeNull();
  });
});

describe("V11 ToolSchemaRevision 仓储：publishToolSchemaRevision", () => {
  let tenantId: string;
  let ownerId: string;
  let toolId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const provider = await createToolProvider({
      tenantId,
      providerKey: "pub-rev-host",
      providerType: "builtin",
      displayName: "Pub Rev Host",
      ownerUserId: ownerId,
    });
    await updateToolProvider({
      tenantId,
      providerId: provider.id,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    const tool = await createTool({
      tenantId,
      providerId: provider.id,
      toolKey: "pub-rev-tool",
      displayName: "Pub Rev Tool",
    });
    toolId = tool.id;
  });

  it("publishToolSchemaRevision draft → published + currentSchemaRevisionId 更新 + Tool versionNo 递增", async () => {
    const v1 = await createToolSchemaRevision({
      tenantId,
      toolId,
      inputSchemaJson: buildInputSchema(),
      createdBy: ownerId,
    });

    const { tool, revision } = await publishToolSchemaRevision({
      tenantId,
      schemaRevisionId: v1.id,
      publishedBy: ownerId,
    });

    expect(revision.revisionState).toBe("published");
    expect(revision.publishedAt).toEqual(expect.any(Date));
    expect(tool.currentSchemaRevisionId).toBe(v1.id);
    expect(tool.versionNo).toBe(2); // Tool versionNo 由 1 → 2

    const current = await getCurrentToolSchemaRevision({ tenantId, toolId });
    expect(current?.id).toBe(v1.id);
    expect(current?.revisionState).toBe("published");
  });

  it("publishToolSchemaRevision 二次发布：新版本 published + 旧版本 withdrawn + currentSchemaRevisionId 切换", async () => {
    const v1 = await createToolSchemaRevision({
      tenantId,
      toolId,
      inputSchemaJson: buildInputSchema(),
      createdBy: ownerId,
    });
    await publishToolSchemaRevision({
      tenantId,
      schemaRevisionId: v1.id,
      publishedBy: ownerId,
    });

    const v2 = await createToolSchemaRevision({
      tenantId,
      toolId,
      inputSchemaJson: { type: "object", properties: { q: { type: "string" } } },
      createdBy: ownerId,
    });
    const { tool, revision } = await publishToolSchemaRevision({
      tenantId,
      schemaRevisionId: v2.id,
      publishedBy: ownerId,
    });

    expect(revision.revisionState).toBe("published");
    expect(tool.currentSchemaRevisionId).toBe(v2.id);

    // v1 应该被自动 withdrawn
    const v1After = await getToolSchemaRevisionById({ tenantId, schemaRevisionId: v1.id });
    expect(v1After?.revisionState).toBe("withdrawn");
  });

  it("publishToolSchemaRevision 重复发布同版本（已 published）→ ToolLifecycleError", async () => {
    const v1 = await createToolSchemaRevision({
      tenantId,
      toolId,
      inputSchemaJson: buildInputSchema(),
      createdBy: ownerId,
    });
    await publishToolSchemaRevision({
      tenantId,
      schemaRevisionId: v1.id,
      publishedBy: ownerId,
    });

    await expect(
      publishToolSchemaRevision({
        tenantId,
        schemaRevisionId: v1.id,
        publishedBy: ownerId,
      }),
    ).rejects.toThrow(ToolLifecycleError);
  });

  it("publishToolSchemaRevision 不存在 / 跨租户 → ToolNotFoundError", async () => {
    await expect(
      publishToolSchemaRevision({
        tenantId: "11111111-1111-4111-8111-111111111111",
        schemaRevisionId: "99999999-9999-4999-8999-999999999999",
        publishedBy: ownerId,
      }),
    ).rejects.toThrow(ToolNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. Admin API: POST /admin/api/v1/connections
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/connections", () => {
  let tenantId: string;
  let userIdentityId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
  });

  it("成功创建 → 201 + ETag(connection-1)", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/connections",
      idempotencyKey: "idem-create-conn-001",
      body: {
        connection_key: "api-conn-1",
        connection_type: "http",
        endpoint_ref: "https://api.example.com",
        auth_method: "bearer",
        owner_user_id: userIdentityId,
      },
    });

    const response = await createConnectionPOST(request);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.connection_key).toBe("api-conn-1");
    expect(body.lifecycle_state).toBe("draft");
    expect(body.version_no).toBe(1);
    expect(body.etag).toBe("connection-1");
    const etag = response.headers.get("etag");
    expect(etag).toContain("connection-1");
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/connections",
      body: {
        connection_key: "no-idem",
        connection_type: "http",
        owner_user_id: userIdentityId,
      },
    });

    const response = await createConnectionPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("请求体非法（缺 owner_user_id）→ 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/connections",
      idempotencyKey: "idem-bad-conn-001",
      body: {
        connection_key: "bad",
        connection_type: "http",
      },
    });

    const response = await createConnectionPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("connectionKey 非法 → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/connections",
      idempotencyKey: "idem-bad-key-001",
      body: {
        connection_key: "Invalid_Key",
        connection_type: "http",
        owner_user_id: userIdentityId,
      },
    });

    const response = await createConnectionPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("幂等重放 → 返回相同 connection", async () => {
    const body = {
      connection_key: "api-idempotent",
      connection_type: "http",
      owner_user_id: userIdentityId,
    };
    const request1 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/connections",
      idempotencyKey: "idem-replay-conn-001",
      body,
    });
    const response1 = await createConnectionPOST(request1);
    expect(response1.status).toBe(201);
    const body1 = (await response1.json()) as Record<string, unknown>;

    const request2 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/connections",
      idempotencyKey: "idem-replay-conn-001",
      body,
    });
    const response2 = await createConnectionPOST(request2);
    expect(response2.status).toBe(201);
    const body2 = (await response2.json()) as Record<string, unknown>;
    expect(body2.id).toBe(body1.id);
  });
});

// ═══════════════════════════════════════════════════════════
// 9. Admin API: GET /connections + GET / PATCH /connections/{id}
// ═══════════════════════════════════════════════════════════

describe("GET / PATCH /admin/api/v1/connections", () => {
  let tenantId: string;
  let userIdentityId: string;
  let connectionId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
    const conn = await createConnection({
      tenantId,
      connectionKey: "api-list-conn",
      connectionType: "http",
      ownerUserId: userIdentityId,
    });
    connectionId = conn.id;
  });

  it("GET /connections 成功 → 200 + items", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: "/connections",
    });
    const response = await listConnectionsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; next_cursor: string | null };
    expect(body.items).toHaveLength(1);
  });

  it("GET /connections/{id} 成功 → 200 + ETag", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: `/connections/${connectionId}`,
    });
    const response = await getConnectionGET(request, {
      params: Promise.resolve({ connection_id: connectionId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(connectionId);
    expect(body.etag).toBe("connection-1");
  });

  it("GET /connections/{id} 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const randomId = "99999999-9999-4999-8999-999999999999";
    const requestId = "req-conn-not-found";
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: `/connections/${randomId}`,
      requestId,
    });
    const response = await getConnectionGET(request, {
      params: Promise.resolve({ connection_id: randomId }),
    });
    await assertCrossTenantHidden(response, requestId);
  });

  it("PATCH /connections/{id} 成功 → 200 + ETag(connection-2)", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/connections/${connectionId}`,
      idempotencyKey: "idem-patch-conn-001",
      ifMatch: "connection-1",
      body: {
        endpoint_ref: "https://updated.example.com",
        lifecycle_state: "enabled",
      },
    });
    const response = await patchConnectionPATCH(request, {
      params: Promise.resolve({ connection_id: connectionId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.endpoint_ref).toBe("https://updated.example.com");
    expect(body.lifecycle_state).toBe("enabled");
    expect(body.version_no).toBe(2);
    expect(body.etag).toBe("connection-2");
  });

  it("PATCH /connections/{id} 缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/connections/${connectionId}`,
      idempotencyKey: "idem-patch-no-ifmatch-001",
      body: { endpoint_ref: "https://x.example.com" },
    });
    const response = await patchConnectionPATCH(request, {
      params: Promise.resolve({ connection_id: connectionId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("PATCH /connections/{id} ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/connections/${connectionId}`,
      idempotencyKey: "idem-patch-etag-mismatch-001",
      ifMatch: "connection-999",
      body: { endpoint_ref: "https://x.example.com" },
    });
    const response = await patchConnectionPATCH(request, {
      params: Promise.resolve({ connection_id: connectionId }),
    });
    expect(response.status).toBe(412);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ETAG_MISMATCH");
  });

  it("PATCH /connections/{id} lifecycle retired → enabled 终态 → 422", async () => {
    // 先 retire
    const retireReq = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/connections/${connectionId}`,
      idempotencyKey: "idem-patch-conn-retire-001",
      ifMatch: "connection-1",
      body: { lifecycle_state: "retired" },
    });
    await patchConnectionPATCH(retireReq, {
      params: Promise.resolve({ connection_id: connectionId }),
    });

    // 再尝试 enable（终态不可恢复）
    const enableReq = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/connections/${connectionId}`,
      idempotencyKey: "idem-patch-conn-retire-002",
      ifMatch: "connection-2",
      body: { lifecycle_state: "enabled" },
    });
    const response = await patchConnectionPATCH(enableReq, {
      params: Promise.resolve({ connection_id: connectionId }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUSINESS_CONSTRAINT_VIOLATION");
  });
});

// ═══════════════════════════════════════════════════════════
// 10. Admin API: POST /tool-providers + GET/PATCH
// ═══════════════════════════════════════════════════════════

describe("Admin API: /admin/api/v1/tool-providers", () => {
  let tenantId: string;
  let userIdentityId: string;
  let providerId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
    const provider = await createToolProvider({
      tenantId,
      providerKey: "api-provider",
      providerType: "builtin",
      displayName: "API Provider",
      ownerUserId: userIdentityId,
    });
    providerId = provider.id;
  });

  it("POST 成功创建 → 201 + ETag(tool-provider-1)", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/tool-providers",
      idempotencyKey: "idem-create-provider-001",
      body: {
        provider_key: "new-provider",
        provider_type: "http_openapi",
        trust_level: "high",
        display_name: "New Provider",
        description: "via API",
        owner_user_id: userIdentityId,
      },
    });

    const response = await createProviderPOST(request);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.provider_key).toBe("new-provider");
    expect(body.trust_level).toBe("high");
    expect(body.etag).toBe("tool-provider-1");
  });

  it("POST 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/tool-providers",
      body: {
        provider_key: "no-idem",
        provider_type: "builtin",
        display_name: "X",
        owner_user_id: userIdentityId,
      },
    });

    const response = await createProviderPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("GET /tool-providers 成功 → 200 + items", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: "/tool-providers",
    });
    const response = await listProvidersGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it("GET /tool-providers/{id} 成功 → 200 + ETag", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: `/tool-providers/${providerId}`,
    });
    const response = await getProviderGET(request, {
      params: Promise.resolve({ provider_id: providerId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(providerId);
    expect(body.etag).toBe("tool-provider-1");
  });

  it("PATCH /tool-providers/{id} 成功 → 200 + ETag(tool-provider-2)", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/tool-providers/${providerId}`,
      idempotencyKey: "idem-patch-provider-001",
      ifMatch: "tool-provider-1",
      body: {
        display_name: "Patched Provider",
        trust_level: "high",
        lifecycle_state: "enabled",
      },
    });
    const response = await patchProviderPATCH(request, {
      params: Promise.resolve({ provider_id: providerId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.display_name).toBe("Patched Provider");
    expect(body.trust_level).toBe("high");
    expect(body.lifecycle_state).toBe("enabled");
    expect(body.version_no).toBe(2);
    expect(body.etag).toBe("tool-provider-2");
  });

  it("PATCH /tool-providers/{id} 缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/tool-providers/${providerId}`,
      idempotencyKey: "idem-patch-provider-no-ifmatch-001",
      body: { display_name: "X" },
    });
    const response = await patchProviderPATCH(request, {
      params: Promise.resolve({ provider_id: providerId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("PATCH /tool-providers/{id} ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/tool-providers/${providerId}`,
      idempotencyKey: "idem-patch-provider-etag-001",
      ifMatch: "tool-provider-999",
      body: { display_name: "X" },
    });
    const response = await patchProviderPATCH(request, {
      params: Promise.resolve({ provider_id: providerId }),
    });
    expect(response.status).toBe(412);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ETAG_MISMATCH");
  });
});

// ═══════════════════════════════════════════════════════════
// 11. Admin API: POST /tools + GET/PATCH
// ═══════════════════════════════════════════════════════════

describe("Admin API: /admin/api/v1/tools", () => {
  let tenantId: string;
  let userIdentityId: string;
  let providerId: string;
  let toolId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
    const provider = await createToolProvider({
      tenantId,
      providerKey: "api-tool-host",
      providerType: "builtin",
      displayName: "API Tool Host",
      ownerUserId: userIdentityId,
    });
    await updateToolProvider({
      tenantId,
      providerId: provider.id,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    providerId = provider.id;
    const tool = await createTool({
      tenantId,
      providerId,
      toolKey: "api-tool",
      displayName: "API Tool",
    });
    toolId = tool.id;
  });

  it("POST 成功创建 → 201 + ETag(tool-1)", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/tools",
      idempotencyKey: "idem-create-tool-001",
      body: {
        provider_id: providerId,
        tool_key: "new-tool",
        display_name: "New Tool",
        risk_class: "high",
      },
    });

    const response = await createToolPOST(request);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.tool_key).toBe("new-tool");
    expect(body.risk_class).toBe("high");
    expect(body.etag).toBe("tool-1");
  });

  it("POST 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/tools",
      body: {
        provider_id: providerId,
        tool_key: "no-idem",
        display_name: "X",
      },
    });

    const response = await createToolPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("POST provider 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const randomProviderId = "99999999-9999-4999-8999-999999999999";
    const requestId = "req-tool-no-provider";
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/tools",
      idempotencyKey: "idem-create-tool-no-provider-001",
      requestId,
      body: {
        provider_id: randomProviderId,
        tool_key: "orphan",
        display_name: "Orphan",
      },
    });

    const response = await createToolPOST(request);
    await assertCrossTenantHidden(response, requestId);
  });

  it("GET /tools 缺少 provider_id → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: "/tools",
    });
    const response = await listToolsGET(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("GET /tools?provider_id=... 成功 → 200 + items", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: `/tools?provider_id=${providerId}`,
    });
    const response = await listToolsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it("GET /tools/{id} 成功 → 200 + ETag + current_schema_revision=null", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: `/tools/${toolId}`,
    });
    const response = await getToolGET(request, {
      params: Promise.resolve({ tool_id: toolId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(toolId);
    expect(body.current_schema_revision).toBeNull();
    expect(body.etag).toBe("tool-1");
  });

  it("GET /tools/{id} 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const randomToolId = "99999999-9999-4999-8999-999999999999";
    const requestId = "req-tool-not-found";
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: `/tools/${randomToolId}`,
      requestId,
    });
    const response = await getToolGET(request, {
      params: Promise.resolve({ tool_id: randomToolId }),
    });
    await assertCrossTenantHidden(response, requestId);
  });

  it("PATCH /tools/{id} 成功 → 200 + ETag(tool-2)", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/tools/${toolId}`,
      idempotencyKey: "idem-patch-tool-001",
      ifMatch: "tool-1",
      body: {
        display_name: "Patched Tool",
        risk_class: "critical",
        lifecycle_state: "enabled",
      },
    });
    const response = await patchToolPATCH(request, {
      params: Promise.resolve({ tool_id: toolId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.display_name).toBe("Patched Tool");
    expect(body.risk_class).toBe("critical");
    expect(body.lifecycle_state).toBe("enabled");
    expect(body.version_no).toBe(2);
    expect(body.etag).toBe("tool-2");
  });

  it("PATCH /tools/{id} 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/tools/${toolId}`,
      ifMatch: "tool-1",
      body: { display_name: "X" },
    });
    const response = await patchToolPATCH(request, {
      params: Promise.resolve({ tool_id: toolId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("PATCH /tools/{id} ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/tools/${toolId}`,
      idempotencyKey: "idem-patch-tool-etag-001",
      ifMatch: "tool-999",
      body: { display_name: "X" },
    });
    const response = await patchToolPATCH(request, {
      params: Promise.resolve({ tool_id: toolId }),
    });
    expect(response.status).toBe(412);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ETAG_MISMATCH");
  });
});

// ═══════════════════════════════════════════════════════════
// 12. Admin API: POST /tools/{tool_id}/schema-revisions
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/tools/{tool_id}/schema-revisions", () => {
  let tenantId: string;
  let userIdentityId: string;
  let toolId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithToolBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
    const provider = await createToolProvider({
      tenantId,
      providerKey: "schema-rev-host",
      providerType: "builtin",
      displayName: "Schema Rev Host",
      ownerUserId: userIdentityId,
    });
    await updateToolProvider({
      tenantId,
      providerId: provider.id,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    const tool = await createTool({
      tenantId,
      providerId: provider.id,
      toolKey: "schema-rev-tool",
      displayName: "Schema Rev Tool",
    });
    toolId = tool.id;
  });

  it("成功创建 → 201 + revision_no=1 + revision_state=draft", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/tools/${toolId}/schema-revisions`,
      idempotencyKey: "idem-create-revision-001",
      body: {
        description: "v1 schema",
        input_schema: buildInputSchema(),
        output_schema: { type: "string" },
        risk_metadata: { effect: "read_only" },
      },
    });

    const response = await createSchemaRevisionPOST(request, {
      params: Promise.resolve({ tool_id: toolId }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.revision_no).toBe(1);
    expect(body.revision_state).toBe("draft");
    expect(body.tool_id).toBe(toolId);
    expect(body.schema_hash).toEqual(expect.any(String));
    expect((body.schema_hash as string).startsWith("sha256:")).toBe(true);
    expect(body.published_at).toBeNull();
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/tools/${toolId}/schema-revisions`,
      body: {
        input_schema: buildInputSchema(),
      },
    });

    const response = await createSchemaRevisionPOST(request, {
      params: Promise.resolve({ tool_id: toolId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("input_schema 非对象（数组）→ 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/tools/${toolId}/schema-revisions`,
      idempotencyKey: "idem-bad-revision-001",
      body: {
        input_schema: [1, 2, 3],
      },
    });

    const response = await createSchemaRevisionPOST(request, {
      params: Promise.resolve({ tool_id: toolId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("Tool 不存在 / 跨租户 → 404 RESOURCE_NOT_FOUND", async () => {
    const randomToolId = "99999999-9999-4999-8999-999999999999";
    const requestId = "req-revision-cross-tenant";
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/tools/${randomToolId}/schema-revisions`,
      idempotencyKey: "idem-revision-cross-tenant-001",
      requestId,
      body: {
        input_schema: buildInputSchema(),
      },
    });

    const response = await createSchemaRevisionPOST(request, {
      params: Promise.resolve({ tool_id: randomToolId }),
    });
    await assertCrossTenantHidden(response, requestId);
  });

  it("幂等重放 → 返回相同 revision", async () => {
    const body = {
      input_schema: buildInputSchema(),
    };
    const request1 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/tools/${toolId}/schema-revisions`,
      idempotencyKey: "idem-revision-replay-001",
      body,
    });
    const response1 = await createSchemaRevisionPOST(request1, {
      params: Promise.resolve({ tool_id: toolId }),
    });
    expect(response1.status).toBe(201);
    const body1 = (await response1.json()) as Record<string, unknown>;

    const request2 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/tools/${toolId}/schema-revisions`,
      idempotencyKey: "idem-revision-replay-001",
      body,
    });
    const response2 = await createSchemaRevisionPOST(request2, {
      params: Promise.resolve({ tool_id: toolId }),
    });
    expect(response2.status).toBe(201);
    const body2 = (await response2.json()) as Record<string, unknown>;
    expect(body2.id).toBe(body1.id);
  });
});

// ═══════════════════════════════════════════════════════════
// 13. Admin API 权限守卫：缺少 action scope → 403
// ═══════════════════════════════════════════════════════════

describe("Admin API 权限守卫：缺少 action scope → 403", () => {
  let tenantId: string;
  let userIdentityId: string;

  beforeEach(async () => {
    // 仅 seed tenant + user，不绑定任何 tool action
    const tenant = await ensureDefaultTenant();
    tenantId = tenant.id;
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: DEFAULT_USER_ID,
      email: DEFAULT_USER_EMAIL,
      displayName: DEFAULT_USER_NAME,
    });
    await upsertPrincipalBinding({
      tenantId: tenant.id,
      subjectType: "user",
      externalId: DEFAULT_USER_ID,
      displayName: DEFAULT_USER_NAME,
      userIdentityId: identity.id,
    });
    userIdentityId = identity.id;
  });

  it("POST /connections 缺 connection.create 绑定 → 403 ACTION_SCOPE_DENIED", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/connections",
      idempotencyKey: "idem-no-scope-conn-001",
      body: {
        connection_key: "no-scope",
        connection_type: "http",
        owner_user_id: userIdentityId,
      },
    });

    const response = await createConnectionPOST(request);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
  });

  it("POST /tool-providers 缺 tool.provider.create 绑定 → 403 ACTION_SCOPE_DENIED", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/tool-providers",
      idempotencyKey: "idem-no-scope-provider-001",
      body: {
        provider_key: "no-scope",
        provider_type: "builtin",
        display_name: "X",
        owner_user_id: userIdentityId,
      },
    });

    const response = await createProviderPOST(request);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
  });

  it("GET /tool-providers 缺 tool.provider.create 绑定 → 403 ACTION_SCOPE_DENIED", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: "/tool-providers",
    });

    const response = await listProvidersGET(request);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
  });
});
