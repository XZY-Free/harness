/**
 * Context 查询编排器（阶段 7 S07-C01）。
 *
 * 事实源：docs/architecture/context-memory-and-knowledge.md §3（渐进加载）、§5（优先级与预算）。
 *
 * 职责：
 * - assembleContextView：运行所有源解析器，收集 Fragment，应用预算策略，返回 ContextView。
 * - 汇总各源状态（ok/empty/denied/unavailable），供 Runtime 区分“无结果”与“不可用”。
 * - 关键内容无法容纳时返回 failureReason（不静默丢约束）。
 *
 * 关键约束：
 * - 查询受 Invocation、用户、Agent、Workspace、Policy 和数据分类限制（由各 Resolver 保证）。
 * - 搜索/查询本身不写 CapabilityUse（与阶段 6 搜索语义一致；实际能力加载在 Tool Schema/Skill 内容读取时记账）。
 */
import {
  type BudgetSelectionResult,
  type ContextBudgetConfig,
  DEFAULT_BUDGET_CONFIG,
  selectFragmentsByBudget,
} from "@/lib/context/budget";
import type { ContextFragment, ExcludedFragment } from "@/lib/context/fragment";
import {
  type ContextQueryContext,
  KnowledgeResolver,
  MemoryResolver,
  RecentItemsResolver,
  SkillResolver,
  type SourceQueryResult,
  type SourceResolver,
  type SourceResultStatus,
  WorkspaceMapResolver,
} from "@/lib/context/source-resolvers";

// ─── ContextView ───────────────────────────────────────────

/**
 * 组装后的 Context View（模型本次看到的有限内容）。
 *
 * - fragments：选入视图的 Fragment（按优先级与插入顺序）。
 * - excluded：被预算排除的 Fragment 及原因（§5：记录被排除内容及原因）。
 * - sourceStatus：各源的查询状态（ok/empty/denied/unavailable）。
 * - tokenAccounting：Token 账目。
 * - failureReason：关键内容无法容纳时的失败原因（非空应显式失败或切换模型）。
 */
export interface ContextView {
  fragments: ContextFragment[];
  excluded: ExcludedFragment[];
  sourceStatus: Record<string, SourceResultStatus>;
  tokenAccounting: {
    inputTokens: number;
    availableInputBudget: number;
    modelOutputReserve: number;
  };
  failureReason: string | null;
}

// ─── 查询请求 ───────────────────────────────────────────────

/**
 * Context 查询请求。
 *
 * - ctx：查询上下文（tenantId/invocationId/threadId 等）。
 * - resolvers：本次查询使用的源解析器列表（由调用方按 requested_sources 构造）。
 * - budget：预算配置（默认 DEFAULT_BUDGET_CONFIG）。
 */
export interface ContextQueryRequest {
  ctx: ContextQueryContext;
  resolvers: SourceResolver[];
  budget?: ContextBudgetConfig;
}

// ─── 编排器 ─────────────────────────────────────────────────

/**
 * 组装 Context View（§3 渐进加载 + §5 优先级与预算）。
 *
 * 流程：
 * 1. 并发运行所有源解析器（Promise.all）。
 * 2. 收集 status=ok 的 Fragment，汇总各源 status。
 * 3. 应用预算策略 selectFragmentsByBudget。
 * 4. 返回 ContextView（含 failureReason）。
 *
 * 不变量：
 * - 源解析器失败（unavailable）不阻断其他源；unavailable 不伪装为 empty。
 * - failureReason 非空时调用方应显式失败或切换长上下文模型。
 */
export async function assembleContextView(request: ContextQueryRequest): Promise<ContextView> {
  const { ctx, resolvers, budget = DEFAULT_BUDGET_CONFIG } = request;

  // 1. 并发运行所有源解析器
  const results = await Promise.all(
    resolvers.map((r) =>
      r.resolve(ctx).catch((err): SourceQueryResult => {
        // 解析器抛错视为 unavailable（不伪装为 empty）
        return {
          sourceType: r.sourceType,
          status: "unavailable",
          fragments: [],
          reasonCode: "resolver_error",
          detail: err instanceof Error ? err.message : String(err),
        };
      }),
    ),
  );

  // 2. 汇总各源状态 + 收集 Fragment
  const sourceStatus: Record<string, SourceResultStatus> = {};
  const allFragments: ContextFragment[] = [];
  const statusPriority: Record<SourceResultStatus, number> = {
    empty: 0,
    ok: 1,
    unavailable: 2,
    denied: 3,
  };
  for (const result of results) {
    const previous = sourceStatus[result.sourceType];
    if (!previous || statusPriority[result.status] > statusPriority[previous]) {
      sourceStatus[result.sourceType] = result.status;
    }
    if (result.status === "ok" && result.fragments.length > 0) {
      allFragments.push(...result.fragments);
    }
  }

  // 3. 应用预算策略
  const selection: BudgetSelectionResult = selectFragmentsByBudget(allFragments, budget);

  // 4. 构造 ContextView
  return {
    fragments: selection.selected,
    excluded: selection.excluded,
    sourceStatus,
    tokenAccounting: {
      inputTokens: selection.totalInputTokens,
      availableInputBudget: selection.availableInputBudget,
      modelOutputReserve: budget.modelOutputReserve,
    },
    failureReason: selection.failureReason,
  };
}

// ─── 默认解析器集合 ─────────────────────────────────────────

/**
 * 构造默认全量解析器集合（所有源）。
 *
 * 调用方按 requested_sources 过滤；未请求的源不运行。
 */
export function buildDefaultResolvers(options: {
  skillId?: string;
}): SourceResolver[] {
  return [
    new RecentItemsResolver(),
    new SkillResolver(options.skillId ?? ""),
    new WorkspaceMapResolver(),
    new MemoryResolver(),
    new KnowledgeResolver(),
  ];
}
