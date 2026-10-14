import { AppearanceSetting } from "@/components/studio/appearance-setting";
import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";

/**
 * Agent Studio Settings 页（消费方模型 v4 改造）。
 *
 * 成员与权限（用户 / 角色 / 授权解释器）已整体迁移至统一身份中心 auth-center
 * 的控制台（/console/settings）——本页保留浏览器本地的外观偏好，并为成员与
 * 权限提供跳转入口。页面不再持有任何身份数据与门禁逻辑（权威在 auth-center）。
 */
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const authCenterBase = (process.env.NEX_AUTH_CENTER_URL ?? "").replace(/\/+$/, "");
  const consoleUrl = authCenterBase ? `${authCenterBase}/console/settings` : "";

  return (
    <StudioPage
      title="平台设置"
      description="外观偏好保存在本浏览器；成员与权限在统一身份中心（auth-center）管理。"
    >
      <div className="space-y-8">
        <StudioSettingsSection
          title="外观"
          description="主题偏好保存在本浏览器；跟随系统会实时响应系统深浅色切换。"
        >
          <StudioSettingsRow title="主题" description="默认跟随系统。">
            <AppearanceSetting />
          </StudioSettingsRow>
        </StudioSettingsSection>
        <StudioSettingsSection
          title="成员与权限"
          description="用户、用户组、后台角色与授权解释器已迁移至统一身份中心，变更立即在本平台生效。"
        >
          <StudioSettingsRow
            title="统一身份中心管理台"
            description="登录、用户目录、角色与权限的唯一权威。"
          >
            {consoleUrl ? (
              <a
                href={consoleUrl}
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
        </StudioSettingsSection>
      </div>
    </StudioPage>
  );
}
