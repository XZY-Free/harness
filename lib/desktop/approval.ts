/**
 * ：审批策略模块。
 *
 * 实现 03-agent-bridge-security.md §7 与 02-desktop-browser-architecture.md
 * 规定的风险矩阵与审批决策。Desktop 不盲信 Server —— 必须对过期、不匹配、
 * 超范围 approval 拒绝执行。RPC 信封中的 approvalId 必须对当前 command + scope 有效。
 *
 * 风险矩阵：
 * | 类型 | 示例 | 默认 |
 * |------------|------------------------------|--------------------|
 * | read | DOM/console/screenshot | allow |
 * | navigation | 打开公开 URL、后退、刷新 | 视网络策略 |
 * | local_write| 下载到 Thread Workspace | allow + 审计 |
 * | external_write | 提交表单、发送、发布 | 必须审批 |
 * | destructive | 删除记录、取消服务 | 必须审批 |
 * | financial | 付款、下单、转账 | 必须审批，禁止批量通配 |
 * | credential | 密码、验证码、Passkey | 用户手动（绝不通过 AI） |
 *
 * 安全约束：
 * - credential 风险一律拒绝（用户必须手动输入，AI 不得代填）
 * - external_write / destructive / financial 必须先获取有效 approvalId 才能执行
 * - validateApprovalScope 严格匹配 command + threadId + tabId + url + expiresAt
 * - 任一字段不匹配 → 拒绝执行（防过度授权）
 */
import { ACTION_COMMANDS, READ_COMMANDS, isActionCommand, isReadCommand } from "./commands";

/**
 * 风险等级。
 */
export type RiskLevel =
  | "read"
  | "navigation"
  | "local_write"
  | "external_write"
  | "destructive"
  | "financial"
  | "credential";

/**
 * 审批决策。
 */
export type ApprovalDecision = "allow" | "require_approval" | "deny";

/**
 * 敏感动作关键词（用于 click / doubleClick 的 description 字段风险判定）。
 *
 * 顺序即匹配优先级 —— 数组中靠前的关键词先匹配。当前顺序保证：
 * - destructive（删除/取消）优先于 external_write（提交/确认）
 * - financial（付款/转账）覆盖独立分支
 * - credential（修改密码）单独处理
 */
export const SENSITIVE_ACTION_KEYWORDS = [
  "删除",
  "delete",
  "remove",
  "destroy",
  "提交",
  "submit",
  "send",
  "发送",
  "发布",
  "publish",
  "post",
  "付款",
  "pay",
  "purchase",
  "buy",
  "checkout",
  "取消",
  "cancel",
  "确认",
  "confirm",
  "转账",
  "transfer",
  "修改密码",
  "change password",
  "reset password",
] as const;

/**
 * 关键词到风险等级的映射。
 *
 * destructive: 删除 / 取消 / destroy 等
 * external_write: 提交 / 发送 / 发布 / 确认 等
 * financial: 付款 / 转账 / 购买 等
 * credential: 修改密码 / 重置密码 等
 */
const KEYWORD_RISK_MAP: Record<string, RiskLevel> = {
  删除: "destructive",
  delete: "destructive",
  remove: "destructive",
  destroy: "destructive",
  取消: "destructive",
  cancel: "destructive",
  提交: "external_write",
  submit: "external_write",
  send: "external_write",
  发送: "external_write",
  发布: "external_write",
  publish: "external_write",
  post: "external_write",
  确认: "external_write",
  confirm: "external_write",
  付款: "financial",
  pay: "financial",
  purchase: "financial",
  buy: "financial",
  checkout: "financial",
  转账: "financial",
  transfer: "financial",
  修改密码: "credential",
  "change password": "credential",
  "reset password": "credential",
};

/**
 * 导航类命令集合（ACTION_COMMANDS 的子集）。
 *
 * 这些命令受网络策略管控，但默认不需要 approval（如刷新、后退、切换 tab）。
 */
const NAVIGATION_COMMANDS = new Set<string>([
  "browser.navigate",
  "browser.reload",
  "browser.goBack",
  "browser.goForward",
  "browser.newTab",
  "browser.closeTab",
  "browser.switchTab",
]);

