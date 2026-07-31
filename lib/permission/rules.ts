import type { PermissionDecision, PermissionScope, ToolPermissionRule } from "@/lib/db/schema";
/**
 * V3.1：权限规则默认集（蓝图 §5.3 / §12 V3.1）。
 *
 * 默认规则从 `PolicyConfig` 派生（零回归）：
 * - `protectedPaths` → `tool.writeFile` 的 deny 规则（argMatcher.pathRegex）
 * - `commandDenyList` → `tool.runCommand` 的 deny 规则（argMatcher.commandRegex）
 * - `deleteFile / applyPatch / multiEditFile` → ask 规则（删除/跨文件 patch 不可逆，默认高风险）
 *
 * writeFile 本身保持 allow（仅 protectedPaths 命中时 deny），不破坏现有代码生成主链路
 * （§12 forceAsk 名单不含 writeFile）。
 *
 * 引擎 `evaluatePermission` 把 DB 规则与这些默认规则合并后按 priority 降序匹配。
 * pathRegex / commandRegex 的匹配语义与 `decideWrite / decideCommand` 等价（test 原文 + 规范化
 * 路径），见 engine.ts 的 matchArg——非 global/sticky 正则 `new RegExp(source).test(s)` 与
 * 原 RegExp.test 等价，故 deny 行为零回归。
 */
import { type PolicyConfig, getPolicyConfig } from "@/lib/policy/config";

/** 引擎消费的规则形状（与 schema ToolPermissionRule 对齐，但解耦自 DB）。 */
export interface PermissionRule {
  id: string;
  scope: PermissionScope;
  scopeRef: string | null;
  /** "tool.writeFile" / "tool.*" / "*" 等。 */
  toolPattern: string;
  argMatcher: { pathRegex?: string; commandRegex?: string; risk?: string } | null;
  decision: PermissionDecision;
  reason: string | null;
  priority: number;
}

/**
 * 把 DB 行（argMatcher 为 json 列，类型 unknown）映射为引擎消费的 PermissionRule。
 * argMatcher 收窄到约定形状；非对象值视为 null（无 arg 约束）。
 */
export function toPermissionRule(row: ToolPermissionRule): PermissionRule {
  const raw = row.argMatcher;
  const argMatcher =
    raw !== null && typeof raw === "object"
      ? (raw as { pathRegex?: string; commandRegex?: string; risk?: string })
      : null;
  return {
    id: row.id,
    scope: row.scope,
    scopeRef: row.scopeRef,
    toolPattern: row.toolPattern,
    argMatcher,
    decision: row.decision,
    reason: row.reason,
    priority: row.priority,
  };
}

/** deny 规则优先级（高于 ask/allow），保证受保护路径/高危命令 fail-closed。 */
const DENY_PRIORITY = 100;
/** ask 默认规则优先级（高于隐含 allow，低于 deny）。 */
const ASK_PRIORITY = 50;

/**
 * 从 PolicyConfig 派生默认规则集。
 *
 * @param config - 默认 getPolicyConfig()（测试可经 setPolicyConfig 覆盖）
 */
