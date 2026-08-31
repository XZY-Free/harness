import { StudioGatePage } from "@/components/studio/gate-page";
import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsLinkRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * 统一管理后台 — 安全与审计页（S11-W01 整合）。
 *
 * 一级导航「安全与审计」整合原 /studio/audit + /studio/policies + 权限规则 +
 * Credential 引用 + Legal Hold + 删除请求。本页提供入口聚合，
 * S11-W08 将扩展并发控制、导出审计与端到端验证。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 *   「安全与审计」：Policy、Permission、Credential 引用、Effect、Audit 和事件处置
 */
export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  return (
    <StudioPage
      title="安全与审计"
      description="管理运行保护、工具权限和后台操作记录。访问凭证的原始内容不会在界面中展示。"
    >
      <StudioSettingsSection title="安全策略">
        <StudioSettingsLinkRow
          href="/studio/governance"
          title="运行保护"
          description="设置受保护路径、受限命令和交付前检查。"
        />
        <StudioSettingsLinkRow
          href="/studio/permission-rules"
          title="工具权限"
          description="决定工具执行时允许、等待确认或阻止。"
        />
      </StudioSettingsSection>
      <StudioSettingsSection title="访问与记录">
        <StudioSettingsLinkRow
          href="/studio/settings"
          title="成员角色"
          description="为现有成员分配后台角色模板。"
        />
        <StudioSettingsLinkRow
          href="/studio/audit"
          title="操作记录"
          description="查看后台敏感操作及其执行结果。"
        />
      </StudioSettingsSection>
    </StudioPage>
  );
}
