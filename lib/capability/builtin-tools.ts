import {
  createTool,
  createToolProvider,
  createToolSchemaRevision,
  getCurrentToolSchemaRevision,
  getToolByKey,
  getToolProviderByKey,
  publishToolSchemaRevision,
  updateTool,
  updateToolProvider,
} from "./tool-queries";

const DEFINITIONS = [
  {
    key: "shell",
    operation: "shell",
    name: "运行命令",
    description:
      "在任务绑定的执行环境运行 shell 命令，可读取系统时间、检索文件、运行程序和修改工作区。返回实际退出码和输出；可能产生副作用，遵循执行权限。",
    argument: "command",
    argumentDescription: "要执行的 shell 命令",
  },
  {
    key: "web-search",
    operation: "web_search",
    name: "搜索网页",
    description: "搜索互联网公开资料，返回允许访问的来源链接和摘要。",
    argument: "query",
    argumentDescription: "搜索关键词",
  },
  {
    key: "web-fetch",
    operation: "web_fetch",
    name: "读取网页",
    description: "读取允许访问的公开网页，返回正文和可追溯来源。",
    argument: "url",
    argumentDescription: "网页的完整 HTTPS 地址",
  },
] as const;

/** 显式登记基础能力；沿用资产发布接口，不修改已有发布版本或管理员的停用决定。 */
export async function registerBuiltinTools(input: {
  tenantId: string;
  ownerUserId: string;
}): Promise<void> {
  let provider = await getToolProviderByKey({
    tenantId: input.tenantId,
    providerKey: "harness-builtin",
  });
  if (!provider) {
    provider = await createToolProvider({
      ...input,
      providerKey: "harness-builtin",
      providerType: "builtin",
      displayName: "Harness 基础工具",
    });
  }
  if (provider.providerType !== "builtin" || provider.connectionId)
    throw new Error("BUILTIN_PROVIDER_CONFLICT");
  if (provider.lifecycleState === "draft") {
    provider = await updateToolProvider({
      tenantId: input.tenantId,
      providerId: provider.id,
      expectedVersionNo: provider.versionNo,
      lifecycleState: "enabled",
    });
  }
  if (provider.lifecycleState !== "enabled") return;
  for (const definition of DEFINITIONS) {
    let tool = await getToolByKey({
      tenantId: input.tenantId,
      providerId: provider.id,
      toolKey: definition.key,
    });
    if (!tool)
      tool = await createTool({
        tenantId: input.tenantId,
        providerId: provider.id,
        toolKey: definition.key,
        displayName: definition.name,
        description: definition.description,
        riskClass: definition.operation === "shell" ? "high" : "low",
      });
    if (tool.lifecycleState !== "draft") continue;
    const current = await getCurrentToolSchemaRevision({
      tenantId: input.tenantId,
      toolId: tool.id,
    });
    if (!current) {
      const revision = await createToolSchemaRevision({
        tenantId: input.tenantId,
        toolId: tool.id,
        createdBy: input.ownerUserId,
        description: definition.description,
        inputSchemaJson: {
          type: "object",
          additionalProperties: false,
          required: [definition.argument],
          properties: {
            [definition.argument]: {
              type: "string",
              minLength: 1,
              maxLength: 8192,
              description: definition.argumentDescription,
            },
          },
        },
        executionContractJson: {
          timeoutMs: 15000,
          idempotencySupport: "none",
          sideEffectMode: definition.operation === "shell" ? "write" : "read",
          verificationMode: "provider_response",
          responseLimits: { maxBytes: 524288 },
          providerOperationMetadata: {
            operation: definition.operation,
            ...(definition.operation === "shell" ? { effectType: "update" } : {}),
          },
        },
      });
      const published = await publishToolSchemaRevision({
        tenantId: input.tenantId,
        schemaRevisionId: revision.id,
        publishedBy: input.ownerUserId,
      });
      tool = published.tool;
    }
    await updateTool({
      tenantId: input.tenantId,
      toolId: tool.id,
      expectedVersionNo: tool.versionNo,
      lifecycleState: "enabled",
    });
  }
}
