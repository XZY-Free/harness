import type { ContextSummaryType, ThreadEvent, ThreadPlanItem, ToolRun } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";

/**
 * a Stage A：六种确定性摘要类型与提取器。
 *
 * 所有提取器都是**纯函数、确定性、不调 LLM**（§1 决策）。
 * toolRun/diff/debug 天然结构化（命令/退出码/错误/文件路径）；
 * turn/decision 用规则提取用户目标 + 状态切换原因 + 未决问题。
 * subagent 为前置空 slot，填充。
 *
 * 提取器只读入参并产出结构化对象 + 摘要正文文本；落库 / checksum / 复用判定由
 * package-builder + queries 层负责，不在本模块。
 */

// ─── 共用工具 ────────────────────────────────────────────────

/** 从消息 parts 中拼接所有 text 段（兼容 UIMessage 的 text part）。 */
export function extractMessageText(message: Pick<ChatMessage, "parts">): string {
  return (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && "text" in p)
    .map((p) => p.text)
    .join("\n");
}

/**
 * 从一段消息中提取工具调用证据（toolName + 关键入参 + 结果状态）。
 *
 * 压缩后旧区段的工具调用/结果会丢失，turn 摘要补留结构化证据，让后续轮次知道读过哪些文件、
 * 跑过什么命令、成功与否。只读 tool-call（toolName/input）与 tool-result（output.ok/error）part。
 */
export type ToolCallEvidence = {
  toolName: string;
  /** 关键入参摘要（command/path 等），截断 80 字符。 */
  inputSummary: string | null;
  /** 结果状态：success/failed/unknown（无对应 result part 时 unknown）。 */
  resultStatus: "success" | "failed" | "unknown";
};

/** 从 input 对象取最关键的一个字段值作为摘要（command > path > pattern > 首个字符串值）。 */
function summarizeToolInput(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const rec = input as Record<string, unknown>;
  for (const key of ["command", "path", "pattern", "url"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return v.slice(0, 80);
  }
  // 兜底：首个字符串值
  for (const v of Object.values(rec)) {
    if (typeof v === "string" && v.length > 0) return v.slice(0, 80);
  }
  return null;
}

export function extractToolCallEvidence(messages: ChatMessage[]): ToolCallEvidence[] {
  // toolCallId → 证据（先收集 call，再补 result 状态）
  const order: string[] = [];
  const map = new Map<string, ToolCallEvidence>();
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      const part = p as {
        type?: string;
        toolCallId?: unknown;
        toolName?: unknown;
        input?: unknown;
        output?: unknown;
      };
      if (part.type === "tool-call" && typeof part.toolCallId === "string") {
        const toolName = typeof part.toolName === "string" ? part.toolName : "(unknown)";
        const ev: ToolCallEvidence = {
          toolName,
          inputSummary: summarizeToolInput(part.input),
          resultStatus: "unknown",
        };
        map.set(part.toolCallId, ev);
        order.push(part.toolCallId);
      }
    }
  }
  // 第二轮补 result 状态
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      const part = p as { type?: string; toolCallId?: unknown; output?: unknown };
      if (part.type === "tool-result" && typeof part.toolCallId === "string") {
        const ev = map.get(part.toolCallId);
        if (!ev) continue;
        const out = part.output as Record<string, unknown> | null;
        if (out && typeof out === "object") {
          ev.resultStatus = out.ok === true ? "success" : out.ok === false ? "failed" : "unknown";
        }
      }
    }
  }
  return order.map((id) => map.get(id)).filter((e): e is ToolCallEvidence => e !== undefined);
}

/** 取首句（按句号/换行/问号切分），用于用户目标提取。 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const match = trimmed.split(/[。\n!?！？]/)[0];
  return (match ?? trimmed).trim();
}

// ─── 1. toolRun 摘要 ─────────────────────────────────────────

export type ToolRunSummary = {
  type: "toolRun";
  toolName: string;
  command: string | null;
  exitCode: number | null;
  error: string | null;
  /** 产物引用（文件路径等）。 */
  artifacts: string[];
  /** 结构化摘要正文（落库 summaryText）。 */
  text: string;
};

/**
 * 提取单个 toolRun 摘要：命令 / 退出码 / 关键错误 / 产物引用。
 * 适用于 runCommand / runTests / readFile / listFiles 等非变更类工具。
 */
