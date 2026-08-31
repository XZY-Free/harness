import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { ZodError } from "zod";
import { parseHarnessNextAction } from "./action-schema";
import {
  type AgentCallAction,
  HARNESS_ACTION_TYPES,
  type HarnessActionHistoryEntry,
  type HarnessActionType,
  type HarnessLoopLimits,
  type HarnessLoopRecoverySnapshot,
  type HarnessLoopView,
  type HarnessNextAction,
  type HarnessObservation,
  type KnowledgeSearchAction,
  type RequestUserInputAction,
  type ToolCallAction,
} from "./types";

export type {
  HarnessActionHistoryEntry,
  HarnessActionType,
  HarnessLoopLimits,
  HarnessLoopRecoverySnapshot,
  HarnessLoopView,
  HarnessNextAction,
  HarnessObservation,
} from "./types";

export const DEFAULT_HARNESS_LOOP_LIMITS: HarnessLoopLimits = Object.freeze({
  maxLoopSteps: 12,
  maxAgentCalls: 3,
  maxToolCalls: 8,
  maxKnowledgeSearches: 6,
  maxConsecutiveSameAction: 2,
});

export interface HarnessDecisionPort {
  decideNextAction(view: HarnessLoopView): Promise<unknown>;
}

export interface HarnessFinalResponsePort {
  generateFinalResponse(
    view: HarnessLoopView,
    emitDelta?: (delta: string) => Promise<void>,
  ): Promise<string>;
}

export interface HarnessLoopEventWriter {
  write(type: string, payload: Record<string, unknown>): Promise<void>;
}

export type HarnessActionExecutionResult =
  | {
      observation: HarnessObservation;
      authorityRef?: string;
      waitingForUser?: {
        requestType: "input";
        purpose: string;
        prompt: string;
        inputSchema: Record<string, unknown>;
      };
      pending?: never;
    }
  | {
      pending: {
        kind: "agent_call" | "tool_call";
        callId: string;
        state: "queued" | "running" | "waiting_user";
      };
      observation?: never;
      authorityRef?: string;
      waitingForUser?: never;
    };

export interface HarnessActionExecutionContext {
  invocationId: string;
  tenantId: string;
  threadId: string;
  turnId: string;
  actionDigest: string;
}

export interface HarnessActionExecutors {
  "knowledge.search"?: (
    action: KnowledgeSearchAction,
    context: HarnessActionExecutionContext,
  ) => Promise<HarnessActionExecutionResult>;
  "tool.call"?: (
    action: ToolCallAction,
    context: HarnessActionExecutionContext,
  ) => Promise<HarnessActionExecutionResult>;
  "agent.call"?: (
    action: AgentCallAction,
    context: HarnessActionExecutionContext,
  ) => Promise<HarnessActionExecutionResult>;
  request_user_input?: (
    action: RequestUserInputAction,
    context: HarnessActionExecutionContext,
  ) => Promise<HarnessActionExecutionResult>;
}

export interface HarnessLoopRecoveryPort {
  load(invocationId: string): Promise<HarnessLoopRecoverySnapshot>;
}

export interface HarnessLoopParams {
  invocationId: string;
  tenantId: string;
  threadId: string;
  turnId: string;
  objective: string;
  contextHandle?: string;
  authorizedKnowledgeSourceRefs?: string[];
  workspace?: { workspace_binding_id: string | null; workspace_type: string } | null;
  executionLimits?: Record<string, number>;
  traceContext?: { trace_id: string; span_id: string };
  capabilityDirectives?: Array<{
    capability_type: "agent";
    capability_id: string;
    mode: "preferred";
  }>;
  decisionPort: HarnessDecisionPort;
  finalResponsePort: HarnessFinalResponsePort;
  eventWriter: HarnessLoopEventWriter;
  executors: HarnessActionExecutors;
  recoveryPort?: HarnessLoopRecoveryPort;
  limits?: Partial<HarnessLoopLimits>;
  emitTextDelta?: (delta: string) => Promise<void>;
  modelRef: string;
}

