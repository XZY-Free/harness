import { isDeepStrictEqual } from "node:util";
import { redactArguments } from "@/lib/capability/redact-arguments";
import {
  type ToolCall,
  ToolCallSequenceConflictError,
  createToolCall,
  updateToolCallState,
} from "@/lib/capability/tool-call-queries";
import {
  computeToolExecutionContractDigest,
  parseToolExecutionContract,
} from "@/lib/capability/tool-execution-contract";
import { createToolExecutionBinding } from "@/lib/capability/tool-execution-queries";
import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { computePolicyRulesHash } from "@/lib/identity/tenant-bootstrap";
import {
  getLatestPermissionDecision,
  recordPermissionDecision,
} from "@/lib/permission/permission-queries";
import { type PolicyRuleView, evaluatePolicy } from "@/lib/permission/policy-evaluator";
import { POLICY_SET_KEY, loadFrozenPolicyRevision } from "@/lib/permission/policy-queries";
import {
  TOOL_PERMISSION_CONFIRMATION_PURPOSE,
  createUserActionRequest,
  getUserActionRequestByPermissionDecisionId,
} from "@/lib/permission/user-action-queries";
import { turnTable } from "@/lib/persistence/schema/conversation";
import type { PermissionDecision } from "@/lib/persistence/schema/permission";
import {
  connectionTable,
  credentialRefTable,
  toolProviderTable,
  toolSchemaRevisionTable,
  toolTable,
} from "@/lib/persistence/schema/tool";
import { verifyCapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import {
  type ExecutionSubject,
  recoverTrustedExecutionSubject,
} from "@/lib/runtime/transport/execution-subject";
import Ajv from "ajv";
import { and, desc, eq, sql } from "drizzle-orm";

export interface ApplyToolCallInput {
  tenantId: string;
  invocationId: string;
  executionSubject: ExecutionSubject;
  toolId: string;
  toolSchemaRevisionId: string;
  schemaHash: string;
  operationId: string;
  arguments: Record<string, unknown>;
}

export interface ApplyToolCallResult {
  toolCall: ToolCall;
  decision: PermissionDecision | null;
  userActionRequestId: string | null;
  replay: boolean;
}

export class ToolApplicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolApplicationError";
  }
}

export async function applyToolCall(input: ApplyToolCallInput): Promise<ApplyToolCallResult> {
  let retries = 0;
  for (;;) {
    try {
      return await db.transaction((tx) => applyToolCallTx(tx, input));
    } catch (error) {
      if (error instanceof ToolCallSequenceConflictError && retries < 3) {
        retries += 1;
        continue;
      }
      throw error;
    }
  }
}

type ApplicationTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function applyToolCallTx(
  tx: ApplicationTx,
  input: ApplyToolCallInput,
): Promise<ApplyToolCallResult> {
  const invocation = await getInvocationById(input.tenantId, input.invocationId, tx);
  if (!invocation) throw new ToolApplicationError("INVOCATION_MISSING", "Invocation 不存在");
  const invocationBinding = await getExecutionBindingByInvocation(
    input.tenantId,
    input.invocationId,
    tx,
  );
  if (!invocationBinding) {
    throw new ToolApplicationError("EXECUTION_BINDING_MISSING", "ExecutionBinding 不存在");
  }
  const subject = recoverTrustedExecutionSubject(invocationBinding, input.tenantId);
  if (
    subject.tenantId !== input.executionSubject.tenantId ||
    subject.subjectType !== input.executionSubject.subjectType ||
    subject.subjectId !== input.executionSubject.subjectId
  ) {
    throw new ToolApplicationError("EXECUTION_SUBJECT_MISMATCH", "执行主体与冻结 Binding 不一致");
  }
  const catalog = verifyCapabilityCatalogSnapshot(
    invocationBinding.capabilityCatalogJson,
    invocationBinding.capabilityCatalogDigest,
  );
  if (catalog.invocationId !== input.invocationId) {
    throw new ToolApplicationError("CAPABILITY_CATALOG_MISMATCH", "能力目录不属于当前 Invocation");
  }
  const catalogTool = catalog.tools.find(
    (tool) =>
      tool.toolId === input.toolId &&
      tool.schemaRevisionId === input.toolSchemaRevisionId &&
      tool.schemaHash === input.schemaHash,
  );
  if (!catalogTool) {
    throw new ToolApplicationError("TOOL_NOT_IN_FROZEN_CATALOG", "Tool 不在冻结能力目录");
  }
  validateArguments(catalogTool.inputSchema, input.arguments);
  const redactedArguments = redactArguments(input.arguments);
  if (!isDeepStrictEqual(redactedArguments, input.arguments)) {
    throw new ToolApplicationError(
      "TOOL_ARGUMENTS_SENSITIVE",
      "Tool arguments 不允许携带 credential 或 secret 字段",
    );
  }

  const [facts] = await tx
    .select({
      tool: toolTable,
      revision: toolSchemaRevisionTable,
      provider: toolProviderTable,
      connection: connectionTable,
    })
    .from(toolTable)
    .innerJoin(
      toolSchemaRevisionTable,
      and(
        eq(toolSchemaRevisionTable.id, input.toolSchemaRevisionId),
        eq(toolSchemaRevisionTable.toolId, toolTable.id),
      ),
    )
    .innerJoin(toolProviderTable, eq(toolProviderTable.id, toolTable.providerId))
    .leftJoin(connectionTable, eq(connectionTable.id, toolProviderTable.connectionId))
    .where(
      and(
        eq(toolTable.tenantId, input.tenantId),
        eq(toolTable.id, input.toolId),
        eq(toolSchemaRevisionTable.revisionState, "published"),
        eq(toolProviderTable.tenantId, input.tenantId),
      ),
    )
    .limit(1);
  if (
    !facts ||
    facts.tool.lifecycleState !== "enabled" ||
    facts.provider.lifecycleState !== "enabled"
  ) {
    throw new ToolApplicationError("TOOL_UNAVAILABLE", "Tool 或 Provider 不可执行");
  }
  if (facts.revision.schemaHash !== input.schemaHash) {
    throw new ToolApplicationError("TOOL_SCHEMA_INTEGRITY_MISMATCH", "Schema 摘要与冻结目录不一致");
  }
  validateArguments(asRecord(facts.revision.inputSchemaJson), input.arguments);
  const executorKind = executorKindFor(facts.provider.providerType);
  if (!executorKind) {
    throw new ToolApplicationError(
      "PROVIDER_EXECUTOR_UNAVAILABLE",
      "Provider 没有 production executor",
    );
  }
  if (
    facts.provider.providerType === "webhook" &&
    (!facts.connection ||
      facts.connection.lifecycleState !== "enabled" ||
      !facts.connection.endpointRef)
  ) {
    throw new ToolApplicationError("PROVIDER_CONNECTION_UNAVAILABLE", "Webhook Connection 不可用");
  }
  const executionContract = parseToolExecutionContract(facts.revision.executionContractJson);
  if (
    computeToolExecutionContractDigest(executionContract) !==
      facts.revision.executionContractDigest ||
    facts.revision.executionContractDigest !== catalogTool.executionContractDigest
  ) {
    throw new ToolApplicationError(
      "TOOL_EXECUTION_CONTRACT_MISMATCH",
      "执行合同摘要与冻结目录不一致",
    );
  }
  if (facts.connection && !["none", "bearer"].includes(facts.connection.authMethod)) {
    throw new ToolApplicationError(
      "PROVIDER_AUTH_UNSUPPORTED",
      "Webhook Connection 的 authMethod 没有 production resolver",
    );
  }
  const frozenPolicy = await loadFrozenPolicyRevision(
    tx,
    input.tenantId,
    invocationBinding.policyRevisionId,
    POLICY_SET_KEY,
  );
  const recomputedPolicyDigest = computePolicyRulesHash(
    frozenPolicy.defaultDecision,
    frozenPolicy.rules.map((rule) => ({
      ruleKey: rule.ruleKey,
      toolPattern: rule.toolPattern,
      argMatcher: rule.argMatcherJson,
      decision: rule.decision,
      scope: rule.scopeJson,
      priority: rule.priority,
      reason: rule.reason,
    })),
  );
  if (recomputedPolicyDigest !== invocationBinding.policyRulesDigest) {
    throw new ToolApplicationError("POLICY_INTEGRITY_MISMATCH", "冻结 Policy digest 不一致");
  }

  let toolCall = await createToolCall(
    {
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      threadId: invocation.threadId,
      turnId: invocation.turnId,
      jobId: invocation.jobId,
      toolId: input.toolId,
      toolSchemaRevisionId: input.toolSchemaRevisionId,
      schemaHash: input.schemaHash,
      operationId: input.operationId,
      argumentsRedactedJson: redactedArguments,
    },
    tx,
  );
  if (toolCall.callState !== "proposed" && toolCall.callState !== "paused") {
    return {
      toolCall,
      decision: await getLatestPermissionDecision(input.tenantId, toolCall.id, tx),
      userActionRequestId: null,
      replay: true,
    };
  }

  const evaluation = evaluatePolicy({
    toolKey: `tool.${facts.tool.toolKey}`,
    arguments: input.arguments,
    toolRiskClass: facts.tool.riskClass,
    scopeContext: { threadId: invocation.threadId, projectId: null, skillId: null },
    defaultDecision: frozenPolicy.defaultDecision,
    rules: toRuleViews(frozenPolicy.rules),
    agentRequirements: null,
    grantScopes: [],
  });
  let approvedPause = false;
  if (toolCall.callState === "paused") {
    const latest = await getLatestPermissionDecision(input.tenantId, toolCall.id, tx);
    if (latest?.decision === "pause") {
      const request = await getUserActionRequestByPermissionDecisionId(
        input.tenantId,
        latest.id,
        tx,
      );
      if (request?.requestState === "pending") {
        return { toolCall, decision: latest, userActionRequestId: request.id, replay: true };
      }
      if (request?.resolution !== "approve") {
        toolCall = await updateToolCallState(
          {
            tenantId: input.tenantId,
            toolCallId: toolCall.id,
            toState: "cancelled",
            errorCode: "USER_DENIED",
          },
          tx,
        );
        return {
          toolCall,
          decision: latest,
          userActionRequestId: request?.id ?? null,
          replay: false,
        };
      }
      approvedPause = true;
    }
  }

  const approvalOverride = approvedPause && evaluation.decision === "pause";
  const effectiveDecision = approvalOverride ? "allow" : evaluation.decision;

  const decision = await recordPermissionDecision(
    {
      tenantId: input.tenantId,
      toolCallId: toolCall.id,
      decision: effectiveDecision,
      policyRevisionId: invocationBinding.policyRevisionId,
      reasonCodes: approvalOverride
        ? [...evaluation.reasonCodes, "USER_APPROVED"]
        : evaluation.reasonCodes,
      riskSummary: evaluation.riskSummary,
      decisionSummary: approvalOverride
        ? `用户确认后执行：${evaluation.decisionSummary}`
        : evaluation.decisionSummary,
      decidedBy: approvalOverride ? "user_action" : "policy_engine",
    },
    { tx },
  );
  if (effectiveDecision === "block") {
    toolCall = await updateToolCallState(
      {
        tenantId: input.tenantId,
        toolCallId: toolCall.id,
        toState: "cancelled",
        errorCode: "POLICY_BLOCKED",
      },
      tx,
    );
    return { toolCall, decision, userActionRequestId: null, replay: false };
  }
  if (effectiveDecision === "pause" && invocation.jobId) {
    toolCall = await updateToolCallState(
      {
        tenantId: input.tenantId,
        toolCallId: toolCall.id,
        toState: "cancelled",
        errorCode: "POLICY_REQUIRES_PREAUTH",
      },
      tx,
    );
    return { toolCall, decision, userActionRequestId: null, replay: false };
  }
  if (effectiveDecision === "pause") {
    const requestId = await createPauseRequest(tx, invocation, toolCall, decision);
    toolCall = await updateToolCallState(
      { tenantId: input.tenantId, toolCallId: toolCall.id, toState: "paused" },
      tx,
    );
    return { toolCall, decision, userActionRequestId: requestId, replay: false };
  }

  const [credential] =
    facts.connection && facts.connection.authMethod !== "none"
      ? await tx
          .select()
          .from(credentialRefTable)
          .where(
            and(
              eq(credentialRefTable.tenantId, input.tenantId),
              eq(credentialRefTable.connectionId, facts.connection.id),
              eq(credentialRefTable.lifecycleState, "active"),
            ),
          )
          .orderBy(desc(credentialRefTable.createdAt))
          .limit(1)
      : [];
  if (facts.connection?.authMethod !== "none" && !credential) {
    throw new ToolApplicationError(
      "CREDENTIAL_UNAVAILABLE",
      "Connection 缺少 active CredentialRef",
    );
  }
  await createToolExecutionBinding(
    {
      tenantId: input.tenantId,
      toolCallId: toolCall.id,
      toolProviderId: facts.provider.id,
      providerType: facts.provider.providerType,
      connectionId: facts.connection?.id ?? null,
      authMethod: facts.connection?.authMethod ?? "none",
      endpointRef: facts.connection?.endpointRef ?? null,
      credentialRefId: credential?.id ?? null,
      executorKind,
      executionContractDigest: facts.revision.executionContractDigest,
    },
    tx,
  );
  toolCall = await updateToolCallState(
    { tenantId: input.tenantId, toolCallId: toolCall.id, toState: "queued" },
    tx,
  );
  return { toolCall, decision, userActionRequestId: null, replay: false };
}

