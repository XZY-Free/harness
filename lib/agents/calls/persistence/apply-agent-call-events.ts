/**
 * applyAgentCallEvents — AgentCallEventIngress 原子应用（事务作用域）。
 *
 * 单一 caller-owned 事务内完成整批 Agent transport 候选事件的归一化：
 * - 锁定 tenant-scoped AgentCall + 其 Binding + parent Invocation（读 parent.threadId）。
 * - 先结构化校验每个事件，再逐个 apply；任何 malformed/mismatch 抛错 → 整个事务回滚。
 * - 绝不触碰 parent Invocation 生命周期 / RuntimeSessionBinding / RuntimeEventIngress /
 *   Turn / ThreadItems。
 *
 * 冻结映射：
 * - A2A taskId → AgentCallAttempt.externalTaskRef
 * - A2A contextId → AgentSessionBinding.externalContextRef（thread 只来自 parent.threadId）
 *
 * canonical payloadHash 含事件 TYPE + 递归规范化 payload（computePayloadHash 已排序）。
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { AgentCallState } from "@/lib/agents/calls/domain/agent-call";
import type { AgentCallCandidateEvent } from "@/lib/agents/calls/transport/agent-transport";
import type { DbOrTx } from "@/lib/db/client";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallEventIngressTable,
  agentCallTable,
  agentSessionBindingTable,
} from "@/lib/persistence/schema/agent-calls";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { and, desc, eq } from "drizzle-orm";

const SUPPORTED_TYPES = new Set([
  "call.started",
  "call.completed",
  "call.input_required",
  "call.failed",
  "call.cancelled",
  "call.lost",
]);

export interface IngestAgentCallEventsInput {
  tenantId: string;
  callId: string;
  events: AgentCallCandidateEvent[];
}

export interface IngestAgentCallEventsResult {
  accepted: number;
  duplicate: number;
  rejected: number;
  finalState: AgentCallState;
}

/** 递归规范化（排序 key）后 sha256，作为 canonical payloadHash（含事件 TYPE）。 */
function canonicalHash(type: string, payload: unknown): string {
  const json = JSON.stringify(sortKeys({ type, payload }));
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = sortKeys((value as Record<string, unknown>)[k]);
  }
  return out;
}

interface ParsedEvent {
  e: AgentCallCandidateEvent;
  type: AgentCallCandidateEvent["type"];
  taskId?: string;
  contextId?: string;
}

/** 结构化校验单个事件；非法即抛稳定错误（不泄露 payload 细节）。 */
function parseEvent(e: AgentCallCandidateEvent): ParsedEvent {
  if (
    !e.producer_event_id ||
    typeof e.producer_event_id !== "string" ||
    e.producer_event_id.trim() === ""
  ) {
    throw new Error("AgentCallEvent 缺少合法 producer_event_id");
  }
  if (!Number.isInteger(e.producer_sequence) || e.producer_sequence < 1) {
    throw new Error("AgentCallEvent producer_sequence 必须为正整数");
  }
  if (!SUPPORTED_TYPES.has(e.type)) {
    throw new Error("不支持的 AgentCall 候选事件类型");
  }
  if (e.payload === null || typeof e.payload !== "object" || Array.isArray(e.payload)) {
    throw new Error("AgentCallEvent payload 必须为对象");
  }
  const { task_id: t, context_id: c } = e.payload as Record<string, unknown>;
  const taskId = typeof t === "string" && t.length > 0 ? t : undefined;
  const contextId = typeof c === "string" && c.length > 0 ? c : undefined;
  // 已知 refs 必须是非空成对；只出现其一视为畸形。
  if (!!taskId !== !!contextId) {
    throw new Error("AgentCallEvent task_id/context_id 必须成对出现");
  }
  return { e, type: e.type, taskId, contextId };
}

interface CallLock {
  state: AgentCallState;
  externalTaskRef: string | null;
  currentAttemptId: string;
  agentSessionBindingId: string | null;
  externalContextRef: string | null;
  versionNo: number;
  agentId: string;
  agentRevisionId: string;
  deploymentRouteId: string;
  routeRevisionId: string;
  parentThreadId: string | null;
}

