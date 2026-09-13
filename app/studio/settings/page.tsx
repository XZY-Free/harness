import { AppearanceSetting } from "@/components/studio/appearance-setting";
import { StudioGatePage } from "@/components/studio/gate-page";
import { SettingsUserRoleManager } from "@/components/studio/settings-user-role-manager";
import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";
import { listSettingsUserRolesView } from "@/lib/identity/settings-queries";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * Agent Studio Settings 页（关口02 02-2c）。
 *
 * 页级守卫 `user.manage`。Settings 只管理已有用户的角色模板绑定（物化为 grant）：
 * 不创建/删除用户，不创建/删除角色模板，不编辑权限。
 * 外观（主题）偏好为浏览器本地设置，随侧栏改版 v3 从导航槽位迁入本页。
 * server component 取 users + 角色模板 + 当前用户 id，传给 client manager。
 */
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const gate = await requireStudioPagePermission("user.manage");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const view = await listSettingsUserRolesView(gate.principal.tenantId);

  return (
    <StudioPage
      title="平台设置"
      description="管理现有成员的后台角色。角色本身及其权限范围由平台统一维护。"
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
        <StudioSettingsSection title="成员与角色" description="选择成员后查看或调整其角色模板。">
          <SettingsUserRoleManager
            currentUserId={gate.principal.userIdentityId}
            users={view.users}
            roles={view.roles}
          />
        </StudioSettingsSection>
      </div>
    </StudioPage>
  );
}
