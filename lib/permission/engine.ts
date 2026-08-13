import type { ApprovalScope, PermissionDecision, ToolApprovalRequest } from "@/lib/db/schema";
/**
 * allow/deny/ask 三态权限引擎纯函数（蓝图 / §12 ）。
 *
 * 单一收口：`executeToolRun` 用本引擎替换 deny-only 的 `beforeTool`。所有工具（含 新增 8 个）
 * 自动受治理，无需在每个工具里重复挂 hook。
 *
 * 三态语义：
 * - `allow` → 直接跑 runner
 * - `deny` → fail-closed 不跑（payload failureKind=policy，与现状一致）
 * - `ask` → 无既定批准则暂停（返回 awaitingApproval）；有匹配批准则升级为 allow
 *
 * deny 零回归：默认 deny 规则由 `buildDefaultRules(PolicyConfig)` 派生，pathRegex/commandRegex
 * 的匹配与 `decideWrite/decideCommand` 等价（test 原文 + 规范化路径）。非 global/sticky 正则
 * `new RegExp(source).test(s)` 与原 RegExp.test 等价。
 *
 * 本函数为纯函数：不触 DB。DB 规则与已批准 approvals 由调用方查询后传入。
 */
import type { PolicyConfig } from "@/lib/policy/config";
import { getPolicyConfig } from "@/lib/policy/config";
import { computeArgFingerprint, isApprovalApplicable, isApprovalExpired } from "./approval";
import { type PermissionRule, buildDefaultRules } from "./rules";

export type { PermissionDecision, PermissionRule };

export interface PermissionVerdict {
  decision: PermissionDecision;
  reason?: string;
  matchedRuleId?: string;
  /** ask 升级为 allow 时附带的已批准审批请求 id。 */
  existingApprovalId?: string;
  /** ask 升级为 allow 时附带的批准复用 scope，供调用方处理 once 消费。 */
  existingApprovalScope?: ApprovalScope | null;
}

export interface EvaluatePermissionArgs {
  toolName: string;
  input: Record<string, unknown>;
  threadId: string;
  projectId?: string | null;
  /**
   * 当前 thread 绑定的 skillId(供 skill-scope 权限规则匹配)。
   * tool-runtime 从 thread.activeSkill 解析后注入;无绑定 skill 时 null。
   * skill-scope 规则(scope=skill, scopeRef=skillId)仅对绑定该 skill 的 thread 生效。
   */
  skillId?: string | null;
  /**
   * 覆盖 permissionKey（默认 `tool.${toolName}`）。
   * MCP/web/custom 工具用非 `tool.` 前缀的 permissionKey（如 `mcp.github.create_issue` /
   * `web.fetch`），需经此传入才能让规则匹配与审批复用对齐。默认走 `tool.<name>`（零回归）。
   */
  permissionKey?: string;
  /** DB 持久化规则（覆盖默认规则）。默认空。 */
  dbRules?: PermissionRule[];
  /** 已批准且按 permissionKey+argFingerprint 候选的审批请求（ask→allow 升级用）。默认空。 */
  existingApprovals?: ToolApprovalRequest[];
  /** PolicyConfig 来源（默认 getPolicyConfig()，测试可经 setPolicyConfig 覆盖）。 */
  config?: PolicyConfig;
}

/** 同优先级决策强度排序：deny > ask > allow。 */
const DECISION_RANK: Record<PermissionDecision, number> = { deny: 3, ask: 2, allow: 1 };

/**
 * 支持的 permissionKey 前缀（多前缀分发）。
 * - tool. 内置工具（tool.writeFile）
 * - mcp. MCP 工具（mcp.<server>.<tool>）
 * - web. web 工具（web.fetch / web.search）
 * - docs. 文档工具（docs.search）
 * - custom. 自定义工具（custom.<name>）
 *
 * 裸名（无任一已知前缀）仍等价 `tool.<name>`（零回归）。
 */
const PERMISSION_PREFIXES = ["tool.", "mcp.", "web.", "docs.", "custom."] as const;

function hasPermissionPrefix(s: string): boolean {
  return PERMISSION_PREFIXES.some((p) => s.startsWith(p));
}

/**
 * toolPattern 是否匹配 permissionKey。
 * - "*" → 匹配全部
 * - "tool.*" → 匹配任意 tool.X
 * - "tool.writeFile" → 精确匹配
 * - 裸 "writeFile" → 等价 "tool.writeFile"（零回归）
 * - "mcp.*" → 匹配任意 mcp.X；"mcp.github.*" → 匹配 mcp.github.<tool>
 * - "web.*"/"docs.*"/"custom.*" 同理
 *
 * 修复：原实现 `pattern.startsWith("tool.") ? pattern : \`tool.${pattern}\``
 * 会把 `mcp.github.*` 错规范化为 `tool.mcp.github.*`，导致 MCP 权限规则永不命中。
 * 现按已知前缀分发：已带前缀原样匹配，裸名才补 `tool.`。
 */
export function matchToolPattern(pattern: string, permissionKey: string): boolean {
  if (pattern === "*") return true;
  // 裸名（无已知前缀）等价 tool.<name>——零回归
  const norm = hasPermissionPrefix(pattern) ? pattern : `tool.${pattern}`;
  // 尾缀通配 `<base>.*` → 匹配 <base> 下任意一层以上（<base>.<...>）。
  // tool.* → base="tool" → 匹配 "tool.X"（不含裸 "tool"，与 行为逐字一致）。
  if (norm.endsWith(".*")) {
    const base = norm.slice(0, -2);
    return permissionKey.startsWith(`${base}.`);
  }
  return norm === permissionKey;
}

