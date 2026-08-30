/**
 * AgentCall Store — MySQL 实现。
 *
 * 最终冻结事务（finalizeAgentCall）：
 * 1. 按固定顺序锁定并重证全部 Agent/Contract/Publication/Route/Policy Authority。
 * 2. 严格区分同 canonical request replay 与同 key 语义冲突。
 * 3. 原子插入 AgentCall + AgentCallBinding + 初始 Attempt(1) + CapabilityUse。
 *
 * 状态转移（updateState）：CAS on versionNo，from/to 由 domain 状态机约束。
 */
import {
  type AgentCall,
  type AgentCallState,
  computeAgentCallCreationRequestDigest,
  isAgentCallTerminal,
} from "@/lib/agents/calls/domain/agent-call";
import {
  type AgentCallAttempt,
  isAgentCallAttemptTerminal,
} from "@/lib/agents/calls/domain/agent-call-attempt";
import {
  AgentCallBindingAlreadyExistsError,
  type AgentCallBindingConfigInput,
} from "@/lib/agents/calls/domain/agent-call-binding";
import type {
  AgentCallStore,
  StoreAgentCallInput,
  UpdateAgentCallStateInput,
} from "@/lib/agents/calls/persistence/agent-call-store";
import { lockAndValidateAgentCallAuthority } from "@/lib/agents/calls/persistence/finalize-agent-call-authority";
import { recordCapabilityUseInSession } from "@/lib/capability/capability-use-queries";
import { db } from "@/lib/db/client";
import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallTable,
} from "@/lib/persistence/schema/agent-calls";
import { and, eq } from "drizzle-orm";

