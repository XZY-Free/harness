import { StudioGatePage } from "@/components/studio/gate-page";
import { SettingsUserRoleManager } from "@/components/studio/settings-user-role-manager";
import { listRolesWithPermissions, listUsersWithRoles } from "@/lib/db/queries";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * Agent Studio Settings 页（Phase 4-4 切片 B3）。
 *
 * 页级守卫 `user.manage`。Settings 只管理已有用户的系统角色绑定：
 * 不创建/删除用户，不创建/删除角色，不编辑 RolePermission。
 * server component 取 users + roles + 当前用户 id，传给 client manager。
 */
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const gate = await requireStudioPagePermission("user.manage");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const [users, roles] = await Promise.all([listUsersWithRoles(), listRolesWithPermissions()]);

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">设置</h1>
      <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
        管理已有用户的系统角色绑定。不创建/删除用户与角色，不编辑角色权限。
      </p>
      <div className="mt-4">
        <SettingsUserRoleManager currentUserId={gate.user.id} users={users} roles={roles} />
      </div>
    </div>
  );
}
