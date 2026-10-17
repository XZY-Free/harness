/** Executor 选择来自已发布的执行合同，不能由模型参数指定模块或程序入口。 */
export function providerExecutorKind(
  providerType: string,
  metadata: Record<string, unknown>,
): string | null {
  // nexharness 自有能力（本地执行）
  if (providerType === "webhook") return "webhook.post_json";
  if (providerType === "builtin") {
    const operation = metadata.operation;
    return operation === "web_search" || operation === "web_fetch" || operation === "shell"
      ? `builtin.${operation}`
      : null;
  }
  // 市场来源能力（执行归 capm）：mcp 走 capm MCP 网关；capm tool 走 capm tools 网关。
  // 操作（工具名 / toolKey）调用时才有，不依赖 metadata.operation。
  if (providerType === "mcp") return "mcp.call";
  if (providerType === "custom" || providerType === "script") return "market.tool.call";
  return null;
}
