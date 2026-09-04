import {
  AgentActionUnavailableError,
  resolveAgentActionBinding,
} from "@/lib/agents/calls/application/resolve-agent-call-binding";
import { createProductionProviderExecutorRegistry } from "@/lib/capability/provider-executor";
import {
  computeToolExecutionContractDigest,
  parseToolExecutionContract,
} from "@/lib/capability/tool-execution-contract";
import {
  getConnectionById,
  getCurrentToolSchemaRevision,
  getToolProviderById,
  listTools,
} from "@/lib/capability/tool-queries";
import { listDiscoverableKnowledgeBases } from "@/lib/context/knowledge-queries";
import { db } from "@/lib/db/client";
import { computePolicyRulesHash } from "@/lib/identity/tenant-bootstrap";
import { POLICY_SET_KEY, loadFrozenPolicyRevision } from "@/lib/permission/policy-queries";
import {
  agentContractCapabilityTable,
  agentContractInvocationContextTable,
  agentContractSnapshotTable,
  agentTable,
} from "@/lib/persistence/schema/agents";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { and, asc, eq } from "drizzle-orm";
import {
  type BuiltCapabilityCatalog,
  type CapabilityCatalogAgent,
  type CapabilityCatalogTool,
  buildCapabilityCatalogSnapshot,
} from "./capability-catalog";

export async function buildProductionCapabilityCatalog(input: {
  tenantId: string;
  invocationId: string;
  threadId: string;
  preferredAgentId: string | null;
  runtimeRevisionId: string;
  policyRevisionId: string;
  policyRulesDigest: string;
  executionSubject: ExecutionSubject;
  resolveRoute: RouteResolver;
  routeScopeKey?: string;
  now?: Date;
}): Promise<BuiltCapabilityCatalog> {
  if (input.executionSubject.tenantId !== input.tenantId || !input.executionSubject.subjectId) {
    throw new Error("CAPABILITY_CATALOG_SUBJECT_TENANT_MISMATCH");
  }
  const unavailableFacts: string[] = [];
  const sourceRefs = [
    `runtime-revision:${input.runtimeRevisionId}`,
    `policy-revision:${input.policyRevisionId}`,
  ];
  const agentCandidate = await loadPreferredAgent(input, sourceRefs, unavailableFacts);
  const tools = await loadAuthorizedTools(input, sourceRefs, unavailableFacts);
  const knowledgeSources = (
    await listDiscoverableKnowledgeBases({
      tenantId: input.tenantId,
      executionSubject: input.executionSubject,
      limit: 500,
    })
  ).map((base) => {
    sourceRefs.push(`knowledge-base:${base.id}:version:${base.versionNo}`);
    return {
      sourceRef: `knowledge-base:${base.id}`,
      knowledgeBaseId: base.id,
      displayName: base.displayName,
      description: base.description ?? "",
    };
  });
  return buildCapabilityCatalogSnapshot({
    invocationId: input.invocationId,
    preferredAgentId: input.preferredAgentId,
    agentCandidate,
    tools,
    knowledgeSources,
    sourceRefs,
    unavailableFacts,
    now: input.now,
  });
}

async function loadPreferredAgent(
  input: Parameters<typeof buildProductionCapabilityCatalog>[0],
  sourceRefs: string[],
  unavailableFacts: string[],
): Promise<CapabilityCatalogAgent | null> {
  if (!input.preferredAgentId) return null;
  let resolved: Awaited<ReturnType<typeof resolveAgentActionBinding>>;
  try {
    resolved = await resolveAgentActionBinding({
      tenantId: input.tenantId,
      agentId: input.preferredAgentId,
      resolveRoute: input.resolveRoute,
      routeScopeKey: input.routeScopeKey ?? "default",
      businessKey: { threadId: input.threadId },
    });
  } catch (error) {
    if (error instanceof AgentActionUnavailableError) {
      unavailableFacts.push(`preferred_agent_unavailable:${input.preferredAgentId}:${error.code}`);
      return null;
    }
    throw error;
  }
  const [header] = await db
    .select({ agent: agentTable, snapshot: agentContractSnapshotTable })
    .from(agentTable)
    .innerJoin(
      agentContractSnapshotTable,
      and(
        eq(agentContractSnapshotTable.id, resolved.contractSnapshotId),
        eq(agentContractSnapshotTable.agentId, agentTable.id),
      ),
    )
    .where(
      and(
        eq(agentTable.tenantId, input.tenantId),
        eq(agentTable.id, input.preferredAgentId),
        eq(agentTable.lifecycleState, "enabled"),
      ),
    )
    .limit(1);
  if (!header) {
    unavailableFacts.push(
      `preferred_agent_unavailable:${input.preferredAgentId}:catalog_facts_missing`,
    );
    return null;
  }
  const capabilities = await db
    .select()
    .from(agentContractCapabilityTable)
    .where(eq(agentContractCapabilityTable.snapshotId, resolved.contractSnapshotId))
    .orderBy(asc(agentContractCapabilityTable.position));
  const contexts = await db
    .select()
    .from(agentContractInvocationContextTable)
    .where(eq(agentContractInvocationContextTable.snapshotId, resolved.contractSnapshotId))
    .orderBy(asc(agentContractInvocationContextTable.position));

  sourceRefs.push(
    `agent-revision:${resolved.agentRevisionId}`,
    `agent-route-revision:${resolved.resolution.routeRevisionId}`,
    `agent-contract:${resolved.contractSnapshotId}:${resolved.contractDigest}`,
  );
  return {
    agentId: header.agent.id,
    agentRevisionId: resolved.agentRevisionId,
    routeRevisionId: resolved.resolution.routeRevisionId,
    contractSnapshotId: resolved.contractSnapshotId,
    contractDigest: resolved.contractDigest,
    publicationRecordId: resolved.publicationRecordId,
    displayName: header.agent.displayName,
    description: header.agent.description ?? "",
    scenarioDeclaration: header.snapshot.scenarioDeclaration,
    applicableScenarios: [...header.snapshot.applicableScenarios],
    excludedScenarios: [...header.snapshot.excludedScenarios],
    contractSummary: [
      ...capabilities.map(
        (capability) => `${capability.nameZhCn}：${capability.descriptionZhCn ?? "按合同输出"}`,
      ),
      header.snapshot.resultNotesZhCn ?? "",
    ]
      .filter(Boolean)
      .join("；"),
    contextRequirements: contexts.map((context) => `${context.key}:${context.necessity}`),
  };
}

