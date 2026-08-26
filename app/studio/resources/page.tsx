import { AgentContractRegistrationPanel } from "@/components/studio/agent-contract-registration-panel";
import { AgentsRevisionSection } from "@/components/studio/agent-revision-section";
import { AgentRuntimeRegistrationPanel } from "@/components/studio/agent-runtime-registration-panel";
import { AgentsViewer } from "@/components/studio/agents-viewer";
import { StudioGatePage } from "@/components/studio/gate-page";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * Studio 智能体控制面资源页（07 §4–§8）。
 *
 * 信息架构不变：合同登记 / Revision 操作 / Runtime 登记面板挂载在本页，
 * 全部经 control-plane-client 走正式 Admin API，UI 不是最终授权。
 */
export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const canReadAgents = await hasStudioAction(gate.principal, "agent.read");
  const canRegisterContract = await hasStudioAction(gate.principal, "agent.contract.register");
  const canManageRevisions = await hasStudioAction(gate.principal, "agent.revision.create");
  const canRegisterRuntime = await hasStudioAction(gate.principal, "agent.runtime.register");

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">资源</h1>

      {!canReadAgents ? (
        <p className="mt-4 text-[13px] text-[var(--fg-muted)]">无可见资源档案。</p>
      ) : (
        <div className="mt-4">
          <p className="mb-2 text-[13px] text-[var(--fg-muted)]">智能体控制面档案与当前修订。</p>
          <AgentsViewer />
        </div>
      )}

      {canRegisterContract && (
        <div className="mt-6">
          <p className="mb-2 text-[13px] text-[var(--fg-muted)]">
            登记外部智能体合同（结构化合同注册，无源码/URL/凭证字段）。
          </p>
          <AgentContractRegistrationPanel />
        </div>
      )}

      {canManageRevisions && canReadAgents && (
        <div className="mt-6">
          <p className="mb-2 text-[13px] text-[var(--fg-muted)]">
            AgentRevision 创建 / 发布 / 撤回。
          </p>
          <AgentsRevisionSection />
        </div>
      )}

      {canRegisterRuntime && canReadAgents && (
        <div className="mt-6">
          <p className="mb-2 text-[13px] text-[var(--fg-muted)]">
            登记外部 Runtime（真实 Conformance 验收；bearer 只能选择已有 CredentialRef）。
          </p>
          <AgentRuntimeRegistrationPanel />
        </div>
      )}
    </div>
  );
}