export function createMysqlAgentCallStore(
  dependencies: {
    recordCapabilityUse: typeof recordCapabilityUseInSession;
  } = { recordCapabilityUse: recordCapabilityUseInSession },
): AgentCallStore {
  return {
    finalizeAgentCall: (input) =>
      db.transaction(async (tx) => {
        await lockAndValidateAgentCallAuthority(tx, input);
        const creationRequestDigest = computeCreationRequestDigest(input);
        // 幂等：同一 (parentInvocationId, logicalCallKey) 已存在 → 返回已存在 call。
        if (input.logicalCallKey) {
          const [existing] = await tx
            .select()
            .from(agentCallTable)
            .where(
              and(
                eq(agentCallTable.parentInvocationId, input.parentInvocationId),
                eq(agentCallTable.logicalCallKey, input.logicalCallKey),
                eq(agentCallTable.tenantId, input.tenantId),
              ),
            )
            .limit(1)
            .for("update");
          if (existing) {
            const binding = await loadBinding(tx, existing.id, input.tenantId);
            const [storedBinding] = await tx
              .select({ bindingHash: agentCallBindingTable.bindingHash })
              .from(agentCallBindingTable)
              .where(eq(agentCallBindingTable.callId, existing.id))
              .limit(1);
            if (
              !storedBinding ||
              storedBinding.bindingHash !== input.bindingHash ||
              existing.creationRequestDigest !== creationRequestDigest
            ) {
              throw new AgentCallIdempotencyConflictError(
                input.parentInvocationId,
                input.logicalCallKey,
              );
            }
            return { call: toAgentCall(existing), binding, status: "replayed" };
          }
        }
        const call = await doCreate(tx, input, dependencies.recordCapabilityUse);
        return { call, binding: input.bindingCandidate, status: "created" };
      }),

    updateState: (input) =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(agentCallTable)
          .where(
            and(
              eq(agentCallTable.id, input.callId),
              eq(agentCallTable.tenantId, input.tenantId),
              eq(agentCallTable.state, input.from),
            ),
          )
          .limit(1)
          .for("update");
        if (!row) {
          // from 不匹配 → 已发生并发转移或跨租户不可见。
          throw new AgentCallStateConcurrencyError(input.callId, input.from);
        }
        if (isAgentCallTerminal(row.state)) {
          throw new AgentCallStateConcurrencyError(input.callId, input.from);
        }
        const updated = {
          state: input.to,
          versionNo: row.versionNo + 1,
          ...(input.lifecycle?.startedAt ? { startedAt: input.lifecycle.startedAt } : {}),
          ...(input.lifecycle?.waitingAt ? { waitingAt: input.lifecycle.waitingAt } : {}),
          ...(input.lifecycle?.finishedAt ? { finishedAt: input.lifecycle.finishedAt } : {}),
          ...(input.externalTaskRef !== undefined
            ? { externalTaskRef: input.externalTaskRef }
            : {}),
          ...(input.externalContextRef !== undefined
            ? { externalContextRef: input.externalContextRef }
            : {}),
          ...(input.resultText !== undefined ? { resultText: input.resultText } : {}),
          ...(input.resultJson !== undefined ? { resultJson: input.resultJson } : {}),
          ...(input.resultDigest !== undefined ? { resultDigest: input.resultDigest } : {}),
          ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
          ...(input.errorSummary !== undefined ? { errorSummary: input.errorSummary } : {}),
        };
        await tx.update(agentCallTable).set(updated).where(eq(agentCallTable.id, input.callId));
        const [after] = await tx
          .select()
          .from(agentCallTable)
          .where(eq(agentCallTable.id, input.callId))
          .limit(1);
        if (!after) throw new Error("AgentCall 状态转移后无法回读");
        return toAgentCall(after);
      }),

    getById: async ({ callId, tenantId }) => {
      const [row] = await db
        .select()
        .from(agentCallTable)
        .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
        .limit(1);
      return row ? toAgentCall(row) : null;
    },

    getBinding: async ({ callId, tenantId }) => {
      const [row] = await db
        .select()
        .from(agentCallBindingTable)
        .where(
          and(
            eq(agentCallBindingTable.callId, callId),
            eq(agentCallBindingTable.tenantId, tenantId),
          ),
        )
        .limit(1);
      return row ? toBindingConfig(row) : null;
    },

    createAttempt: async ({ callId, tenantId, attemptNo, now }) => {
      try {
        await db.insert(agentCallAttemptTable).values({
          callId,
          tenantId,
          attemptNo,
          attemptState: "queued",
          dispatchAttemptCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        if (isMysqlDuplicateEntryError(err)) {
          // UNIQUE(callId, attemptNo) 冲突 → 已存在，返回现有 attempt。
          const [existing] = await db
            .select()
            .from(agentCallAttemptTable)
            .where(
              and(
                eq(agentCallAttemptTable.callId, callId),
                eq(agentCallAttemptTable.attemptNo, attemptNo),
              ),
            )
            .limit(1);
          if (existing) return toAttempt(existing);
        }
        throw err;
      }
      const [row] = await db
        .select()
        .from(agentCallAttemptTable)
        .where(
          and(
            eq(agentCallAttemptTable.callId, callId),
            eq(agentCallAttemptTable.attemptNo, attemptNo),
          ),
        )
        .limit(1);
      if (!row) throw new Error("AgentCallAttempt 插入后无法回读");
      return toAttempt(row);
    },

    recordOutbound: async ({ callId, tenantId, attemptNo }) => {
      const [row] = await db
        .select()
        .from(agentCallAttemptTable)
        .where(
          and(
            eq(agentCallAttemptTable.callId, callId),
            eq(agentCallAttemptTable.tenantId, tenantId),
            eq(agentCallAttemptTable.attemptNo, attemptNo),
          ),
        )
        .limit(1)
        .for("update");
      if (!row) throw new Error(`AgentCallAttempt ${callId}#${attemptNo} 不存在`);
      const next = { dispatchAttemptCount: row.dispatchAttemptCount + 1, updatedAt: new Date() };
      await db.update(agentCallAttemptTable).set(next).where(eq(agentCallAttemptTable.id, row.id));
      const [after] = await db
        .select()
        .from(agentCallAttemptTable)
        .where(eq(agentCallAttemptTable.id, row.id))
        .limit(1);
      if (!after) throw new Error("AgentCallAttempt outbound 后无法回读");
      return toAttempt(after);
    },

    claimInitialAttempt: ({ callId, tenantId, requestDigest, now }) =>
      db.transaction(async (tx) => {
        const [callRow] = await tx
          .select()
          .from(agentCallTable)
          .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
          .limit(1)
          .for("update");
        if (!callRow) throw new Error(`AgentCall ${callId} 不存在或不属于租户`);
        const [attemptRow] = await tx
          .select()
          .from(agentCallAttemptTable)
          .where(
            and(
              eq(agentCallAttemptTable.callId, callId),
              eq(agentCallAttemptTable.tenantId, tenantId),
              eq(agentCallAttemptTable.attemptNo, 1),
            ),
          )
          .limit(1)
          .for("update");
        if (!attemptRow) throw new Error(`AgentCallAttempt ${callId}#1 不存在`);

        const call = toAgentCall(callRow);
        const attempt = toAttempt(attemptRow);

        // 已认领：同 digest → idempotent；异 digest → conflict（稳定冲突，含终态后）。
        if (attemptRow.requestDigest !== null) {
          if (attemptRow.requestDigest === requestDigest) {
            return { status: "idempotent", attempt, call } as const;
          }
          return { status: "conflict", attempt, call } as const;
        }

        // 未认领但已终态：返回既有结果，不重复 outbound。
        if (
          isAgentCallAttemptTerminal(attemptRow.attemptState) ||
          isAgentCallTerminal(callRow.state)
        ) {
          return { status: "terminal", attempt, call } as const;
        }

        // 赢得认领：唯一发 HTTP 者。requestDigest + running + outbound=1。
        await tx
          .update(agentCallAttemptTable)
          .set({
            requestDigest,
            attemptState: "running",
            dispatchAttemptCount: 1,
            startedAt: now,
            updatedAt: now,
          })
          .where(eq(agentCallAttemptTable.id, attemptRow.id));
        // call queued→running（含 startedAt）；若已是 running 则不动 versionNo。
        const updatedCall = await doClaimCallRunning(tx, callRow, now);

        const [afterAttempt] = await tx
          .select()
          .from(agentCallAttemptTable)
          .where(eq(agentCallAttemptTable.id, attemptRow.id))
          .limit(1);
        if (!afterAttempt) throw new Error("AgentCallAttempt claim 后无法回读");
        return { status: "owner", attempt: toAttempt(afterAttempt), call: updatedCall } as const;
      }),
  };
}