export interface HarnessLoopResult {
  completed: boolean;
  pending?: boolean;
  waitingForUser?: boolean;
  responseText: string;
  errorCode?: string;
  failureReason?: string;
  observations: HarnessObservation[];
  actionHistory: HarnessActionHistoryEntry[];
}

export class HarnessLoopError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const EMPTY_RECOVERY: HarnessLoopRecoverySnapshot = {
  invocationState: "running",
  nextProducerSequence: 1,
  observations: [],
  actionHistory: [],
};

export class HarnessLoop {
  private readonly params: HarnessLoopParams;
  private readonly limits: HarnessLoopLimits;
  private observations: HarnessObservation[] = [];
  private actionHistory: HarnessActionHistoryEntry[] = [];

  constructor(params: HarnessLoopParams) {
    this.params = params;
    this.limits = { ...DEFAULT_HARNESS_LOOP_LIMITS };
    for (const [key, value] of Object.entries(params.limits ?? {})) {
      if (typeof value === "number") {
        (this.limits as unknown as Record<string, number>)[key] = value;
      }
    }
  }

  async run(): Promise<HarnessLoopResult> {
    try {
      const recovered = this.params.recoveryPort
        ? await this.params.recoveryPort.load(this.params.invocationId)
        : EMPTY_RECOVERY;
      this.observations = [...recovered.observations];
      this.actionHistory = [...recovered.actionHistory];
      if (recovered.invocationState === "waiting_user") {
        return {
          completed: false,
          waitingForUser: true,
          responseText: "",
          observations: [...this.observations],
          actionHistory: [...this.actionHistory],
        };
      }

      const unfinished = this.actionHistory.filter(
        (entry) =>
          entry.state === "proposed" ||
          entry.state === "started" ||
          (entry.state === "completed" &&
            entry.actionType !== "respond" &&
            entry.observation === undefined),
      );
      if (unfinished.length > 1) {
        throw new HarnessLoopError(
          "HARNESS_LOOP_STATE_RECOVERY_FAILED",
          "Harness Loop 存在多个未完成行动",
        );
      }
      if (unfinished[0]) {
        const recoveredResult = await this.executeAction(
          unfinished[0],
          unfinished[0].state === "proposed",
        );
        if (recoveredResult) return recoveredResult;
      }

      while (true) {
        const nextStepNo = this.nextStepNo();
        if (nextStepNo > this.limits.maxLoopSteps) {
          throw new HarnessLoopError(
            "HARNESS_LOOP_STEP_LIMIT_EXCEEDED",
            `Harness Loop 超过最大步骤数 ${this.limits.maxLoopSteps}`,
          );
        }

        const rawAction = await this.params.decisionPort.decideNextAction(this.buildView());
        let action: HarnessNextAction;
        try {
          action = parseHarnessNextAction(rawAction);
        } catch (error) {
          throw new HarnessLoopError(
            "HARNESS_ACTION_SCHEMA_INVALID",
            error instanceof ZodError
              ? error.issues.map((issue) => issue.message).join("; ")
              : String(error),
          );
        }
        this.validateAction(action, nextStepNo);

        const actionDigest = computeCanonicalDigest({
          actionType: action.actionType,
          payload: action.payload,
        });
        const targetRef = actionTargetRef(action);
        const historyEntry: HarnessActionHistoryEntry = {
          actionId: action.actionId,
          stepNo: action.stepNo,
          actionType: action.actionType,
          actionDigest,
          targetRef,
          purposeCode: action.purposeCode,
          shortPurpose: action.shortPurpose,
          action,
          state: "proposed",
        };
        this.actionHistory.push(historyEntry);
        await this.writeActionEvent("harness.action.proposed", historyEntry);

        const actionResult = await this.executeAction(historyEntry, true);
        if (actionResult) return actionResult;
      }
    } catch (error) {
      const current = this.actionHistory.at(-1);
      const explicitErrorCode = errorCode(error);
      const loopError =
        error instanceof HarnessLoopError
          ? error
          : new HarnessLoopError(
              current?.actionType === "knowledge.search"
                ? "KNOWLEDGE_ACTION_FAILED"
                : current?.actionType === "tool.call"
                  ? "TOOL_ACTION_FAILED"
                  : current?.actionType === "agent.call"
                    ? (explicitErrorCode ?? "AGENT_CALL_FAILED")
                    : current?.actionType === "respond"
                      ? "MODEL_EXECUTION_FAILED"
                      : "HARNESS_ACTION_EXECUTION_FAILED",
              errorMessage(error),
            );
      if (current?.state === "proposed" || current?.state === "started") {
        current.state = "failed";
        current.errorCode = loopError.code;
        await this.safeWriteActionFailed(current);
      }
      await this.safeWriteExecutionFailed(loopError);
      return {
        completed: false,
        responseText: "",
        errorCode: loopError.code,
        failureReason: loopError.message,
        observations: [...this.observations],
        actionHistory: [...this.actionHistory],
      };
    }
  }

