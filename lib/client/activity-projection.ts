import type { ClientAgentCallSummary, ClientEvent } from "@/lib/client/types";

/** 过程透明日志流的动作语义图标类别（合同 v2.2：类型独立图标）。 */
export type ActivityKind =
  | "think"
  | "search"
  | "read"
  | "write"
  | "exec"
  | "agent"
  | "wait"
  | "fail";

export type ActivityPhase =
  | "think"
  | "proposed"
  | "started"
  | "completed"
  | "waiting"
  | "failed"
  | "cancelled";

export interface ActivityEntry {
  /** 去重键：event_id 或 item_id。 */
  readonly key: string;
  readonly turnId: string | null;
  readonly kind: ActivityKind;
  readonly phase: ActivityPhase;
  readonly label: string;
  /** 可展开最小单元内容：思考摘要 / 命令 / 命令+结果。 */
  readonly block: string | null;
  readonly risk: boolean;
  readonly actionId: string | null;
  readonly occurredAt: string;
}

function agentResponseEntry(call: ClientAgentCallSummary, name: string): ActivityEntry {
  const base = {
    key: `agent-response-${call.call_id}`,
    turnId: null,
    kind: "agent" as const,
    risk: false,
    actionId: null,
    occurredAt: call.finished_at ?? call.waiting_at ?? call.started_at ?? call.created_at,
  };
  switch (call.state) {
    case "queued":
      return { ...base, phase: "proposed", label: `${name}等待开始处理`, block: null };
    case "running":
      return { ...base, phase: "started", label: `${name}正在处理`, block: null };
    case "waiting_user":
      return { ...base, kind: "wait", phase: "waiting", label: `${name}需要你的操作`, block: null };
    case "completed": {
      const duration =
        call.duration_ms === null
          ? ""
          : ` · ${Math.max(1, Math.round(call.duration_ms / 1000))} 秒`;
      return {
        ...base,
        phase: "completed",
        label: `已收到${name}返回结果${duration}`,
        block: "智能体返回的结果已由平台整理为下方答复。",
      };
    }
    case "failed":
      return {
        ...base,
        kind: "fail",
        phase: "failed",
        label: `${name}未能完成本次请求`,
        block: null,
      };
    case "cancelled":
      return { ...base, phase: "cancelled", label: `已取消${name}请求`, block: null };
    case "lost":
      return {
        ...base,
        kind: "fail",
        phase: "failed",
        label: `与${name}的连接已中断`,
        block: null,
      };
    default:
      return { ...base, phase: "started", label: `${name}状态已更新`, block: null };
  }
}

/**
 * 将员工端安全的 AgentCall 摘要投影进同一执行记录。
 * 请求正文只取用户自己的触发消息；原始出站参数、身份上下文和 Agent 原始结果不进入页面。
 */
export function projectAgentCallActivity(
  calls: readonly ClientAgentCallSummary[],
  requestText?: string | null,
): ActivityEntry[] {
  const normalizedRequest = requestText?.trim() || null;
  return calls.flatMap((call) => {
    const name = call.display_name?.trim() || "智能体";
    const request: ActivityEntry = {
      key: `agent-request-${call.call_id}`,
      turnId: null,
      kind: "agent",
      phase: call.state === "queued" ? "proposed" : "completed",
      label: call.state === "queued" ? `准备请求${name}` : `已向${name}发送请求`,
      block: normalizedRequest ? `你的请求：${normalizedRequest}` : null,
      risk: false,
      actionId: null,
      occurredAt: call.started_at ?? call.created_at,
    };
    return [request, agentResponseEntry(call, name)];
  });
}

const RISK_PATTERN = /create|write|update|delete|send|revoke|approve/i;
const READ_PATTERN = /read|fetch_doc|load/i;
const SEARCH_PATTERN = /query|search|lookup|list/i;