/**
 * 所有已知命令集合（READ_COMMANDS + ACTION_COMMANDS）。
 *
 * 不在集合内的命令一律视为未知，保守按 external_write 处理（需审批），
 * 由调用方在更上层（rpc-security / commands 校验）兜底拒绝。
 */
const KNOWN_COMMANDS = new Set<string>([...READ_COMMANDS, ...ACTION_COMMANDS]);

/**
 * 审批范围。
 *
 * Desktop 收到 Server 携带 approvalId 的 RPC 请求后，需校验 approvalId 对应的
 * scope 是否覆盖当前命令。任一字段不匹配即拒绝执行。
 */
export interface ApprovalScope {
  /** 绑定的命令名（必须精确匹配） */
  command: string;
  /** 绑定的 thread ID */
  threadId: string;
  /** 绑定的 tab ID（可选，仅在双方都存在时校验） */
  tabId?: string;
  /** 绑定的 URL（可选，用于 navigate 命令） */
  url?: string;
  /** 过期时间（epoch ms） */
  expiresAt: number;
}

/**
 * 从 payload 中安全提取字符串字段。
 *
 * @param payload 命令 payload
 * @param field 字段名
 * @returns 字段值为字符串时返回，否则返回 undefined
 */
function getStringField(payload: unknown, field: string): string | undefined {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/**
 * 从描述文本推断风险等级（取首个匹配关键词对应的等级）。
 *
 * @param description 描述文本（如 click 的 description 字段）
 * @returns 命中关键词返回对应风险等级，未命中返回 null
 */
function riskFromDescription(description: string | undefined): RiskLevel | null {
  if (!description) return null;
  const lower = description.toLowerCase();
  for (const keyword of SENSITIVE_ACTION_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
      return KEYWORD_RISK_MAP[keyword] ?? null;
    }
  }
  return null;
}

/**
 * 判断描述文本是否包含敏感动作关键词（不区分大小写）。
 *
 * 用于 click / doubleClick 的 description 字段风险判定：当描述含「删除」「提交」
 * 「付款」等关键词时，命令风险等级应升级为 destructive / external_write / financial。
 *
 * @param description 描述文本
 * @returns 包含敏感关键词返回 true
 */
