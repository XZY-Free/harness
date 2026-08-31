import { StudioGatePage } from "@/components/studio/gate-page";
import { SettingsUserRoleManager } from "@/components/studio/settings-user-role-manager";
import { StudioPage } from "@/components/studio/studio-page";
import { listSettingsUserRolesView } from "@/lib/identity/settings-queries";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * Agent Studio Settings 页（关口02 02-2c）。
 *
 * 页级守卫 `user.manage`。Settings 只管理已有用户的角色模板绑定（物化为 grant）：
 * 不创建/删除用户，不创建/删除角色模板，不编辑权限。
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
      <section aria-label="成员与角色" className="space-y-3">
        <div className="space-y-1 px-0.5">
          <h2 className="text-sm font-semibold text-foreground">成员与角色</h2>
          <p className="text-xs leading-5 text-muted-foreground">
            选择成员后查看或调整其角色模板。
          </p>
        </div>
        <SettingsUserRoleManager
          currentUserId={gate.principal.userIdentityId}
          users={view.users}
          roles={view.roles}
        />
      </section>
    </StudioPage>
  );
}