export function activityKindFor(actionType: string, purposeCode: string | null): ActivityKind {
  const subject = `${actionType} ${purposeCode ?? ""}`;
  if (READ_PATTERN.test(subject)) return "read";
  if (SEARCH_PATTERN.test(subject)) return "search";
  if (RISK_PATTERN.test(subject)) return "write";
  return "exec";
}

export function isRiskAction(actionType: string, purposeCode: string | null): boolean {
  return RISK_PATTERN.test(`${actionType} ${purposeCode ?? ""}`);
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 截断过长块内容，防日志流膨胀。 */
function capBlock(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}\n…（已截断）` : text;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 呈现工具的实际输出，而非 Harness/缓存/权限协议封套。 */
function observationBlock(value: unknown): string {
  const observation = record(value);
  const data = record(observation.data);
  const result = record(data.result);
  if ("stdout" in result || "stderr" in result) {
    return [result.stdout, result.stderr, result.exitCode && `退出码：${result.exitCode}`]
      .filter((part) => typeof part === "string" && part.trim())
      .join("\n")
      .trim();
  }
  if (typeof result.text === "string") return result.text.trim();
  if (Array.isArray(result.results))
    return result.results
      .map((item) => {
        const hit = record(item);
        return [hit.title, hit.url, hit.snippet].filter(Boolean).join("\n");
      })
      .join("\n\n");
  if (data.errorCode) return `操作未完成：${data.errorCode}`;
  if (Object.keys(result).length) return prettyJson(result);
  if (Object.keys(data).length)
    return typeof observation.summary === "string" ? observation.summary : "";
  return prettyJson(value);
}

function actionBlock(payload: unknown): string {
  if (payload && typeof payload === "object" && "arguments" in payload) {
    const args = (payload as { arguments: unknown }).arguments;
    if (args && typeof args === "object" && "command" in args && typeof args.command === "string")
      return `$ ${args.command}`;
    if (args && typeof args === "object") {
      if ("url" in args && typeof args.url === "string") return args.url;
      if ("query" in args && typeof args.query === "string") return args.query;
    }
    return prettyJson(args);
  }
  return prettyJson(payload);
}

interface ActionEventPayload {
  readonly action_id?: string;
  readonly action_type?: string;
  readonly purpose_code?: string | null;
  readonly short_purpose?: string;
  readonly action_payload?: unknown;
  readonly observation?: unknown;
  readonly error_code?: string;
  readonly state?: string;
}

/**
 * 将 harness 动作事件投影为日志流条目（纯函数，live 与历史重建共用）。
 * progress.snapshot 走 user_guidance Item，由组件从 items 投影，不在此处理。
 */
export function projectActivityEvent(event: ClientEvent): ActivityEntry | null {
  const payload = (event.payload ?? {}) as Partial<ActionEventPayload>;
  const actionType = payload.action_type ?? "unknown";
  // respond 的正文由 assistant_message 展示，不把内部 evidenceRefs 再画成工具操作。
  if (actionType === "respond" && event.event_type !== "harness.action.failed") return null;
  const purpose = payload.purpose_code ?? null;
  const shortPurpose = payload.short_purpose ?? actionType;
  const risk = isRiskAction(actionType, purpose);
  const operation = record(payload.action_payload).operationId;
  const args = record(record(payload.action_payload).arguments);
  const kind =
    operation === "shell"
      ? "exec"
      : operation === "web-fetch"
        ? "read"
        : operation === "web-search"
          ? "search"
          : activityKindFor(actionType, purpose);
  const toolLabel =
    operation === "shell" && typeof args.command === "string"
      ? `运行 ${args.command}`
      : operation === "web-fetch" && typeof args.url === "string"
        ? `读取网页 ${args.url}`
        : operation === "web-search" && typeof args.query === "string"
          ? `搜索网页 ${args.query}`
          : null;
  const base = {
    key: event.event_id,
    turnId: event.turn_id,
    risk,
    actionId: payload.action_id ?? null,
    occurredAt: event.occurred_at,
    kind,
  };
  switch (event.event_type) {
    case "harness.action.proposed":
      return {
        ...base,
        phase: "proposed",
        label: toolLabel ? `准备${toolLabel}` : `准备执行： ${shortPurpose}`,
        block:
          payload.action_payload === undefined
            ? null
            : capBlock(actionBlock(payload.action_payload)),
      };
    case "harness.action.started":
      return {
        ...base,
        phase: "started",
        label: toolLabel ? `正在${toolLabel}` : `正在执行： ${shortPurpose}`,
        block: null,
      };
    case "harness.action.completed": {
      const parts: string[] = [];
      if (payload.action_payload !== undefined) parts.push(actionBlock(payload.action_payload));
      if (payload.observation !== undefined) parts.push(observationBlock(payload.observation));
      const observation = payload.observation as
        | { data?: { state?: string; result?: { ok?: boolean } } }
        | undefined;
      const cancelled = observation?.data?.state === "cancelled";
      const failed =
        ["failed", "cancelled", "unknown_effect"].includes(observation?.data?.state ?? "") ||
        observation?.data?.result?.ok === false;
      return {
        ...base,
        kind: failed ? "fail" : base.kind,
        phase: cancelled ? "cancelled" : failed ? "failed" : "completed",
        label: cancelled
          ? `未执行： ${shortPurpose}`
          : failed
            ? `执行失败： ${shortPurpose}`
            : toolLabel
              ? `已${toolLabel}`
              : `已执行 · ${shortPurpose}`,
        block: parts.length ? capBlock(parts.join("\n")) : null,
      };
    }
    case "harness.action.failed":
      return {
        ...base,
        kind: "fail",
        phase: "failed",
        label: `执行失败： ${shortPurpose} · ${payload.error_code ?? "UNKNOWN"}`,
        block: payload.error_code ?? null,
      };
    default:
      return null;
  }
}

/** 从 user_guidance progress.snapshot Item 投影思考条目（历史与 live 共用）。 */
export function projectProgressItem(item: {
  readonly id: string;
  readonly turn_id: string | null;
  readonly content: unknown;
  readonly created_at?: string;
}): ActivityEntry | null {
  const content = item.content as Record<string, unknown> | null;
  if (!content || content.kind !== "progress.snapshot") return null;
  const message = typeof content.message === "string" ? content.message : "思考中…";
  const think = typeof content.think === "string" ? content.think : null;
  return {
    key: item.id,
    turnId: item.turn_id,
    kind: "think",
    phase: "think",
    label: message,
    block: think?.replace(/^决定[：:]\s*/, "") ?? null,
    risk: false,
    actionId: null,
    occurredAt: item.created_at ?? "",
  };
}

/** 同一次操作只保留一行；状态更新沿用最早位置，完成结果替换运行态。 */
export function mergeActionEntries(entries: readonly ActivityEntry[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const entry of entries) {
    const index = entry.actionId
      ? out.findIndex((prev) => prev.actionId === entry.actionId && prev.turnId === entry.turnId)
      : -1;
    const prev = out[index];
    if (!prev) {
      out.push(entry);
      continue;
    }
    const terminal = ["completed", "failed", "cancelled"].includes(prev.phase);
    if (terminal && !["completed", "failed", "cancelled"].includes(entry.phase)) continue;
    const block = !entry.block
      ? prev.block
      : !prev.block || entry.block.includes(prev.block)
        ? entry.block
        : [prev.block, entry.block].join("\n");
    out[index] = { ...entry, key: prev.key, occurredAt: prev.occurredAt, block };
  }
  return out;
}

/** 相邻状态原位更新；公开决策说明保留，不跨操作或回合合并。 */
export function mergeThinkEntries(entries: readonly ActivityEntry[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    const prev = out[out.length - 1];
    if (
      entry.phase === "think" &&
      prev?.phase === "think" &&
      !prev.block &&
      prev.turnId === entry.turnId
    ) {
      out[out.length - 1] = { ...entry, key: prev.key, occurredAt: prev.occurredAt };
    } else out.push(entry);
  }
  return out;
}
