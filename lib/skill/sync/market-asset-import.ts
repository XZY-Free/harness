import { computeToolExecutionContractDigest } from "@/lib/capability/tool-execution-contract";
import {
  createTool,
  createToolProvider,
  createToolSchemaRevision,
  getConnectionById,
  getCurrentToolSchemaRevision,
  getToolByKey,
  getToolProviderByKey,
  publishToolSchemaRevision,
  updateTool,
  updateToolProvider,
} from "@/lib/capability/tool-queries";
import { capabilityMarketConfig } from "@/lib/config";
/**
 * 市场 Tool / MCP 同步导入器。
 *
 * 把 capm 的 `tool_detail` / `mcp_detail` 落成本地 Tool 定义，**满足 catalog 三道门**：
 *   1. ToolSchemaRevision 落库后立即 publish（currentSchemaRevisionId 指向它）；
 *   2. ToolProvider + Tool lifecycleState = enabled；
 *   3. providerType 与 executorKind 匹配（tool → custom；mcp → mcp），registry 有执行器。
 *
 * 分层（2026-10-17 定稿）：市场能力的**执行归 capm**，本地只落"定义 + 连接指向"：
 *   - Connection.endpointRef = **capm API base**（执行时由此拼 /mcp|/tools/call）；
 *     远端 MCP 连接与凭证由 capm 持有，本地不落远端地址/凭证。
 *   - 每个远端资产一个本地 ToolProvider；mcp 的一个 Provider 可挂多个 Tool（按 tool 快照）。
 *
 * 幂等：按 (tenantId, providerKey) 查已有 Provider；存在则复用并（可选）新建 schema revision。
 */
import type {
  CapmMcpDetail,
  CapmToolDetail,
  SyncItem,
} from "@/lib/skill/sync/capability-market-client";

export class ToolSyncImportError extends Error {}

export interface ToolSyncImportResult {
  providerId: string;
  toolId: string;
  toolKey: string;
}

/** 默认执行合同：只读、幂等 header、30s、1MB 响应上限。市场能力多为读操作。 */
function defaultExecutionContract(sideEffect: "none" | "read" | "write") {
  return {
    timeoutMs: 30_000,
    idempotencySupport: "header" as const,
    sideEffectMode: sideEffect,
    verificationMode: sideEffect === "write" ? ("provider_response" as const) : ("none" as const),
    responseLimits: { maxBytes: 1_000_000 },
    providerOperationMetadata: {
      ...(sideEffect === "write" ? { effectType: "update" } : {}),
    },
  };
}

/** capm base（执行端点；本地 Connection.endpointRef 用它）。 */
function capmBase(): string {
  const endpoint = capabilityMarketConfig.endpoint;
  if (!endpoint)
    throw new ToolSyncImportError("capm endpoint 未配置（NEX_CAPABILITY_MARKET_ENDPOINT）");
  return endpoint.replace(/\/+$/, "");
}

/**
 * 导入一个远端资产（tool / mcp）为本地定义。
 *
 * @returns 本地 Provider + 首个 Tool id
 */
export async function importMarketAsset(input: {
  tenantId: string;
  actorUserId: string;
  item: SyncItem;
  /** 复用的本地 Connection（endpointRef = capm base）；null 时新建。 */
  connectionId: string | null;
  /** 是否为更新（已存在绑定）。 */
  isUpdate: boolean;
}): Promise<ToolSyncImportResult> {
  const { tenantId, actorUserId, item } = input;
  if (item.asset_type === "tool") {
    return importToolAsset(input, item, item.tool_detail);
  }
  if (item.asset_type === "mcp") {
    return importMcpAsset(input, item, item.mcp_detail);
  }
  throw new ToolSyncImportError(`不支持的资产类型：${item.asset_type}`);
}

async function importToolAsset(
  input: { tenantId: string; actorUserId: string; connectionId: string | null },
  item: SyncItem,
  detail: CapmToolDetail | null,
): Promise<ToolSyncImportResult> {
  if (!detail) throw new ToolSyncImportError(`tool ${item.asset_name} 缺少 tool_detail`);
  const { tenantId, actorUserId } = input;
  const providerKey = "capm-tool";
  const provider = await ensureProvider({
    tenantId,
    actorUserId,
    providerKey,
    providerType: "custom",
    displayName: "capability-market tool",
    description: "从 capability-market 同步的工具（执行经 capm）",
    connectionId: input.connectionId,
  });

  const toolKey = detail.tool_key || item.asset_name;
  const riskClass = asRiskClass(item.risk_level);
  const tool = await ensureTool({
    tenantId,
    providerId: provider.id,
    toolKey,
    displayName: toolKey,
    description: item.asset_name,
    riskClass,
  });

  await publishRevision({
    tenantId,
    actorUserId,
    toolId: tool.id,
    description: `${item.asset_name}@${item.resolved_version}`,
    inputSchema: detail.input_schema ?? { type: "object", properties: {} },
    outputSchema: detail.output_schema ?? null,
    executionContract: defaultExecutionContract("read"),
    // 执行经 capm /tools/call/:toolKey（capm 按 asset name 解析）
    metadata: { capmToolName: item.asset_name },
  });

  return { providerId: provider.id, toolId: tool.id, toolKey };
}

