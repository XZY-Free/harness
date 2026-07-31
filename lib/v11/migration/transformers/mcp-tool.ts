/**
 * S13-C03 mcp_tool 域迁移转换器。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §mcp_tool
 * - ../v11-agentkit-platform/10-core-data-model.md §4.4（能力和治理表）
 *
 * 映射：
 * - McpServerConfig → V11Connection + V11CredentialRef + V11ToolProvider + V11Tool
 *   （name→connectionKey/providerKey；env→CredentialRef vaultRef 不存明文；
 *     allowedTools→V11Tool；enabled→lifecycleState；name 重复为异常）
 * - CustomTool → V11Connection + V11ToolProvider + V11Tool + V11ToolSchemaRevision
 *   （inputSchema→ToolSchemaRevision(published)；executorConfig→Connection；
 *     name→providerKey/toolKey；保留源 id 为 V11Tool.id；name 重复为异常）
 *
 * 迁移原则：
 * - 只迁可证明事实；env 字段含 secret 脱敏存储，不迁移明文，用 CredentialRef vaultRef 引用。
 * - 保留源 id 作为主目标 id（McpServerConfig→V11Connection.id；CustomTool→V11Tool.id），
 *   便于跨表关联追溯。
 * - 跨表依赖按域顺序保证：McpServerConfig(order 1) → CustomTool(order 2)。
 * - name 重复（目标侧 connectionKey/providerKey 已存在）入异常队列，不猜测。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { DEFAULT_TENANT_ID } from "@/lib/v11/identity/tenant-queries";
import type { MigrationTransformer, TransformTarget } from "@/lib/v11/migration/migration-runner";
import { v11Connection, v11ToolProvider } from "@/lib/v11/schema/tool";
import { and, eq } from "drizzle-orm";

/**
 * 迁移系统服务账号 id（ownerUserId 逻辑外键，DB 不强制）。
 * 旧表不记录属主，迁移后统一归属迁移系统账号，便于追溯。
 */
const MIGRATION_SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000001";

/** 计算 sha256 指纹（带 sha256: 前缀，用于 CredentialRef 脱敏比对）。 */
function sha256Fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * enabled → V11 lifecycleState（true→enabled，false→disabled）。
 * 迁移运行器通过 db.execute 原生 SQL 读取源记录，boolean 列返回 0/1（number），
 * drizzle 类型映射不生效，故兼容 false/0/"0"/"false" 等假值表示。
 */
function enabledToLifecycleState(enabled: unknown): "enabled" | "disabled" {
  const isDisabled = enabled === false || enabled === 0 || enabled === "0" || enabled === "false";
  return isDisabled ? "disabled" : "enabled";
}

// ─── McpServerConfig → V11Connection + V11CredentialRef + V11ToolProvider + V11Tool ───

const mcpServerConfigTransformer: MigrationTransformer = async (record) => {
  const sourceId = String(record.id ?? "");
  const name = String(record.name ?? "");

  if (!sourceId) {
    return { targets: [], anomalyReason: "McpServerConfig.id 为空" };
  }
  if (!name) {
    return { targets: [], anomalyReason: "McpServerConfig.name 为空" };
  }

  // name 重复检查：目标 V11Connection 已存在同名 connectionKey
  const [existingConn] = await db
    .select({ id: v11Connection.id })
    .from(v11Connection)
    .where(
      and(eq(v11Connection.tenantId, DEFAULT_TENANT_ID), eq(v11Connection.connectionKey, name)),
    )
    .limit(1);
  if (existingConn) {
    return {
      targets: [],
      anomalyReason: `McpServerConfig name "${name}" 重复（V11Connection 已存在）`,
    };
  }

  const lifecycleState = enabledToLifecycleState(record.enabled);
  const url = record.url ? String(record.url) : null;
  const command = record.command ? String(record.command) : null;
  // stdio→command；http/sse→url；无端点时 null
  const endpointRef = url ?? command;

  const targets: TransformTarget[] = [];

  // 1. V11Connection（保留源 id）
  targets.push({
    table: "V11Connection",
    data: {
      id: sourceId,
      tenantId: DEFAULT_TENANT_ID,
      connectionKey: name,
      connectionType: "mcp",
      endpointRef: endpointRef ?? null,
      authMethod: "none",
      ownerUserId: MIGRATION_SYSTEM_USER_ID,
      lifecycleState,
    },
  });

  // 2. V11CredentialRef（env→vaultRef 引用，不存明文；仅存指纹用于脱敏比对）
  const env = record.env;
  if (env && typeof env === "object") {
    const envStr = JSON.stringify(env);
    targets.push({
      table: "V11CredentialRef",
      data: {
        id: randomUUID(),
        tenantId: DEFAULT_TENANT_ID,
        connectionId: sourceId,
        provider: "env",
        vaultRef: `mcp:${name}:env`,
        fingerprint: sha256Fingerprint(envStr),
        scopeJson: null,
        lifecycleState: "active",
      },
    });
  }

  // 3. V11ToolProvider（关联 Connection）
  const providerId = randomUUID();
  targets.push({
    table: "V11ToolProvider",
    data: {
      id: providerId,
      tenantId: DEFAULT_TENANT_ID,
      providerKey: name,
      providerType: "mcp",
      connectionId: sourceId,
      trustLevel: "standard",
      displayName: name,
      description: null,
      ownerUserId: MIGRATION_SYSTEM_USER_ID,
      lifecycleState,
    },
  });

  // 4. allowedTools → V11Tool（null=全部，无法枚举时不创建具体 Tool）
  const allowedTools = record.allowedTools;
  if (Array.isArray(allowedTools)) {
    for (const toolName of allowedTools) {
      const toolKey = String(toolName ?? "");
      if (!toolKey) continue;
      targets.push({
        table: "V11Tool",
        data: {
          id: randomUUID(),
          tenantId: DEFAULT_TENANT_ID,
          providerId,
          toolKey,
          displayName: toolKey,
          description: null,
          riskClass: "medium",
          currentSchemaRevisionId: null,
          lifecycleState,
        },
      });
    }
  }

  return { targets };
};

