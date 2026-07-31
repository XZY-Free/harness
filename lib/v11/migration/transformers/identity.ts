/**
 * S13-W03 identity 域迁移转换器。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §identity
 * - ../v11-agentkit-platform/10-core-data-model.md §2、§8
 *
 * 映射：
 * - User → UserIdentity + PrincipalBinding(subjectType=user)
 * - Role → PrincipalBinding(subjectType=role)
 * - RolePermission → RoleActionBinding（permission→actionCode 映射；无法映射入异常队列）
 * - UserRole → RoleActionBinding（复制角色权限到用户 PrincipalBinding）
 *
 * 迁移原则：
 * - 只迁可证明事实；无法映射的 permission 入异常队列，不猜测。
 * - 跨表依赖按域顺序保证：User/Role → RolePermission → UserRole。
 * - 保留源 id 作为 UserIdentity.id，便于跨表关联追溯。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { role as roleTable, user as userTable } from "@/lib/db/schema";
import { DEFAULT_TENANT_ID } from "@/lib/v11/identity/tenant-queries";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { mapPermissionToActionCodes } from "@/lib/v11/migration/permission-mapping";
import { roleActionBinding } from "@/lib/v11/schema/authorization";
import { principalBinding } from "@/lib/v11/schema/identity";
import { and, eq } from "drizzle-orm";

/** 角色级 resource scope（tenant 级，不限定具体资源）。 */
const TENANT_SCOPE_JSON = JSON.stringify({ type: "tenant" });

// ─── User → UserIdentity + PrincipalBinding ────────────────

const userTransformer: MigrationTransformer = (record) => {
  const externalId = String(record.externalId ?? "");
  if (!externalId) {
    return { targets: [], anomalyReason: "externalId 为空" };
  }
  const userIdentityId = String(record.id);
  const displayName = record.name ? String(record.name) : null;

  return {
    targets: [
      {
        table: "UserIdentity",
        data: {
          id: userIdentityId,
          tenantId: DEFAULT_TENANT_ID,
          externalSubject: externalId,
          email: String(record.email ?? ""),
          displayName,
          status: "active",
        },
      },
      {
        table: "PrincipalBinding",
        data: {
          id: randomUUID(),
          tenantId: DEFAULT_TENANT_ID,
          subjectType: "user",
          externalId: externalId,
          displayName,
          userIdentityId,
        },
      },
    ],
  };
};

// ─── Role → PrincipalBinding(subjectType=role) ─────────────

const roleTransformer: MigrationTransformer = (record) => {
  const key = String(record.key ?? "");
  if (!key) {
    return { targets: [], anomalyReason: "Role.key 为空" };
  }
  return {
    targets: [
      {
        table: "PrincipalBinding",
        data: {
          id: randomUUID(),
          tenantId: DEFAULT_TENANT_ID,
          subjectType: "role",
          externalId: key,
          displayName: record.name ? String(record.name) : null,
          userIdentityId: null,
        },
      },
    ],
  };
};

// ─── RolePermission → RoleActionBinding ────────────────────

const rolePermissionTransformer: MigrationTransformer = async (record) => {
  const roleId = String(record.roleId ?? "");
  const permission = String(record.permission ?? "");

  // permission → actionCode 映射
  const actionCodes = mapPermissionToActionCodes(permission);
  if (!actionCodes) {
    return {
      targets: [],
      anomalyReason: `permission "${permission}" 无对应 V11 actionCode`,
    };
  }

  // 查询 Role 获取 key
  const [roleRow] = await db
    .select({ key: roleTable.key })
    .from(roleTable)
    .where(eq(roleTable.id, roleId))
    .limit(1);
  if (!roleRow) {
    return { targets: [], anomalyReason: `Role ${roleId} 不存在` };
  }

  // 查询角色对应的 PrincipalBinding（须先迁移 Role）
  const [pb] = await db
    .select({ id: principalBinding.id })
    .from(principalBinding)
    .where(
      and(
        eq(principalBinding.subjectType, "role"),
        eq(principalBinding.externalId, roleRow.key),
        eq(principalBinding.tenantId, DEFAULT_TENANT_ID),
      ),
    )
    .limit(1);
  if (!pb) {
    return {
      targets: [],
      anomalyReason: `角色 ${roleRow.key} 的 PrincipalBinding 不存在（须先迁移 Role）`,
    };
  }

  // 为每个 actionCode 创建 RoleActionBinding
  return {
    targets: actionCodes.map((actionCode) => ({
      table: "RoleActionBinding",
      data: {
        id: randomUUID(),
        tenantId: DEFAULT_TENANT_ID,
        principalBindingId: pb.id,
        actionCode,
        resourceScopeJson: TENANT_SCOPE_JSON,
      },
    })),
  };
};

