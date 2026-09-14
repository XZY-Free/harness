import type { ActionScopeRequest } from "./authorization";
import type { JsonValue } from "./enterprise-user";
import {
  type EnterpriseUserProfileFacts,
  attributesFromRows,
} from "./enterprise-user-profile-queries";
export interface EnterpriseAuthorizationProvider {
  readonly name: string;
  readonly agentIds: "all" | readonly string[];
  evaluate(context: {
    tenantId: string;
    userIdentityId: string;
    attributes: Readonly<Record<string, JsonValue>>;
    agentIds: readonly string[];
    signal: AbortSignal;
  }): Promise<readonly { agentId: string; allowed: boolean }[]>;
}
export interface EnterpriseAuthorizationDecisions {
  agentIds: "all" | readonly string[];
  decisions: Record<string, { allowed: boolean; reason: string }>;
}
export async function evaluateEnterpriseAuthorization(
  provider: EnterpriseAuthorizationProvider | undefined,
  tenantId: string,
  userId: string,
  requests: readonly ActionScopeRequest[],
  facts: EnterpriseUserProfileFacts | null,
): Promise<EnterpriseAuthorizationDecisions | null> {
  if (!provider) return null;
  const ids = [
    ...new Set(
      requests
        .filter(
          (r) =>
            r.actionCode === "agent.invoke" &&
            r.resource.type === "agent" &&
            r.resource.id &&
            (provider.agentIds === "all" || provider.agentIds.includes(r.resource.id)),
        )
        .map((r) => r.resource.id as string),
    ),
  ];
  const denied = (reason: string): EnterpriseAuthorizationDecisions => ({
    agentIds: provider.agentIds,
    decisions: Object.fromEntries(ids.map((id) => [id, { allowed: false, reason }])),
  });
  if (!ids.length) return denied("企业接管范围未请求");
  if (!facts?.syncState || facts.syncState.freshUntil <= new Date())
    return denied("企业授权所需资料缺失或已过期");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, 3000);
    });
    const response = await Promise.race([
      provider.evaluate({
        tenantId,
        userIdentityId: userId,
        agentIds: ids,
        attributes: attributesFromRows(facts.attributes),
        signal: controller.signal,
      }),
      timeout,
    ]);
    if (
      !Array.isArray(response) ||
      response.some(
        (r) =>
          !r ||
          typeof r.agentId !== "string" ||
          typeof r.allowed !== "boolean" ||
          !ids.includes(r.agentId),
      ) ||
      new Set(response.map((r) => r.agentId)).size !== response.length
    )
      return denied("企业授权返回无效结果");
    return {
      agentIds: provider.agentIds,
      decisions: Object.fromEntries(
        ids.map((id) => {
          const allowed = response.find((r) => r.agentId === id)?.allowed === true;
          return [id, { allowed, reason: allowed ? "企业授权允许" : "企业授权未允许" }];
        }),
      ),
    };
  } catch {
    return denied(controller.signal.aborted ? "企业授权服务超时" : "企业授权服务不可用");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
