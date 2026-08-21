import { ApprovalPanel } from "@/components/studio/approval-panel";
import { ContextManifestPanel } from "@/components/studio/context-manifest-panel";
import { DeliveryPanel } from "@/components/studio/delivery-panel";
import { DeploymentPanel } from "@/components/studio/deployment-panel";
import { ExternalToolsPanel } from "@/components/studio/external-tools-panel";
import { MemoryPanel } from "@/components/studio/memory-panel";
import { QaPanel } from "@/components/studio/qa-panel";
import { RuntimeCapabilityPanel } from "@/components/studio/runtime-capability-panel";
import { ThreadAutoRefresh } from "@/components/studio/thread-auto-refresh";
import { ThreadPlanPanel } from "@/components/studio/thread-plan-panel";
import { ThreadTimeline } from "@/components/studio/thread-timeline";
import { ToolTrace } from "@/components/studio/tool-trace";
import { WorkspaceExplorer } from "@/components/studio/workspace-explorer";
import {
  getActiveThreadPlan,
  getThreadById,
  listCheckpointsByThread,
  listContextSnapshotsForThread,
  listDeploymentsByThread,
  listExternalFetchedEvents,
  listQaEventsByThread,
  listSummariesByThread,
  listThreadEvents,
  listThreadPlanItems,
  requireThreadForUser,
} from "@/lib/db/queries";
import {
  listArtifactsForThread,
  listEventsForThread,
  listToolRunsForThread,
} from "@/lib/db/studio-queries";
import { hasStudioAction, resolveStudioPrincipal } from "@/lib/identity/studio-access";
import { resolveRuntimes } from "@/lib/runtime/registry";
import { listWorkspaceFiles } from "@/lib/workspace";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

/**
 * Agent Studio Thread 详情（Phase 4-4 Stage D，只读）。
 *
 * 合并原 /studio/workspaces/[threadId]（文件管理）到本页「文件」tab——
 * 一个会话的执行过程 + 产物 + 工作区文件统一在此查看,不再三页跳转。
 *
 * member → requireThreadForUser（foreign → notFound，不泄露）；admin → getThreadById。
 * tab 用 searchParams 切换（可分享链接）；「文件」tab 需 workspace.read,无则不显示。
 */
export const dynamic = "force-dynamic";

// P2 i18n: STATUS_LABEL 改用 lib/i18n 共享字典,后续逐步迁移其余硬编码文案。
import { STATUS_LABEL as STATUS_LABEL_DICT } from "@/lib/i18n";
const STATUS_LABEL = STATUS_LABEL_DICT.zh;

type TabKey =
  | "overview"
  | "timeline"
  | "tools"
  | "artifacts"
  | "files"
  | "context"
  | "delivery"
  | "deployments"
  | "external"
  | "qa";

const TAB_LABEL: Record<TabKey, string> = {
  overview: "概览",
  timeline: "时间线",
  tools: "工具调用",
  artifacts: "产物",
  files: "文件",
  context: "上下文",
  delivery: "交付",
  deployments: "部署",
  external: "外部",
  qa: "QA 证据",
};

