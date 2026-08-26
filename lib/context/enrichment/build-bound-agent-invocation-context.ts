/**
 * Bound Context Orchestration（04 §3）。
 *
 * 职责：
 * ```text
 * Binding + trusted ExecutionSubject + 当前平台可用 Context + external egress policy
 * → Allowed InvocationContextBundle
 * ```
 *
 * 关键不变量：
 * - Contract 只能来自 Binding 冻结的 exact AgentContractSnapshot
 *   （resolveBindingContextContract，04 §2），禁止读"Agent 最新合同"；
 * - 复用 buildInvocationContextBundle，禁止第二 Context Builder（04 §3）；
 * - Base Harness（agentRevisionId=null / snapshot 全 null）→ 不执行 Agent 级
 *   Context Contract，返回 null（04 §14）；
 * - required 缺失/被策略拒绝 → 调用前 fail（04 §8）；
 * - Production External 热路径使用 externalAgentContextPolicyFilter，
 *   禁止 allowAllContextPolicyFilter（04 §7）。
 *
 * 事实源：docs/V12/01/04-InvocationContext-Enrichment-A2A.md。
 */
import { buildInvocationContextBundle } from "@/lib/context/enrichment/build-invocation-context-bundle";
import type {
  ContextPolicyFilter,
  InvocationContextBundle,
  PlatformContextEnvironment,
} from "@/lib/context/enrichment/build-invocation-context-bundle";
import { externalAgentContextPolicyFilter } from "@/lib/context/enrichment/external-agent-context-policy";
import { resolveBindingContextContract } from "@/lib/executions/application/resolve-binding-context-contract";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";

/** Binding 冻结的 Agent Contract 证据（ExecutionBinding 列）。 */
export interface BoundContextBindingEvidence {
  agentContractSnapshotId: string | null;
  agentContextDigest: string | null;
}

export interface BuildBoundAgentInvocationContextInput {
  tenantId: string;
  /** ExecutionBinding 冻结证据（base route 三元组全 null）。 */
  binding: BoundContextBindingEvidence;
  /** 服务端认证 Principal 生成的 trusted ExecutionSubject；null = 本次无可信主体。 */
  executionSubject: ExecutionSubject | null;
  /** 每次 dispatch 时的服务器当前时间（不得启动时冻结，04 §6）。 */
  now: Date;
  /** 平台其余可用上下文（timezone/locale 等；无权威来源时省略，04 §6）。 */
  platform?: {
    timezone?: string | null;
    locale?: string | null;
    conversationContextRef?: string | null;
    attachmentRefs?: string[];
    workspaceContextRef?: string | null;
  };
  /** 策略过滤器；缺省 externalAgentContextPolicyFilter（04 §7）。 */
  policyFilter?: ContextPolicyFilter;
  /** accepted 上下文显式选择集合（04 §10：仅确定性任务相关事实）。 */
  selectedAcceptedContextKinds?: string[];
}

/**
 * 从 Binding 冻结合同构建允许外发的 InvocationContextBundle。
 *
 * base route（无 Agent Contract）→ null：不读取合同、不执行 Agent 级 Enrichment。
 */
export async function buildBoundAgentInvocationContext(
  input: BuildBoundAgentInvocationContextInput,
): Promise<InvocationContextBundle | null> {
  const contract = await resolveBindingContextContract({
    tenantId: input.tenantId,
    agentContractSnapshotId: input.binding.agentContractSnapshotId,
    agentContextDigest: input.binding.agentContextDigest,
  });
  if (contract === null) {
    // Base Harness（agentRevisionId=null）：Agent=0 不执行 Agent 级 Context Contract。
    return null;
  }
  const environment: PlatformContextEnvironment = {
    tenantId: input.tenantId,
    executionSubject: input.executionSubject,
    now: input.now,
    timezone: input.platform?.timezone ?? null,
    locale: input.platform?.locale ?? null,
    conversationContextRef: input.platform?.conversationContextRef ?? null,
    attachmentRefs: input.platform?.attachmentRefs,
    workspaceContextRef: input.platform?.workspaceContextRef ?? null,
  };
  return buildInvocationContextBundle({
    contract,
    environment,
    policyFilter: input.policyFilter ?? externalAgentContextPolicyFilter(),
    ...(input.selectedAcceptedContextKinds
      ? { selectedAcceptedContextKinds: input.selectedAcceptedContextKinds }
      : {}),
  });
}
