import { StudioGatePage } from "@/components/studio/gate-page";
import { PromptDiff } from "@/components/studio/prompt-diff";
import { SkillDeleteButton } from "@/components/studio/skill-delete-button";
import { SkillFileEditor } from "@/components/studio/skill-file-editor";
import { SkillSyncMeta } from "@/components/studio/skill-sync-meta";
import { SkillVersionTimeline } from "@/components/studio/skill-version-timeline";
import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";
import { getSkillById } from "@/lib/capability/skill-queries";
import { getSkillSyncInfo, listSkillVersions } from "@/lib/capability/skill-studio-queries";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const LIFECYCLE_LABEL: Record<string, string> = {
  draft: "草稿",
  enabled: "可用",
  disabled: "已归档",
  retired: "已停用",
};

const VISIBILITY_LABEL: Record<string, string> = {
  tenant: "组织内可见",
  internal: "员工可用",
  owner: "仅负责人可见",
};

export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const gate = await requireStudioPagePermission("skill.read");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const { tenantId } = gate.principal;
  const { id } = await params;
  const skill = await getSkillById({ tenantId, skillId: id });
  if (!skill) notFound();

  const versions = await listSkillVersions(tenantId, id);
  const canWrite = await hasStudioAction(gate.principal, "skill.write");
  const isSynced = skill.sourceType === "capability_market";
  const effectiveCanWrite = canWrite && !isSynced;
  const syncInfo = isSynced ? await getSkillSyncInfo(tenantId, id) : null;

  return (
    <StudioPage
      title={skill.displayName || skill.skillKey}
      description={
        <div className="space-y-1">
          <p>{skill.description ?? "暂无描述"}</p>
          <p className="text-xs">
            {LIFECYCLE_LABEL[skill.lifecycleState] ?? "状态未知"} ·{" "}
            {VISIBILITY_LABEL[skill.visibilityScope] ?? "可见范围未知"} ·{" "}
            {isSynced ? "技能库同步，只读" : "本地创建"}
          </p>
          {skill.displayName && skill.displayName !== skill.skillKey && (
            <p className="font-mono text-xs">技能标识：{skill.skillKey}</p>
          )}
        </div>
      }
      actions={
        effectiveCanWrite ? (
          <SkillDeleteButton skillId={skill.id} skillName={skill.displayName || skill.skillKey} />
        ) : null
      }
      width="wide"
    >
      {isSynced && (
        <StudioSettingsSection
          title="同步信息"
          description="该技能由技能库统一维护，当前页面只提供查看和停止同步。"
        >
          {syncInfo ? (
            <SkillSyncMeta
              skillId={skill.id}
              skillName={skill.displayName || skill.skillKey}
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
          ) : (
            <StudioSettingsRow
              title="同步状态暂不可用"
              description="未找到这项技能的同步记录，请返回列表重新同步。"
            />
          )}
        </StudioSettingsSection>
      )}

      <StudioSettingsSection
        title="版本记录"
        description="查看历史版本，并在需要时恢复或重新设为当前版本。"
      >
        <SkillVersionTimeline
          skillId={skill.id}
          versions={versions.map((version) => ({
            id: version.id,
            version: version.versionNo,
            status: version.revisionState,
            createdAt: version.createdAt,
            commitSha: version.contentRef,
          }))}
          currentVersionId={skill.currentVersionId}
          canWrite={effectiveCanWrite}
        />
      </StudioSettingsSection>

      <SkillFileEditor
        skillId={skill.id}
        skillName={skill.displayName || skill.skillKey}
        canWrite={effectiveCanWrite}
      />

      <StudioSettingsSection
        title="版本内容对比"
        description="选择两个版本，逐行查看工作说明发生的变化。"
      >
        <div className="p-4">
          <PromptDiff
            versions={versions.map((version) => ({
              id: version.id,
              version: version.versionNo,
              promptTemplate: version.manifestJson ? JSON.stringify(version.manifestJson) : null,
            }))}
          />
        </div>
      </StudioSettingsSection>
    </StudioPage>
  );
}