function validateArguments(schema: Record<string, unknown>, args: Record<string, unknown>): void {
  try {
    const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
    if (!validate(args)) {
      throw new ToolApplicationError(
        "TOOL_ARGUMENTS_INVALID",
        JSON.stringify(validate.errors ?? []),
      );
    }
  } catch (error) {
    if (error instanceof ToolApplicationError) throw error;
    throw new ToolApplicationError("TOOL_SCHEMA_INVALID", "Tool Schema 无法编译");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolApplicationError("TOOL_SCHEMA_INVALID", "Tool Schema 不是对象");
  }
  return value as Record<string, unknown>;
}

function executorKindFor(providerType: string): string | null {
  return providerType === "webhook" ? "webhook.post_json" : null;
}

function toRuleViews(
  rules: Array<{
    ruleKey: string;
    toolPattern: string;
    argMatcherJson: unknown;
    decision: "allow" | "pause" | "block";
    scopeJson: unknown;
    priority: number;
  }>,
): PolicyRuleView[] {
  return rules.map((rule) => ({
    ruleKey: rule.ruleKey,
    toolPattern: rule.toolPattern,
    argMatcher: (rule.argMatcherJson as PolicyRuleView["argMatcher"]) ?? null,
    decision: rule.decision,
    scope: (rule.scopeJson as PolicyRuleView["scope"]) ?? null,
    priority: rule.priority,
  }));
}

