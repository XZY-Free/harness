import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import Ajv from "ajv";
import type { HarnessNextAction } from "./types";

export const CAPABILITY_CATALOG_VERSION = "1" as const;

export interface CapabilityCatalogAgent {
  agentId: string;
  agentRevisionId: string;
  routeRevisionId: string;
  contractSnapshotId: string;
  contractDigest: string;
  publicationRecordId: string;
  displayName: string;
  description: string;
  scenarioDeclaration: "declared" | "unspecified";
  applicableScenarios: string[];
  excludedScenarios: string[];
  contractSummary: string;
  contextRequirements: string[];
}

export interface CapabilityCatalogTool {
  toolId: string;
  /** Tool 内的稳定操作标识；ToolCall.operationId 由 Invocation/action 再派生。 */
  operationId: string;
  schemaRevisionId: string;
  schemaHash: string;
  executionContractDigest: string;
  displayName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sideEffect: "none" | "read" | "write" | "unknown";
  idempotent: boolean;
}

export interface CapabilityCatalogKnowledgeSource {
  sourceRef: string;
  knowledgeBaseId: string;
  displayName: string;
  description: string;
}

export interface CapabilityCatalogSnapshot {
  version: typeof CAPABILITY_CATALOG_VERSION;
  invocationId: string;
  createdAt: string;
  sourceRefs: string[];
  agents: CapabilityCatalogAgent[];
  tools: CapabilityCatalogTool[];
  knowledgeSources: CapabilityCatalogKnowledgeSource[];
  unavailableFacts: string[];
}

export interface BuiltCapabilityCatalog {
  snapshot: CapabilityCatalogSnapshot;
  digest: string;
  version: typeof CAPABILITY_CATALOG_VERSION;
  sourceRefs: string[];
  createdAt: Date;
}

export class CapabilityCatalogIntegrityError extends Error {
  readonly code = "CAPABILITY_CATALOG_INTEGRITY_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "CapabilityCatalogIntegrityError";
  }
}

export class CapabilityActionValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityActionValidationError";
  }
}

export function buildCapabilityCatalogSnapshot(input: {
  invocationId: string;
  preferredAgentId: string | null;
  agentCandidate: CapabilityCatalogAgent | null;
  tools: CapabilityCatalogTool[];
  knowledgeSources: CapabilityCatalogKnowledgeSource[];
  sourceRefs: string[];
  unavailableFacts?: string[];
  now?: Date;
}): BuiltCapabilityCatalog {
  if (!input.invocationId) {
    throw new CapabilityCatalogIntegrityError("invocationId 不能为空");
  }
  const createdAt = input.now ?? new Date();
  const snapshot: CapabilityCatalogSnapshot = {
    version: CAPABILITY_CATALOG_VERSION,
    invocationId: input.invocationId,
    createdAt: createdAt.toISOString(),
    sourceRefs: uniqueSorted(input.sourceRefs),
    agents:
      input.preferredAgentId && input.agentCandidate?.agentId === input.preferredAgentId
        ? [clone(input.agentCandidate)]
        : [],
    tools: [...input.tools]
      .map(clone)
      .sort((a, b) =>
        `${a.toolId}\u0000${a.operationId}`.localeCompare(`${b.toolId}\u0000${b.operationId}`),
      ),
    knowledgeSources: [...input.knowledgeSources]
      .map(clone)
      .sort((a, b) => a.sourceRef.localeCompare(b.sourceRef)),
    unavailableFacts: uniqueSorted(input.unavailableFacts ?? []),
  };
  const digest = computeCapabilityCatalogDigest(snapshot);
  return {
    snapshot: deepFreeze(snapshot),
    digest,
    version: CAPABILITY_CATALOG_VERSION,
    sourceRefs: [...snapshot.sourceRefs],
    createdAt,
  };
}

export function computeCapabilityCatalogDigest(snapshot: CapabilityCatalogSnapshot): string {
  return computeCanonicalDigest(snapshot);
}

