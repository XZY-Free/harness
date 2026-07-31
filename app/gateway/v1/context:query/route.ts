import { REQUEST_ID_HEADER, getRequestId, v11Error, v11Ok } from "@/lib/http";
import { recordCapabilityUse } from "@/lib/v11/capability/capability-use-queries";
import type { ContextBudgetConfig } from "@/lib/v11/context/budget";
import {
  CONTEXT_CLASSIFICATIONS,
  CONTEXT_SOURCE_TYPES,
  type ContextHandleBinding,
  ContextHandleError,
  type ContextSourceType,
  resolveContextHandle,
} from "@/lib/v11/context/context-handle";
import { assembleContextView } from "@/lib/v11/context/context-query";
import type { ContextFragment } from "@/lib/v11/context/fragment";
import {
  KnowledgeResolver,
  MemoryResolver,
  RecentItemsResolver,
  SkillResolver,
  type SourceResolver,
  WorkspaceMapResolver,
} from "@/lib/v11/context/source-resolvers";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  resolveGatewayPrincipal,
  v11GatewaySchemaInvalid,
} from "@/lib/v11/gateway/route-helpers";

export const dynamic = "force-dynamic";

interface ContextQueryBody {
  context_handle: string;
  sources: ContextSourceType[];
  query: string;
  limits: Record<string, unknown>;
}

const BODY_KEYS = new Set(["context_handle", "sources", "query", "limits"]);
const SOURCE_SET: ReadonlySet<string> = new Set(CONTEXT_SOURCE_TYPES);
const LIMIT_KEYS = new Set(["max_items", "max_tokens", "max_sensitivity"]);
const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MAX_TOKENS = 4_000;

function validateBody(value: unknown): value is ContextQueryBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !BODY_KEYS.has(key))) return false;
  if (typeof body.context_handle !== "string" || !body.context_handle) return false;
  if (!Array.isArray(body.sources) || body.sources.length === 0) return false;
  if (body.sources.some((source) => typeof source !== "string" || !SOURCE_SET.has(source))) {
    return false;
  }
  if (typeof body.query !== "string" || !body.query.trim()) return false;
  if (!body.limits || typeof body.limits !== "object" || Array.isArray(body.limits)) {
    return false;
  }
  return true;
}

interface ParsedContextLimits {
  maxItems: number;
  maxTokens: number;
  maxSensitivity: ContextHandleBinding["classification"];
  budget: ContextBudgetConfig;
}

function parseLimits(limits: Record<string, unknown>): ParsedContextLimits | null {
  if (Object.keys(limits).some((key) => !LIMIT_KEYS.has(key))) return null;
  const maxItems = limits.max_items ?? DEFAULT_MAX_ITEMS;
  const maxTokens = limits.max_tokens ?? DEFAULT_MAX_TOKENS;
  const maxSensitivity = limits.max_sensitivity ?? "confidential";
  if (!Number.isInteger(maxItems) || (maxItems as number) <= 0) return null;
  if (!Number.isInteger(maxTokens) || (maxTokens as number) <= 0) return null;
  if (
    typeof maxSensitivity !== "string" ||
    !CONTEXT_CLASSIFICATIONS.includes(maxSensitivity as ContextHandleBinding["classification"])
  ) {
    return null;
  }
  return {
    maxItems: maxItems as number,
    maxTokens: maxTokens as number,
    maxSensitivity: maxSensitivity as ContextHandleBinding["classification"],
    budget: {
      totalBudget: maxTokens as number,
      modelOutputReserve: 0,
      toolResultReserve: 0,
    },
  };
}

