/**
 * Thread 执行上下文的共享解析（R01 §1 唯一生产组合层的一部分）。
 *
 * Thread 调度路径（`lib/runtime/dispatcher.ts`）与**关联了 Thread** 的 Job 调度路径
 * （`lib/job/job-admission.ts`）必须用同一份规则得出 WorkspaceBinding 与
 * EnvironmentDefinitionRevision；任何"Job 另写一套"都会造成同一 Thread 下两条执行
 * 语义，因此这两段解析只保留这一份实现。
 */
import {
  getEnvironmentDefinitionById,
  getEnvironmentRevisionById,
} from "@/lib/environment/environment-definition-store";
import { getEffectiveEnvironmentSelection } from "@/lib/environment/environment-selection";
import type { EnvironmentChangeRequest } from "@/lib/persistence/schema/environment-change-request";
import type { EnvironmentDefinitionRevision } from "@/lib/persistence/schema/environment-definition-revision";
import { WorkspaceNotReadyError } from "@/lib/workspace/managed-workspace-host";
import { resolveDeclaredWorkspaceBinding } from "@/lib/workspace/workspace-queries";

export interface ThreadWorkspaceFacts {
  /** Thread 冻结的真实 WorkspaceBinding（null = 没有可用绑定）。 */
  workspaceBindingId: string | null;
  /** Thread 声明了 Workspace 但当前解析不到 → MANAGED 执行必须 fail closed。 */
  workspaceUnavailable: boolean;
}

/**
 * Thread 固定的 Workspace 事实。
 *
 * 声明的 Workspace 通过与 profile 无关的正式合同解析读取（R01 §1）：云端/远端/Sandbox
 * 合同必须在入口就能解析成正式合同，否则同一份声明在不同调用路径下会得到不同的
 * Workspace 语义。设备撤销/绑定失效只让「解析不出」这一事实成立，如何处理由
 * `assertDeclaredWorkspaceReady` 按是否携带平台环境决定。
 */
export async function resolveThreadWorkspaceFacts(
  tenantId: string,
  thread: { defaultWorkspaceId: string | null; ownerUserId: string },
): Promise<ThreadWorkspaceFacts> {
  const binding = thread.defaultWorkspaceId
    ? await resolveDeclaredWorkspaceBinding(
        tenantId,
        thread.defaultWorkspaceId,
        thread.ownerUserId,
      )
    : null;
  return {
    workspaceBindingId: binding?.id ?? null,
    workspaceUnavailable: Boolean(thread.defaultWorkspaceId) && !binding,
  };
}

/**
 * R01 §1 / R07 §4：携带平台环境（MANAGED）的执行必须携带 Thread/Job 声明的真实
 * Workspace 合同。
 *
 * 声明了 Workspace 却解析不出正式合同时必须 fail closed —— 以 `WorkspaceNotReady`
 * 保留可恢复失败事实，**绝不**静默降级成 NO_PLATFORM_WORKSPACE 合同（那会让一次
 * MANAGED 执行在没有声明者同意的情况下丢掉它声明的 Workspace）。NONE 只用于
 * 「没有平台环境、也不携带 Workspace」的执行。
 */
export function assertDeclaredWorkspaceReady(input: {
  environmentRevisionId: string | null;
  workspaceUnavailable: boolean;
}): void {
  if (input.environmentRevisionId && input.workspaceUnavailable) {
    throw new WorkspaceNotReadyError(
      "声明的 Workspace 无法解析为正式合同：MANAGED 执行不得降级为 NO_PLATFORM_WORKSPACE",
    );
  }
}

export interface ResolvedInvocationEnvironment {
  revision: EnvironmentDefinitionRevision | null;
  /** 生效中的 EnvironmentChangeRequest（用于「首次应用记录」；null = 未做过选择）。 */
  selection: EnvironmentChangeRequest | null;
}

/**
 * 冻结本 Invocation 实际使用的 Environment Revision，并带上"生效中的环境选择"。
 *
 * Revision 来源优先级：Thread 生效中的 EnvironmentChangeRequest 明确请求的 Revision >
 * EnvironmentDefinition.currentRevisionId。两者都不可用即 `EnvironmentRevisionUnavailable`
 * （fail-closed，不静默退化成无环境）。
 */
export async function resolveEnvironmentRevisionForInvocation(
  tenantId: string,
  threadId: string,
  environmentDefinitionId: string | null,
): Promise<ResolvedInvocationEnvironment> {
  if (!environmentDefinitionId) return { revision: null, selection: null };
  const definition = await getEnvironmentDefinitionById(tenantId, environmentDefinitionId);
  if (!definition || definition.lifecycleState !== "active")
    throw new Error("EnvironmentRevisionUnavailable");
  const selection = await getEffectiveEnvironmentSelection(tenantId, threadId);
  const revisionId = selection?.requestedRevisionId ?? definition.currentRevisionId;
  if (!revisionId) throw new Error("EnvironmentRevisionUnavailable");
  const revision = await getEnvironmentRevisionById(tenantId, revisionId);
  if (!revision || revision.definitionId !== definition.id)
    throw new Error("EnvironmentRevisionUnavailable");
  return { revision, selection };
}
