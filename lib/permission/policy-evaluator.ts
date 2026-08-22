import type { PermissionDecisionValue } from "@/lib/persistence/schema/permission";
/**
 * Formal Policy Evaluator（关口02 02-6 · 冻结方案 §15 / §16 / §18 / §P6）。
 *
 * 纯函数：只接受平台已解析事实，不接受模型直传的 tenantId/userId/policyRevisionId/
 * credentialRef/permissionDecision 作为 Authority（§15.1）。
 *
 * 策略层级（§15.2）：
 *   平台不可关闭的强制规则  >  Tenant/Route PolicyRevision  >  AgentRevision 更严格 requirements
 *   >  当前操作已有的窄范围授权事实（Grant）。
 *
 * 原则：
 *   - Agent 只能收紧（block > pause > allow），绝不放宽。
 *   - Grant 只满足"允许被授权的缺口"（可把 pause → allow），绝不把 block 降级。
 *   - 任何东西都不能把 block 降级。
 *
 * 正式决策值仅 allow / pause / block（§P3，无 legacy ask/deny）。
 * 无规则命中时使用冻结 Revision 的 defaultDecision（P1 默认 pause，§P1）。
 *
 * 本文件自带匹配逻辑（toolPattern / argMatcher / scope），不复用已删除的 legacy
 * lib/permission/engine.ts（02-6 P9 物理删除）。正则 ReDoS 防护复用 lib/security/regex-safety。
 */
import { isReDoSRisky } from "@/lib/security/regex-safety";

// ─── 决策强度 ─────────────────────────────────────────────
/** 决策强度排序：block > pause > allow（§6.2 / schema Policy.priority 注释）。 */
export const DECISION_RANK: Record<PermissionDecisionValue, number> = {
  block: 2,
  pause: 1,
  allow: 0,
};

