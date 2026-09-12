/** Executor 选择来自已发布的执行合同，不能由模型参数指定模块或程序入口。 */
export function providerExecutorKind(
  providerType: string,
  metadata: Record<string, unknown>,
): string | null {
  if (providerType === "webhook") return "webhook.post_json";
  if (providerType !== "builtin") return null;
  const operation = metadata.operation;
  return operation === "web_search" || operation === "web_fetch" || operation === "shell"
    ? `builtin.${operation}`
    : null;
}