export function extractToolRunSummary(toolRun: ToolRun): ToolRunSummary {
  const input = (toolRun.input ?? {}) as Record<string, unknown>;
  const output = (toolRun.output ?? null) as Record<string, unknown> | null;
  const command = typeof input.command === "string" ? input.command : null;
  const exitCode =
    output && typeof output.exitCode === "number"
      ? output.exitCode
      : toolRun.status === "failed"
        ? -1
        : null;
  const error = toolRun.error ?? (output && typeof output.error === "string" ? output.error : null);

  const artifacts: string[] = [];
  if (typeof input.path === "string") artifacts.push(input.path);
  if (output && typeof output.path === "string") artifacts.push(output.path);

  const lines = [
    `工具: ${toolRun.toolName}`,
    command ? `命令: ${command}` : null,
    exitCode !== null ? `退出码: ${exitCode}` : null,
    error ? `错误: ${error}` : null,
    artifacts.length > 0 ? `产物: ${artifacts.join(", ")}` : null,
    `状态: ${toolRun.status}`,
  ].filter((l): l is string => Boolean(l));

  return {
    type: "toolRun",
    toolName: toolRun.toolName,
    command,
    exitCode,
    error,
    artifacts,
    text: lines.join("\n"),
  };
}

// ─── 2. diff 摘要 ────────────────────────────────────────────

/** 文件行为分类。 */
export type DiffAction = "write" | "modify" | "delete";

export type DiffSummary = {
  type: "diff";
  toolName: string;
  path: string | null;
  action: DiffAction;
  /** 风险点（删除 / 覆盖大文件等）。 */
  risks: string[];
  text: string;
};

const DIFF_TOOLS = new Set(["writeFile", "applyPatch", "multiEditFile", "deleteFile"]);

/**
 * 提取变更类工具的 diff 摘要：文件路径 / 行为变化（写/改/删）/ 风险点。
 * 从 input.path + output 推断 action。
 */
export function extractDiffSummary(toolRun: ToolRun): DiffSummary {
  const input = (toolRun.input ?? {}) as Record<string, unknown>;
  const output = (toolRun.output ?? null) as Record<string, unknown> | null;
  const path = typeof input.path === "string" ? input.path : null;

  let action: DiffAction = "modify";
  if (toolRun.toolName === "writeFile") action = "write";
  else if (toolRun.toolName === "deleteFile") action = "delete";
  else if (toolRun.toolName === "applyPatch" || toolRun.toolName === "multiEditFile")
    action = "modify";

  const risks: string[] = [];
  if (action === "delete") risks.push("删除文件不可逆");
  if (action === "write" && typeof input.content === "string" && input.content.length > 20_000) {
    risks.push("覆盖大文件");
  }
  if (toolRun.status === "failed") risks.push("变更失败");

  const ok = output && output.ok === true;
  const lines = [
    `工具: ${toolRun.toolName}`,
    path ? `路径: ${path}` : null,
    `行为: ${action}`,
    ok === false ? "结果: 失败" : ok === true ? "结果: 成功" : null,
    risks.length > 0 ? `风险: ${risks.join("; ")}` : null,
  ].filter((l): l is string => Boolean(l));

  return { type: "diff", toolName: toolRun.toolName, path, action, risks, text: lines.join("\n") };
}

/** 判断 toolRun 是否为变更类（用于 builder 决定用 diff 还是 toolRun 摘要）。 */
export function isDiffToolRun(toolRun: ToolRun): boolean {
  return DIFF_TOOLS.has(toolRun.toolName);
}

// ─── 3. debug 摘要 ───────────────────────────────────────────

export type DebugSummary = {
  type: "debug";
  failedCommands: Array<{ toolName: string; command: string | null; error: string | null }>;
  /** 已排除假设（从连续失败推断）。 */
  excludedHypotheses: string[];
  nextStep: string;
  text: string;
};

/**
 * 提取调试摘要：失败命令 / 已排除假设（从连续 failureKind 推断）/ 下一步建议。
 * 输入为一段连续失败的 toolRun 列表（按时间序）。
 */
