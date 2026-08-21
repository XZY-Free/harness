import { AgentsViewer } from "@/components/studio/agents-viewer";
import { StudioGatePage } from "@/components/studio/gate-page";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * Studio 智能体控制面资源页。
 */
export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const canReadAgents = await hasStudioAction(gate.principal, "agent.read");

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
    </div>
  );
}