async function importMcpAsset(
  input: { tenantId: string; actorUserId: string; connectionId: string | null },
  item: SyncItem,
  detail: CapmMcpDetail | null,
): Promise<ToolSyncImportResult> {
  if (!detail) throw new ToolSyncImportError(`mcp ${item.asset_name} 缺少 mcp_detail`);
  const { tenantId, actorUserId } = input;
  const providerKey = "capm-mcp";
  const provider = await ensureProvider({
    tenantId,
    actorUserId,
    providerKey,
    providerType: "mcp",
    displayName: "capability-market mcp",
    description: "从 capability-market 同步的 MCP server（执行经 capm 网关）",
    connectionId: input.connectionId,
  });

  const tools = Array.isArray(detail.tools) ? detail.tools : [];
  if (tools.length === 0) {
    throw new ToolSyncImportError(`mcp ${item.asset_name} 无工具快照`);
  }
  let firstToolId: string | null = null;
  let firstToolKey: string | null = null;
  for (const t of tools) {
    const toolKey = t.name;
    if (!toolKey) continue;
    // 本地 toolKey 规则：^[a-z0-9]+(-[a-z0-9]+)*$（仅单连字符）。
    // mcp 工具名以 `-` 拼接并规范化（下划线/点等 → `-`），非法字符剔除以满足约束。
    const localKey = toLocalToolKey(item.asset_name, toolKey);
    const tool = await ensureTool({
      tenantId,
      providerId: provider.id,
      toolKey: localKey,
      displayName: toolKey,
      description: t.description ?? "",
      riskClass: asRiskClass(item.risk_level),
    });
    await publishRevision({
      tenantId,
      actorUserId,
      toolId: tool.id,
      description: `${item.asset_name}__${toolKey}@${item.resolved_version}`,
      inputSchema: t.input_schema ?? { type: "object", properties: {} },
      outputSchema: t.output_schema ?? null,
      // annotations 存入 riskMetadataJson（catalog 消费；缺失则 null 降级）
      riskMetadata: t.annotations ? { mcpAnnotations: t.annotations } : null,
      executionContract: defaultExecutionContract("read"),
      // 执行经 capm /mcp/call/:toolName：capm 侧命名为 `{asset}__{tool}`（见 capm mcp-proxy）
      metadata: { capmToolName: `${item.asset_name}__${toolKey}` },
    });
    if (!firstToolId) {
      firstToolId = tool.id;
      firstToolKey = tool.toolKey;
    }
  }
  if (!firstToolId || !firstToolKey) {
    throw new ToolSyncImportError(`mcp ${item.asset_name} 无有效工具`);
  }
  return { providerId: provider.id, toolId: firstToolId, toolKey: firstToolKey };
}

/** 确保 Provider 存在且 enabled（capm 同步来源）。 */
async function ensureProvider(input: {
  tenantId: string;
  actorUserId: string;
  providerKey: string;
  providerType: "custom" | "mcp";
  displayName: string;
  description: string;
  connectionId: string | null;
}) {
  const existing = await getToolProviderByKey({
    tenantId: input.tenantId,
    providerKey: input.providerKey,
  });
  if (existing) {
    // 已存在：确保 enabled + 挂 capm connection
    if (
      existing.lifecycleState !== "enabled" ||
      (input.connectionId && existing.connectionId !== input.connectionId)
    ) {
      return updateToolProvider({
        tenantId: input.tenantId,
        providerId: existing.id,
        lifecycleState: "enabled",
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        expectedVersionNo: existing.versionNo,
      });
    }
    return existing;
  }
  const created = await createToolProvider({
    tenantId: input.tenantId,
    providerKey: input.providerKey,
    providerType: input.providerType,
    connectionId: input.connectionId,
    displayName: input.displayName,
    description: input.description,
    ownerUserId: input.actorUserId,
  });
  return updateToolProvider({
    tenantId: input.tenantId,
    providerId: created.id,
    lifecycleState: "enabled",
    expectedVersionNo: created.versionNo,
  });
}

