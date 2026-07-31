/**
 * V5-E：前台 chat 不渲染的「内部工具」白名单。
 *
 * 这些工具属于 agent 内部编排细节（外部能力调用 / 子代理派生汇合），
 * 对普通员工无业务含义，且其 toolLabel 会暴露 MCP / subagent 等英文术语。
 * 方案 README「不做清单」明确：MCP / tool trace 仅 Studio 后台可见。
 *
 * 前台 MessageRow 在渲染 `tool-*` part 前先调 `isInternalToolPart` 过滤；
 * 后台 Studio thread 详情走 `app/studio/threads/[id]/page.tsx` 的 ToolTrace 组件，
 * 该组件直接从 DB listToolRunsByThread 拿数据，不依赖 chat part，过滤不影响排障视图。
 *
 * 名单与 lib/ai/tool-registry.ts 注册的 tool.name 严格对齐（仅收录内部编排类）。
 */
export const INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  // V3.4 Stage C：MCP 通用入口——员工不应感知「MCP」协议存在
  "listMcpTools",
  "callMcpTool",
  // V3.5 Stage C：子代理编排——派生 / 汇合属 agent 内部调度，员工看不到子代理
  "spawnSubagent",
  "joinSubagent",
  "joinSubagents",
]);

/**
 * 判定一个 tool part 是否属于「内部工具」（前台不渲染）。
 *
 * 入参形态：AI SDK 的 tool part，type 形如 `"tool-listMcpTools"`。
 * 兜底：part.type 非字符串 / 不以 `tool-` 开头 → false（交由 MessageRow 默认分支处理）。
 */
export function isInternalToolPart(part: { type: unknown }): boolean {
  if (typeof part.type !== "string") return false;
  if (!part.type.startsWith("tool-")) return false;
  const name = part.type.slice("tool-".length);
  return INTERNAL_TOOL_NAMES.has(name);
}