function buildResolvers(
  sources: readonly ContextSourceType[],
  allowedSkillIds: readonly string[],
): SourceResolver[] {
  const resolvers: SourceResolver[] = [];
  for (const source of sources) {
    switch (source) {
      case "recent_items":
        resolvers.push(new RecentItemsResolver());
        break;
      case "skill":
        if (allowedSkillIds.length === 0) {
          resolvers.push(new SkillResolver(""));
        } else {
          resolvers.push(...allowedSkillIds.map((skillId) => new SkillResolver(skillId)));
        }
        break;
      case "workspace_map":
        resolvers.push(new WorkspaceMapResolver());
        break;
      case "memory":
        resolvers.push(new MemoryResolver());
        break;
      case "knowledge":
        resolvers.push(new KnowledgeResolver());
        break;
    }
  }
  return resolvers;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: GatewayPrincipal;
  try {
    principal = await resolveGatewayPrincipal(request.headers);
  } catch (error) {
    const response = gatewayAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }

  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11GatewaySchemaInvalid(
      requestId,
      "请求体必须且只能包含 context_handle、sources、query、limits",
    );
  }
  const limits = parseLimits(body.limits);
  if (!limits) {
    return v11GatewaySchemaInvalid(
      requestId,
      "limits 只能包含正整数 max_items/max_tokens 与合法 max_sensitivity",
    );
  }

  let binding: ContextHandleBinding;
  try {
    binding = await resolveContextHandle(body.context_handle, {
      tenantId: principal.tenantId,
      invocationId: principal.invocationId,
    });
  } catch (error) {
    if (error instanceof ContextHandleError) {
      return v11Error("ACCESS_DENIED", error.message, { requestId });
    }
    throw error;
  }

  if (binding.classification === "restricted") {
    return v11Error("ACCESS_DENIED", "restricted 数据不得通过 Context Query 返回正文", {
      requestId,
    });
  }
  const sensitivityRank = new Map(
    CONTEXT_CLASSIFICATIONS.map((classification, index) => [classification, index]),
  );
  if (
    (sensitivityRank.get(binding.classification) ?? Number.POSITIVE_INFINITY) >
    (sensitivityRank.get(limits.maxSensitivity) ?? -1)
  ) {
    return v11Error("ACCESS_DENIED", "请求的敏感级别上限低于当前上下文分类", {
      requestId,
    });
  }
  if (body.sources.some((source) => !binding.allowedSources.includes(source))) {
    return v11Error("ACCESS_DENIED", "请求包含 context_handle 未授权的来源", { requestId });
  }

  const view = await assembleContextView({
    ctx: {
      ...binding,
      allowedSources: binding.allowedSources,
      allowedSkillIds: binding.allowedSkillIds,
      query: body.query,
      maxItems: limits.maxItems,
      maxTokens: limits.maxTokens,
      maxSensitivity: limits.maxSensitivity,
    },
    resolvers: buildResolvers(body.sources, binding.allowedSkillIds),
    budget: limits.budget,
  });

  if (Object.values(view.sourceStatus).includes("denied")) {
    return v11Error("ACCESS_DENIED", "上下文来源访问被拒绝", { requestId });
  }
  if (Object.values(view.sourceStatus).includes("unavailable")) {
    return v11Error("RESOURCE_NOT_FOUND", "请求的上下文来源当前不可用", { requestId });
  }
  if (view.failureReason) {
    return v11GatewaySchemaInvalid(requestId, view.failureReason);
  }

  const selectedFragments = view.fragments.slice(0, limits.maxItems);
  const results = selectedFragments.map(projectContextResult);
  if (results.some((result) => result === null)) {
    return v11GatewaySchemaInvalid(requestId, "请求源当前没有符合 Context Query oneOf 的结果形态");
  }

  let capabilityUseRecorded = false;
  for (const fragment of selectedFragments) {
    if (fragment.kind !== "skill") continue;
    await recordCapabilityUse({
      tenantId: principal.tenantId,
      invocationId: principal.invocationId,
      capabilityType: "skill",
      capabilityId: fragment.sourceRef.id,
      revisionId: fragment.sourceRef.revisionId ?? null,
      contentHash: fragment.contentHash,
      schemaHash: null,
      sourceType: "dynamic_discovery",
      sourceRef: `context:${fragment.sourceRef.type}/${fragment.sourceRef.id}`,
      selectionReasonCode: "explicit_select",
    });
    capabilityUseRecorded = true;
  }

  return v11Ok(
    { results, capability_use_recorded: capabilityUseRecorded },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

export function projectContextResult(fragment: ContextFragment): Record<string, string> | null {
  if (
    fragment.kind === "knowledge" &&
    fragment.sourceRef.type === "knowledge_document" &&
    fragment.sourceRef.revisionId &&
    fragment.text !== undefined
  ) {
    return {
      source_type: "knowledge_document",
      source_id: fragment.sourceRef.id,
      revision_id: fragment.sourceRef.revisionId,
      content_hash: fragment.contentHash,
      content: fragment.text,
      citation_ref:
        fragment.contentRef ?? `kb://${fragment.sourceRef.id}#${fragment.sourceRef.revisionId}`,
    };
  }
  if (
    fragment.kind === "memory" &&
    fragment.sourceRef.type === "memory" &&
    fragment.text !== undefined
  ) {
    return {
      source_type: "memory",
      source_id: fragment.sourceRef.id,
      content_hash: fragment.contentHash,
      content: fragment.text,
      scope: fragment.scope,
    };
  }
  return null;
}
