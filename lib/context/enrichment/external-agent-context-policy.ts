/**
 * External Agent Context Policy（04 §7）。
 *
 * Production External Agent 热路径禁止使用 allowAllContextPolicyFilter；
 * 本模块是阶段 1 固定保守策略：
 * - 低风险平台事实（execution_subject / current_datetime / timezone / locale）
 *   在合同声明前提下允许；
 * - 数据型 Context（conversation_* / attachment_references / workspace_context /
 *   organization_context / memory_context / knowledge_context / tenant_context 等）
 *   必须有明确现有 permission / egress allow；阶段 1 无明确 allow → deny。
 *
 * 事实源：docs/V12/01/04-InvocationContext-Enrichment-A2A.md §7/§12。
 */
import type { ContextPolicyFilter } from "@/lib/context/enrichment/build-invocation-context-bundle";

/** 低风险平台事实（04 §7：合同声明前提下可进入允许判断）。 */
const LOW_RISK_PLATFORM_FACTS = new Set([
  "execution_subject",
  "current_datetime",
  "timezone",
  "locale",
]);

/**
 * 阶段 1 固定保守 External egress 策略。
 *
 * @param options.explicitAllows 阶段 1 无数据型 Context 的正式 egress allow 来源；
 * 预留参数只在调用方持有明确 permission/egress allow 时传入（当前生产路径不传）。
 */
export function externalAgentContextPolicyFilter(
  options: { explicitAllows?: ReadonlySet<string> } = {},
): ContextPolicyFilter {
  const explicitAllows = options.explicitAllows ?? new Set<string>();
  return (contextKind) => {
    if (LOW_RISK_PLATFORM_FACTS.has(contextKind)) return { decision: "allow" };
    if (explicitAllows.has(contextKind)) return { decision: "allow" };
    return {
      decision: "deny",
      reason: `External egress 阶段 1 无明确 allow，数据型 contextKind=${contextKind} 默认拒绝`,
    };
  };
}