// ─── CustomTool → V11Connection + V11ToolProvider + V11Tool + V11ToolSchemaRevision ───

const customToolTransformer: MigrationTransformer = async (record) => {
  const sourceId = String(record.id ?? "");
  const name = String(record.name ?? "");

  if (!sourceId) {
    return { targets: [], anomalyReason: "CustomTool.id 为空" };
  }
  if (!name) {
    return { targets: [], anomalyReason: "CustomTool.name 为空" };
  }

  // name 重复检查：目标 V11ToolProvider 已存在同名 providerKey
  const [existingProvider] = await db
    .select({ id: v11ToolProvider.id })
    .from(v11ToolProvider)
    .where(
      and(eq(v11ToolProvider.tenantId, DEFAULT_TENANT_ID), eq(v11ToolProvider.providerKey, name)),
    )
    .limit(1);
  if (existingProvider) {
    return {
      targets: [],
      anomalyReason: `CustomTool name "${name}" 重复（V11ToolProvider 已存在）`,
    };
  }

  const lifecycleState = enabledToLifecycleState(record.enabled);
  const description = record.description ? String(record.description) : null;
  const executorType = String(record.executorType ?? "");
  const executorConfig = record.executorConfig;
  // webhook: { url, method, headers? }；script: { scriptId }
  const endpointRef =
    executorConfig && typeof executorConfig === "object"
      ? String(
          (executorConfig as Record<string, unknown>).url ??
            (executorConfig as Record<string, unknown>).scriptId ??
            "",
        ) || null
      : null;
  const connectionType = executorType === "webhook" ? "webhook" : "script";

  const targets: TransformTarget[] = [];

  // 1. V11Connection（executorConfig→Connection）
  const connectionId = randomUUID();
  targets.push({
    table: "V11Connection",
    data: {
      id: connectionId,
      tenantId: DEFAULT_TENANT_ID,
      connectionKey: name,
      connectionType,
      endpointRef: endpointRef ?? null,
      authMethod: "none",
      ownerUserId: MIGRATION_SYSTEM_USER_ID,
      lifecycleState,
    },
  });

  // 2. V11ToolProvider（关联 Connection）
  const providerId = randomUUID();
  targets.push({
    table: "V11ToolProvider",
    data: {
      id: providerId,
      tenantId: DEFAULT_TENANT_ID,
      providerKey: name,
      providerType: "custom",
      connectionId,
      trustLevel: "standard",
      displayName: name,
      description,
      ownerUserId: MIGRATION_SYSTEM_USER_ID,
      lifecycleState,
    },
  });

  // 3. V11ToolSchemaRevision（inputSchema→published revision；先生成 id 供 Tool 引用）
  const inputSchema = record.inputSchema;
  const revisionId = randomUUID();
  const inputSchemaStr =
    inputSchema && typeof inputSchema === "object" ? JSON.stringify(inputSchema) : "{}";

  // 4. V11Tool（保留源 id；currentSchemaRevisionId 指向同批 Revision）
  targets.push({
    table: "V11Tool",
    data: {
      id: sourceId,
      tenantId: DEFAULT_TENANT_ID,
      providerId,
      toolKey: name,
      displayName: name,
      description,
      riskClass: "medium",
      currentSchemaRevisionId: revisionId,
      lifecycleState,
    },
  });

  targets.push({
    table: "V11ToolSchemaRevision",
    data: {
      id: revisionId,
      toolId: sourceId,
      revisionNo: 1,
      description: null,
      inputSchemaJson: inputSchema ?? {},
      outputSchemaJson: null,
      schemaHash: sha256Fingerprint(inputSchemaStr),
      riskMetadataJson: null,
      revisionState: "published",
      createdBy: MIGRATION_SYSTEM_USER_ID,
      publishedAt: new Date(),
    },
  });

  return { targets };
};

// ─── 导出 mcp_tool 域转换器注册表 ──────────────────────────

/** 创建 mcp_tool 域的全部转换器（key = 物理表名）。 */
export function createMcpToolTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ["McpServerConfig", mcpServerConfigTransformer],
    ["CustomTool", customToolTransformer],
  ]);
}