export function verifyCapabilityCatalogSnapshot(
  value: unknown,
  expectedDigest: string,
): CapabilityCatalogSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityCatalogIntegrityError("能力目录快照不是对象");
  }
  const snapshot = value as CapabilityCatalogSnapshot;
  if (
    snapshot.version !== CAPABILITY_CATALOG_VERSION ||
    typeof snapshot.invocationId !== "string" ||
    !Array.isArray(snapshot.agents) ||
    !Array.isArray(snapshot.tools) ||
    !Array.isArray(snapshot.knowledgeSources) ||
    !Array.isArray(snapshot.sourceRefs) ||
    !Array.isArray(snapshot.unavailableFacts)
  ) {
    throw new CapabilityCatalogIntegrityError("能力目录快照结构无效");
  }
  const actualDigest = computeCapabilityCatalogDigest(snapshot);
  if (actualDigest !== expectedDigest) {
    throw new CapabilityCatalogIntegrityError(
      `能力目录摘要不一致：expected=${expectedDigest} actual=${actualDigest}`,
    );
  }
  return deepFreeze(clone(snapshot));
}

/** 只从持久快照投影安全模型视图，不读取当前目录。 */
export function capabilityCatalogModelView(snapshot: CapabilityCatalogSnapshot) {
  return {
    version: snapshot.version,
    agents: snapshot.agents.map((agent) => ({
      agentId: agent.agentId,
      displayName: agent.displayName,
      description: agent.description,
      scenarioDeclaration: agent.scenarioDeclaration,
      applicableScenarios: [...agent.applicableScenarios],
      excludedScenarios: [...agent.excludedScenarios],
      contractSummary: agent.contractSummary,
      contextRequirements: [...agent.contextRequirements],
    })),
    tools: snapshot.tools.map((tool) => ({
      toolId: tool.toolId,
      operationId: tool.operationId,
      displayName: tool.displayName,
      description: tool.description,
      inputSchema: clone(tool.inputSchema),
      sideEffect: tool.sideEffect,
      idempotent: tool.idempotent,
    })),
    knowledgeSources: snapshot.knowledgeSources.map((source) => ({
      sourceRef: source.sourceRef,
      displayName: source.displayName,
      description: source.description,
    })),
    unavailableFacts: [...snapshot.unavailableFacts],
  };
}

export function validateHarnessActionAgainstCatalog(
  action: HarnessNextAction,
  snapshot: CapabilityCatalogSnapshot,
): { agent?: CapabilityCatalogAgent; tool?: CapabilityCatalogTool } {
  if (action.actionType === "agent.call") {
    const agent = snapshot.agents.find((entry) => entry.agentId === action.payload.agentId);
    if (!agent) {
      throw new CapabilityActionValidationError(
        "AGENT_ACTION_NOT_ALLOWED",
        `Agent 不在冻结能力目录：${action.payload.agentId}`,
      );
    }
    return { agent };
  }
  if (action.actionType === "tool.call") {
    const tool = snapshot.tools.find(
      (entry) =>
        entry.toolId === action.payload.toolId && entry.operationId === action.payload.operationId,
    );
    if (!tool) {
      throw new CapabilityActionValidationError(
        "TOOL_ACTION_NOT_ALLOWED",
        `Tool Operation 不在冻结能力目录：${action.payload.toolId}/${action.payload.operationId}`,
      );
    }
    try {
      const validate = new Ajv({ strict: false, allErrors: true }).compile(tool.inputSchema);
      if (!validate(action.payload.arguments)) {
        throw new CapabilityActionValidationError(
          "TOOL_ARGUMENTS_INVALID",
          `Tool 参数不符合冻结 Schema：${JSON.stringify(validate.errors ?? [])}`,
        );
      }
    } catch (error) {
      if (error instanceof CapabilityActionValidationError) throw error;
      throw new CapabilityActionValidationError("TOOL_SCHEMA_INVALID", "冻结 Tool Schema 无法编译");
    }
    return { tool };
  }
  if (action.actionType === "knowledge.search") {
    const allowed = new Set(snapshot.knowledgeSources.map((entry) => entry.sourceRef));
    if (action.payload.preferredSourceRefs?.some((sourceRef) => !allowed.has(sourceRef))) {
      throw new CapabilityActionValidationError(
        "ACTION_SCOPE_DENIED",
        "knowledge.search 包含冻结目录外的 source ref",
      );
    }
  }
  return {};
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