export function extractDebugSummary(failedToolRuns: ToolRun[]): DebugSummary {
  const failedCommands = failedToolRuns.map((tr) => {
    const input = (tr.input ?? {}) as Record<string, unknown>;
    return {
      toolName: tr.toolName,
      command: typeof input.command === "string" ? input.command : null,
      error: tr.error ?? null,
    };
  });

  // 已排除假设：同一命令重复失败 → 该命令路径已被排除。
  const seen = new Set<string>();
  const excludedHypotheses: string[] = [];
  for (const fc of failedCommands) {
    const key = fc.command ?? fc.toolName;
    if (key && seen.has(key)) {
      excludedHypotheses.push(`「${key}」仍未解决问题`);
    }
    if (key) seen.add(key);
  }

  const nextStep =
    failedCommands.length === 0
      ? "无失败记录"
      : excludedHypotheses.length > 0
        ? "换一种思路，避免重复已排除的路径"
        : "检查最近一次失败的错误信息并修正";

  const lines = [
    `失败次数: ${failedCommands.length}`,
    failedCommands.length > 0
      ? `失败命令:\n${failedCommands
          .map(
            (fc, i) =>
              ` ${i + 1}. ${fc.toolName}${fc.command ? `: ${fc.command}` : ""}${fc.error ? ` → ${fc.error}` : ""}`,
          )
          .join("\n")}`
      : null,
    excludedHypotheses.length > 0
      ? `已排除假设:\n${excludedHypotheses.map((h) => ` - ${h}`).join("\n")}`
      : null,
    `下一步: ${nextStep}`,
  ].filter((l): l is string => Boolean(l));

  return { type: "debug", failedCommands, excludedHypotheses, nextStep, text: lines.join("\n") };
}

// ─── 4. turn 摘要 ────────────────────────────────────────────

export type TurnSummary = {
  type: "turn";
  /** 用户目标（首句）。 */
  userGoal: string;
  /** 指令动词（首句首个动词词，粗略提取）。 */
  imperativeVerb: string | null;
  /** assistant 状态切换原因（从最近状态变化事件提取）。 */
  stateTransitions: string[];
  /** 未决问题（从 plan item failed/pending 推断）。 */
  openQuestions: string[];
  /**
   * 本轮工具调用证据（toolName + 入参摘要 + 结果状态）。
   * 压缩后旧区段工具调用会丢失，turn 摘要保留结构化证据供后续轮次参考。
   */
  toolCalls: ToolCallEvidence[];
  text: string;
};

/**
 * 提取一轮对话的 turn 摘要：用户目标（首句/指令动词）/ assistant 状态切换原因 / 未决问题 / 工具证据。
 * 不调 LLM；状态切换原因由调用方传入的 statusChange 事件 payload 提取。
 */
export function extractTurnSummary(args: {
  messages: ChatMessage[];
  /** 最近的状态切换事件（agent.status_changed），按时间序。 */
  statusChanges?: Array<{ reason?: string; from?: string; to?: string }>;
  /** 当前 plan items，用于推断未决问题。 */
  planItems?: ThreadPlanItem[];
}): TurnSummary {
  // 取最后一条**含非空 text part** 的 user 消息。
  // 原实现 find(role===user) 可能命中 tool-result carrier（无 text part）→ userGoal 为空。
  const lastUser = [...args.messages]
    .reverse()
    .find((m) => m.role === "user" && extractMessageText(m).trim().length > 0);
  const userText = lastUser ? extractMessageText(lastUser) : "";
  const userGoal = firstSentence(userText);
  const imperativeVerb = extractImperativeVerb(userGoal);

  const stateTransitions = (args.statusChanges ?? [])
    .map((s) => s.reason)
    .filter((r): r is string => Boolean(r));

  const openQuestions = (args.planItems ?? [])
    .filter(
      (it) => it.status === "failed" || it.status === "pending" || it.status === "in_progress",
    )
    .map((it) => `${it.title} [${it.status}]`);

  // 提取工具调用证据
  const toolCalls = extractToolCallEvidence(args.messages);

  const lines = [
    userGoal ? `用户目标: ${userGoal}` : "用户目标: (空)",
    imperativeVerb ? `指令动词: ${imperativeVerb}` : null,
    stateTransitions.length > 0 ? `状态切换: ${stateTransitions.join(", ")}` : null,
    openQuestions.length > 0
      ? `未决问题:\n${openQuestions.map((q) => ` - ${q}`).join("\n")}`
      : null,
    toolCalls.length > 0
      ? `工具证据:\n${toolCalls
          .map(
            (t) =>
              ` - ${t.toolName}${t.inputSummary ? `(${t.inputSummary})` : ""} → ${t.resultStatus}`,
          )
          .join("\n")}`
      : null,
  ].filter((l): l is string => Boolean(l));

  return {
    type: "turn",
    userGoal,
    imperativeVerb,
    stateTransitions,
    openQuestions,
    toolCalls,
    text: lines.join("\n"),
  };
}

