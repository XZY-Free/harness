import { listPermissionManagement } from "./permission-management";
/** 旧成员列表入口读取正式角色关系；不再通过动作签名反推角色。 */
export async function listSettingsUserRolesView(tenantId: string) {
  const view = await listPermissionManagement(tenantId);
  return {
    users: view.users.map((u) => ({
      ...u,
      templateKeys: view.assignments
        .filter((a) => a.principalId === u.principalId && a.source === "local")
        .map((a) => a.roleKey),
    })),
    roles: view.roles.map((r) => ({
      key: r.key,
      name: r.name,
      isSystem: r.isSystem,
      actions: [...new Set(r.grants.map((g) => g.actionCode))],
    })),
  };
}