  private async executeAction(
    historyEntry: HarnessActionHistoryEntry,
    writeStarted: boolean,
  ): Promise<HarnessLoopResult | null> {
    const action = historyEntry.action;
    if (action.actionType === "respond") {
      return await this.respond(action, historyEntry, writeStarted);
    }

    const executor = this.executorFor(action);
    if (!executor) {
      throw new HarnessLoopError(
        action.actionType === "agent.call"
          ? "AGENT_CALL_EXECUTOR_UNAVAILABLE"
          : "HARNESS_ACTION_EXECUTOR_UNAVAILABLE",
        `${action.actionType} 执行器未注册`,
      );
    }

    if (writeStarted) {
      historyEntry.state = "started";
      await this.writeActionEvent("harness.action.started", historyEntry);
    }
    const execution = await executor(action as never, {
      invocationId: this.params.invocationId,
      tenantId: this.params.tenantId,
      threadId: this.params.threadId,
      turnId: this.params.turnId,
      actionDigest: historyEntry.actionDigest,
    });
    if (execution.pending) {
      return {
        completed: false,
        pending: true,
        ...(execution.pending.state === "waiting_user" ? { waitingForUser: true } : {}),
        responseText: "",
        observations: [...this.observations],
        actionHistory: [...this.actionHistory],
      };
    }
    if (execution.waitingForUser) {
      await this.params.eventWriter.write("user_action.requested", {
        request_type: execution.waitingForUser.requestType,
        purpose: execution.waitingForUser.purpose,
        prompt: execution.waitingForUser.prompt,
        input_schema: execution.waitingForUser.inputSchema,
        action_id: action.actionId,
      });
    }
    historyEntry.state = "completed";
    historyEntry.authorityRef = execution.authorityRef;
    historyEntry.observation = execution.observation;
    this.observations.push(execution.observation);
    await this.writeActionEvent("harness.action.completed", historyEntry);

    if (execution.waitingForUser) {
      return {
        completed: false,
        waitingForUser: true,
        responseText: "",
        observations: [...this.observations],
        actionHistory: [...this.actionHistory],
      };
    }
    return null;
  }

  private async respond(
    action: Extract<HarnessNextAction, { actionType: "respond" }>,
    historyEntry: HarnessActionHistoryEntry,
    writeStarted = true,
  ): Promise<HarnessLoopResult> {
    if (writeStarted) {
      historyEntry.state = "started";
      await this.writeActionEvent("harness.action.started", historyEntry);
    }
    const responseText = await this.params.finalResponsePort.generateFinalResponse(
      this.buildView(),
      this.params.emitTextDelta,
    );
    if (!responseText.trim()) {
      throw new HarnessLoopError("MODEL_EXECUTION_FAILED", "最终正文为空");
    }
    await this.params.eventWriter.write("response.completed", {
      text: responseText,
      item_type: "assistant_message",
      model_ref: this.params.modelRef,
      finish_reason: "stop",
      evidence_refs: action.payload.evidenceRefs ?? [],
    });
    historyEntry.state = "completed";
    await this.writeActionEvent("harness.action.completed", historyEntry);
    await this.params.eventWriter.write("execution.completed", {
      finish_reason: "execution.completed",
    });
    return {
      completed: true,
      responseText,
      observations: [...this.observations],
      actionHistory: [...this.actionHistory],
    };
  }

