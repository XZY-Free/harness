/**
 * S13-C03 mcp_tool 域迁移转换器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - McpServerConfig 转换器：正常迁移（stdio/http）、env 脱敏 CredentialRef、
 *   allowedTools→V11Tool、name 重复异常、enabled 状态映射、保留源 id
 * - CustomTool 转换器：正常迁移（webhook/script）、inputSchema→ToolSchemaRevision、
 *   name 重复异常、enabled 状态映射、保留源 id
 * - 端到端 mcp_tool 域迁移：McpServerConfig/CustomTool 顺序执行
 * - 幂等性：二次运行跳过已迁移记录
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { customTool as CustomTool, mcpServerConfig as McpServerConfig } from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { createExecutionRunner } from "@/lib/v11/migration/migration-runner";
import { InMemoryMigrationStateStore } from "@/lib/v11/migration/migration-state";
import { createMcpToolTransformers } from "@/lib/v11/migration/transformers/mcp-tool";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import {
  v11Connection,
  v11CredentialRef,
  v11Tool,
  v11ToolProvider,
  v11ToolSchemaRevision,
} from "@/lib/v11/schema/tool";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/** 迁移系统账号 id（与 mcp-tool.ts 中常量一致）。 */
const MIGRATION_SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

// ═══════════════════════════════════════════════════════════
// 1. McpServerConfig 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 McpServerConfig 转换器", () => {
  it("正常 stdio 迁移：Connection + CredentialRef + ToolProvider + Tool", async () => {
    await db.insert(McpServerConfig).values({
      id: "mcp-001",
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { API_KEY: "secret-abc", NODE_ENV: "production" },
      allowedTools: ["read_file", "write_file"],
      enabled: true,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMcpToolTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("mcp_tool");

    const table = result.tables.find((t) => t.sourceTable === "McpServerConfig");
    expect(table?.sourceCount).toBe(1);
    // 1 Connection + 1 CredentialRef + 1 ToolProvider + 2 Tool = 5
    expect(table?.targetCount).toBe(5);
    expect(table?.anomalyCount).toBe(0);

    // 验证 V11Connection（保留源 id）
    const [conn] = await db
      .select()
      .from(v11Connection)
      .where(eq(v11Connection.id, "mcp-001"))
      .limit(1);
    expect(conn).toBeDefined();
    expect(conn?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(conn?.connectionKey).toBe("filesystem");
    expect(conn?.connectionType).toBe("mcp");
    expect(conn?.endpointRef).toBe("npx");
    expect(conn?.authMethod).toBe("none");
    expect(conn?.ownerUserId).toBe(MIGRATION_SYSTEM_USER_ID);
    expect(conn?.lifecycleState).toBe("enabled");

    // 验证 V11CredentialRef（env 脱敏：不存明文，只存 vaultRef + 指纹）
    const [cred] = await db
      .select()
      .from(v11CredentialRef)
      .where(eq(v11CredentialRef.connectionId, "mcp-001"))
      .limit(1);
    expect(cred).toBeDefined();
    expect(cred?.provider).toBe("env");
    expect(cred?.vaultRef).toBe("mcp:filesystem:env");
    expect(cred?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cred?.lifecycleState).toBe("active");

    // 验证 V11ToolProvider
    const [provider] = await db
      .select()
      .from(v11ToolProvider)
      .where(eq(v11ToolProvider.connectionId, "mcp-001"))
      .limit(1);
    expect(provider).toBeDefined();
    expect(provider?.providerKey).toBe("filesystem");
    expect(provider?.providerType).toBe("mcp");
    expect(provider?.connectionId).toBe("mcp-001");
    expect(provider?.lifecycleState).toBe("enabled");

    // 验证 V11Tool（allowedTools 每项一个）
    const tools = await db
      .select()
      .from(v11Tool)
      .where(eq(v11Tool.providerId, provider?.id as string));
    expect(tools.length).toBe(2);
    const toolKeys = tools.map((t) => t.toolKey).sort();
    expect(toolKeys).toEqual(["read_file", "write_file"]);
    for (const t of tools) {
      expect(t.lifecycleState).toBe("enabled");
      expect(t.riskClass).toBe("medium");
    }
  });

  it("http 无 env 无 allowedTools：仅 Connection + ToolProvider", async () => {
    await db.insert(McpServerConfig).values({
      id: "mcp-002",
      name: "remote-api",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMcpToolTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("mcp_tool");

    const [conn] = await db
      .select()
      .from(v11Connection)
      .where(eq(v11Connection.id, "mcp-002"))
      .limit(1);
    expect(conn?.endpointRef).toBe("https://example.com/mcp");

    // 无 env → 无 CredentialRef
    const creds = await db
      .select()
      .from(v11CredentialRef)
      .where(eq(v11CredentialRef.connectionId, "mcp-002"));
    expect(creds.length).toBe(0);

    // 无 allowedTools(null=全部) → 无具体 V11Tool
    const [provider] = await db
      .select()
      .from(v11ToolProvider)
      .where(eq(v11ToolProvider.connectionId, "mcp-002"))
      .limit(1);
    const tools = await db
      .select()
      .from(v11Tool)
      .where(eq(v11Tool.providerId, provider?.id as string));
    expect(tools.length).toBe(0);
  });

  it("name 重复时入异常队列", async () => {
    // 预先插入同名 V11Connection（模拟目标侧已存在）
    await db.insert(v11Connection).values({
      id: "conn-pre-001",
      tenantId: DEFAULT_TENANT_ID,
      connectionKey: "mcp-dup",
      connectionType: "mcp",
      ownerUserId: MIGRATION_SYSTEM_USER_ID,
    });
    await db.insert(McpServerConfig).values({
      id: "mcp-dup-001",
      name: "mcp-dup",
      transport: "stdio",
      command: "node",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMcpToolTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("mcp_tool");

    const table = result.tables.find((t) => t.sourceTable === "McpServerConfig");
    expect(table?.anomalyCount).toBe(1);
    expect(table?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("McpServerConfig");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain("重复");
  });

  it("enabled=false 映射为 lifecycleState=disabled", async () => {
    await db.insert(McpServerConfig).values({
      id: "mcp-003",
      name: "disabled-server",
      transport: "stdio",
      command: "node",
      enabled: false,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMcpToolTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("mcp_tool");

    const [conn] = await db
      .select()
      .from(v11Connection)
      .where(eq(v11Connection.id, "mcp-003"))
      .limit(1);
    expect(conn?.lifecycleState).toBe("disabled");

    const [provider] = await db
      .select()
      .from(v11ToolProvider)
      .where(eq(v11ToolProvider.connectionId, "mcp-003"))
      .limit(1);
    expect(provider?.lifecycleState).toBe("disabled");
  });

  it("env 脱敏：V11CredentialRef 不存明文", async () => {
    await db.insert(McpServerConfig).values({
      id: "mcp-004",
      name: "secret-server",
      transport: "stdio",
      command: "node",
      env: { TOKEN: "plaintext-secret-value" },
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMcpToolTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("mcp_tool");

    const [cred] = await db
      .select()
      .from(v11CredentialRef)
      .where(eq(v11CredentialRef.connectionId, "mcp-004"))
      .limit(1);
    expect(cred).toBeDefined();
    // vaultRef 是引用路径，不含明文
    expect(cred?.vaultRef).toBe("mcp:secret-server:env");
    expect(cred?.vaultRef).not.toContain("plaintext-secret-value");
    // 指纹是 sha256 hash，不含明文
    expect(cred?.fingerprint).not.toContain("plaintext-secret-value");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. CustomTool 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 CustomTool 转换器", () => {
  it("正常 webhook 迁移：Connection + ToolProvider + Tool + ToolSchemaRevision", async () => {
    const inputSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    await db.insert(CustomTool).values({
      id: "ct-001",
      name: "web-search",
      description: "Web search tool",
      inputSchema,
      executorType: "webhook",
      executorConfig: { url: "https://hook.example.com/search", method: "POST" },
      enabled: true,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMcpToolTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("mcp_tool");

    const table = result.tables.find((t) => t.sourceTable === "CustomTool");
    expect(table?.sourceCount).toBe(1);
    // 1 Connection + 1 ToolProvider + 1 Tool + 1 SchemaRevision = 4
    expect(table?.targetCount).toBe(4);
    expect(table?.anomalyCount).toBe(0);

    // 验证 V11Connection（executorConfig→Connection）
    const [conn] = await db
      .select()
      .from(v11Connection)
      .where(eq(v11Connection.connectionKey, "web-search"))
      .limit(1);
    expect(conn).toBeDefined();
    expect(conn?.connectionType).toBe("webhook");
    expect(conn?.endpointRef).toBe("https://hook.example.com/search");
    expect(conn?.lifecycleState).toBe("enabled");

    // 验证 V11ToolProvider
    const [provider] = await db
      .select()
      .from(v11ToolProvider)
      .where(eq(v11ToolProvider.providerKey, "web-search"))
      .limit(1);
    expect(provider).toBeDefined();
    expect(provider?.providerType).toBe("custom");
    expect(provider?.connectionId).toBe(conn?.id);
    expect(provider?.displayName).toBe("web-search");
    expect(provider?.description).toBe("Web search tool");

    // 验证 V11Tool（保留源 id）
    const [tool] = await db.select().from(v11Tool).where(eq(v11Tool.id, "ct-001")).limit(1);
    expect(tool).toBeDefined();
    expect(tool?.providerId).toBe(provider?.id);
    expect(tool?.toolKey).toBe("web-search");
    expect(tool?.lifecycleState).toBe("enabled");
    expect(tool?.currentSchemaRevisionId).not.toBeNull();

    // 验证 V11ToolSchemaRevision（inputSchema→published revision）
    const [revision] = await db
      .select()
      .from(v11ToolSchemaRevision)
      .where(eq(v11ToolSchemaRevision.toolId, "ct-001"))
      .limit(1);
    expect(revision).toBeDefined();
    expect(revision?.revisionNo).toBe(1);
    expect(revision?.revisionState).toBe("published");
    expect(revision?.publishedAt).not.toBeNull();
    expect(revision?.schemaHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(revision?.inputSchemaJson).toEqual(inputSchema);
    expect(revision?.createdBy).toBe(MIGRATION_SYSTEM_USER_ID);
    // Tool.currentSchemaRevisionId 指向该 Revision
    expect(tool?.currentSchemaRevisionId).toBe(revision?.id);
  });

  it("script executor 映射为 connectionType=script", async () => {
    await db.insert(CustomTool).values({
      id: "ct-002",
      name: "lint-script",
      description: "Run linter",
      inputSchema: { type: "object", properties: {} },
      executorType: "script",
      executorConfig: { scriptId: "lint-v1" },
      enabled: true,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMcpToolTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("mcp_tool");

    const [conn] = await db
      .select()
      .from(v11Connection)
      .where(eq(v11Connection.connectionKey, "lint-script"))
      .limit(1);
    expect(conn?.connectionType).toBe("script");
    expect(conn?.endpointRef).toBe("lint-v1");
  });

  it("name 重复时入异常队列", async () => {
    // 预先插入同名 V11ToolProvider（模拟目标侧已存在）
    await db.insert(v11ToolProvider).values({
      id: "tp-pre-001",
      tenantId: DEFAULT_TENANT_ID,
      providerKey: "ct-dup",
      providerType: "custom",
      displayName: "ct-dup",
      ownerUserId: MIGRATION_SYSTEM_USER_ID,
    });
    await db.insert(CustomTool).values({
      id: "ct-dup-001",
      name: "ct-dup",
      description: "dup tool",
      inputSchema: { type: "object" },
      executorType: "webhook",
      executorConfig: { url: "https://hook.example.com", method: "POST" },
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMcpToolTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("mcp_tool");

    const table = result.tables.find((t) => t.sourceTable === "CustomTool");
    expect(table?.anomalyCount).toBe(1);
    expect(table?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("CustomTool");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain("重复");
  });

  it("enabled=false 映射为 lifecycleState=disabled", async () => {
    await db.insert(CustomTool).values({
      id: "ct-003",
      name: "disabled-tool",
      description: "disabled",
      inputSchema: { type: "object" },
      executorType: "webhook",
      executorConfig: { url: "https://hook.example.com", method: "POST" },
      enabled: false,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMcpToolTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("mcp_tool");

    const [conn] = await db
      .select()
      .from(v11Connection)
      .where(eq(v11Connection.connectionKey, "disabled-tool"))
      .limit(1);
    expect(conn?.lifecycleState).toBe("disabled");

    const [tool] = await db.select().from(v11Tool).where(eq(v11Tool.id, "ct-003")).limit(1);
    expect(tool?.lifecycleState).toBe("disabled");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 端到端 mcp_tool 域迁移
// ═══════════════════════════════════════════════════════════

describe("S13-C03 mcp_tool 域端到端迁移", () => {
  it("完整域迁移：McpServerConfig/CustomTool 顺序执行", async () => {
    await db.insert(McpServerConfig).values({
      id: "e2e-mcp-001",
      name: "e2e-filesystem",
      transport: "stdio",
      command: "npx",
      env: { KEY: "val" },
      allowedTools: ["read"],
      enabled: true,
    });
    await db.insert(CustomTool).values({
      id: "e2e-ct-001",
      name: "e2e-custom",
      description: "e2e custom tool",
      inputSchema: { type: "object" },
      executorType: "webhook",
      executorConfig: { url: "https://hook.example.com", method: "POST" },
      enabled: true,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMcpToolTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("mcp_tool");

    // 汇总：2 条源记录
    expect(result.totalSourceCount).toBe(2);
    expect(result.totalAnomalyCount).toBe(0);

    // McpServerConfig: 1 Connection + 1 CredentialRef + 1 ToolProvider + 1 Tool = 4
    const mcpTable = result.tables.find((t) => t.sourceTable === "McpServerConfig");
    expect(mcpTable?.targetCount).toBe(4);

    // CustomTool: 1 Connection + 1 ToolProvider + 1 Tool + 1 SchemaRevision = 4
    const ctTable = result.tables.find((t) => t.sourceTable === "CustomTool");
    expect(ctTable?.targetCount).toBe(4);

    // 验证 V11 表实际写入
    const conns = await db.select().from(v11Connection);
    expect(conns.length).toBe(2);
    const providers = await db.select().from(v11ToolProvider);
    expect(providers.length).toBe(2);
    const tools = await db.select().from(v11Tool);
    expect(tools.length).toBe(2);
    const revisions = await db.select().from(v11ToolSchemaRevision);
    expect(revisions.length).toBe(1);
    const creds = await db.select().from(v11CredentialRef);
    expect(creds.length).toBe(1);
  });

  it("幂等性：二次运行跳过所有已迁移记录", async () => {
    await db.insert(McpServerConfig).values({
      id: "idem-mcp-001",
      name: "idem-server",
      transport: "stdio",
      command: "node",
      enabled: true,
    });
    await db.insert(CustomTool).values({
      id: "idem-ct-001",
      name: "idem-tool",
      description: "idem",
      inputSchema: { type: "object" },
      executorType: "script",
      executorConfig: { scriptId: "s1" },
      enabled: true,
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMcpToolTransformers();

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runDomain("mcp_tool");
    expect(result1.totalTargetCount).toBeGreaterThan(0);

    const connCount1 = (await db.select().from(v11Connection)).length;
    const providerCount1 = (await db.select().from(v11ToolProvider)).length;

    // 第二次运行：应全部跳过，不产生新目标
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runDomain("mcp_tool");

    expect(result2.totalTargetCount).toBe(0);
    expect(result2.totalSkipCount).toBe(2);

    // V11 表行数不变
    const connCount2 = (await db.select().from(v11Connection)).length;
    const providerCount2 = (await db.select().from(v11ToolProvider)).length;
    expect(connCount2).toBe(connCount1);
    expect(providerCount2).toBe(providerCount1);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. createMcpToolTransformers 工厂
// ═══════════════════════════════════════════════════════════

describe("S13-C03 createMcpToolTransformers 工厂", () => {
  it("返回 2 个转换器", () => {
    const transformers = createMcpToolTransformers();
    expect(transformers.size).toBe(2);
    expect(transformers.has("McpServerConfig")).toBe(true);
    expect(transformers.has("CustomTool")).toBe(true);
  });

  it("每个转换器是函数类型", () => {
    const transformers = createMcpToolTransformers();
    for (const [, transformer] of transformers) {
      expect(typeof transformer).toBe("function");
    }
  });

  it("工厂每次调用返回独立 Map 实例", () => {
    const t1 = createMcpToolTransformers();
    const t2 = createMcpToolTransformers();
    expect(t1).not.toBe(t2);
    expect(t1.size).toBe(t2.size);
  });
});