/** 粗略提取中文/英文指令首动词。 */
function extractImperativeVerb(sentence: string): string | null {
  const verbs = [
    "实现",
    "创建",
    "修复",
    "运行",
    "重构",
    "删除",
    "添加",
    "修改",
    "部署",
    "测试",
    "implement",
    "create",
    "fix",
    "build",
    "run",
    "refactor",
    "delete",
    "add",
    "update",
    "deploy",
    "test",
  ];
  const lower = sentence.toLowerCase();
  for (const v of verbs) {
    if (sentence.includes(v) || lower.includes(v)) return v;
  }
  return null;
}

// ─── 5. decision 摘要 ────────────────────────────────────────

export type DecisionSummary = {
  type: "decision";
  /** 已选项。 */
  choices: string[];
  /** 约束。 */
  constraints: string[];
  /** 拒绝方案。 */
  rejected: string[];
  /** 信心（高/中/低，规则推断）。 */
  confidence: "high" | "medium" | "low";
  text: string;
};

/**
 * 提取决策日志摘要：选择 / 约束 / 拒绝方案 / 信心。
 * 从 plan 事件 + 状态切换事件用规则提取（不调 LLM）。
 */
export function extractDecisionLog(args: {
  planEvents: ThreadEvent[];
  statusChanges?: Array<{ reason?: string; to?: string }>;
}): DecisionSummary {
  const choices: string[] = [];
  const rejected: string[] = [];

  for (const ev of args.planEvents) {
    const payload = ev.payload as Record<string, unknown>;
    if (ev.type === "plan.created" && typeof payload.title === "string") {
      choices.push(`采纳计划: ${payload.title}`);
    }
    if (
      ev.type === "plan.updated" &&
      payload.status === "abandoned" &&
      typeof payload.title === "string"
    ) {
      rejected.push(`放弃计划: ${payload.title}`);
    }
    if (
      ev.type === "plan.item_updated" &&
      payload.status === "failed" &&
      typeof payload.title === "string"
    ) {
      rejected.push(`失败条目: ${payload.title}`);
    }
  }

  const constraints = (args.statusChanges ?? [])
    .filter((s) => s.to === "awaiting_approval" || s.to === "awaiting_input")
    .map((s) => `需${s.to === "awaiting_approval" ? "审批" : "用户输入"}: ${s.reason ?? ""}`)
    .filter((s) => s.length > 0);

  // 信心改为加权打分（替代原三档粗糙推断）。
  // choices × +1，rejected(失败/放弃) × -1，awaiting 约束 × -1；映射 high(>=1) / medium(0) / low(<0)。
  const awaitingCount = (args.statusChanges ?? []).filter(
    (s) => s.to === "awaiting_approval" || s.to === "awaiting_input",
  ).length;
  const score = choices.length * 1 + rejected.length * -1 + awaitingCount * -1;
  const confidence: "high" | "medium" | "low" =
    choices.length === 0 && rejected.length === 0 && awaitingCount === 0
      ? "low"
      : score >= 1
        ? "high"
        : score === 0
          ? "medium"
          : "low";

  const lines = [
    choices.length > 0 ? `选择:\n${choices.map((c) => ` - ${c}`).join("\n")}` : null,
    constraints.length > 0 ? `约束:\n${constraints.map((c) => ` - ${c}`).join("\n")}` : null,
    rejected.length > 0 ? `拒绝:\n${rejected.map((r) => ` - ${r}`).join("\n")}` : null,
    `信心: ${confidence}`,
  ].filter((l): l is string => Boolean(l));

  return { type: "decision", choices, constraints, rejected, confidence, text: lines.join("\n") };
}

// ─── 汇总：类型 → 提取器元数据 ──────────────────────────────

export const SUMMARY_TYPES: readonly ContextSummaryType[] = [
  "turn",
  "toolRun",
  "diff",
  "debug",
  "decision",
  "subagent",
] as const;

/** 各摘要类型的可读名（供 Studio 展示）。 */
export const SUMMARY_TYPE_LABELS: Record<ContextSummaryType, string> = {
  turn: "对话轮次",
  toolRun: "工具执行",
  diff: "文件变更",
  debug: "调试记录",
  decision: "决策日志",
  subagent: "子代理",
};