/** 锁定 tenant-scoped call + binding + parent，读回线程/证据。 */
async function lockCall(tx: DbOrTx, callId: string, tenantId: string): Promise<CallLock> {
  const [callRow] = await tx
    .select()
    .from(agentCallTable)
    .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
    .limit(1)
    .for("update");
  if (!callRow) {
    throw new Error(`AgentCall ${callId} 不存在或不属于租户`);
  }
  const [binding] = await tx
    .select()
    .from(agentCallBindingTable)
    .where(
      and(eq(agentCallBindingTable.callId, callId), eq(agentCallBindingTable.tenantId, tenantId)),
    )
    .limit(1)
    .for("update");
  if (!binding) throw new Error(`AgentCallBinding ${callId} 不存在`);
  const [parent] = await tx
    .select({ threadId: invocationTable.threadId })
    .from(invocationTable)
    .where(eq(invocationTable.id, callRow.parentInvocationId))
    .limit(1)
    .for("update");
  const attemptRows = await tx
    .select()
    .from(agentCallAttemptTable)
    .where(
      and(eq(agentCallAttemptTable.callId, callId), eq(agentCallAttemptTable.tenantId, tenantId)),
    )
    .orderBy(desc(agentCallAttemptTable.attemptNo))
    .for("update");
  const activeAttempts = attemptRows.filter(
    (attempt) => attempt.attemptState === "queued" || attempt.attemptState === "running",
  );
  if (activeAttempts.length > 1) throw new Error("AgentCall 存在多个活动 Attempt");
  const currentAttempt = activeAttempts[0] ?? attemptRows[0];
  if (!currentAttempt) throw new Error(`AgentCallAttempt ${callId} 不存在`);
  const result: CallLock = {
    state: callRow.state as AgentCallState,
    externalTaskRef: currentAttempt.externalTaskRef,
    currentAttemptId: currentAttempt.id,
    agentSessionBindingId: callRow.agentSessionBindingId,
    externalContextRef: null,
    versionNo: callRow.versionNo,
    agentId: callRow.agentId,
    agentRevisionId: binding.agentRevisionId,
    deploymentRouteId: binding.deploymentRouteId,
    routeRevisionId: binding.routeRevisionId,
    parentThreadId: parent?.threadId ?? null,
  };
  if (callRow.agentSessionBindingId) {
    const [session] = await tx
      .select({ externalContextRef: agentSessionBindingTable.externalContextRef })
      .from(agentSessionBindingTable)
      .where(
        and(
          eq(agentSessionBindingTable.id, callRow.agentSessionBindingId),
          eq(agentSessionBindingTable.tenantId, tenantId),
        ),
      )
      .limit(1)
      .for("update");
    if (!session) throw new Error(`AgentSessionBinding ${callRow.agentSessionBindingId} 不存在`);
    result.externalContextRef = session.externalContextRef;
  }
  return result;
}

async function bindCurrentAttemptTask(
  tx: DbOrTx,
  attemptId: string,
  taskId: string,
): Promise<void> {
  await tx
    .update(agentCallAttemptTable)
    .set({ externalTaskRef: taskId, updatedAt: new Date() })
    .where(eq(agentCallAttemptTable.id, attemptId));
}

/** 校验当前已绑定 refs 与事件 refs 精确匹配；已绑定但事件 refs 存在且不同 → 关联不匹配。 */
function assertRefsMatch(
  boundTask: string | null,
  boundContext: string | null,
  taskId?: string,
  contextId?: string,
): void {
  if (!taskId || !contextId) return; // 事件未携带 refs（如 call.lost 合成）→ 不校验。
  if (boundTask !== null && boundTask !== taskId) {
    throw new Error("AgentCall taskId 关联不匹配");
  }
  if (boundContext !== null && boundContext !== contextId) {
    throw new Error("AgentCall contextId 关联不匹配");
  }
}

/** 建立/复用 AgentSessionBinding。精确维度一致才可复用。 */
async function ensureSession(
  tx: DbOrTx,
  lock: CallLock,
  tenantId: string,
  threadId: string | null,
  contextId: string,
): Promise<string> {
  const [existing] = await tx
    .select()
    .from(agentSessionBindingTable)
    .where(
      and(
        eq(agentSessionBindingTable.tenantId, tenantId),
        eq(agentSessionBindingTable.agentId, lock.agentId),
        eq(agentSessionBindingTable.agentRevisionId, lock.agentRevisionId),
        eq(agentSessionBindingTable.deploymentRouteId, lock.deploymentRouteId),
        eq(agentSessionBindingTable.routeRevisionId, lock.routeRevisionId),
        eq(agentSessionBindingTable.externalContextRef, contextId),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.threadId !== threadId || existing.bindingState !== "active") {
      throw new Error("AgentSessionBinding 关联冲突：context 已归属其它会话或已关闭");
    }
    return existing.id;
  }
  const id = randomUUID();
  await tx.insert(agentSessionBindingTable).values({
    id,
    tenantId,
    threadId,
    agentId: lock.agentId,
    agentRevisionId: lock.agentRevisionId,
    deploymentRouteId: lock.deploymentRouteId,
    routeRevisionId: lock.routeRevisionId,
    externalContextRef: contextId,
    bindingState: "active",
    createdAt: new Date(),
    lastUsedAt: new Date(),
  });
  return id;
}