  private validateAction(action: HarnessNextAction, expectedStepNo: number): void {
    if (action.stepNo !== expectedStepNo) {
      throw new HarnessLoopError(
        "HARNESS_ACTION_SCHEMA_INVALID",
        `action.stepNo=${action.stepNo}，期望 ${expectedStepNo}`,
      );
    }
    const duplicateId = this.actionHistory.find((entry) => entry.actionId === action.actionId);
    if (duplicateId) {
      throw new HarnessLoopError(
        "HARNESS_ACTION_SCHEMA_INVALID",
        `actionId 已存在：${action.actionId}`,
      );
    }
    if (action.actionType === "agent.call") {
      const preferredAgentId = this.preferredAgentId();
      if (!preferredAgentId || preferredAgentId !== action.payload.agentId) {
        throw new HarnessLoopError(
          "AGENT_ACTION_NOT_ALLOWED",
          `agent.call 目标不在本 Turn preferred AgentUseDirective 中：${action.payload.agentId}`,
        );
      }
    }
    if (
      action.actionType === "knowledge.search" &&
      action.payload.preferredSourceRefs?.some(
        (sourceRef) => !this.params.authorizedKnowledgeSourceRefs?.includes(sourceRef),
      )
    ) {
      throw new HarnessLoopError(
        "ACTION_SCOPE_DENIED",
        "knowledge.search 包含未授权 preferredSourceRefs",
      );
    }
    this.validateTypeBudget(action.actionType);
    this.validateConsecutiveRepeat(action);
  }

  private validateTypeBudget(actionType: HarnessActionType): void {
    const count = this.actionHistory.filter((entry) => entry.actionType === actionType).length;
    const limit =
      actionType === "agent.call"
        ? this.limits.maxAgentCalls
        : actionType === "tool.call"
          ? this.limits.maxToolCalls
          : actionType === "knowledge.search"
            ? this.limits.maxKnowledgeSearches
            : null;
    if (limit !== null && count >= limit) {
      throw new HarnessLoopError(
        "HARNESS_LOOP_STEP_LIMIT_EXCEEDED",
        `${actionType} 超过预算 ${limit}`,
      );
    }
  }

  private validateConsecutiveRepeat(action: HarnessNextAction): void {
    const actionDigest = computeCanonicalDigest({
      actionType: action.actionType,
      payload: action.payload,
    });
    const targetRef = actionTargetRef(action);
    let consecutive = 0;
    for (let index = this.actionHistory.length - 1; index >= 0; index -= 1) {
      const entry = this.actionHistory[index];
      if (!entry) break;
      if (
        entry.actionType !== action.actionType ||
        entry.targetRef !== targetRef ||
        entry.actionDigest !== actionDigest
      ) {
        break;
      }
      consecutive += 1;
    }
    if (consecutive >= this.limits.maxConsecutiveSameAction) {
      throw new HarnessLoopError(
        "HARNESS_LOOP_REPEATED_ACTION",
        `连续相同行动超过预算 ${this.limits.maxConsecutiveSameAction}`,
      );
    }
  }

  private executorFor(action: Exclude<HarnessNextAction, { actionType: "respond" }>) {
    return this.params.executors[action.actionType] as
      | ((
          action: never,
          context: HarnessActionExecutionContext,
        ) => Promise<HarnessActionExecutionResult>)
      | undefined;
  }