/** 返回更严格者（tighter(a,b)；用于 Agent 收紧 / Grant 之外的合成）。 */
export function tighterDecision(
  a: PermissionDecisionValue,
  b: PermissionDecisionValue,
): PermissionDecisionValue {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

// ─── 规则视图（解耦 DB row，纯输入） ──────────────────────
/** 与 PolicyRuleDigestInput 对齐的规则视图（不含 row id/时间戳）。 */
export interface PolicyRuleView {
  ruleKey: string;
  toolPattern: string;
  argMatcher: { pathRegex?: string; commandRegex?: string; risk?: string } | null;
  decision: PermissionDecisionValue;
  scope: { type: string; ref?: string | null } | null;
  priority: number;
}

/** AgentRevision.permissionRequirementsJson 中本批解释的子集：工具风险硬上限。 */
export interface AgentPermissionRequirements {
  /** 允许的工具风险类上限；超过 → Agent 收紧为 pause（§15.2 Agent 只能收紧）。 */
  toolRiskMax?: string | null;
}

/** 评估上下文（scope 匹配用；来自 Invocation/Thread）。 */
export interface PolicyScopeContext {
  threadId?: string | null;
  projectId?: string | null;
  skillId?: string | null;
}

export interface PolicyEvaluatorInput {
  /** 完整 permissionKey（如 `tool.writeFile`），匹配 Policy.toolPattern。 */
  toolKey: string;
  /** 脱敏后的工具参数（argMatcher 匹配）。 */
  arguments: Record<string, unknown>;
  /** Tool 风险类（riskClass，来自 Tool/riskMetadata）。 */
  toolRiskClass: string | null;
  /** scope 上下文（Invocation/Thread 派生）。 */
  scopeContext: PolicyScopeContext;
  /** 冻结 Revision 的 defaultDecision（无规则命中时生效）。 */
  defaultDecision: PermissionDecisionValue;
  /** 冻结 Revision 的 Policy rows（本批精确加载的那一版）。 */
  rules: readonly PolicyRuleView[];
  /** AgentRevision.permissionRequirementsJson 解释结果；null=无更严约束。 */
  agentRequirements: AgentPermissionRequirements | null;
  /** 当前操作已有的窄范围授权 scopes（有效 Grant）；空=无。 */
  grantScopes: readonly string[];
  /** 平台不可关闭强制规则（可选；命中 → fail-closed block）。 */
  platformRules?: readonly PolicyRuleView[];
}

export interface PolicyEvaluationResult {
  decision: PermissionDecisionValue;
  /** 触发原因码（写入 PermissionDecision.reasonCodesJson，脱敏）。 */
  reasonCodes: string[];
  /** 风险摘要（riskSummaryJson）。 */
  riskSummary: Record<string, unknown> | null;
  /** 人类可读决策说明（脱敏）。 */
  decisionSummary: string;
  /** 命中的策略规则；null = 无规则命中（走 defaultDecision）。 */
  matchedRule: { ruleKey: string; toolPattern: string; decision: PermissionDecisionValue } | null;
  /** 是否被 Agent 更严要求收紧。 */
  agentGated: boolean;
  /** 是否由 Grant 满足允许缺口（pause → allow）。 */
  grantSatisfied: boolean;
}

// ─── toolPattern 匹配（§6.4 正式形态） ────────────────────
/** 规范化：裸名（无前缀）补 `tool.` 前缀；已带前缀原样（对齐 legacy 零回归语义）。 */
const PREFIX_RE = /^(tool|mcp|web|docs|custom|external)\b/;
function normalizePattern(pattern: string): string {
  return PREFIX_RE.test(pattern) ? pattern : `tool.${pattern}`;
}

/**
 * toolPattern 是否匹配 toolKey。
 * - "*" → 全部
 * - "prefix.*" → 匹配 prefix.<X>（一层以上）
 * - 完整 key → 精确匹配
 * - 裸名 → 等价 `tool.<name>`
 */
export function matchPolicyPattern(pattern: string, toolKey: string): boolean {
  if (pattern === "*") return true;
  const norm = normalizePattern(pattern);
  if (norm.endsWith(".*")) {
    const base = norm.slice(0, -2);
    return toolKey.startsWith(`${base}.`);
  }
  return norm === toolKey;
}

// ─── argMatcher 匹配（§6.5；fail-closed） ─────────────────
function normalizePathForMatch(raw: string): string {
  const p = raw.replace(/^(\/|\.\/)+/, "");
  const parts = p.split("/").filter(Boolean);
  const resolved: string[] = [];
  for (const seg of parts) {
    if (seg === ".") continue;
    if (seg === "..") {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  return resolved.join("/");
}

/** argMatcher 是否匹配 input（fail-closed：约束字段缺失 → 不匹配）。 */
function matchPolicyArg(
  matcher: PolicyRuleView["argMatcher"],
  input: Record<string, unknown>,
): boolean {
  if (!matcher) return true;
  if (matcher.pathRegex !== undefined) {
    if (typeof input.path !== "string") return false;
    if (input.path.length > 10_000) return false;
    if (isReDoSRisky(matcher.pathRegex)) return false;
    const re = new RegExp(matcher.pathRegex);
    const normalized = normalizePathForMatch(input.path);
    return re.test(input.path) || re.test(normalized);
  }
  if (matcher.commandRegex !== undefined) {
    if (typeof input.command !== "string") return false;
    if (input.command.length > 10_000) return false;
    if (isReDoSRisky(matcher.commandRegex)) return false;
    return new RegExp(matcher.commandRegex).test(input.command);
  }
  return true;
}

// ─── scope 匹配（对齐 legacy isScopeApplicable，fail-closed） ──
function isScopeApplicable(scope: PolicyRuleView["scope"], ctx: PolicyScopeContext): boolean {
  if (!scope) return true;
  switch (scope.type) {
    case "tenant":
    case "global":
      return true;
    case "thread":
      return scope.ref === null || scope.ref === undefined || scope.ref === ctx.threadId;
    case "project":
      return scope.ref === null || scope.ref === undefined || scope.ref === ctx.projectId;
    case "skill":
      return scope.ref === null || scope.ref === undefined || scope.ref === ctx.skillId;
    default:
      // 未识别 scope 类型 → fail-closed 不匹配。
      return false;
  }
}

/** 单条规则是否命中（toolPattern + argMatcher + scope 全匹配）。 */
function ruleMatches(rule: PolicyRuleView, input: PolicyEvaluatorInput): boolean {
  if (!matchPolicyPattern(rule.toolPattern, input.toolKey)) return false;
  if (!matchPolicyArg(rule.argMatcher, input.arguments)) return false;
  if (!isScopeApplicable(rule.scope, input.scopeContext)) return false;
  return true;
}

/**
 * 规则集合排序：priority DESC → decision(block>pause>allow) → toolPattern ASC → ruleKey ASC。
 * 与 computePolicyRulesHash 的 canonical 排序一致（§7）。
 */
export function sortPolicyRules(rules: readonly PolicyRuleView[]): PolicyRuleView[] {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const da = DECISION_RANK[a.decision];
    const db = DECISION_RANK[b.decision];
    if (da !== db) return db - da;
    if (a.toolPattern !== b.toolPattern) return a.toolPattern < b.toolPattern ? -1 : 1;
    return a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0;
  });
}

/** 命中规则中按 effective 顺序取第一条（priority 最高；同优先级 block>pause>allow）。 */
function pickMatchedRule(input: PolicyEvaluatorInput): PolicyRuleView | null {
  const matched = input.rules.filter((r) => ruleMatches(r, input));
  if (matched.length === 0) return null;
  return sortPolicyRules(matched)[0] ?? null;
}

// ─── Agent 风险收紧 ───────────────────────────────────────
/** 风险类排序（未知 → 最低）。 */
const RISK_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  high_with_confirmation: 2,
  critical: 3,
};
function rankRisk(value: string | null | undefined): number {
  if (!value) return 0;
  return RISK_RANK[value] ?? 0;
}

/**
 * Agent 更严格 requirements 的收紧结果。
 * - 无 toolRiskMax → allow（不收紧）。
 * - toolRiskMax 明确且工具风险超过上限 → pause（需要确认，Agent 只收紧）。
 * 返回决策值；block 永不由此产生（Agent 只能收紧到 pause，block 只来自平台/Policy）。
 */