/** 幂等写入 ingress 账本；返回 accepted / duplicate，冲突抛错（回滚）。 */
async function writeIngress(
  tx: DbOrTx,
  callId: string,
  tenantId: string,
  p: ParsedEvent,
): Promise<"accepted" | "duplicate"> {
  const payloadHash = canonicalHash(p.type, p.e.payload);
  const [byEvent] = await tx
    .select()
    .from(agentCallEventIngressTable)
    .where(
      and(
        eq(agentCallEventIngressTable.callId, callId),
        eq(agentCallEventIngressTable.tenantId, tenantId),
        eq(agentCallEventIngressTable.producerEventId, p.e.producer_event_id),
      ),
    )
    .limit(1);
  if (byEvent) {
    if (byEvent.payloadHash === payloadHash && byEvent.candidateType === p.type) {
      return "duplicate";
    }
    throw new Error("AgentCallEvent 同 key 内容冲突（payload 或类型改变）");
  }
  await tx.insert(agentCallEventIngressTable).values({
    id: randomUUID(),
    callId,
    tenantId,
    producerEventId: p.e.producer_event_id,
    producerSequence: p.e.producer_sequence,
    candidateType: p.type,
    payloadHash,
    payloadJson: p.e.payload,
    ingressState: "accepted",
    receivedAt: new Date(),
  });
  return "accepted";
}

async function markMapped(
  tx: DbOrTx,
  callId: string,
  tenantId: string,
  producerEventId: string,
): Promise<void> {
  await tx
    .update(agentCallEventIngressTable)
    .set({ ingressState: "mapped", mappedAt: new Date() })
    .where(
      and(
        eq(agentCallEventIngressTable.callId, callId),
        eq(agentCallEventIngressTable.tenantId, tenantId),
        eq(agentCallEventIngressTable.producerEventId, producerEventId),
      ),
    );
}

const TERMINAL: Record<string, AgentCallState> = {
  "call.completed": "completed",
  "call.failed": "failed",
  "call.cancelled": "cancelled",
  "call.lost": "lost",
};

/**
 * 在 caller-owned 事务内应用整批事件。任何非法/不匹配抛错 → 上层事务整体回滚。
 */
