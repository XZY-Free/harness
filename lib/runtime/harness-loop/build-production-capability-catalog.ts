import {
  getCurrentToolSchemaRevision,
  listTools,
} from "@/lib/capability/tool-queries";
import { listKnowledgeBases } from "@/lib/context/knowledge-queries";
import { db } from "@/lib/db/client";
import { computePolicyRulesHash } from "@/lib/identity/tenant-bootstrap";
import { type PolicyRuleView, evaluatePolicy } from "@/lib/permission/policy-evaluator";
import { POLICY_SET_KEY, loadFrozenPolicyRevision } from "@/lib/permission/policy-queries";
import {
  agentContractCapabilityTable,
  agentContractInvocationContextTable,
  agentContractSnapshotTable,
  agentTable,
} from "@/lib/persistence/schema/agents";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import {
  AgentActionUnavailableError,
  resolveAgentActionBinding,
} from "@/lib/agents/calls/application/resolve-agent-call-binding";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { and, asc, eq } from "drizzle-orm";
import {
  buildCapabilityCatalogSnapshot,
  type BuiltCapabilityCatalog,
  type CapabilityCatalogAgent,
  type CapabilityCatalogTool,
} from "./capability-catalog";

export async function buildProductionCapabilityCatalog(input: {
  tenantId: string;
  invocationId: string;
  threadId: string;
  preferredAgentId: string | null;
  runtimeRevisionId: string;
  policyRevisionId: string;
  policyRulesDigest: string;
  executionSubject: ExecutionSubject | null;
  resolveRoute: RouteResolver;
  routeScopeKey?: string;
  now?: Date;
}): Promise<BuiltCapabilityCatalog> {
  if (input.executionSubject && input.executionSubject.tenantId !== input.tenantId) {
    throw new Error("CAPABILITY_CATALOG_SUBJECT_TENANT_MISMATCH");
  }
  const unavailableFacts: string[] = [];
  const sourceRefs = [
    `runtime-revision:${input.runtimeRevisionId}`,
    `policy-revision:${input.policyRevisionId}`,
  ];
  const agentCandidate = await loadPreferredAgent(input, sourceRefs, unavailableFacts);
  const tools = await loadAuthorizedTools(input, sourceRefs);
  const knowledgeSources = (await listKnowledgeBases(input.tenantId, {
    lifecycleStates: ["active"],
    limit: 500,
  })).map((base) => {
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
      unavailableFacts.push(
        `preferred_agent_unavailable:${input.preferredAgentId}:${error.code}`,
      );
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
  const applicableScenarios = capabilities.flatMap((capability) => {
    const examples = Array.isArray(capability.examples)
      ? capability.examples.filter((entry): entry is string => typeof entry === "string")
      : [];
    return [
      capability.descriptionZhCn ?? capability.nameZhCn,
      ...examples,
    ].filter(Boolean);
  });
  const hrLike = /(^|[-_])hr($|[-_])|人力|人事/i.test(
    `${header.agent.agentKey} ${header.agent.displayName}`,
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
    applicableScenarios,
    excludedScenarios: [
      ...(hrLike ? ["普通寒暄"] : []),
      "合同 capabilities 未声明的业务场景",
    ],
    contractSummary: [
      ...capabilities.map(
        (capability) =>
          `${capability.nameZhCn}：${capability.descriptionZhCn ?? "按合同输出"}`,
      ),
      header.snapshot.resultNotesZhCn ?? "",
    ]
      .filter(Boolean)
      .join("；"),
    contextRequirements: contexts.map(
      (context) => `${context.key}:${context.necessity}`,
    ),
  };
}

async function loadAuthorizedTools(
  input: Parameters<typeof buildProductionCapabilityCatalog>[0],
  sourceRefs: string[],
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
  const rules: PolicyRuleView[] = frozen.rules.map((rule) => ({
    ruleKey: rule.ruleKey,
    toolPattern: rule.toolPattern,
    argMatcher: (rule.argMatcherJson as PolicyRuleView["argMatcher"]) ?? null,
    decision: rule.decision,
    scope: (rule.scopeJson as PolicyRuleView["scope"]) ?? null,
    priority: rule.priority,
  }));
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
      const evaluation = evaluatePolicy({
        toolKey: `tool.${tool.toolKey}`,
        arguments: {},
        toolRiskClass: tool.riskClass,
        scopeContext: { threadId: input.threadId, projectId: null, skillId: null },
        defaultDecision: frozen.defaultDecision,
        rules,
        agentRequirements: null,
        grantScopes: [],
      });
      if (evaluation.decision === "block") continue;
      sourceRefs.push(`tool-schema:${revision.id}:${revision.schemaHash}`);
      result.push({
        toolId: tool.id,
        operationId: tool.toolKey,
        schemaRevisionId: revision.id,
        schemaHash: revision.schemaHash,
        displayName: tool.displayName,
        description: revision.description ?? tool.description ?? "",
        inputSchema: asRecord(revision.inputSchemaJson),
        sideEffect: sideEffect(revision.riskMetadataJson),
        confirmation: evaluation.decision === "pause" ? "required" : "none",
        idempotent: true,
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

function sideEffect(value: unknown): CapabilityCatalogTool["sideEffect"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const metadata = value as Record<string, unknown>;
  const raw = metadata.side_effects ?? metadata.sideEffect ?? metadata.effect;
  if (raw === false || raw === "none") return "none";
  if (raw === "read" || raw === "read_only") return "read";
  if (raw === true || raw === "write" || raw === "side_effect") return "write";
  return "unknown";
}
