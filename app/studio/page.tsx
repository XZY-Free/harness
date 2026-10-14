"use client";

import { useApiData } from "@/components/hooks/use-api-data";
import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";
import { t } from "@/lib/i18n";

/** 技能列表 wire 行（仅取计数所需字段）。 */
interface SkillListWireRow {
  readonly lifecycleState: string;
}

/**
 * Agent Studio 总览。
 *
 * 客户端聚合仪表盘（正式 Skill / Agent 视角）：
 * - 资源计数：skills(enabled) / agents。
 * 数据来自 /studio/api/skills 与 /admin/api/agents；门禁由 StudioShell 承担。
 *
 * 旧 analytics 面板已随本地执行体系移除；旧 legacy threads/artifacts 段已随
 * Studio threads 页移除（P2-delete）；正式 Policy Revision 由 /studio/governance 承接。
 */
export default function StudioOverviewPage() {
  const skillsState = useApiData<SkillListWireRow[]>("/studio/api/skills");
  const agentsState = useApiData<{ total: number }>("/admin/api/agents");

  // listSkills + activeOnly 语义：以 enabled 计数（与原 server 版一致）。
  const skillCount = (skillsState.data ?? []).filter(
    (skill) => skill.lifecycleState === "enabled",
  ).length;
  const agentCount = agentsState.data?.total ?? 0;
  const loading = skillsState.loading || agentsState.loading;

  return (
    <StudioPage title={t("studio.overview.title")} description="查看当前组织可用的智能体与技能。">
      <StudioSettingsSection title={t("studio.overview.section.resources")}>
        <StudioSettingsRow title="启用中的技能" description={`技能库共 ${skillCount} 条记录`}>
          <span className="text-sm font-medium tabular-nums text-foreground">
            {loading ? "…" : skillCount}
          </span>
        </StudioSettingsRow>
        <StudioSettingsRow title="智能体" description="当前组织内已登记的智能体">
          <span className="text-sm font-medium tabular-nums text-foreground">
            {loading ? "…" : agentCount}
          </span>
        </StudioSettingsRow>
      </StudioSettingsSection>
    </StudioPage>
  );
}