/**
 * argMatcher 是否匹配 input（与 decideWrite/decideCommand 等价）。
 * - pathRegex：对 input.path 的原文与规范化形式都 test（对齐 decideWrite）
 * - commandRegex：对 input.command 的原文 test（对齐 decideCommand）
 * - risk：不在引擎层解释（规则层 ask 表达），存在即忽略
 */
function matchArg(matcher: PermissionRule["argMatcher"], input: Record<string, unknown>): boolean {
  if (!matcher) return true;
  if (matcher.pathRegex !== undefined) {
    // 审计修复 H2：原代码在 input 无 path 字段时 fall-through 到 return true（fail-open），
    // 导致 pathRegex deny 规则错误匹配 runCommand 等无 path 工具。
    // 现 fail-closed：约束字段不存在 → 不匹配（与 mcp/tools.ts matchArgMatcher 对齐）。
    if (typeof input.path !== "string") return false;
    // ReDoS 防护——限输入长度 + 源码风险检测（嵌套量词拒绝）
    if (input.path.length > 10_000) return false;
    if (isReDoSRisky(matcher.pathRegex)) return false;
    const re = new RegExp(matcher.pathRegex);
    const normalized = normalizePathForMatch(input.path);
    if (re.test(input.path) || re.test(normalized)) return true;
    return false;
  }
  if (matcher.commandRegex !== undefined) {
    // 审计修复 H2：同上，command 字段不存在时 fail-closed
    if (typeof input.command !== "string") return false;
    if (input.command.length > 10_000) return false;
    if (isReDoSRisky(matcher.commandRegex)) return false;
    const re = new RegExp(matcher.commandRegex);
    return re.test(input.command);
  }
  return true;
}

/**
 * 审计修复：路径规范化（纯字符串操作，不触 IO）。
 * 剥离前导 "/" 和 "./"，解析 ".." 和 "." 组件，返回干净的相对路径。
 * 与 workspace.ts safeJoin 的词法守卫对齐，让 permission engine 看到的
 * normalized path 和实际写入路径一致，防规则绕过。
 */
function normalizePathForMatch(raw: string): string {
  // 剥离前导 "/"、"./"
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

/** ReDoS 源码风险检测（嵌套量词 / 重叠交替量词）。 */
export function isReDoSRisky(source: string): boolean {
  if (/\([^()]*[+*?][^()]*\)[+*?]/.test(source)) return true;
  if (/\(([^|()]+)\|(\1)\)[+*?]/.test(source)) return true;
  return false;
}

/**
 * scope 是否对当前 (threadId, projectId, skillId) 适用。
 *
 * skill-scope 真解释(原注释自承"不解释,空壳")。
 * - scopeRef=null → 不绑定具体 skill,对所有 thread 放行(全局 skill 规则)
 * - scopeRef=skillId → 仅对绑定该 skill 的 thread 生效(ctx.skillId 匹配)
 */
function isScopeApplicable(
  rule: PermissionRule,
  ctx: { threadId: string; projectId?: string | null; skillId?: string | null },
): boolean {
  switch (rule.scope) {
    case "global":
    case "tenant": // 无 tenant 维度，按全局处理
      return true;
    case "thread":
      return rule.scopeRef === null || rule.scopeRef === ctx.threadId;
    case "project":
      return rule.scopeRef === null || rule.scopeRef === (ctx.projectId ?? null);
    case "skill":
      // scopeRef=null 放行(全局 skill 规则);否则仅绑定该 skill 的 thread 匹配
      return rule.scopeRef === null || rule.scopeRef === (ctx.skillId ?? null);
    default:
      return false;
  }
}

/**
 * 评估单次工具调用的权限决策。
 *
 * 匹配顺序：
 * 1. 合并 DB 规则 + 默认规则，按 priority 降序；同优先级 deny > ask > allow。
 * 2. 取首个 toolPattern + scope + argMatcher 都匹配的规则。
 * 3. 命中 deny → deny；命中 allow → allow；命中 ask → 查 existingApprovals，
 * 有适用且未过期的批准 → allow（带 existingApprovalId），否则 ask。
 * 4. 无规则命中 → allow（默认开放，与 beforeTool 其余工具放行一致）。
 */
export function evaluatePermission(args: EvaluatePermissionArgs): PermissionVerdict {
  const permissionKey = args.permissionKey ?? `tool.${args.toolName}`;
  const ctx = {
    threadId: args.threadId,
    projectId: args.projectId ?? null,
    skillId: args.skillId ?? null,
  };
  const config = args.config ?? getPolicyConfig();

  const rules = [...(args.dbRules ?? []), ...buildDefaultRules(config)]
    .filter((r) => matchToolPattern(r.toolPattern, permissionKey))
    .filter((r) => isScopeApplicable(r, ctx))
    .filter((r) => matchArg(r.argMatcher, args.input))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return DECISION_RANK[b.decision] - DECISION_RANK[a.decision];
    });

  const top = rules[0];
  if (!top) return { decision: "allow" };

  if (top.decision === "deny") {
    return { decision: "deny", reason: top.reason ?? undefined, matchedRuleId: top.id };
  }
  if (top.decision === "allow") {
    return { decision: "allow", matchedRuleId: top.id };
  }

  // ask：查既有批准升级为 allow
  const now = new Date();
  const matched = (args.existingApprovals ?? []).find(
    (a) =>
      a.permissionKey === permissionKey &&
      a.argFingerprint === computeArgFingerprint(permissionKey, args.input) &&
      a.status === "approved" &&
      !isApprovalExpired(a, now) &&
      isApprovalApplicable(a, ctx),
  );
  if (matched) {
    return {
      decision: "allow",
      matchedRuleId: top.id,
      existingApprovalId: matched.id,
      existingApprovalScope: matched.approvedScope,
    };
  }
  return { decision: "ask", reason: top.reason ?? undefined, matchedRuleId: top.id };
}