async function createPauseRequest(
  tx: ApplicationTx,
  invocation: NonNullable<Awaited<ReturnType<typeof getInvocationById>>>,
  toolCall: ToolCall,
  decision: PermissionDecision,
): Promise<string> {
  if (!invocation.threadId || !invocation.turnId) {
    throw new ToolApplicationError("PAUSE_CONTEXT_MISSING", "Turn pause 缺少 thread/turn");
  }
  const created = await createUserActionRequest(
    {
      tenantId: invocation.tenantId,
      threadId: invocation.threadId,
      turnId: invocation.turnId,
      invocationId: invocation.id,
      toolCallId: toolCall.id,
      requestType: "confirmation",
      purpose: TOOL_PERMISSION_CONFIRMATION_PURPOSE,
      permissionDecisionId: decision.id,
      promptJson: {
        tool_id: toolCall.toolId,
        operation_id: toolCall.operationId,
        decision: "pause",
        decision_summary: decision.decisionSummary,
      },
    },
    { tx },
  );
  await updateInvocationState(tx, invocation.tenantId, invocation.id, "waiting_user");
  const turnUpdate = await tx
    .update(turnTable)
    .set({
      turnState: "waiting_user",
      waitingAt: new Date(),
      activeInvocationId: invocation.id,
      versionNo: sql`${turnTable.versionNo} + 1`,
    })
    .where(
      and(
        eq(turnTable.id, invocation.turnId),
        eq(turnTable.threadId, invocation.threadId),
        eq(turnTable.turnState, "running"),
        eq(turnTable.activeInvocationId, invocation.id),
      ),
    );
  if (turnUpdate[0].affectedRows !== 1) {
    throw new ToolApplicationError("TURN_STATE_INVALID", "Turn 状态无法进入 waiting_user");
  }
  return created.request.id;
}