async function loadAuthorizedTools(
  input: Parameters<typeof buildProductionCapabilityCatalog>[0],
  sourceRefs: string[],
  unavailableFacts: string[],
): Promise<CapabilityCatalogTool[]> {
  const frozen = await loadFrozenPolicyRevision(
    db,
    input.tenantId,
    input.policyRevisionId,
    POLICY_SET_KEY,
  );
  const digest = computePolicyRulesHash(
    frozen.defaultDecision,
    frozen.rules.map((rule) => ({
      ruleKey: rule.ruleKey,
      toolPattern: rule.toolPattern,
      argMatcher: rule.argMatcherJson,
      decision: rule.decision,
      scope: rule.scopeJson,
      priority: rule.priority,
      reason: rule.reason,
    })),
  );
  if (digest !== input.policyRulesDigest) {
    throw new Error("CAPABILITY_CATALOG_POLICY_INTEGRITY_MISMATCH");
  }
  const registry = createProductionProviderExecutorRegistry();
  const result: CapabilityCatalogTool[] = [];
  let cursor: string | null = null;
  do {
    const page = await listTools({
      tenantId: input.tenantId,
      lifecycleStates: ["enabled"],
      limit: 200,
      cursor,
    });
    for (const tool of page.items) {
      const revision = await getCurrentToolSchemaRevision({
        tenantId: input.tenantId,
        toolId: tool.id,
      });
      if (!revision || revision.revisionState !== "published") continue;
      const provider = await getToolProviderById({
        tenantId: input.tenantId,
        providerId: tool.providerId,
      });
      if (!provider || provider.lifecycleState !== "enabled") continue;
      const executorKind = provider.providerType === "webhook" ? "webhook.post_json" : null;
      if (!executorKind || !registry.supports(provider.providerType, executorKind)) continue;
      const connection = provider.connectionId
        ? await getConnectionById({
            tenantId: input.tenantId,
            connectionId: provider.connectionId,
          })
        : null;
      if (!connection || connection.lifecycleState !== "enabled" || !connection.endpointRef) {
        continue;
      }
      if (!["none", "bearer"].includes(connection.authMethod)) {
        unavailableFacts.push(`tool_unavailable:${tool.id}:unsupported_auth_method`);
        continue;
      }
      const contract = parseToolExecutionContract(revision.executionContractJson);
      if (computeToolExecutionContractDigest(contract) !== revision.executionContractDigest) {
        unavailableFacts.push(`tool_unavailable:${tool.id}:execution_contract_integrity`);
        continue;
      }
      sourceRefs.push(
        `tool-schema:${revision.id}:${revision.schemaHash}`,
        `tool-execution-contract:${revision.id}:${revision.executionContractDigest}`,
        `tool-provider:${provider.id}:${provider.versionNo}`,
        `connection:${connection.id}:${connection.versionNo}`,
      );
      result.push({
        toolId: tool.id,
        operationId: tool.toolKey,
        schemaRevisionId: revision.id,
        schemaHash: revision.schemaHash,
        executionContractDigest: revision.executionContractDigest,
        displayName: tool.displayName,
        description: revision.description ?? tool.description ?? "",
        inputSchema: asRecord(revision.inputSchemaJson),
        sideEffect: contract.sideEffectMode,
        idempotent: contract.idempotencySupport !== "none",
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CAPABILITY_CATALOG_TOOL_SCHEMA_INVALID");
  }
  return value as Record<string, unknown>;
}
