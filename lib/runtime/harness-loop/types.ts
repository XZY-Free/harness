export const HARNESS_ACTION_TYPES = [
  "knowledge.search",
  "tool.call",
  "agent.call",
  "request_user_input",
  "respond",
] as const;

export type HarnessActionType = (typeof HARNESS_ACTION_TYPES)[number];

interface HarnessActionBase<TType extends HarnessActionType, TPayload> {
  actionId: string;
  stepNo: number;
  actionType: TType;
  purposeCode: string;
  shortPurpose: string;
  payload: TPayload;
}

export type KnowledgeSearchAction = HarnessActionBase<
  "knowledge.search",
  {
    query: string;
    preferredSourceRefs?: string[];
    maxResults?: number;
  }
>;

export type ToolCallAction = HarnessActionBase<
  "tool.call",
  {
    toolId: string;
    operationId: string;
    arguments: Record<string, unknown>;
  }
>;

export type AgentCallAction = HarnessActionBase<
  "agent.call",
  {
    agentId: string;
    task: string;
    expectedOutput?: string;
    contextRefs?: string[];
  }
>;

export type RequestUserInputAction = HarnessActionBase<
  "request_user_input",
  {
    purpose: string;
    inputSchema: Record<string, unknown>;
    prompt: string;
  }
>;

export type RespondAction = HarnessActionBase<
  "respond",
  {
    evidenceRefs?: string[];
  }
>;

export type HarnessNextAction =
  | KnowledgeSearchAction
  | ToolCallAction
  | AgentCallAction
  | RequestUserInputAction
  | RespondAction;

export interface HarnessObservation {
  observationType: "knowledge" | "tool" | "agent" | "user_input";
  summary: string;
  sourceRefs: string[];
  data: unknown;
}

export type HarnessActionState = "proposed" | "started" | "completed" | "failed";

export interface HarnessActionHistoryEntry {
  actionId: string;
  stepNo: number;
  actionType: HarnessActionType;
  actionDigest: string;
  targetRef: string | null;
  purposeCode: string;
  shortPurpose: string;
  action: HarnessNextAction;
  state: HarnessActionState;
  authorityRef?: string;
  errorCode?: string;
  observation?: HarnessObservation;
}

export interface HarnessLoopLimits {
  maxLoopSteps: number;
  maxAgentCalls: number;
  maxToolCalls: number;
  maxKnowledgeSearches: number;
  maxConsecutiveSameAction: number;
}

export interface HarnessLoopBudgetView {
  limits: HarnessLoopLimits;
  used: {
    loopSteps: number;
    agentCalls: number;
    toolCalls: number;
    knowledgeSearches: number;
  };
  remaining: {
    loopSteps: number;
    agentCalls: number;
    toolCalls: number;
    knowledgeSearches: number;
  };
}

export interface HarnessLoopView {
  invocation: {
    invocationId: string;
    tenantId: string;
    threadId: string;
    turnId: string;
    executionState: "running";
  };
  objective: string;
  context: {
    contextHandle?: string;
    workspace?: { workspace_binding_id: string | null; workspace_type: string } | null;
    executionLimits?: Record<string, number>;
    traceContext?: { trace_id: string; span_id: string };
  };
  capabilities: {
    supportedActionTypes: HarnessActionType[];
    preferredAgentCandidate: { agentId: string } | null;
  };
  observations: HarnessObservation[];
  actionHistory: HarnessActionHistoryEntry[];
  budget: HarnessLoopBudgetView;
  control: {
    cancelled: false;
    waitingForUser: false;
  };
}

export interface HarnessLoopRecoverySnapshot {
  invocationState: "running" | "waiting_user";
  nextProducerSequence: number;
  observations: HarnessObservation[];
  actionHistory: HarnessActionHistoryEntry[];
}