  private buildView(): HarnessLoopView {
    const used = {
      loopSteps: this.actionHistory.length,
      agentCalls: this.actionHistory.filter((entry) => entry.actionType === "agent.call").length,
      toolCalls: this.actionHistory.filter((entry) => entry.actionType === "tool.call").length,
      knowledgeSearches: this.actionHistory.filter(
        (entry) => entry.actionType === "knowledge.search",
      ).length,
    };
    return {
      invocation: {
        invocationId: this.params.invocationId,
        tenantId: this.params.tenantId,
        threadId: this.params.threadId,
        turnId: this.params.turnId,
        executionState: "running",
      },
      objective: this.params.objective,
      context: {
        contextHandle: this.params.contextHandle,
        workspace: this.params.workspace,
        executionLimits: this.params.executionLimits,
        traceContext: this.params.traceContext,
      },
      capabilities: {
        supportedActionTypes: HARNESS_ACTION_TYPES.filter(
          (actionType) => actionType === "respond" || actionType in this.params.executors,
        ),
        preferredAgentCandidate: this.preferredAgentId()
          ? { agentId: this.preferredAgentId() as string }
          : null,
      },
      observations: [...this.observations],
      actionHistory: this.actionHistory.map((entry) => ({ ...entry })),
      budget: {
        limits: this.limits,
        used,
        remaining: {
          loopSteps: Math.max(0, this.limits.maxLoopSteps - used.loopSteps),
          agentCalls: Math.max(0, this.limits.maxAgentCalls - used.agentCalls),
          toolCalls: Math.max(0, this.limits.maxToolCalls - used.toolCalls),
          knowledgeSearches: Math.max(0, this.limits.maxKnowledgeSearches - used.knowledgeSearches),
        },
      },
      control: { cancelled: false, waitingForUser: false },
    };
  }

  private nextStepNo(): number {
    return Math.max(0, ...this.actionHistory.map((entry) => entry.stepNo)) + 1;
  }

  private preferredAgentId(): string | null {
    return (
      this.params.capabilityDirectives?.find(
        (directive) => directive.capability_type === "agent" && directive.mode === "preferred",
      )?.capability_id ?? null
    );
  }

  private async writeActionEvent(
    type:
      | "harness.action.proposed"
      | "harness.action.started"
      | "harness.action.completed"
      | "harness.action.failed",
    entry: HarnessActionHistoryEntry,
  ): Promise<void> {
    await this.params.eventWriter.write(type, {
      action_id: entry.actionId,
      step_no: entry.stepNo,
      action_type: entry.actionType,
      action_digest: entry.actionDigest,
      purpose_code: entry.purposeCode,
      short_purpose: entry.shortPurpose,
      target_ref: entry.targetRef,
      state: entry.state,
      action_payload: entry.action.payload,
      ...(entry.authorityRef ? { authority_ref: entry.authorityRef } : {}),
      ...(entry.errorCode ? { error_code: entry.errorCode } : {}),
      ...(entry.observation ? { observation: entry.observation } : {}),
    });
  }

  private async safeWriteActionFailed(entry: HarnessActionHistoryEntry): Promise<void> {
    try {
      await this.writeActionEvent("harness.action.failed", entry);
    } catch {
      // 保留原始失败；Event Ingress 不可用由外层 Runtime 监控处理。
    }
  }

  private async safeWriteExecutionFailed(error: HarnessLoopError): Promise<void> {
    try {
      await this.params.eventWriter.write("execution.failed", {
        error_code: error.code,
        error_summary: error.message,
      });
    } catch {
      // 保留原始失败；Event Ingress 不可用由外层 Runtime 监控处理。
    }
  }
}

function actionTargetRef(action: HarnessNextAction): string | null {
  switch (action.actionType) {
    case "knowledge.search":
      return action.payload.preferredSourceRefs?.join(",") ?? null;
    case "tool.call":
      return `${action.payload.toolId}:${action.payload.operationId}`;
    case "agent.call":
      return action.payload.agentId;
    case "request_user_input":
      return action.payload.purpose;
    case "respond":
      return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" && error.code ? error.code : null;
}