function evaluateAgentRisk(
  input: PolicyEvaluatorInput,
  agentRequirements: AgentPermissionRequirements,
): PermissionDecisionValue {
  if (!agentRequirements.toolRiskMax) return "allow";
  if (rankRisk(input.toolRiskClass) > rankRisk(agentRequirements.toolRiskMax)) {
    return "pause";
  }
  return "allow";
}

// ─── Grant 满足允许缺口 ───────────────────────────────────
/** Grant scope 是否覆盖当前工具调用（tool:execute 全局 / tool.<key> 精确 / <key>:* 前缀）。 */
function grantCovers(input: PolicyEvaluatorInput): boolean {
  if (input.grantScopes.length === 0) return false;
  const exact = `tool:${input.toolKey}`;
  const bare = input.toolKey;
  return input.grantScopes.some((scope) => {
    if (scope === "tool:execute") return true;
    if (scope === exact) return true;
    if (scope === bare) return true;
    if (scope.endsWith(":execute") && scope.slice(0, -":execute".length) === bare) return true;
    return false;
  });
}

// ─── 主评估 ───────────────────────────────────────────────
function buildResult(
  decision: PermissionDecisionValue,
  matchedRule: PolicyEvaluationResult["matchedRule"],
  agentGated: boolean,
  grantSatisfied: boolean,
  input: PolicyEvaluatorInput,
): PolicyEvaluationResult {
  const reasonCodes: string[] = [];
  const riskSummary: Record<string, unknown> = { riskClass: input.toolRiskClass ?? "low" };
  const parts: string[] = [];

  if (matchedRule) {
    reasonCodes.push(`policy.${matchedRule.decision}`);
    reasonCodes.push(`rule.${matchedRule.ruleKey}`);
    parts.push(`规则 ${matchedRule.ruleKey}(${matchedRule.decision})`);
  } else {
    reasonCodes.push(`policy.default_${input.defaultDecision}`);
    parts.push(`默认 ${input.defaultDecision}`);
  }
  if (agentGated) {
    reasonCodes.push("agent.risk_gate");
    parts.push("Agent 风险收紧");
  }
  if (grantSatisfied) {
    reasonCodes.push("grant.satisfied");
    parts.push("已授权");
  }

  let decisionSummary: string;
  switch (decision) {
    case "block":
      decisionSummary = `已阻止（${parts.join("；")}）`;
      break;
    case "pause":
      decisionSummary = `待确认（${parts.join("；")}）`;
      break;
    default:
      decisionSummary = `已允许（${parts.join("；")}）`;
  }

  return {
    decision,
    reasonCodes,
    riskSummary,
    decisionSummary,
    matchedRule,
    agentGated,
    grantSatisfied,
  };
}

/**
 * 正式策略评估（纯函数，§15）。
 *
 * 流程：
 * 1. 平台不可关闭强制规则：命中 → fail-closed block（§15.2 最顶）。
 * 2. PolicyRevision 规则：取首个 toolPattern+argMatcher+scope 全匹配规则；无 → defaultDecision。
 *    policy block → 立即 block（任何东西不能降级 block）。
 * 3. Agent 更严要求：只收紧（block/pause > allow），绝不放宽；block 已返回则不再收紧。
 * 4. 合成 tighter(policy, agent)；block 永不降级。
 * 5. Grant 只满足允许缺口：pause → allow（不降级 block）。
 */
export function evaluatePolicy(input: PolicyEvaluatorInput): PolicyEvaluationResult {
  // 1. 平台强制规则（fail-closed）。
  for (const rule of sortPolicyRules(input.platformRules ?? [])) {
    if (ruleMatches(rule, input)) {
      return buildResult(
        "block",
        { ruleKey: rule.ruleKey, toolPattern: rule.toolPattern, decision: rule.decision },
        false,
        false,
        input,
      );
    }
  }

  // 2. PolicyRevision 规则。
  const matched = pickMatchedRule(input);
  const policyDecision: PermissionDecisionValue = matched
    ? matched.decision
    : input.defaultDecision;
  const matchedMeta = matched
    ? { ruleKey: matched.ruleKey, toolPattern: matched.toolPattern, decision: matched.decision }
    : null;

  // block 永不降级（§15.2）。
  if (policyDecision === "block") {
    return buildResult("block", matchedMeta, false, false, input);
  }

  // 3. Agent 更严要求（只收紧）。
  let agentGated = false;
  let agentDecision: PermissionDecisionValue = "allow";
  if (input.agentRequirements) {
    agentDecision = evaluateAgentRisk(input, input.agentRequirements);
    if (agentDecision === "pause") agentGated = true;
  }

  // 4. 合成（tighter）。
  let decision = tighterDecision(policyDecision, agentDecision);

  // 5. Grant 满足允许缺口（pause → allow；block 已返回，永不降级）。
  let grantSatisfied = false;
  if (decision === "pause" && grantCovers(input)) {
    decision = "allow";
    grantSatisfied = true;
  }

  return buildResult(decision, matchedMeta, agentGated, grantSatisfied, input);
}
