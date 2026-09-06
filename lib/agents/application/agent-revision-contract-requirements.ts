import type { HostControlCapabilityPolicy } from "@/lib/agents/calls/transport/a2a/host-control-contract";
import type { EnterpriseUserAccessPolicy } from "@/lib/identity/enterprise-user-access-policy";

/** AgentRevision 声明与不可变 AgentContractSnapshot 不一致时的稳定失败。 */
export class AgentRevisionContractRequirementsError extends Error {
  readonly code = "agent_revision_contract_requirements_mismatch";

  constructor(message: string) {
    super(`AgentRevision 接口要求与冻结合同不一致：${message}`);
    this.name = "AgentRevisionContractRequirementsError";
  }
}

/**
 * 只校验声明与冻结合同是否相容，不修改合同、不在运行时补写 context/capability。
 * 创建 Revision 时调用；运行时也可复用此函数拒绝历史不一致数据。
 */
export function assertAgentRevisionContractRequirements(params: {
  enterprisePolicy: EnterpriseUserAccessPolicy;
  hostControlPolicy: HostControlCapabilityPolicy;
  contexts: readonly { key: string; necessity: string }[];
  interaction: { inputRequired: boolean; resume: boolean };
}): void {
  if (params.enterprisePolicy.profileRequirement !== "none") {
    const enterpriseContext = params.contexts.find(
      (context) => context.key === "enterprise_user_context",
    );
    if (!enterpriseContext || enterpriseContext.necessity !== "required") {
      throw new AgentRevisionContractRequirementsError(
        "enterprise_user_context 非 none 时合同必须显式声明 required enterprise_user_context",
      );
    }
  }

  if (
    params.hostControlPolicy.confirmationActionKeys.length > 0 &&
    (!params.interaction.inputRequired || !params.interaction.resume)
  ) {
    throw new AgentRevisionContractRequirementsError(
      "声明 confirmation 时合同必须同时支持 input-required 与 resume",
    );
  }
}
