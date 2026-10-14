"use client";

import { useApiData } from "@/components/hooks/use-api-data";
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
import { useStudioContext } from "@/components/studio/studio-shell";
import { snapshotAllowsTenantAction } from "@/lib/client/studio-permissions";
import { useParams } from "next/navigation";

/** GET /studio/api/skills/[id] 响应（wire 形状）。 */
interface SkillDetailWire {
  skill: {
    id: string;
    skillKey: string;
    displayName: string | null;
    description: string | null;
    sourceType: string;
    lifecycleState: string;
    visibilityScope: string;
    currentVersionId: string | null;
  };
  currentVersion: unknown;
  syncInfo: {
    syncState: string;
    remoteAssetId: string;
    remoteName: string | null;
    remoteDisplayName: string | null;
    remoteVersion: string | null;
    remoteContentHash: string | null;
    lastSyncedAt: string | null;
    lastError: string | null;
  } | null;
}

/** GET /studio/api/skills/[id]/versions 行（wire 形状）。 */
interface SkillVersionWire {
  readonly id: string;
  readonly versionNo: number;
  readonly revisionState: string;
  readonly createdAt: string;
  readonly contentRef: string | null;
  readonly manifestJson: unknown;
}

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

/**
 * Studio 技能详情页（页面数据 API 化）。
 *
 * - 数据来自 GET /studio/api/skills/[id] 与 /versions（服务端 skill.read 守卫；403 → 门禁页）。
 * - skill.write 决定写入口显隐（快照轻量断言）；同步技能只读（服务端兜底）。
 */
export default function SkillDetailPage() {
  const { snapshot } = useStudioContext();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const canWrite = snapshotAllowsTenantAction(snapshot, "skill.write");

  const detail = useApiData<SkillDetailWire>(`/studio/api/skills/${id}`);
  const versionsState = useApiData<SkillVersionWire[]>(`/studio/api/skills/${id}/versions`);

  if (detail.httpStatus === 404) {
    return <StudioGatePage status={404} message="技能不存在或已删除。" />;
  }
  if (detail.httpStatus !== null && detail.httpStatus !== 404) {
    return (
      <StudioGatePage
        status={detail.httpStatus === 0 ? 500 : detail.httpStatus}
        message={detail.errorMessage ?? "加载失败，请稍后重试"}
      />
    );
  }
  if (detail.loading || !detail.data) {
    return (
      <StudioPage title="技能" description="正在加载…" width="wide">
        <div className="rounded-xl border border-border bg-card px-5 py-10 text-center text-sm text-muted-foreground">
          正在加载…
        </div>
      </StudioPage>
    );
  }

  const { skill, syncInfo } = detail.data;
  const versions = versionsState.data ?? [];
  const isSynced = skill.sourceType === "capability_market";
  const effectiveCanWrite = canWrite && !isSynced;

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
                  ? new Date(syncInfo.lastSyncedAt).toLocaleString("zh-CN", { hour12: false })
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
