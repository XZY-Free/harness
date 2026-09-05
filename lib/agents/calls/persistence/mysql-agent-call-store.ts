/**
 * AgentCall Store — MySQL 实现。
 *
 * 最终冻结事务（finalizeAgentCall）：
 * 1. 按固定顺序锁定并重证全部 Agent/Contract/Publication/Route/Policy Authority。
 * 2. 严格区分同 canonical request replay 与同 key 语义冲突。
 * 3. 原子插入 AgentCall + AgentCallBinding + 初始 Attempt(1) + CapabilityUse。
 *
 * AgentCall 状态转换只由 apply-agent-call-transition 持有，本 Store 不公开任意 updateState。
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
} from "@/lib/agents/calls/persistence/agent-call-store";
import { lockAndValidateAgentCallAuthority } from "@/lib/agents/calls/persistence/finalize-agent-call-authority";
import { recordCapabilityUseInSession } from "@/lib/capability/capability-use-queries";
import { db } from "@/lib/db/client";
import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallTable,
  agentSessionBindingTable,
} from "@/lib/persistence/schema/agent-calls";
import { and, desc, eq } from "drizzle-orm";

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
            return {
              call: await toAgentCallWithSession(tx, existing),
              binding,
              status: "replayed",
            };
          }
        }
        const call = await doCreate(tx, input, dependencies.recordCapabilityUse);
        return { call, binding: input.bindingCandidate, status: "created" };
      }),

    getById: async ({ callId, tenantId }) => {
      const [row] = await db
        .select()
        .from(agentCallTable)
        .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
        .limit(1);
      return row ? toAgentCallWithSession(db, row) : null;
    },

    getByLogicalCallKey: async ({ parentInvocationId, tenantId, logicalCallKey }) => {
      const [row] = await db
        .select()
        .from(agentCallTable)
        .where(
          and(
            eq(agentCallTable.parentInvocationId, parentInvocationId),
            eq(agentCallTable.tenantId, tenantId),
            eq(agentCallTable.logicalCallKey, logicalCallKey),
          ),
        )
        .limit(1);
      return row ? toAgentCallWithSession(db, row) : null;
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

    createAttempt: ({ callId, tenantId, retryReasonCode, transportChannel, now }) =>
      db.transaction(async (tx) => {
        const [call] = await tx
          .select({ id: agentCallTable.id })
          .from(agentCallTable)
          .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
          .limit(1)
          .for("update");
        if (!call) throw new Error(`AgentCall ${callId} 不存在或不属于租户`);
        const [latest] = await tx
          .select()
          .from(agentCallAttemptTable)
          .where(
            and(
              eq(agentCallAttemptTable.callId, callId),
              eq(agentCallAttemptTable.tenantId, tenantId),
            ),
          )
          .orderBy(desc(agentCallAttemptTable.attemptNo))
          .limit(1)
          .for("update");
        if (latest && !isAgentCallAttemptTerminal(latest.attemptState)) {
          throw new AgentCallAttemptConflictError(callId, "仍存在活动 Attempt");
        }
        const attemptNo = (latest?.attemptNo ?? 0) + 1;
        await tx.insert(agentCallAttemptTable).values({
          callId,
          tenantId,
          attemptNo,
          attemptState: "queued",
          dispatchAttemptCount: 0,
          retryReasonCode,
          transportChannel,
          transportMetadataJson: { channel: transportChannel },
          createdAt: now,
          updatedAt: now,
        });
        const [row] = await tx
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
      }),

    bindAttemptTask: ({ callId, tenantId, attemptNo, externalTaskRef, now }) =>
      db.transaction(async (tx) => {
        const normalizedTaskRef = externalTaskRef.trim();
        if (!normalizedTaskRef) throw new AgentCallAttemptConflictError(callId, "taskId 为空");
        const [row] = await tx
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
        if (row.externalTaskRef !== null) {
          if (row.externalTaskRef !== normalizedTaskRef) {
            throw new AgentCallAttemptConflictError(callId, "Attempt 已绑定不同 taskId");
          }
          return toAttempt(row);
        }
        try {
          await tx
            .update(agentCallAttemptTable)
            .set({ externalTaskRef: normalizedTaskRef, updatedAt: now })
            .where(eq(agentCallAttemptTable.id, row.id));
        } catch (error) {
          if (isMysqlDuplicateEntryError(error)) {
            throw new AgentCallAttemptConflictError(callId, "taskId 已绑定其它 Attempt");
          }
          throw error;
        }
        const [after] = await tx
          .select()
          .from(agentCallAttemptTable)
          .where(eq(agentCallAttemptTable.id, row.id))
          .limit(1);
        if (!after) throw new Error("AgentCallAttempt task 绑定后无法回读");
        return toAttempt(after);
      }),

    getAttemptByTaskRef: async ({ tenantId, externalTaskRef }) => {
      const [row] = await db
        .select()
        .from(agentCallAttemptTable)
        .where(
          and(
            eq(agentCallAttemptTable.tenantId, tenantId),
            eq(agentCallAttemptTable.externalTaskRef, externalTaskRef),
          ),
        )
        .limit(1);
      return row ? toAttempt(row) : null;
    },

    getCurrentAttempt: async ({ callId, tenantId }) => {
      const rows = await db
        .select()
        .from(agentCallAttemptTable)
        .where(
          and(
            eq(agentCallAttemptTable.callId, callId),
            eq(agentCallAttemptTable.tenantId, tenantId),
          ),
        )
        .orderBy(desc(agentCallAttemptTable.attemptNo));
      const active = rows.filter((row) => !isAgentCallAttemptTerminal(row.attemptState));
      if (active.length > 1) {
        throw new AgentCallAttemptConflictError(callId, "存在多个活动 Attempt");
      }
      return active[0] ? toAttempt(active[0]) : rows[0] ? toAttempt(rows[0]) : null;
    },

    finishAttempt: ({ callId, tenantId, attemptNo, to, errorCode, errorSummary, now }) =>
      db.transaction(async (tx) => {
        const [row] = await tx
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
        if (isAgentCallAttemptTerminal(row.attemptState)) {
          if (row.attemptState === to) return toAttempt(row);
          throw new AgentCallAttemptConflictError(callId, "Attempt 已进入其它终态");
        }
        await tx
          .update(agentCallAttemptTable)
          .set({
            attemptState: to,
            errorCode: errorCode ?? null,
            errorSummary: errorSummary ?? null,
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(agentCallAttemptTable.id, row.id));
        const [after] = await tx
          .select()
          .from(agentCallAttemptTable)
          .where(eq(agentCallAttemptTable.id, row.id))
          .limit(1);
        if (!after) throw new Error("AgentCallAttempt 完成后无法回读");
        return toAttempt(after);
      }),

    recordOutbound: ({ callId, tenantId, attemptNo }) =>
      db.transaction(async (tx) => {
        const [row] = await tx
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
        await tx
          .update(agentCallAttemptTable)
          .set(next)
          .where(eq(agentCallAttemptTable.id, row.id));
        const [after] = await tx
          .select()
          .from(agentCallAttemptTable)
          .where(eq(agentCallAttemptTable.id, row.id))
          .limit(1);
        if (!after) throw new Error("AgentCallAttempt outbound 后无法回读");
        return toAttempt(after);
      }),

    claimCurrentAttempt: ({ callId, tenantId, requestDigest, now }) =>
      db.transaction(async (tx) => {
        const [callRow] = await tx
          .select()
          .from(agentCallTable)
          .where(and(eq(agentCallTable.id, callId), eq(agentCallTable.tenantId, tenantId)))
          .limit(1)
          .for("update");
        if (!callRow) throw new Error(`AgentCall ${callId} 不存在或不属于租户`);
        const attemptRows = await tx
          .select()
          .from(agentCallAttemptTable)
          .where(
            and(
              eq(agentCallAttemptTable.callId, callId),
              eq(agentCallAttemptTable.tenantId, tenantId),
            ),
          )
          .orderBy(desc(agentCallAttemptTable.attemptNo))
          .for("update");
        const activeAttempts = attemptRows.filter(
          (attempt) => !isAgentCallAttemptTerminal(attempt.attemptState),
        );
        if (activeAttempts.length > 1) {
          throw new AgentCallAttemptConflictError(callId, "存在多个活动 Attempt");
        }
        const attemptRow = activeAttempts[0] ?? attemptRows[0];
        if (!attemptRow) throw new Error(`AgentCallAttempt ${callId} 不存在`);

        const call = await toAgentCallWithSession(tx, callRow);
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

        // 赢得认领：唯一发 HTTP 者。Attempt 进入 running；AgentCall 必须等待正式
        // call.started 才能进入 running，禁止 claim 伪造远端 started 事实。
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
        const [afterAttempt] = await tx
          .select()
          .from(agentCallAttemptTable)
          .where(eq(agentCallAttemptTable.id, attemptRow.id))
          .limit(1);
        if (!afterAttempt) throw new Error("AgentCallAttempt claim 后无法回读");
        return { status: "owner", attempt: toAttempt(afterAttempt), call } as const;
      }),
  };
}

export const mysqlAgentCallStore: AgentCallStore = createMysqlAgentCallStore();

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

export class AgentCallAttemptConflictError extends Error {
  readonly code = "AGENT_CALL_ATTEMPT_CONFLICT";

  constructor(
    public readonly callId: string,
    detail: string,
  ) {
    super(`AgentCall ${callId} Attempt 关联冲突：${detail}`);
    this.name = "AgentCallAttemptConflictError";
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    state: "queued",
    logicalCallKey: input.logicalCallKey,
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
    enterpriseUserContextJson: b.enterpriseUserContext ?? null,
    bindingHash: input.bindingHash,
    boundAt: input.createdAt,
  });
  await tx.insert(agentCallAttemptTable).values({
    callId: input.id,
    tenantId: input.tenantId,
    attemptNo: 1,
    attemptState: "queued",
    dispatchAttemptCount: 0,
    transportChannel: input.transportChannel,
    transportMetadataJson: { channel: input.transportChannel },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  await recordCapabilityUse(tx, {
    tenantId: input.tenantId,
    invocationId: input.parentInvocationId,
    capabilityType: "agent",
    capabilityId: input.agentId,
    revisionId: b.agentRevisionId,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    selectionReasonCode: "preferred_agent_relevant",
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
    agentRevisionId: input.bindingCandidate.agentRevisionId,
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
    sourceType: row.sourceType as AgentCall["sourceType"],
    sourceRef: row.sourceRef,
    state: row.state as AgentCallState,
    agentSessionBindingId: row.agentSessionBindingId,
    sessionBinding: null,
    currentAttempt: null,
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

async function toAgentCallWithSession(
  client: Pick<typeof db, "select">,
  row: typeof agentCallTable.$inferSelect,
): Promise<AgentCall> {
  let call = toAgentCall(row);
  if (row.agentSessionBindingId) {
    const [session] = await client
      .select({
        id: agentSessionBindingTable.id,
        externalContextRef: agentSessionBindingTable.externalContextRef,
      })
      .from(agentSessionBindingTable)
      .where(
        and(
          eq(agentSessionBindingTable.id, row.agentSessionBindingId),
          eq(agentSessionBindingTable.tenantId, row.tenantId),
        ),
      )
      .limit(1);
    call = { ...call, sessionBinding: session ?? null };
  }
  const attemptRows = await client
    .select()
    .from(agentCallAttemptTable)
    .where(
      and(
        eq(agentCallAttemptTable.callId, row.id),
        eq(agentCallAttemptTable.tenantId, row.tenantId),
      ),
    )
    .orderBy(desc(agentCallAttemptTable.attemptNo));
  const activeAttempts = attemptRows.filter(
    (attempt) => !isAgentCallAttemptTerminal(attempt.attemptState),
  );
  if (activeAttempts.length > 1) {
    throw new AgentCallAttemptConflictError(row.id, "存在多个活动 Attempt");
  }
  const current = activeAttempts[0] ?? attemptRows[0] ?? null;
  return {
    ...call,
    currentAttempt: current
      ? {
          id: current.id,
          attemptNo: current.attemptNo,
          externalTaskRef: current.externalTaskRef,
          transportChannel: current.transportChannel,
        }
      : null,
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
    ...(row.enterpriseUserContextJson
      ? {
          enterpriseUserContext:
            row.enterpriseUserContextJson as AgentCallBindingConfigInput["enterpriseUserContext"],
        }
      : {}),
  };
}

function toAttempt(row: typeof agentCallAttemptTable.$inferSelect): AgentCallAttempt {
  return {
    id: row.id,
    callId: row.callId,
    tenantId: row.tenantId,
    attemptNo: row.attemptNo,
    attemptState: row.attemptState,
    dispatchAttemptCount: row.dispatchAttemptCount,
    retryReasonCode: row.retryReasonCode,
    externalTaskRef: row.externalTaskRef,
    transportChannel: row.transportChannel,
    transportMetadata: row.transportMetadataJson,
    requestDigest: row.requestDigest,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorCode: row.errorCode,
    errorSummary: row.errorSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