export default async function ThreadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const principal = await resolveStudioPrincipal(await headers());
  const canAll = await hasStudioAction(principal, "thread.read");
  const canReadWorkspace = await hasStudioAction(principal, "workspace.read");
  const canWriteWorkspace = await hasStudioAction(principal, "workspace.write");

  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, principal.userIdentityId);
  if (!thread) notFound();

  // 可见 tab 集合（「文件」tab 需 workspace.read）
  const tabs: TabKey[] = canReadWorkspace
    ? [
        "overview",
        "timeline",
        "tools",
        "artifacts",
        "files",
        "context",
        "delivery",
        "deployments",
        "external",
        "qa",
      ]
    : [
        "overview",
        "timeline",
        "tools",
        "artifacts",
        "context",
        "delivery",
        "deployments",
        "external",
        "qa",
      ];
  const requested = sp.tab as TabKey | undefined;
  const tab: TabKey = requested && tabs.includes(requested) ? requested : "overview";
  // 无权限访问「文件」tab → 回概览
  if (requested === "files" && !canReadWorkspace) redirect(`/studio/threads/${id}`);

  // 按当前 tab 取数（文件 tab 才读工作区,避免无谓 IO）
  const [events, toolRuns, artifacts] = await Promise.all([
    listEventsForThread(id),
    listToolRunsForThread(id),
    listArtifactsForThread(id),
  ]);
  const files = tab === "files" ? await listWorkspaceFiles(id) : [];
  // V3.0 Stage E：上下文 tab 才读 context snapshot / plan，避免无谓 IO
  const snapshots = tab === "context" ? await listContextSnapshotsForThread(id, 5) : [];
  const activePlan = tab === "context" ? await getActiveThreadPlan(id) : null;
  const planItems =
    tab === "context" && activePlan ? await listThreadPlanItems(id, activePlan.id) : [];
  // V3.3a Stage E：压缩版本历史（含 supersede 链）
  const summaries =
    tab === "context"
      ? await listSummariesByThread(id, { limit: 50, includeSuperseded: true })
      : [];
  // V3.7 Stage E：交付 tab 才读 delivery 事件 + checkpoint，避免无谓 IO
  const deliveryEvents = tab === "delivery" ? await listThreadEvents(id) : [];
  const deliverySummary =
    tab === "delivery"
      ? ([...deliveryEvents].reverse().find((e) => e.type === "delivery.succeeded")?.payload ??
        null)
      : null;
  const checkpoints = tab === "delivery" ? await listCheckpointsByThread(id) : [];
  // V3.4 Stage E：外部 tab 才读 external.fetched 审计事件，避免无谓 IO
  const externalEvents = tab === "external" ? await listExternalFetchedEvents(id) : [];
  // V3.6 Stage E：QA tab 才读 QA 事件，避免无谓 IO
  const qaEvents = tab === "qa" ? await listQaEventsByThread(id) : [];
  // V3.8 Stage E：部署 tab 才读部署记录 + runtime capability，避免无谓 IO
  const deployments = tab === "deployments" ? await listDeploymentsByThread(id) : [];
  const runtimeHandle =
    tab === "deployments"
      ? resolveRuntimes(id, (thread.runtimeType ?? undefined) as "host" | "container" | undefined)
      : null;

  return (
    <div>
      <h1 className="text-[18px] font-semibold text-[var(--fg)]">
        {thread.title || <span className="font-mono text-[var(--fg-muted)]">{thread.id}</span>}
      </h1>
      <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
        状态 {STATUS_LABEL[thread.status] ?? thread.status}
        <ThreadAutoRefresh status={thread.status} threadId={thread.id} />
        {" · "}
        创建 {new Date(thread.createdAt).toLocaleString()}
      </p>

      {/* tab 导航 */}
      <div className="mt-4 flex gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-0.5 text-[13px]">
        {tabs.map((t) => {
          const active = t === tab;
          return (
            <Link
              key={t}
              href={`/studio/threads/${id}${t === "overview" ? "" : `?tab=${t}`}`}
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

      <section className="mt-4">
        {tab === "overview" && (
          <div className="flex flex-col gap-4">
            {thread.status === "awaiting_approval" && (
              <div className="rounded-[var(--radius)] border border-[var(--primary)] bg-[var(--accent-soft)] p-4">
                <h2 className="mb-2 text-[14px] font-medium text-[var(--primary)]">待审批操作</h2>
                <ApprovalPanel threadId={id} />
              </div>
            )}
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px] text-[var(--fg-muted)]">
              <div>状态:{STATUS_LABEL[thread.status] ?? thread.status}</div>
              <div className="mt-1">创建时间:{new Date(thread.createdAt).toLocaleString()}</div>
              <div className="mt-1">预览:{thread.previewUrl ?? "—"}</div>
            </div>
          </div>
        )}
        {tab === "timeline" && <ThreadTimeline events={events} />}
        {tab === "tools" && <ToolTrace toolRuns={toolRuns} />}
        {tab === "artifacts" && (
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
            {artifacts.length === 0 ? (
              <div className="text-[13px] text-[var(--fg-muted)]">无产物。</div>
            ) : (
              <pre className="overflow-auto text-[12px] text-[var(--fg-muted)]">
                {artifacts.map((a) => JSON.stringify(a.payload, null, 2)).join("\n---\n")}
              </pre>
            )}
          </div>
        )}
        {tab === "files" && (
          <div>
            <p className="mb-2 text-[12px] text-[var(--fg-subtle)]">
              工作区文件管理 · {canWriteWorkspace ? "可读写" : "只读"} · {files.length} 个文件
            </p>
            <WorkspaceExplorer threadId={id} files={files} canWrite={canWriteWorkspace} />
          </div>
        )}
        {tab === "context" && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="mb-2 text-[14px] font-medium text-[var(--fg)]">上下文快照</h2>
              <ContextManifestPanel snapshots={snapshots} summaries={summaries} />
            </div>
            <div>
              <h2 className="mb-2 text-[14px] font-medium text-[var(--fg)]">长期记忆</h2>
              <MemoryPanel threadId={id} />
            </div>
            <div>
              <h2 className="mb-2 text-[14px] font-medium text-[var(--fg)]">计划 / Todo</h2>
              <ThreadPlanPanel plan={activePlan} items={planItems} />
            </div>
          </div>
        )}
        {tab === "delivery" && (
          <DeliveryPanel
            summary={deliverySummary as import("@/lib/delivery/summary").DeliverySummary | null}
            checkpoints={checkpoints.map((c) => ({
              id: c.id,
              tag: c.tag,
              commitSha: c.commitSha,
              reason: c.reason,
              restoredAt: c.restoredAt,
              createdAt: c.createdAt,
            }))}
          />
        )}
        {tab === "external" && <ExternalToolsPanel threadId={id} externalEvents={externalEvents} />}
        {tab === "deployments" && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="mb-2 text-[14px] font-medium text-[var(--fg)]">Runtime 能力</h2>
              <RuntimeCapabilityPanel capability={runtimeHandle?.capability} />
            </div>
            <div>
              <h2 className="mb-2 text-[14px] font-medium text-[var(--fg)]">部署历史</h2>
              <DeploymentPanel
                deployments={deployments.map((d) => ({
                  id: d.id,
                  environment: d.environment,
                  commitSha: d.commitSha,
                  imageTag: d.imageTag,
                  cicdJobId: d.cicdJobId,
                  cicdJobUrl: d.cicdJobUrl,
                  status: d.status,
                  previousDeploymentId: d.previousDeploymentId,
                  deployedAt: d.deployedAt,
                  rolledBackAt: d.rolledBackAt,
                  errorMessage: d.errorMessage,
                  createdAt: d.createdAt,
                }))}
              />
            </div>
          </div>
        )}
        {tab === "qa" && (
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <QaPanel threadId={id} events={qaEvents} />
          </div>
        )}
      </section>
    </div>
  );
}