// ─── UserRole → RoleActionBinding（复制角色权限到用户）──────

const userRoleTransformer: MigrationTransformer = async (record) => {
  const userId = String(record.userId ?? "");
  const roleId = String(record.roleId ?? "");

  // 查询 User 获取 externalId
  const [userRow] = await db
    .select({ externalId: userTable.externalId })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!userRow) {
    return { targets: [], anomalyReason: `User ${userId} 不存在` };
  }

  // 查询用户的 PrincipalBinding（须先迁移 User）
  const [userPb] = await db
    .select({ id: principalBinding.id })
    .from(principalBinding)
    .where(
      and(
        eq(principalBinding.subjectType, "user"),
        eq(principalBinding.externalId, userRow.externalId),
        eq(principalBinding.tenantId, DEFAULT_TENANT_ID),
      ),
    )
    .limit(1);
  if (!userPb) {
    return {
      targets: [],
      anomalyReason: `用户 ${userRow.externalId} 的 PrincipalBinding 不存在（须先迁移 User）`,
    };
  }

  // 查询 Role 获取 key
  const [roleRow] = await db
    .select({ key: roleTable.key })
    .from(roleTable)
    .where(eq(roleTable.id, roleId))
    .limit(1);
  if (!roleRow) {
    return { targets: [], anomalyReason: `Role ${roleId} 不存在` };
  }

  // 查询角色 PrincipalBinding
  const [rolePb] = await db
    .select({ id: principalBinding.id })
    .from(principalBinding)
    .where(
      and(
        eq(principalBinding.subjectType, "role"),
        eq(principalBinding.externalId, roleRow.key),
        eq(principalBinding.tenantId, DEFAULT_TENANT_ID),
      ),
    )
    .limit(1);
  if (!rolePb) {
    return {
      targets: [],
      anomalyReason: `角色 ${roleRow.key} 的 PrincipalBinding 不存在（须先迁移 Role）`,
    };
  }

  // 查询角色的 RoleActionBinding（须先迁移 RolePermission）
  const roleBindings = await db
    .select({
      actionCode: roleActionBinding.actionCode,
      resourceScopeJson: roleActionBinding.resourceScopeJson,
    })
    .from(roleActionBinding)
    .where(
      and(
        eq(roleActionBinding.principalBindingId, rolePb.id),
        eq(roleActionBinding.tenantId, DEFAULT_TENANT_ID),
      ),
    );

  // 角色无权限映射：跳过（用户继承空权限集）
  if (roleBindings.length === 0) {
    return { targets: [], skip: true };
  }

  // 复制角色权限到用户 PrincipalBinding
  return {
    targets: roleBindings.map((rb) => ({
      table: "RoleActionBinding",
      data: {
        id: randomUUID(),
        tenantId: DEFAULT_TENANT_ID,
        principalBindingId: userPb.id,
        actionCode: rb.actionCode,
        resourceScopeJson: rb.resourceScopeJson,
      },
    })),
  };
};

// ─── 导出 identity 域转换器注册表 ──────────────────────────

/** 创建 identity 域的全部转换器（key = 物理表名）。 */
export function createIdentityTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ["User", userTransformer],
    ["Role", roleTransformer],
    ["RolePermission", rolePermissionTransformer],
    ["UserRole", userRoleTransformer],
  ]);
}