export const mysqlAgentCallStore: AgentCallStore = createMysqlAgentCallStore();

export class AgentCallStateConcurrencyError extends Error {
  constructor(
    public readonly callId: string,
    public readonly expectedFrom: AgentCallState,
  ) {
    super(`AgentCall ${callId} 状态转移并发冲突（期望 from=${expectedFrom}）`);
    this.name = "AgentCallStateConcurrencyError";
  }
}

export class AgentCallIdempotencyConflictError extends Error {
  readonly code = "AGENT_CALL_IDEMPOTENCY_CONFLICT";

  constructor(
    public readonly parentInvocationId: string,
    public readonly logicalCallKey: string,
  ) {
    super(
      `AgentCall 幂等冲突：parentInvocationId=${parentInvocationId}, logicalCallKey=${logicalCallKey}`,
    );
    this.name = "AgentCallIdempotencyConflictError";
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** claim owner 使 call 进入 running（queued→running CAS；已 running 则仅回读，不重复 bump versionNo）。 */
async function doClaimCallRunning(
  tx: Transaction,
  callRow: typeof agentCallTable.$inferSelect,
  now: Date,
): Promise<AgentCall> {
  if (callRow.state === "queued") {
    await tx
      .update(agentCallTable)
      .set({ state: "running", startedAt: now, versionNo: callRow.versionNo + 1 })
      .where(eq(agentCallTable.id, callRow.id));
  }
  const [after] = await tx
    .select()
    .from(agentCallTable)
    .where(eq(agentCallTable.id, callRow.id))
    .limit(1);
  if (!after) throw new Error("AgentCall claim 后无法回读");
  return toAgentCall(after);
}

async function doCreate(
  tx: Transaction,
  input: StoreAgentCallInput,
  recordCapabilityUse: typeof recordCapabilityUseInSession = recordCapabilityUseInSession,
): Promise<AgentCall> {
  // 同一 call 已绑定 → 禁止重复。
  const [existingBinding] = await tx
    .select({ callId: agentCallBindingTable.callId })
    .from(agentCallBindingTable)
    .where(eq(agentCallBindingTable.callId, input.id))
    .limit(1);
  if (existingBinding) throw new AgentCallBindingAlreadyExistsError(input.id);

  // 插入 AgentCall + Binding + 初始 Attempt(1) + CapabilityUse。
  await tx.insert(agentCallTable).values({
    id: input.id,
    tenantId: input.tenantId,
    parentInvocationId: input.parentInvocationId,
    agentId: input.agentId,
    agentRevisionId: input.agentRevisionId,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef ?? null,
    state: "queued",
    logicalCallKey: input.logicalCallKey ?? null,
    creationRequestDigest: computeCreationRequestDigest(input),
    createdAt: input.createdAt,
    versionNo: 1,
  });
  const b = input.bindingCandidate;
  await tx.insert(agentCallBindingTable).values({
    callId: input.id,
    tenantId: input.tenantId,
    agentId: b.agentId,
    agentRevisionId: b.agentRevisionId,
    agentContractSnapshotId: b.agentContractSnapshotId,
    agentContractDigest: b.agentContractDigest,
    agentCapabilityDigest: b.agentCapabilityDigest,
    agentContextDigest: b.agentContextDigest,
    agentPublicationRecordId: b.agentPublicationRecordId,
    deploymentRouteId: b.deploymentRouteId,
    routeRevisionId: b.routeRevisionId,
    routeActivationId: b.routeActivationId,
    routeContentDigest: b.routeContentDigest,
    resolutionInputDigest: b.resolutionInputDigest,
    projectionVersionNo: b.projectionVersionNo,
    endpointRef: b.endpointRef,
    identityMode: b.identityMode,
    credentialRefId: b.credentialRefId ?? null,
    networkZone: b.networkZone,
    protocolType: b.protocolType,
    protocolContractRevision: b.protocolContractRevision,
    policyRevisionId: b.policyRevisionId,
    policyRulesDigest: b.policyRulesDigest,
    governanceConfigRevisionId: b.governanceConfigRevisionId,
    governanceConfigDigest: b.governanceConfigDigest,
    bindingHash: input.bindingHash,
    boundAt: input.createdAt,
  });
  await tx.insert(agentCallAttemptTable).values({
    callId: input.id,
    tenantId: input.tenantId,
    attemptNo: 1,
    attemptState: "queued",
    dispatchAttemptCount: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  await recordCapabilityUse(tx, {
    tenantId: input.tenantId,
    invocationId: input.parentInvocationId,
    capabilityType: "agent",
    capabilityId: input.agentId,
    revisionId: input.agentRevisionId,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    selectionReasonCode: input.sourceType === "user_selected" ? "explicit_select" : null,
  });

  const [row] = await tx
    .select()
    .from(agentCallTable)
    .where(eq(agentCallTable.id, input.id))
    .limit(1);
  if (!row) throw new Error("AgentCall 插入后无法回读");
  return toAgentCall(row);
}

function computeCreationRequestDigest(input: StoreAgentCallInput): string {
  return computeAgentCallCreationRequestDigest({
    tenantId: input.tenantId,
    parentInvocationId: input.parentInvocationId,
    agentId: input.agentId,
    agentRevisionId: input.agentRevisionId,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    logicalCallKey: input.logicalCallKey,
    bindingHash: input.bindingHash,
  });
}

async function loadBinding(
  tx: Transaction,
  callId: string,
  tenantId: string,
): Promise<AgentCallBindingConfigInput> {
  const [row] = await tx
    .select()
    .from(agentCallBindingTable)
    .where(
      and(eq(agentCallBindingTable.callId, callId), eq(agentCallBindingTable.tenantId, tenantId)),
    )
    .limit(1);
  if (!row) throw new Error(`AgentCallBinding ${callId} 不存在`);
  return toBindingConfig(row);
}

function toAgentCall(row: typeof agentCallTable.$inferSelect): AgentCall {
  return {
    id: row.id,
    tenantId: row.tenantId,
    parentInvocationId: row.parentInvocationId,
    agentId: row.agentId,
    agentRevisionId: row.agentRevisionId,
    sourceType: row.sourceType as AgentCall["sourceType"],
    sourceRef: row.sourceRef,
    state: row.state as AgentCallState,
    externalContextRef: row.externalContextRef,
    externalTaskRef: row.externalTaskRef,
    resultText: row.resultText,
    resultJson: row.resultJson,
    resultDigest: row.resultDigest,
    errorCode: row.errorCode,
    errorSummary: row.errorSummary,
    logicalCallKey: row.logicalCallKey,
    creationRequestDigest: row.creationRequestDigest,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    waitingAt: row.waitingAt,
    finishedAt: row.finishedAt,
    versionNo: Number(row.versionNo),
  };
}

function toBindingConfig(
  row: typeof agentCallBindingTable.$inferSelect,
): AgentCallBindingConfigInput {
  return {
    agentId: row.agentId,
    agentRevisionId: row.agentRevisionId,
    agentContractSnapshotId: row.agentContractSnapshotId,
    agentContractDigest: row.agentContractDigest,
    agentCapabilityDigest: row.agentCapabilityDigest,
    agentContextDigest: row.agentContextDigest,
    agentPublicationRecordId: row.agentPublicationRecordId,
    deploymentRouteId: row.deploymentRouteId,
    routeRevisionId: row.routeRevisionId,
    routeActivationId: row.routeActivationId,
    routeContentDigest: row.routeContentDigest,
    resolutionInputDigest: row.resolutionInputDigest,
    projectionVersionNo: row.projectionVersionNo,
    endpointRef: row.endpointRef,
    identityMode: row.identityMode,
    credentialRefId: row.credentialRefId,
    networkZone: row.networkZone,
    protocolType: row.protocolType,
    protocolContractRevision: row.protocolContractRevision,
    policyRevisionId: row.policyRevisionId,
    policyRulesDigest: row.policyRulesDigest,
    governanceConfigRevisionId: row.governanceConfigRevisionId,
    governanceConfigDigest: row.governanceConfigDigest,
  };
}

function toAttempt(row: typeof agentCallAttemptTable.$inferSelect): AgentCallAttempt {
  return {
    id: row.id,
    callId: row.callId,
    tenantId: row.tenantId,
    attemptNo: row.attemptNo,
    attemptState: row.attemptState,
    externalTaskRef: row.externalTaskRef,
    dispatchAttemptCount: row.dispatchAttemptCount,
    retryReasonCode: row.retryReasonCode,
    requestDigest: row.requestDigest,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorCode: row.errorCode,
    errorSummary: row.errorSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
