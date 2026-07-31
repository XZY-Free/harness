import { AgentsViewer } from "@/components/studio/agents-viewer";
import { StudioGatePage } from "@/components/studio/gate-page";
import { ProvidersViewer } from "@/components/studio/providers-viewer";
import { listAgents, listProviders } from "@/lib/db/queries";
import { hasPermission } from "@/lib/rbac";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";
import Link from "next/link";

/**
 * Agent Studio 资源档案页。
 *
 * 合并原 /studio/agents 与 /studio/providers:两者都是只读配置档案,形态一致,
 * 合到一个 tab 页减少导航项。tab 级权限:agent.read / provider.read,无权限的 tab 不显示。
 */
export const dynamic = "force-dynamic";

type TabKey = "agents" | "providers";

const TAB_LABEL: Record<TabKey, string> = {
  agents: "智能体",
  providers: "模型提供方",
};

export default async function ResourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const [canReadAgents, canReadProviders] = await Promise.all([
    hasPermission(gate.user.id, "agent.read"),
    hasPermission(gate.user.id, "provider.read"),
  ]);

  const tabs: TabKey[] = [];
  if (canReadAgents) tabs.push("agents");
  if (canReadProviders) tabs.push("providers");

  const sp = await searchParams;
  const requested = sp.tab as TabKey | undefined;
  const tab: TabKey = requested && tabs.includes(requested) ? requested : (tabs[0] ?? "agents");

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">资源</h1>

      {tabs.length === 0 ? (
        <p className="mt-4 text-[13px] text-[var(--fg-muted)]">无可见资源档案。</p>
      ) : (
        <>
          {/* tab 导航 */}
          <div className="mt-4 flex gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-0.5 text-[13px]">
            {tabs.map((t) => {
              const active = t === tab;
              return (
                <Link
                  key={t}
                  href={`/studio/resources?tab=${t}`}
                  className={`rounded-[var(--radius-sm)] px-3 py-1.5 ${
                    active
                      ? "bg-[var(--accent-soft)] text-[var(--primary)] font-medium"
                      : "text-[var(--fg-muted)] hover:text-[var(--fg)]"
                  }`}
                >
                  {TAB_LABEL[t]}
                </Link>
              );
            })}
          </div>

          <div className="mt-4">
            {tab === "agents" && canReadAgents && (
              <>
                <p className="mb-2 text-[13px] text-[var(--fg-muted)]">
                  agent 档案只读展示（模型 + skill 绑定）。仅档案存储,不接 runtime 执行链。
                </p>
                <AgentsViewer agents={await listAgents()} />
              </>
            )}
            {tab === "providers" && canReadProviders && (
              <>
                <p className="mb-2 text-[13px] text-[var(--fg-muted)]">
                  LLM 提供方档案只读展示。apiKeyRef 为 env 引用名（不落明文）；仅档案存储,不接
                  runtime。
                </p>
                <ProvidersViewer providers={await listProviders()} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
