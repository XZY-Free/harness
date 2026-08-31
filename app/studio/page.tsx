import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";
import { listAgents } from "@/lib/agents/persistence/agent-queries";
import { listSkills } from "@/lib/capability/skill-studio-queries";
import { resolvePrincipal } from "@/lib/identity/resolver";
import { headers } from "next/headers";

/**
 * Agent Studio 总览。
 *
 * 全 server component,只读聚合仪表盘（正式 Skill / Agent 视角）：
 * - 资源计数:skills(active)/ agents。
 *
 * 门禁 = studio.access(layout 已保证)。旧 analytics 面板已随本地执行体系移除；
 * 旧 legacy threads/artifacts 段已随 Studio threads 页移除（P2-delete）；
 * 旧 legacy PolicyConfig KV 策略摘要段已随 02-6 P9 legacy 物理删除移除——
 * 正式 Policy Revision 的查看/编辑由 /studio/governance 承接。
 * 正式执行指标由管理控制面（admin Invocation/Job 排障页）提供。
 */
export const dynamic = "force-dynamic";

// P2 i18n: 共享字典（STATUS_LABEL 已随 legacy threads 段移除）。
import { t } from "@/lib/i18n";

export default async function StudioOverviewPage() {
  const requestHeaders = await headers();
  const adminPrincipal = await resolvePrincipal(requestHeaders, "admin");

  const [skills, agents] = await Promise.all([
    listSkills(adminPrincipal.tenantId, undefined, { activeOnly: true }),
    listAgents(adminPrincipal.tenantId),
  ]);

  // listSkills(activeOnly=true) 已只返回 lifecycleState=enabled 的 skill
  const activeSkills = skills.length;

  return (
    <StudioPage title={t("studio.overview.title")} description="查看当前组织可用的智能体与技能。">
      <StudioSettingsSection title={t("studio.overview.section.resources")}>
        <StudioSettingsRow title="启用中的技能" description={`技能库共 ${skills.length} 条记录`}>
          <span className="text-sm font-medium tabular-nums text-foreground">{activeSkills}</span>
        </StudioSettingsRow>
        <StudioSettingsRow title="智能体" description="当前组织内已登记的智能体">
          <span className="text-sm font-medium tabular-nums text-foreground">{agents.length}</span>
        </StudioSettingsRow>
      </StudioSettingsSection>
    </StudioPage>
  );
}
