import type { ThreadPlan, ToolApprovalRequest, ToolRun } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";
import { extractMessageText } from "./summary-types";

/**
 * V3.3a Stage B：永不压缩集合计算（首版）。
 *
 * Stage B 覆盖四类 protected 项：最新用户消息 / active plan / pending approval / 最近失败错误片段。
 * Stage D 补全：安全权限部署硬约束 + pinned facts，并把边界（多失败取最近 / 多 pending 全保留）
 * 与硬不变式测试落齐。
 *
 * 「永不压缩」是硬不变式：任意压缩后 protected 内容必须仍出现在装配的 messages 里
 * （package-builder 把 injected 文本写入 system 摘要消息 + protectedMessageIds 原样保留）。
 *
 * P0 修复（tool-call/tool-result 配对回填）：
 * AI SDK v6 协议要求 assistant 消息的 `tool-call` part 与下一条 user 消息的 `tool-result` part
 * 通过 `toolCallId` 一一配对。若压缩只保留其中一半，`convertToModelMessages` 产出的 messages
 * 会含孤儿 tool-call 或孤儿 tool-result，模型侧拒绝请求或 hallucinate。
 * `backfillToolPairRefs` 在初步 protected 集合算完后，扫描 history 中所有 tool-call/tool-result
 * 配对，若一侧在 protected、另一侧不在，把缺失侧回填进 protected，迭代直到稳定。
 */

export type ProtectedKind =
  | "latest_user"
  | "recent_messages"
  | "active_plan"
  | "pending_approval"
  | "recent_failure"
  | "policy_constraint"
  | "pinned_fact"
  | "tool_pair_backfill";

export type ProtectedRef = {
  kind: ProtectedKind;
  /** 涉及的 history message id（若 protected 项本身就是消息）。 */
  messageIds: string[];
  reason: string;
};

export type InjectedProtected = {
  kind: ProtectedKind;
  text: string;
};

export type ProtectedRefsResult = {
  /** 必须原样保留的 history message id（不进入可压缩旧区段）。 */
  protectedMessageIds: Set<string>;
  /** 额外注入的 protected 内容（active plan / pending approval / recent failure，非历史消息）。 */
  injected: InjectedProtected[];
  refs: ProtectedRef[];
};

/** 默认最近保留的原始消息条数（除最新用户消息外的尾部原始消息）。 */
const DEFAULT_RECENT_KEEP = 6;

/**
 * 从消息 parts 提取所有 toolCallId（兼容 AI SDK v6 的 `tool-call` / `tool-result` part）。
 * 任何带 `toolCallId: string` 字段的 part 都计入（避免与 SDK 内部类型耦合过紧）。
 */
function extractToolCallIds(message: ChatMessage): string[] {
  const ids: string[] = [];
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return ids;
  for (const p of parts) {
    if (p && typeof p === "object") {
      const part = p as { type?: string; toolCallId?: unknown };
      if (
        (part.type === "tool-call" || part.type === "tool-result") &&
        typeof part.toolCallId === "string" &&
        part.toolCallId.length > 0
      ) {
        ids.push(part.toolCallId);
      }
    }
  }
  return ids;
}

/**
 * P0-2 配对回填：保证每个 toolCallId 的 tool-call 与 tool-result 要么同在 protected、要么同在 compressible。
 *
 * 算法：
 * 1. 扫 history，建立 toolCallId → { callMsgId?, resultMsgId? } 索引。
 * 2. 对每个 toolCallId，若 callMsgId 在 protected 但 resultMsgId 不在（或反之），把缺失侧加入 protected。
 * 3. 迭代直到一轮无新增（新加入的 protected 消息可能携带新的 toolCallId，需继续回填）。
 *
 * 边界：tool-call 无对应 tool-result（agent 中途中断）不触发回填——无配对则无强制约束。
 *       tool-result 无对应 tool-call（历史数据异常）同理。
 *
 * @returns 新增的 message id 集合（供 ref 记录）；原 protectedMessageIds 集合被原地补全。
 */
function backfillToolPairRefs(
  messages: ChatMessage[],
  protectedMessageIds: Set<string>,
): Set<string> {
  // 1. 建 toolCallId → { callMsgId?, resultMsgId? }
  const index = new Map<string, { callMsgId?: string; resultMsgId?: string }>();
  for (const m of messages) {
    const parts = (m as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      const part = p as { type?: string; toolCallId?: unknown };
      if (
        (part.type !== "tool-call" && part.type !== "tool-result") ||
        typeof part.toolCallId !== "string"
      )
        continue;
      const id = part.toolCallId;
      const entry = index.get(id) ?? {};
      if (part.type === "tool-call") entry.callMsgId = m.id;
      else entry.resultMsgId = m.id;
      index.set(id, entry);
    }
  }

  // 2. 迭代回填直到稳定
  const added = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { callMsgId, resultMsgId } of index.values()) {
      if (!callMsgId || !resultMsgId) continue; // 无配对，跳过
      const callIn = protectedMessageIds.has(callMsgId);
      const resultIn = protectedMessageIds.has(resultMsgId);
      if (callIn === resultIn) continue; // 同侧，无需回填
      const missing = callIn ? resultMsgId : callMsgId;
      protectedMessageIds.add(missing);
      added.add(missing);
      changed = true;
    }
  }
  return added;
}

