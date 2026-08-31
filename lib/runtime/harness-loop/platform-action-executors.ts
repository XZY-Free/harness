import { createAgentActionExecutor } from "@/lib/agents/calls/application/agent-action-executor";
import { searchKnowledgeEvidence } from "@/lib/context/knowledge-queries";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import type { HarnessActionExecutors } from "./loop";

/** 平台内置 Action Executor；Hosted 进程内与 Gateway HTTP 共用。 */
export function createPlatformHarnessActionExecutors(params: {
  tenantId: string;
  executionSubject: ExecutionSubject | null;
  resolveRoute: RouteResolver;
}): HarnessActionExecutors {
  return {
    "agent.call": createAgentActionExecutor(params),
    "knowledge.search": async (action) => {
      const result = await searchKnowledgeEvidence({
        tenantId: params.tenantId,
        query: action.payload.query,
        limit: action.payload.maxResults,
      });
      if (result.status === "denied" || result.status === "unavailable") {
        throw new Error(result.reasonCode ?? "KNOWLEDGE_ACTION_FAILED");
      }
      const sourceRefs = result.hits.map(
        (hit) =>
          `knowledge_document:${hit.documentId}:revision:${hit.revisionId}:chunk:${hit.chunkId}`,
      );
      const summary =
        result.status === "empty"
          ? "未检索到匹配的 Knowledge 证据"
          : result.hits
              .map((hit) => `${hit.documentTitle}: ${hit.chunkText ?? "[受限内容]"}`)
              .join("\n");
      return {
        authorityRef: `harness-action:${action.actionId}`,
        observation: {
          observationType: "knowledge",
          summary: summary.slice(0, 20_000),
          sourceRefs,
          data: {
            status: result.status,
            reasonCode: result.reasonCode ?? null,
            hits: result.hits.map((hit) => ({
              chunkId: hit.chunkId,
              chunkHash: hit.chunkHash,
              revisionId: hit.revisionId,
              revisionPublishedAt: hit.revisionPublishedAt?.toISOString() ?? null,
              documentId: hit.documentId,
              documentTitle: hit.documentTitle,
              score: hit.score,
            })),
          },
        },
      };
    },
    request_user_input: async (action) => ({
      authorityRef: `harness-action:${action.actionId}`,
      observation: {
        observationType: "user_input",
        summary: "已请求用户补充信息",
        sourceRefs: [],
        data: { purpose: action.payload.purpose },
      },
      waitingForUser: {
        requestType: "input",
        purpose: action.payload.purpose,
        prompt: action.payload.prompt,
        inputSchema: action.payload.inputSchema,
      },
    }),
  };
}