export async function applyAgentCallEvents(
  tx: DbOrTx,
  input: IngestAgentCallEventsInput,
): Promise<IngestAgentCallEventsResult> {
  const lock = await lockCall(tx, input.callId, input.tenantId);
  const parsed = input.events.map(parseEvent); // 先结构化校验全部事件。

  let state = lock.state;
  let externalTaskRef = lock.externalTaskRef;
  let agentSessionBindingId = lock.agentSessionBindingId;
  let externalContextRef = lock.externalContextRef;
  let accepted = 0;
  let duplicate = 0;
  let rejected = 0;

  for (const p of parsed) {
    const write = await writeIngress(tx, input.callId, input.tenantId, p);
    if (write === "duplicate") {
      duplicate += 1;
      continue; // 已处理过的回放：不重复转移。
    }
    accepted += 1;

    // 关联校验：事件 refs 须与当前已绑定（含本批先导事件）精确一致。
    assertRefsMatch(externalTaskRef, externalContextRef, p.taskId, p.contextId);

    if (p.type === "call.started") {
      // 首次官方 Task：绑定 refs + 建会话；running 中重复 started 不重置生命周期。
      if (p.taskId && externalTaskRef === null) {
        externalTaskRef = p.taskId;
        externalContextRef = p.contextId ?? null;
        // call.started 首次官方 Task 必须携带 contextId 才能建立会话；缺失即 fail closed。
        if (!p.contextId) {
          throw new Error("call.started 缺少 contextId，无法建立 AgentCall 会话");
        }
        agentSessionBindingId = await ensureSession(
          tx,
          lock,
          input.tenantId,
          lock.parentThreadId,
          p.contextId,
        );
        await bindCurrentAttemptTask(tx, lock.currentAttemptId, externalTaskRef);
        await tx
          .update(agentCallTable)
          .set({ agentSessionBindingId, versionNo: lock.versionNo + 1 })
          .where(eq(agentCallTable.id, input.callId));
      } else if (p.taskId && externalTaskRef !== null && externalTaskRef !== p.taskId) {
        throw new Error("AgentCall taskId 关联不匹配");
      }
      if (state === "queued") {
        state = "running";
        await tx
          .update(agentCallTable)
          .set({ state, startedAt: new Date(), versionNo: lock.versionNo + 1 })
          .where(eq(agentCallTable.id, input.callId));
      }
      await markMapped(tx, input.callId, input.tenantId, p.e.producer_event_id);
      continue;
    }

    if (state === "completed" || state === "failed" || state === "cancelled" || state === "lost") {
      // 终态后迟到事件：拒绝但绝不改终态/结果。
      rejected += 1;
      throw new Error("AgentCall 已终态，迟到事件被拒绝");
    }

    if (p.type === "call.completed") {
      const text = typeof p.e.payload.text === "string" ? p.e.payload.text : null;
      const data = p.e.payload.data ?? null;
      if (text === null && data === null) throw new Error("AgentCall completed 缺少 text 或 data");
      const resultDigest = canonicalHash("result", { text, data });
      state = "completed";
      await tx
        .update(agentCallTable)
        .set({
          state,
          resultText: text,
          resultJson: data,
          resultDigest,
          finishedAt: new Date(),
          versionNo: lock.versionNo + 1,
        })
        .where(eq(agentCallTable.id, input.callId));
      await updateAttempt(tx, input.callId, input.tenantId, "completed", null, null);
      await markMapped(tx, input.callId, input.tenantId, p.e.producer_event_id);
      continue;
    }

    if (p.type === "call.input_required") {
      if (p.taskId && externalTaskRef === null) {
        if (!p.contextId) {
          throw new Error("call.input_required 缺少 contextId，无法建立 AgentCall 会话");
        }
        externalTaskRef = p.taskId;
        externalContextRef = p.contextId;
        agentSessionBindingId = await ensureSession(
          tx,
          lock,
          input.tenantId,
          lock.parentThreadId,
          p.contextId,
        );
        await bindCurrentAttemptTask(tx, lock.currentAttemptId, externalTaskRef);
      }
      state = "waiting_user";
      await tx
        .update(agentCallTable)
        .set({
          state,
          agentSessionBindingId,
          waitingAt: new Date(),
          versionNo: lock.versionNo + 1,
        })
        .where(eq(agentCallTable.id, input.callId));
      await markMapped(tx, input.callId, input.tenantId, p.e.producer_event_id);
      continue;
    }

    // call.failed / call.cancelled / call.lost
    const terminalState = TERMINAL[p.type];
    if (!terminalState) {
      throw new Error(`未知 AgentCall 终态事件类型: ${p.type}`);
    }
    state = terminalState;
    const err = (p.e.payload.error ?? {}) as Record<string, unknown>;
    const errorCode = typeof err.code === "string" ? err.code : p.type;
    const errorSummary = typeof err.message === "string" ? err.message : null;
    await tx
      .update(agentCallTable)
      .set({
        state,
        errorCode,
        errorSummary,
        finishedAt: new Date(),
        versionNo: lock.versionNo + 1,
      })
      .where(eq(agentCallTable.id, input.callId));
    await updateAttempt(tx, input.callId, input.tenantId, terminalState, errorCode, errorSummary);
    await markMapped(tx, input.callId, input.tenantId, p.e.producer_event_id);
  }

  return { accepted, duplicate, rejected, finalState: state };
}

async function updateAttempt(
  tx: DbOrTx,
  callId: string,
  tenantId: string,
  attemptState: string,
  errorCode: string | null,
  errorSummary: string | null,
): Promise<void> {
  const [attempt] = await tx
    .select()
    .from(agentCallAttemptTable)
    .where(
      and(eq(agentCallAttemptTable.callId, callId), eq(agentCallAttemptTable.tenantId, tenantId)),
    )
    .orderBy(desc(agentCallAttemptTable.attemptNo))
    .limit(1);
  if (!attempt) return;
  const updates: Record<string, unknown> = { attemptState, updatedAt: new Date() };
  if (
    attemptState === "completed" ||
    attemptState === "failed" ||
    attemptState === "cancelled" ||
    attemptState === "lost"
  ) {
    updates.finishedAt = new Date();
  }
  if (errorCode) updates.errorCode = errorCode;
  if (errorSummary) updates.errorSummary = errorSummary;
  await tx
    .update(agentCallAttemptTable)
    .set(updates)
    .where(eq(agentCallAttemptTable.id, attempt.id));
}