/**
 * 计算 protected refs（V3.3a 永不压缩集合）。
 *
 * 六类 protected（蓝图 §6.4，硬不变式——任意压缩后必须仍出现在装配 messages 里）：
 *  1. 最新用户消息（最后一条 role=user 的 message id，逐字保留）。
 *  2. active plan（注入文本）。
 *  3. pending approval（全部注入；多个全保留）。
 *  4. 当前失败原始错误片段（最近一次失败 toolRun，注入）。
 *  5. 安全/权限/部署硬约束（policyConstraints，从 policy config 派生，注入）。
 *  6. 用户 pinned facts（注入）。
 *
 * 另：最近 `recentKeepCount` 条原始消息逐字保留（确保最新上下文可见）。
 * 边界：多个 pending approval 全保留；多个失败取最近一次。
 *
 * P0-2：在以上 protected 集合算完后，调 `backfillToolPairRefs` 保证 tool-call/tool-result 配对完整，
 * 避免压缩产出孤儿 tool part 违反 AI SDK v6 协议。
 */
export function computeProtectedRefs(args: {
  messages: ChatMessage[];
  activePlan?: ThreadPlan | null;
  pendingApprovals?: ToolApprovalRequest[];
  recentFailure?: ToolRun | null;
  /** Stage D：安全/权限/部署硬约束（从 policy config 派生）。 */
  policyConstraints?: string[];
  /** Stage D：用户明确要求保留的 pinned facts。 */
  pinnedFacts?: string[];
  recentKeepCount?: number;
}): ProtectedRefsResult {
  const keep = Math.max(1, args.recentKeepCount ?? DEFAULT_RECENT_KEEP);
  const messages = args.messages;

  const protectedMessageIds = new Set<string>();
  const refs: ProtectedRef[] = [];
  const injected: InjectedProtected[] = [];

  // 最新用户消息
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx >= 0) {
    const lastUser = messages[lastUserIdx];
    if (lastUser) {
      protectedMessageIds.add(lastUser.id);
      refs.push({
        kind: "latest_user",
        messageIds: [lastUser.id],
        reason: "最新用户指令（永不压缩）",
      });
    }
  }

  // 最近 N 条原始消息
  const recentIds = messages.slice(Math.max(0, messages.length - keep)).map((m) => m.id);
  for (const id of recentIds) protectedMessageIds.add(id);
  refs.push({
    kind: "recent_messages",
    messageIds: recentIds,
    reason: `最近 ${recentIds.length} 条原始消息逐字保留`,
  });

  // active plan（注入）
  if (args.activePlan) {
    injected.push({
      kind: "active_plan",
      text: `当前计划: ${args.activePlan.title} [${args.activePlan.status}]`,
    });
    refs.push({ kind: "active_plan", messageIds: [], reason: "active plan 作为 protected 注入" });
  }

  // pending approval（注入，全部保留）
  const pending = args.pendingApprovals ?? [];
  if (pending.length > 0) {
    const lines = pending.map(
      (p) => `- 待审批: ${p.toolName} (${p.permissionKey}) — ${p.argSummary}`,
    );
    injected.push({ kind: "pending_approval", text: `待审批项:\n${lines.join("\n")}` });
    refs.push({
      kind: "pending_approval",
      messageIds: [],
      reason: `${pending.length} 个 pending approval 全部保留`,
    });
  }

  // 最近失败（注入）
  if (args.recentFailure) {
    const input = (args.recentFailure.input ?? {}) as Record<string, unknown>;
    const cmd = typeof input.command === "string" ? input.command : args.recentFailure.toolName;
    const err = args.recentFailure.error ?? "未知错误";
    injected.push({
      kind: "recent_failure",
      text: `最近失败: ${cmd} → ${err}`,
    });
    refs.push({ kind: "recent_failure", messageIds: [], reason: "当前失败原始错误片段保留" });
  }

  // 安全/权限/部署硬约束（注入）
  const policyConstraints = args.policyConstraints ?? [];
  if (policyConstraints.length > 0) {
    injected.push({
      kind: "policy_constraint",
      text: `硬约束:\n${policyConstraints.map((c) => `  - ${c}`).join("\n")}`,
    });
    refs.push({
      kind: "policy_constraint",
      messageIds: [],
      reason: `${policyConstraints.length} 条安全/权限/部署硬约束保留`,
    });
  }

  // pinned facts（注入）
  const pinnedFacts = args.pinnedFacts ?? [];
  if (pinnedFacts.length > 0) {
    injected.push({
      kind: "pinned_fact",
      text: `pinned facts:\n${pinnedFacts.map((f) => `  - ${f}`).join("\n")}`,
    });
    refs.push({
      kind: "pinned_fact",
      messageIds: [],
      reason: `${pinnedFacts.length} 条用户 pinned facts 保留`,
    });
  }

  // P0-2：tool-call/tool-result 配对回填（必须在所有 protected 源算完后）
  const backfilledIds = backfillToolPairRefs(messages, protectedMessageIds);
  if (backfilledIds.size > 0) {
    refs.push({
      kind: "tool_pair_backfill",
      messageIds: [...backfilledIds],
      reason: `${backfilledIds.size} 条消息因 tool-call/tool-result 配对完整性回填保留`,
    });
  }

  return { protectedMessageIds, injected, refs };
}

/** 把注入的 protected 内容拼成可写入 system 消息的文本块。 */
export function renderInjectedProtected(injected: InjectedProtected[]): string {
  if (injected.length === 0) return "";
  return injected.map((p) => p.text).join("\n");
}

/** 兜底：从消息里取最新用户文本（供摘要引用）。 */
export function latestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return extractMessageText(m);
  }
  return "";
}