export function buildDefaultRules(config: PolicyConfig = getPolicyConfig()): PermissionRule[] {
  const rules: PermissionRule[] = [];

  // protectedPaths → tool.writeFile deny（零回归：等价 decideWrite）
  for (const re of config.protectedPaths) {
    rules.push({
      id: `default:writeFile:deny:${re.source}`,
      scope: "global",
      scopeRef: null,
      toolPattern: "tool.writeFile",
      argMatcher: { pathRegex: re.source },
      decision: "deny",
      reason: `受保护路径：${re.source}`,
      priority: DENY_PRIORITY,
    });
  }

  // commandDenyList → tool.runCommand deny（零回归：等价 decideCommand）
  for (const re of config.commandDenyList) {
    rules.push({
      id: `default:runCommand:deny:${re.source}`,
      scope: "global",
      scopeRef: null,
      toolPattern: "tool.runCommand",
      argMatcher: { commandRegex: re.source },
      decision: "deny",
      reason: `高风险命令：${re.source}`,
      priority: DENY_PRIORITY,
    });
  }

  // V3.2：commandDenyList 镜像到 tool.runBuild deny（runBuild 走既有 deny-list，plan §8）
  for (const re of config.commandDenyList) {
    rules.push({
      id: `default:runBuild:deny:${re.source}`,
      scope: "global",
      scopeRef: null,
      toolPattern: "tool.runBuild",
      argMatcher: { commandRegex: re.source },
      decision: "deny",
      reason: `高风险命令：${re.source}`,
      priority: DENY_PRIORITY,
    });
  }

  // 审计修复：commandDenyList 镜像到 tool.startBackgroundTask deny。
  // 原实现仅覆盖 runCommand/runBuild，startBackgroundTask 可执行任意后台命令
  // （包括 deny-list 中的被禁命令），完全绕过 deny-list 防线。
  for (const re of config.commandDenyList) {
    rules.push({
      id: `default:startBackgroundTask:deny:${re.source}`,
      scope: "global",
      scopeRef: null,
      toolPattern: "tool.startBackgroundTask",
      argMatcher: { commandRegex: re.source },
      decision: "deny",
      reason: `高风险命令（后台任务）：${re.source}`,
      priority: DENY_PRIORITY,
    });
  }

  // 新增高风险写/删/patch 工具默认 ask（§0.3 / §1）
  for (const name of ["deleteFile", "applyPatch", "multiEditFile"]) {
    rules.push({
      id: `default:${name}:ask`,
      scope: "global",
      scopeRef: null,
      toolPattern: `tool.${name}`,
      argMatcher: null,
      decision: "ask",
      reason: `${name} 默认需审批`,
      priority: ASK_PRIORITY,
    });
  }

  // V3.2：installDependencies 默认 ask（装包可执行 postinstall、改 lockfile、联网，高风险，plan §8）
  rules.push({
    id: "default:installDependencies:ask",
    scope: "global",
    scopeRef: null,
    toolPattern: "tool.installDependencies",
    argMatcher: null,
    decision: "ask",
    reason: "installDependencies 默认需审批",
    priority: ASK_PRIORITY,
  });

  // 审计修复：startBackgroundTask 默认 ask（后台任务可执行任意命令且长期运行，高风险）。
  // 原实现中 startBackgroundTask 在 HIGH_RISK_TOOLS 集合中但无 ask 规则，
  // 引擎对无规则匹配的工具默认返回 allow，导致绕过审批。
  rules.push({
    id: "default:startBackgroundTask:ask",
    scope: "global",
    scopeRef: null,
    toolPattern: "tool.startBackgroundTask",
    argMatcher: null,
    decision: "ask",
    reason: "startBackgroundTask 默认需审批（后台执行任意命令）",
    priority: ASK_PRIORITY,
  });

  // V3.7：git 写操作默认 ask（蓝图 §9.2「Git 操作默认高风险」）。
  // gitStatus/gitDiff 只读不在此列（默认 allow）；createPullRequest 在 Stage C 追加。
  // gitRestoreCheckpoint 含 git reset --hard（不可逆），gitPush/gitCommit 同高风险。
  for (const name of [
    "gitCheckpoint",
    "gitRestoreCheckpoint",
    "gitCreateBranch",
    "gitCommit",
    "gitPush",
    "createPullRequest",
  ]) {
    rules.push({
      id: `default:${name}:ask`,
      scope: "global",
      scopeRef: null,
      toolPattern: `tool.${name}`,
      argMatcher: null,
      decision: "ask",
      reason: `${name} 默认需审批`,
      priority: ASK_PRIORITY,
    });
  }

  // V3.5：spawnSubagent 默认 ask（派生子代理是高资源动作：独立 streamText + 工具执行）。
  // joinSubagent 默认 allow（读结果，无规则→allow）。DB 规则可覆盖（permissionKey=tool.spawnSubagent）。
  rules.push({
    id: "default:spawnSubagent:ask",
    scope: "global",
    scopeRef: null,
    toolPattern: "tool.spawnSubagent",
    argMatcher: null,
    decision: "ask",
    reason: "spawnSubagent 默认需审批（高资源动作）",
    priority: ASK_PRIORITY,
  });

  // 审计修复：deployToEnvironment / rollback 默认 ask（部署/回滚是不可逆高影响操作，
  // 触发 CI/CD webhook、部署到 staging/prod、回滚生产环境）。
  // 原实现中这两个工具在 HIGH_RISK_TOOLS 集合中但无 ask 规则，
  // 引擎对无规则匹配的工具默认返回 allow，导致绕过审批。
  for (const name of ["deployToEnvironment", "rollback"]) {
    rules.push({
      id: `default:${name}:ask`,
      scope: "global",
      scopeRef: null,
      toolPattern: `tool.${name}`,
      argMatcher: null,
      decision: "ask",
      reason: `${name} 默认需审批（不可逆部署/回滚操作）`,
      priority: ASK_PRIORITY,
    });
  }

  return rules;
}
