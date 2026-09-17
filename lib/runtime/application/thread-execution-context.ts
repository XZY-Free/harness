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
import { resolveWorkspaceBindingId } from "@/lib/workspace/desktop-workspace-queries";

export interface ThreadWorkspaceFacts {
  /** Thread 冻结的真实 WorkspaceBinding（null = 没有可用绑定）。 */
  workspaceBindingId: string | null;
  /** Thread 声明了 Workspace 但当前解析不到 → 只降级 Workspace 能力，不阻断调度。 */
  workspaceUnavailable: boolean;
}

/**
 * Thread 固定的 Workspace 事实。
 *
 * 桌面绑定冻结：Thread 固定的 Workspace 事实不回滚。设备撤销/绑定失效只降级 Workspace
 * 能力（catalog 记 unavailableFacts），不阻断基础聊天调度。
 */
export async function resolveThreadWorkspaceFacts(
  tenantId: string,
  thread: { defaultWorkspaceId: string | null; ownerUserId: string },
): Promise<ThreadWorkspaceFacts> {
  const workspaceBindingId = thread.defaultWorkspaceId
    ? await resolveWorkspaceBindingId(tenantId, thread.defaultWorkspaceId, thread.ownerUserId)
    : null;
  return {
    workspaceBindingId,
    workspaceUnavailable: Boolean(thread.defaultWorkspaceId) && !workspaceBindingId,
  };
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
