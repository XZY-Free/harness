import { StudioGatePage } from "@/components/studio/gate-page";
import { PromptDiff } from "@/components/studio/prompt-diff";
import { SkillDeleteButton } from "@/components/studio/skill-delete-button";
import { SkillFileEditor } from "@/components/studio/skill-file-editor";
import { SkillSyncMeta } from "@/components/studio/skill-sync-meta";
import { SkillVersionTimeline } from "@/components/studio/skill-version-timeline";
import { getSkillById } from "@/lib/db/queries";
import { getSkillSyncInfo, listSkillVersions } from "@/lib/db/studio-queries";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";
import { notFound } from "next/navigation";

/**
 * Agent Studio Skill 详情（Phase 4-4 Stage B + 02 文档 §7.1/§7.2）。
 * server component 取 skill + 版本列表；版本时间线 + prompt diff + 发布/回滚（client）。
 * 同步 Skill（source=capability-market）只读：隐藏删除/编辑/发布回滚按钮,显示同步元数据。
 */
export const dynamic = "force-dynamic";

export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const gate = await requireStudioPagePermission("skill.read");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const { id } = await params;
  const sk = await getSkillById(id);
  if (!sk) notFound();
  const versions = await listSkillVersions(id);
  const canWrite = await hasStudioAction(gate.principal, "skill.write");
  const isSynced = sk.source === "capability-market";
  // 同步 Skill 只读：写按钮一律隐藏（服务端已硬拦截,前端隐藏仅为体验）
  const effectiveCanWrite = canWrite && !isSynced;
  const syncInfo = isSynced ? await getSkillSyncInfo(id) : null;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-[22px] font-semibold text-[var(--fg)]">{sk.name}</h1>
        {effectiveCanWrite && <SkillDeleteButton skillId={sk.id} skillName={sk.name} />}
      </div>
      <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
        {sk.description ?? "（无描述）"} · 状态 {sk.status} · 可见性 {sk.visibility} · 来源{" "}
        {isSynced ? "同步镜像（只读）" : "本地自建"}
      </p>

      {isSynced && syncInfo && (
        <SkillSyncMeta
          skillId={sk.id}
          skillName={sk.name}
          syncState={syncInfo.syncState}
          remoteAssetId={syncInfo.remoteAssetId}
          remoteName={syncInfo.remoteName}
          remoteDisplayName={syncInfo.remoteDisplayName}
          remoteVersion={syncInfo.remoteVersion}
          remoteContentHash={syncInfo.remoteContentHash}
          lastSyncedAt={
            syncInfo.lastSyncedAt
              ? syncInfo.lastSyncedAt.toLocaleString("zh-CN", { hour12: false })
              : null
          }
          lastError={syncInfo.lastError}
        />
      )}

      <section className="mt-6">
        <h2 className="mb-3 text-[15px] font-medium text-[var(--fg)]">版本时间线</h2>
        <SkillVersionTimeline
          skillId={sk.id}
          versions={versions.map((v) => ({
            id: v.id,
            version: v.version,
            status: v.status,
            createdAt: v.createdAt,
            commitSha: v.commitSha,
          }))}
          currentVersionId={sk.currentVersionId}
          canWrite={effectiveCanWrite}
        />
      </section>

      <section className="mt-8">
        <SkillFileEditor skillId={sk.id} skillName={sk.name} canWrite={effectiveCanWrite} />
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-[15px] font-medium text-[var(--fg)]">Prompt Diff</h2>
        <PromptDiff
          versions={versions.map((v) => ({
            id: v.id,
            version: v.version,
            promptTemplate: v.promptTemplate,
          }))}
        />
      </section>
    </div>
  );
}
