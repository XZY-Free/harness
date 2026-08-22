/**
 * POST /gateway/v1/tool-calls — Tool Gateway 正式执行链（关口02 02-6 · 冻结方案 §14 / §15 / §16 / §18 / §P6 / §55.5）。
 *
 * Runtime 表达「我要调用哪个 Tool」，SnowHarness 决定 allow / pause / block（§3 根本 Authority）。
 *
 * 流程（§16）：
 * 1. resolveWorkloadPrincipal(headers, "gateway") → tenantId + invocationId（Authority）。
 * 2. body.invocation_id 仅协议一致性校验（== token.invocationId）。
 * 3. Tool Schema / operation_id 验证；schema_hash 与 current Revision 不一致 → 409 TOOL_SCHEMA_CHANGED。
 * 4. arguments 脱敏 + hash；创建或幂等取得 ToolCall(callState=proposed)（§16.2）。
 * 5. §16.3 同一 Application Transaction：
 *    SELECT ToolCall FOR UPDATE → 读 Invocation / ExecutionBinding → 校验 tenant/invocation/toolCall
 *    → 读 Binding.policyRevisionId → 读该精确 Revision 的 Policy rows → 重算 rulesHash
 *    → == Binding.policyRulesDigest（否则 fail-closed 不评估）→ Formal Policy Evaluator
 *    → ToolCall 行锁分配 decisionSequence → INSERT PermissionDecision。
 * 6. 三路（§18）：
 *    - allow → ToolCall proposed → running（授权执行；Executor 后置）。
 *    - block → ToolCall proposed → cancelled，errorCode=POLICY_BLOCKED，不建 UAR。
 *    - pause + Turn → ToolCall paused + UAR(confirmation/tool_permission_confirmation) + Invocation waiting_user。
 *    - pause + Job → ToolCall cancelled，errorCode=POLICY_REQUIRES_PREAUTH，不建 UAR（§18.4）。
 *
 * 幂等：同 (toolId, operationId) 同 arguments_hash → 同一 ToolCall（已评估则返回其状态，不重复评估）。
 * 不同 arguments_hash → 409 OPERATION_PAYLOAD_CONFLICT。
 *
 * 错误映射：
 * - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 * - 请求体非法 / body.invocation_id 不一致 → 400 REQUEST_SCHEMA_INVALID
 * - Tool 不存在/跨租户 → 404 CAPABILITY_NOT_ALLOWED
 * - Tool 未发布 SchemaRevision → 422 CAPABILITY_CONTENT_BLOCKED
 * - schema_hash 不一致 → 409 TOOL_SCHEMA_CHANGED（retryable）
 * - 同 operation_id 不同 arguments → 409 OPERATION_PAYLOAD_CONFLICT
 * - Policy digest 不一致 → 409 POLICY_INTEGRITY_MISMATCH（fail-closed）
 * - block → 403 POLICY_BLOCKED；Job pause → 403 POLICY_REQUIRES_PREAUTH
 */
import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import { redactArguments } from "@/lib/capability/redact-arguments";
import {
  type ToolCall,
  ToolCallConflictError,
  ToolCallSequenceConflictError,
  createToolCall,
  updateToolCallState,
} from "@/lib/capability/tool-call-queries";
import { getCurrentToolSchemaRevision, getToolById } from "@/lib/capability/tool-queries";
import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewayCapabilityContentBlockedTable,
  gatewayCapabilityNotAllowedTable,
  gatewaySchemaInvalidTable,
  gatewayToolSchemaChangedTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
import { REQUEST_ID_HEADER, apiError, apiSuccess, getRequestId } from "@/lib/http";
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
import type { PermissionDecision } from "@/lib/persistence/schema/permission";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";

export const dynamic = "force-dynamic";

/** 请求体（§5.1）。 */
interface ToolCallBody {
  invocation_id: string;
  tool_id: string;
  schema_hash: string;
  operation_id: string;
  arguments: Record<string, unknown>;
}

function parseBody(raw: unknown): ToolCallBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  for (const key of ["invocation_id", "tool_id", "schema_hash", "operation_id"] as const) {
    if (typeof o[key] !== "string" || (o[key] as string).length === 0) return null;
  }
  if (typeof o.arguments !== "object" || o.arguments === null || Array.isArray(o.arguments)) {
    return null;
  }
  return {
    invocation_id: o.invocation_id as string,
    tool_id: o.tool_id as string,
    schema_hash: o.schema_hash as string,
    operation_id: o.operation_id as string,
    arguments: o.arguments as Record<string, unknown>,
  };
}