/** 确保 Tool 存在且 enabled。 */
async function ensureTool(input: {
  tenantId: string;
  providerId: string;
  toolKey: string;
  displayName: string;
  description: string;
  riskClass: "low" | "medium" | "high" | "critical";
}) {
  const existing = await getToolByKey({
    tenantId: input.tenantId,
    providerId: input.providerId,
    toolKey: input.toolKey,
  });
  if (existing) {
    if (existing.lifecycleState !== "enabled") {
      return updateTool({
        tenantId: input.tenantId,
        toolId: existing.id,
        lifecycleState: "enabled",
        expectedVersionNo: existing.versionNo,
      });
    }
    return existing;
  }
  const created = await createTool({
    tenantId: input.tenantId,
    providerId: input.providerId,
    toolKey: input.toolKey,
    displayName: input.displayName,
    description: input.description,
    riskClass: input.riskClass,
  });
  return updateTool({
    tenantId: input.tenantId,
    toolId: created.id,
    lifecycleState: "enabled",
    expectedVersionNo: created.versionNo,
  });
}

/** 建 schema revision 并立即 publish（满足 catalog 门 1）。 */
async function publishRevision(input: {
  tenantId: string;
  actorUserId: string;
  toolId: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  riskMetadata?: unknown;
  executionContract: ReturnType<typeof defaultExecutionContract>;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const contract = {
    ...input.executionContract,
    providerOperationMetadata: {
      ...input.executionContract.providerOperationMetadata,
      ...input.metadata,
    },
  };
  const revision = await createToolSchemaRevision({
    tenantId: input.tenantId,
    toolId: input.toolId,
    description: input.description,
    inputSchemaJson: input.inputSchema,
    outputSchemaJson: input.outputSchema ?? undefined,
    riskMetadataJson: input.riskMetadata ?? undefined,
    executionContractJson: contract,
    createdBy: input.actorUserId,
  });
  await publishToolSchemaRevision({
    tenantId: input.tenantId,
    schemaRevisionId: revision.id,
    publishedBy: input.actorUserId,
  });
}

function asRiskClass(risk: string | null): "low" | "medium" | "high" | "critical" {
  return risk === "low" || risk === "high" || risk === "critical" ? risk : "medium";
}

/**
 * 生成合法的本地 toolKey（`^[a-z0-9]+(-[a-z0-9]+)*$`，1-64）。
 * mcp 工具名可能含下划线/点等；规范化后用 `-` 拼接 asset 名，超长截断。
 */
export function toLocalToolKey(assetName: string, remoteToolName: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const a = norm(assetName);
  const t = norm(remoteToolName);
  let key = a && t ? `${a}-${t}` : a || t;
  if (!key) key = "mcp-tool";
  if (key.length > 64) key = key.slice(0, 64).replace(/-+$/, "");
  return key || "mcp-tool";
}

/** 取/建 capm 专用 Connection（endpointRef = capm base，authMethod=none，鉴权走 token）。 */
export async function ensureCapmConnection(input: {
  tenantId: string;
  actorUserId: string;
  existingConnectionId: string | null;
}): Promise<string | null> {
  const base = capmBase();
  if (input.existingConnectionId) {
    const existing = await getConnectionById({
      tenantId: input.tenantId,
      connectionId: input.existingConnectionId,
    });
    if (existing) return existing.id;
  }
  // 复用/新建：connectionKey 固定（租户级单例），endpointRef = capm base
  const { createConnection, updateConnection } = await import("@/lib/capability/tool-queries");
  const { getConnectionByKey } = await import("@/lib/capability/tool-queries");
  const key = "capability-market";
  const found = await getConnectionByKey({ tenantId: input.tenantId, connectionKey: key });
  if (found) {
    if (found.lifecycleState !== "enabled" || found.endpointRef !== base) {
      const updated = await updateConnection({
        tenantId: input.tenantId,
        connectionId: found.id,
        endpointRef: base,
        authMethod: "none",
        lifecycleState: "enabled",
        expectedVersionNo: found.versionNo,
      });
      return updated.id;
    }
    return found.id;
  }
  const created = await createConnection({
    tenantId: input.tenantId,
    connectionKey: key,
    connectionType: "http",
    endpointRef: base,
    authMethod: "none",
    ownerUserId: input.actorUserId,
  });
  const enabled = await updateConnection({
    tenantId: input.tenantId,
    connectionId: created.id,
    lifecycleState: "enabled",
    expectedVersionNo: created.versionNo,
  });
  return enabled.id;
}

/** 导出合同摘要计算（供调用方记录/校验）。 */
export function contractDigestOf(contract: unknown): string {
  return computeToolExecutionContractDigest(contract);
}