export function containsSensitiveKeyword(description: string): boolean {
  if (!description) return false;
  const lower = description.toLowerCase();
  for (const keyword of SENSITIVE_ACTION_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * 命令风险分类（基于 command 名 + payload）。
 *
 * 分类规则参见模块顶部注释与 03-agent-bridge-security.md §7 风险矩阵：
 * 1. READ_COMMANDS → read
 * 2. navigation 命令（navigate / reload / goBack / goForward / newTab / closeTab / switchTab）→ navigation
 * 3. browser.scroll → read（不修改页面状态）
 * 4. browser.click / browser.doubleClick → 检查 description，命中敏感关键词按关键词映射，
 * 未命中 → read（点击按钮多用于导航，视同读取）
 * 5. browser.type → 检查 selector 是否含 password / pwd，是 → credential；否 → local_write
 * 6. browser.press / browser.select / browser.uploadWorkspaceFile → local_write
 * 7. 未知命令 → external_write（保守需审批，由上层兜底拒绝）
 *
 * @param command 命令名（V10 dotted 格式）
 * @param payload 命令 payload
 * @returns 风险等级
 */
export function classifyCommandRisk(command: string, payload: unknown): RiskLevel {
  // 1. 读取类命令
  if (isReadCommand(command)) {
    return "read";
  }

  // 2. 操作类命令进一步分类
  if (isActionCommand(command)) {
    // 2a. 导航类命令
    if (NAVIGATION_COMMANDS.has(command)) {
      return "navigation";
    }

    // 2b. scroll 不修改页面状态 → read
    if (command === "browser.scroll") {
      return "read";
    }

    // 2c. click / doubleClick：依据 description 判定
    if (command === "browser.click" || command === "browser.doubleClick") {
      const description = getStringField(payload, "description");
      const risk = riskFromDescription(description);
      if (risk) {
        return risk;
      }
      return "read";
    }

    // 2d. type：检查 selector 是否指向密码字段
    if (command === "browser.type") {
      const selector = getStringField(payload, "selector");
      if (selector) {
        const lower = selector.toLowerCase();
        if (lower.includes("password") || lower.includes("pwd")) {
          return "credential";
        }
      }
      return "local_write";
    }

    // 2e. press / select / uploadWorkspaceFile → local_write
    if (
      command === "browser.press" ||
      command === "browser.select" ||
      command === "browser.uploadWorkspaceFile"
    ) {
      return "local_write";
    }
  }

  // 3. 未知命令（不在 KNOWN_COMMANDS 内）：保守视为 external_write（需审批）
  // READ_COMMANDS / ACTION_COMMANDS 在此引用，确保命令白名单与 commands.ts 一致
  if (!KNOWN_COMMANDS.has(command)) {
    return "external_write";
  }

  // 4. 已知命令但未匹配上述分支：保守视为 external_write
  return "external_write";
}

/**
 * 判断命令是否需要 approval。
 *
 * - external_write / destructive / financial 必须审批
 * - read / navigation / local_write 直接放行（local_write 由调用方审计）
 * - credential 不走审批流程 —— 由 decideApproval 一律 deny（用户必须手动输入）
 *
 * @param command 命令名
 * @param payload 命令 payload
 * @returns 需要审批返回 true
 */
export function requiresApproval(command: string, payload: unknown): boolean {
  const risk = classifyCommandRisk(command, payload);
  return risk === "external_write" || risk === "destructive" || risk === "financial";
}

/**
 * 审批决策。
 *
 * - read / navigation / local_write → allow
 * - external_write / destructive / financial → require_approval
 * - credential → deny（AI 不得代填密码，用户必须手动）
 *
 * @param command 命令名
 * @param payload 命令 payload
 * @returns allow / require_approval / deny
 */
export function decideApproval(command: string, payload: unknown): ApprovalDecision {
  const risk = classifyCommandRisk(command, payload);
  switch (risk) {
    case "read":
    case "navigation":
    case "local_write":
      return "allow";
    case "external_write":
    case "destructive":
    case "financial":
      return "require_approval";
    case "credential":
      return "deny";
  }
}

/**
 * 校验 approval 是否对当前命令有效。
 *
 * Desktop 不盲信 Server：必须对过期、不匹配、超范围 approval 一律拒绝。
 * 检查顺序：
 * 1. scope.command === command（精确匹配，防跨命令复用 approval）
 * 2. scope.expiresAt > now（未过期，防重放过期 approval）
 * 3. scope.threadId === payload.threadId（同 thread，防跨 thread 越权）
 * 4. scope.tabId === payload.tabId（双方都存在时校验，防跨 tab）
 * 5. scope.url === payload.url（双方都存在时校验，用于 navigate 命令防 URL 篡改）
 *
 * @param scope 审批范围
 * @param command 当前命令名
 * @param payload 当前命令 payload
 * @param now 当前时间（epoch ms）
 * @returns 校验通过返回 { ok: true }，失败返回 { ok: false, reason }
 */
export function validateApprovalScope(
  scope: ApprovalScope,
  command: string,
  payload: unknown,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  // 1. 命令名精确匹配
  if (scope.command !== command) {
    return { ok: false, reason: "command_mismatch" };
  }

  // 2. 未过期（expiresAt === now 视为已过期）
  if (scope.expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }

  // 3. threadId 匹配（payload 含 threadId 时校验）
  const payloadThreadId = getStringField(payload, "threadId");
  if (typeof payloadThreadId === "string" && scope.threadId !== payloadThreadId) {
    return { ok: false, reason: "thread_mismatch" };
  }

  // 4. tabId 匹配（双方都存在时校验，防跨 tab 越权）
  const payloadTabId = getStringField(payload, "tabId");
  if (
    typeof payloadTabId === "string" &&
    typeof scope.tabId === "string" &&
    scope.tabId !== payloadTabId
  ) {
    return { ok: false, reason: "tab_mismatch" };
  }

  // 5. url 匹配（双方都存在时校验，用于 navigate 命令防 URL 篡改）
  const payloadUrl = getStringField(payload, "url");
  if (typeof payloadUrl === "string" && typeof scope.url === "string" && scope.url !== payloadUrl) {
    return { ok: false, reason: "url_mismatch" };
  }

  return { ok: true };
}
