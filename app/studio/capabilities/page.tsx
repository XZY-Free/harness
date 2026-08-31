import { StudioGatePage } from "@/components/studio/gate-page";
import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsLinkRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * 统一管理后台 — 能力与知识页（S11-W01 占位）。
 *
 * 一级导航「能力与知识」整合原 /studio/resources + /studio/skills + /studio/artifacts。
 * 本页为 S11-W01 重组后的着陆页，提供到现有子页面的入口；
 * S11-W03 将在此页直接渲染 Skill / Tool / Knowledge / Connection 一体化管理。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 *   「能力与知识」：Skill、Tool、Knowledge、模型、连接、来源和风险变化
 */
export const dynamic = "force-dynamic";

export default async function CapabilitiesPage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  return (
    <StudioPage title="能力与知识" description="管理员工工作时可以使用的技能与智能体。">
      <StudioSettingsSection title="可用能力">
        <StudioSettingsLinkRow
          href="/studio/skills"
          title="技能"
          description="维护技能内容、版本和发布状态。"
        />
        <StudioSettingsLinkRow
          href="/studio/agents"
          title="智能体"
          description="登记智能体，管理版本与员工侧发布。"
        />
      </StudioSettingsSection>
    </StudioPage>
  );
}
