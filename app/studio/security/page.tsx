"use client";

import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsLinkRow,
  StudioSettingsRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";
import { useStudioContext } from "@/components/studio/studio-shell";

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
 *
 * 门禁（studio.access）由 StudioShell 统一承担（页面数据 API 化）；
 * auth-center 管理台地址来自 /studio/api/context（服务端环境注入）。
 */
export default function SecurityPage() {
  const { authCenterBaseUrl } = useStudioContext();
  const authCenterConsoleUrl = authCenterBaseUrl ? `${authCenterBaseUrl}/console/settings` : "";

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
        <StudioSettingsRow
          title="成员角色"
          description="用户、用户组与后台角色已迁移至统一身份中心（auth-center）管理。"
        >
          {authCenterConsoleUrl ? (
            <a
              href={authCenterConsoleUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-[10px] border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              前往管理台 ↗
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">未配置身份中心地址</span>
          )}
        </StudioSettingsRow>
        <StudioSettingsLinkRow
          href="/studio/audit"
          title="操作记录"
          description="查看后台敏感操作及其执行结果。"
        />
      </StudioSettingsSection>
    </StudioPage>
  );
}