/** 冻结 Policy rows → Evaluator 规则视图。 */
function toRuleViews(
  rules: {
    ruleKey: string;
    toolPattern: string;
    argMatcherJson: unknown;
    decision: "allow" | "pause" | "block";
    scopeJson: unknown;
    priority: number;
  }[],
): PolicyRuleView[] {
  return rules.map((r) => ({
    ruleKey: r.ruleKey,
    toolPattern: r.toolPattern,
    argMatcher: (r.argMatcherJson as PolicyRuleView["argMatcher"]) ?? null,
    decision: r.decision,
    scope: (r.scopeJson as PolicyRuleView["scope"]) ?? null,
    priority: r.priority,
  }));
}

/** §16.3 权限事务结果（三路 / 幂等重放 判别联合）。 */
type PermissionOutcome =
  | {
      kind: "decision";
      toolCall: ToolCall;
      decision: PermissionDecision;
      decisionValue: "allow" | "pause" | "block";
      isJob: boolean;
      /** pause 路径：关联的 UserActionRequest id（新建或幂等重放既有），否则 null。 */
      userActionRequestId: string | null;
    }
  | { kind: "replay"; toolCall: ToolCall };

/** 幂等重放响应体。 */
function replayBody(toolCall: ToolCall, latestDecision: PermissionDecision | null) {
  return {
    tool_call_id: toolCall.id,
    call_state: toolCall.callState,
    decision: latestDecision?.decision ?? null,
    decision_sequence: latestDecision?.decisionSequence ?? null,
    schema_revision_id: toolCall.toolSchemaRevisionId,
    result: null,
    effect: null,
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 身份（Authority = WorkloadPrincipal）。
  let principal: GatewayPrincipal;
  try {
    principal = await resolveGatewayPrincipal(request.headers);
  } catch (err) {
    const authResp = gatewayAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }
  const { tenantId, invocationId } = principal;

  // 2. 解析 + 校验 body。
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return gatewaySchemaInvalidTable(requestId, "请求体必须是合法 JSON");
  }
  const body = parseBody(rawBody);
  if (!body) {
    return gatewaySchemaInvalidTable(
      requestId,
      "请求体缺少必填字段（invocation_id/tool_id/schema_hash/operation_id/arguments）",
    );
  }
  // body.invocation_id 仅协议一致性校验（§16.1）。
  if (body.invocation_id !== invocationId) {
    return gatewaySchemaInvalidTable(requestId, "body.invocation_id 与 Workload Token 不一致");
  }

  // 3. Tool + Schema 验证（§16.2）。
  const tool = await getToolById({ tenantId, toolId: body.tool_id });
  if (!tool) {
    return gatewayCapabilityNotAllowedTable(requestId, `Tool 不存在或无权访问: ${body.tool_id}`);
  }
  const schemaRevision = await getCurrentToolSchemaRevision({ tenantId, toolId: body.tool_id });
  if (!schemaRevision) {
    return gatewayCapabilityContentBlockedTable(
      requestId,
      `Tool ${body.tool_id} 当前未发布 SchemaRevision`,
    );
  }
  if (schemaRevision.schemaHash !== body.schema_hash) {
    return gatewayToolSchemaChangedTable(
      requestId,
      "schema_hash 与当前 SchemaRevision 不一致，请重新读取目录",
      {
        schema_hash: schemaRevision.schemaHash,
      },
    );
  }

  // 4. 脱敏 + hash（§16.2）。
  const argumentsRedacted = redactArguments(body.arguments);

  // 5. §16.3 Permission 事务。
  // 并发同 (toolId, operationId) 时，输家事务可能因 UNIQUE(invocationId, callSequence) ER_DUP_ENTRY
  // 而抛 ToolCallSequenceConflictError（REPEATABLE READ 下看不到未提交的赢家行）。这是瞬态竞争：
  // 重试整个事务，赢家提交后即可经幂等回查命中同一 ToolCall（callState!=proposed）→ 幂等重放，不重复决策。
  let outcome: PermissionOutcome;
  let attempts = 0;
  for (;;) {
    try {
      outcome = await db.transaction(async (tx) => {
        const invocation = await getInvocationById(tenantId, invocationId, tx);
        if (!invocation) {
          throw new Error("GATEWAY_INVOCATION_MISSING");
        }

        const binding = await getExecutionBindingByInvocation(tenantId, invocationId, tx);
        if (!binding) {
          throw new Error("GATEWAY_BINDING_MISSING");
        }

        // 读 Binding 冻结的精确 Revision；重算 digest == Binding.policyRulesDigest（否则 fail-closed）。
        const frozen = await loadFrozenPolicyRevision(
          tx,
          tenantId,
          binding.policyRevisionId,
          POLICY_SET_KEY,
        );
        const recomputed = computePolicyRulesHash(
          frozen.defaultDecision,
          frozen.rules.map((r) => ({
            ruleKey: r.ruleKey,
            toolPattern: r.toolPattern,
            argMatcher: (r.argMatcherJson as unknown) ?? null,
            decision: r.decision,
            scope: r.scopeJson,
            priority: r.priority,
            reason: r.reason,
          })),
        );
        if (recomputed !== binding.policyRulesDigest) {
          throw new Error("GATEWAY_POLICY_DIGEST_MISMATCH");
        }

        // 创建或幂等取得 ToolCall（§16.2；§16.3 同事务）。
        const toolCall = await createToolCall(
          {
            tenantId,
            invocationId,
            threadId: invocation.threadId,
            turnId: invocation.turnId,
            jobId: invocation.jobId,
            toolId: tool.id,
            toolSchemaRevisionId: schemaRevision.id,
            schemaHash: schemaRevision.schemaHash,
            operationId: body.operation_id,
            argumentsRedactedJson: argumentsRedacted,
          },
          tx,
        );

        const isJob = invocation.jobId != null;

        // 幂等重放：running/终态（非 proposed 非 paused）→ 不重复评估，返回其状态。
        if (toolCall.callState !== "proposed" && toolCall.callState !== "paused") {
          return { kind: "replay" as const, toolCall };
        }

        // Agent 更严要求（immutable Revision）。
        let agentRequirements: { toolRiskMax?: string | null } | null = null;
        if (binding.agentRevisionId) {
          const agentRevision = await getRevisionById(binding.agentRevisionId);
          const req = (agentRevision?.permissionRequirementsJson ?? {}) as {
            tool_risk_max?: string | null;
          };
          if (req.tool_risk_max) {
            agentRequirements = { toolRiskMax: req.tool_risk_max };
          }
        }

        // Formal Policy Evaluator（纯函数）。
        const evaluation = evaluatePolicy({
          toolKey: `tool.${tool.toolKey}`,
          arguments: argumentsRedacted,
          toolRiskClass: tool.riskClass,
          scopeContext: { threadId: invocation.threadId, projectId: null, skillId: null },
          defaultDecision: frozen.defaultDecision,
          rules: toRuleViews(frozen.rules),
          agentRequirements,
          grantScopes: [], // P6/P7：Invocation 维度无 user 身份可解析 Grant；留 P8 接线。
        });

        // paused 重提交（§20.1 / §20.2）：员工已 approve 的 pause 一次性确认可升级为 allow。
        if (toolCall.callState === "paused") {
          const latest = await getLatestPermissionDecision(tenantId, toolCall.id, tx);
          if (latest && latest.decision === "pause") {
            const uar = await getUserActionRequestByPermissionDecisionId(tenantId, latest.id, tx);
            // §20.1：一次性确认仅在 4 个事实未变时有效 —— ToolCall.id 相同（本分支前提）、
            // argumentsHash 未变（createToolCall 幂等已保证）、UAR approve、
            // policyRevisionId 未变（Binding 冻结值必须等于 pause Decision 时的值）。
            const approved =
              uar !== null &&
              uar.requestState === "resolved" &&
              uar.resolution === "approve" &&
              latest.policyRevisionId === binding.policyRevisionId;
            if (approved) {
              // §20.2：approve 不能绕过 block。重估为 block → 追加 block + paused → cancelled。
              if (evaluation.decision === "block") {
                const decision = await recordPermissionDecision(
                  {
                    tenantId,
                    toolCallId: toolCall.id,
                    decision: "block",
                    policyRevisionId: binding.policyRevisionId,
                    reasonCodes: evaluation.reasonCodes,
                    riskSummary: evaluation.riskSummary,
                    decisionSummary: evaluation.decisionSummary,
                    decidedBy: "policy_engine",
                  },
                  { tx },
                );
                const updatedToolCall = await updateToolCallState(
                  {
                    tenantId,
                    toolCallId: toolCall.id,
                    toState: "cancelled",
                    errorCode: "POLICY_BLOCKED",
                  },
                  tx,
                );
                return {
                  kind: "decision" as const,
                  toolCall: updatedToolCall,
                  decision,
                  decisionValue: "block" as const,
                  isJob,
                  userActionRequestId: null,
                };
              }
              // §20.1：有效确认 → pause → allow，追加 allow + paused → running（执行）。
              const decision = await recordPermissionDecision(
                {
                  tenantId,
                  toolCallId: toolCall.id,
                  decision: "allow",
                  policyRevisionId: binding.policyRevisionId,
                  reasonCodes: evaluation.reasonCodes,
                  riskSummary: evaluation.riskSummary,
                  decisionSummary: evaluation.decisionSummary,
                  decidedBy: "policy_engine",
                },
                { tx },
              );
              const updatedToolCall = await updateToolCallState(
                { tenantId, toolCallId: toolCall.id, toState: "running" },
                tx,
              );
              return {
                kind: "decision" as const,
                toolCall: updatedToolCall,
                decision,
                decisionValue: "allow" as const,
                isJob,
                userActionRequestId: null,
              };
            }
            // UAR 仍 pending（未 approve）→ 幂等 pause 重放：返回既有 paused 状态 + 既有 UAR，
            // 不重复建 UAR（§47.3 UNIQUE(permissionDecisionId) 之外，不再新建 pause 决策）。
            if (uar && uar.requestState === "pending") {
              return {
                kind: "decision" as const,
                toolCall,
                decision: latest,
                decisionValue: "pause" as const,
                isJob: false,
                userActionRequestId: uar.id ?? null,
              };
            }
            // 确认已解析但 policyRevisionId 已变 → approval 失效（§20.2 fail-closed），
            // 落入正常重估：按新 Binding 冻结 Policy 重新 allow/pause/block。
          }
          // 无 pause 决策（异常）→ 落入正常重估。
        }

        // 记录 PermissionDecision（Tx-aware，ToolCall 行锁分配 decisionSequence）。
        const decision = await recordPermissionDecision(
          {
            tenantId,
            toolCallId: toolCall.id,
            decision: evaluation.decision,
            policyRevisionId: binding.policyRevisionId,
            reasonCodes: evaluation.reasonCodes,
            riskSummary: evaluation.riskSummary,
            decisionSummary: evaluation.decisionSummary,
            decidedBy: "policy_engine",
          },
          { tx },
        );

        // 三路状态迁移（§18）。
        let toState: "running" | "paused" | "cancelled";
        let errorCode: string | undefined;
        let userActionRequestId: string | null = null;
        if (evaluation.decision === "allow") {
          toState = "running";
        } else if (evaluation.decision === "pause") {
          if (isJob) {
            toState = "cancelled";
            errorCode = "POLICY_REQUIRES_PREAUTH";
          } else {
            toState = "paused";
            // 同事务建 UAR + Invocation → waiting_user（§55.7：PermissionDecision 成功后 UAR 失败全 rollback）。
            userActionRequestId = await createTurnPauseUserActionTx(tx, {
              tenantId,
              invocationId,
              invocation,
              toolCall,
              decision,
            });
          }
        } else {
          toState = "cancelled";
          errorCode = "POLICY_BLOCKED";
        }

        const updatedToolCall = await updateToolCallState(
          { tenantId, toolCallId: toolCall.id, toState, errorCode },
          tx,
        );

        return {
          kind: "decision" as const,
          toolCall: updatedToolCall,
          decision,
          decisionValue: evaluation.decision,
          isJob,
          userActionRequestId,
        };
      });
      break;
    } catch (err) {
      // 瞬态并发竞争：重试（赢家提交后经幂等回查命中现有 ToolCall → 幂等重放）。
      if (err instanceof ToolCallSequenceConflictError && attempts < 3) {
        attempts += 1;
        continue;
      }
      return mapGatewayError(err, requestId);
    }
  }

  // 幂等重放（已评估过的 ToolCall → 返回其现有最新决策，不重复评估）。
  if (outcome.kind === "replay") {
    const latest = await getLatestPermissionDecision(tenantId, outcome.toolCall.id);
    return apiSuccess(replayBody(outcome.toolCall, latest), {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  }

  // 三路响应（§18）。
  if (outcome.decisionValue === "block") {
    return apiError("POLICY_BLOCKED", "Tool 调用被策略阻止", {
      requestId,
      details: { tool_call_id: outcome.toolCall.id },
    });
  }
  if (outcome.decisionValue === "pause") {
    if (outcome.isJob) {
      return apiError(
        "POLICY_REQUIRES_PREAUTH",
        "Job 未预授权：调度前必须准备 Grant/授权/更明确 Policy",
        {
          requestId,
          details: { tool_call_id: outcome.toolCall.id },
        },
      );
    }
    // Turn pause：UAR 已在 §16.3 事务内创建（或幂等重放既有 pending UAR）。
    return apiSuccess(
      {
        tool_call_id: outcome.toolCall.id,
        call_state: outcome.toolCall.callState,
        decision: "pause",
        decision_sequence: outcome.decision.decisionSequence,
        schema_revision_id: outcome.toolCall.toolSchemaRevisionId,
        user_action_request_id: outcome.userActionRequestId,
        result: null,
        effect: null,
      },
      { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  }

  // allow。
  return apiSuccess(
    {
      tool_call_id: outcome.toolCall.id,
      call_state: outcome.toolCall.callState,
      decision: "allow",
      decision_sequence: outcome.decision.decisionSequence,
      schema_revision_id: outcome.toolCall.toolSchemaRevisionId,
      result: null,
      effect: null,
    },
    { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}

/** §16.3 事务回调的事务句柄类型（与 invocation-queries 的 `Tx` 同源）。 */
type GatewayTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface TurnPauseContext {
  tenantId: string;
  invocationId: string;
  /** §16.3 事务内已加载的 Invocation（含 threadId / turnId / jobId）。 */
  invocation: NonNullable<Awaited<ReturnType<typeof getInvocationById>>>;
  toolCall: ToolCall;
  decision: PermissionDecision;
}

/**
 * Turn pause 的 UAR 创建（§18.3 / §19）：requestType=confirmation、
 * purpose=tool_permission_confirmation、permissionDecisionId=该 pause 决策、toolCallId 必填。
 * 返回新 UAR id。
 *
 * Tx-aware（§22 / §55.7）：与 PermissionDecision / ToolCall 状态迁移同事务；UAR 创建或
 * Invocation → waiting_user 任一步失败，整个 pause 决策全部 rollback。
 */
async function createTurnPauseUserActionTx(tx: GatewayTx, ctx: TurnPauseContext): Promise<string> {
  const invocation = ctx.invocation;
  if (!invocation?.threadId || !invocation.turnId) {
    throw new Error("GATEWAY_PAUSE_NO_THREAD");
  }
  const result = await createUserActionRequest(
    {
      tenantId: ctx.tenantId,
      threadId: invocation.threadId,
      turnId: invocation.turnId,
      invocationId: ctx.invocationId,
      toolCallId: ctx.toolCall.id,
      requestType: "confirmation",
      purpose: TOOL_PERMISSION_CONFIRMATION_PURPOSE,
      permissionDecisionId: ctx.decision.id,
      promptJson: {
        tool_id: ctx.toolCall.toolId,
        operation_id: ctx.toolCall.operationId,
        decision: "pause",
        decision_summary: ctx.decision.decisionSummary,
      },
    },
    { tx },
  );

  // Invocation → waiting_user（§18.3；与 UAR 同事务）。
  await updateInvocationState(tx, ctx.tenantId, ctx.invocationId, "waiting_user");

  return result.request.id;
}

/** 把 §16.3 事务抛出的已知错误映射为 Gateway 响应。 */
function mapGatewayError(err: unknown, requestId: string): Response {
  if (err instanceof ToolCallConflictError) {
    return apiError("OPERATION_PAYLOAD_CONFLICT", "同 operation_id 已存在但 arguments 不同", {
      requestId,
      details: { operation_id: err.operationId },
    });
  }
  const message = err instanceof Error ? err.message : "内部错误";
  switch (message) {
    case "GATEWAY_INVOCATION_MISSING":
      return apiError("CAPABILITY_NOT_ALLOWED", "Invocation 不存在或无权访问", { requestId });
    case "GATEWAY_BINDING_MISSING":
      return apiError("CAPABILITY_NOT_ALLOWED", "ExecutionBinding 不存在", { requestId });
    case "GATEWAY_POLICY_DIGEST_MISMATCH":
      return apiError("POLICY_INTEGRITY_MISMATCH", "Policy digest 不一致（fail-closed，未评估）", {
        requestId,
      });
    case "GATEWAY_PAUSE_NO_THREAD":
      return apiError("POLICY_REQUIRES_PREAUTH", "Turn pause 缺少 thread/turn 上下文", {
        requestId,
      });
    default:
      if (isPolicyLoadError(err)) {
        return apiError("POLICY_INTEGRITY_MISMATCH", "冻结 PolicyRevision 不可读", { requestId });
      }
      // 未知错误 → 让上层（Next）返回 500；fail-closed 不泄露内部细节。
      throw err;
  }
}

function isPolicyLoadError(err: unknown): boolean {
  return (
    err instanceof Error &&
    ("code" in err ? (err as { code?: string }).code === "POLICY_LOAD_FAILED" : false)
  );
}
