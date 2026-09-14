import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { checkActionScope, checkServiceActionScope } from "./authorization";
export class AgentCallPermissionError extends Error {
  readonly code = "ACTION_SCOPE_DENIED";
  constructor() {
    super("当前身份无权使用此智能体，权限可能已被撤销。");
  }
}
export async function assertAgentSubjectPermission(
  tenantId: string,
  agentId: string,
  subject: ExecutionSubject,
) {
  if (subject.tenantId !== tenantId) throw new AgentCallPermissionError();
  const request = {
    actionCode: "agent.invoke" as const,
    resource: { type: "agent" as const, id: agentId },
  };
  const decision =
    subject.subjectType === "user"
      ? await checkActionScope(tenantId, subject.subjectId, request)
      : checkServiceActionScope(subject.subjectId, request);
  if (!decision.allowed) throw new AgentCallPermissionError();
}
/** 恢复和重试必须从持久化执行绑定恢复用户，不接受请求自报身份。 */
export async function assertAgentInvocationPermission(
  tenantId: string,
  invocationId: string,
  agentId: string,
  outboundSubject?: ExecutionSubject | null,
) {
  const binding = await getExecutionBindingByInvocation(tenantId, invocationId);
  if (!binding) throw new AgentCallPermissionError();
  if (
    outboundSubject &&
    (outboundSubject.tenantId !== tenantId ||
      outboundSubject.subjectId !== binding.executionSubjectId ||
      outboundSubject.subjectType !== binding.executionSubjectType)
  )
    throw new AgentCallPermissionError();
  await assertAgentSubjectPermission(tenantId, agentId, {
    tenantId,
    subjectId: binding.executionSubjectId,
    subjectType: binding.executionSubjectType,
  });
}
