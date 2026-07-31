-- Phase 4-4 切片 B2：回填 workspace.read / workspace.write 权限到 admin / member 角色。
-- 幂等：ON DUPLICATE KEY UPDATE 命中唯一索引 (roleId, permission) 时 no-op。
-- workspace.read 进 admin + member；workspace.write 仅 admin（不进 member，写操作仅管理员）。
-- 新装库走 seedDefaultRoles（MEMBER_PERMISSIONS / ADMIN_PERMISSIONS 常量已更新）；本迁移回填存量库。
INSERT INTO `RolePermission` (`roleId`, `permission`)
  SELECT r.id, 'workspace.read' FROM `Role` r WHERE r.`key` = 'admin'
  UNION SELECT r.id, 'workspace.write' FROM `Role` r WHERE r.`key` = 'admin'
  UNION SELECT r.id, 'workspace.read' FROM `Role` r WHERE r.`key` = 'member'
ON DUPLICATE KEY UPDATE `permission` = VALUES(`permission`);
