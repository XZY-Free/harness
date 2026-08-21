/**
 * Settings 角色管理（grant 化）专用查询。
 *
 * 关口02 02-2c：Settings 用户/角色管理从 legacy role/rolePermission/userRole 迁到
 * 正式身份模型（principalBinding + roleActionBinding）。本模块只走正式表，
 * 不碰 legacy role/rolePermission/userRole。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { type AppendAdminAuditLogInput, appendAdminAuditLog } from "@/lib/db/queries";
import { parseResourceScope } from "@/lib/identity/resource-scope";
import {
  type ActionCode,
  ROLE_TEMPLATES,
  type ResourceScope,
  grantSignature,
  templateActions,
} from "@/lib/identity/role-templates";
import { roleActionBinding } from "@/lib/persistence/schema/authorization";
import { principalBinding, userIdentity } from "@/lib/persistence/schema/identity";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";

/** Settings 用户 + 有效 grant 摘要。 */
export interface SettingsUserWithGrants {
  /** userIdentityId。 */
  id: string;
  email: string;
  displayName: string | null;
  externalSubject: string;
  /** 当前有效 roleActionBinding 的稳定签名（actionCode|scope）。 */
  grantSignatures: string[];
}

/**
 * 列出租户内全部用户及其有效 grant 签名。
 * 经 userIdentity → principalBinding(subjectType=user) → roleActionBinding 联查；
 * 只保留当前有效的绑定（validUntil IS NULL 或 > now）。
 */
export async function listUsersWithActionBindings(
  tenantId: string,
): Promise<SettingsUserWithGrants[]> {
  const now = new Date();
  const rows = await db
    .select({
      id: userIdentity.id,
      email: userIdentity.email,
      displayName: userIdentity.displayName,
      externalSubject: userIdentity.externalSubject,
      bindingId: roleActionBinding.id,
      actionCode: roleActionBinding.actionCode,
      resourceScopeJson: roleActionBinding.resourceScopeJson,
      validUntil: roleActionBinding.validUntil,
    })
    .from(userIdentity)
    .leftJoin(
      principalBinding,
      and(
        eq(principalBinding.userIdentityId, userIdentity.id),
        eq(principalBinding.tenantId, tenantId),
        eq(principalBinding.subjectType, "user"),
      ),
    )
    .leftJoin(
      roleActionBinding,
      and(
        eq(roleActionBinding.principalBindingId, principalBinding.id),
        eq(roleActionBinding.tenantId, tenantId),
      ),
    )
    .where(eq(userIdentity.tenantId, tenantId))
    .orderBy(asc(userIdentity.createdAt));

  const byUser = new Map<string, SettingsUserWithGrants>();
  for (const r of rows) {
    let u = byUser.get(r.id);
    if (!u) {
      u = {
        id: r.id,
        email: r.email,
        displayName: r.displayName,
        externalSubject: r.externalSubject,
        grantSignatures: [],
      };
      byUser.set(r.id, u);
    }
    if (!r.bindingId || !r.actionCode || !r.resourceScopeJson) continue;
    // 跳过已撤销（validUntil <= now）
    if (r.validUntil !== null && r.validUntil <= now) continue;
    // 解析 scope；DB 中非法 scope（不应发生）→ 跳过（fail-closed）
    let scope: ResourceScope;
    try {
      scope = parseResourceScope(r.resourceScopeJson);
    } catch {
      continue;
    }
    u.grantSignatures.push(grantSignature(r.actionCode, scope));
  }
  return [...byUser.values()];
}

/** 推导用户所属的全部角色模板：模板 grant 全集被用户 grant 签名集覆盖即计入。 */
export function deriveTemplateKeys(
  user: Pick<SettingsUserWithGrants, "grantSignatures">,
): string[] {
  const sigs = new Set(user.grantSignatures);
  const keys: string[] = [];
  for (const tpl of ROLE_TEMPLATES) {
    let covered = true;
    for (const g of tpl.grants) {
      if (!sigs.has(grantSignature(g.actionCode, g.resourceScope))) {
        covered = false;
        break;
      }
    }
    if (covered) keys.push(tpl.key);
  }
  return keys;
}

/** Settings GET 视图形状：users（含推导模板）+ 角色模板（含只读 action 列表）。 */
export interface SettingsUserRolesView {
  users: Array<{
    id: string;
    email: string;
    displayName: string | null;
    externalSubject: string;
    templateKeys: string[];
  }>;
  roles: Array<{
    key: string;
    name: string;
    isSystem: boolean;
    actions: ActionCode[];
  }>;
}

/** 组装 Settings 用户/角色管理视图（GET 路由与 page server component 共用）。 */
export async function listSettingsUserRolesView(tenantId: string): Promise<SettingsUserRolesView> {
  const users = await listUsersWithActionBindings(tenantId);
  return {
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      externalSubject: u.externalSubject,
      templateKeys: deriveTemplateKeys(u),
    })),
    roles: ROLE_TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      isSystem: t.isSystem,
      actions: templateActions(t),
    })),
  };
}

/**
 * 覆盖用户全部有效 grant + 写 succeeded 审计，单事务。
 *
 * 撤销目标用户所有 principalBinding(subjectType=user) 上的有效 roleActionBinding
 * （回填 validUntil=now），再按 grants 授予（去重后挂在第一个 user 绑定上）。
 * 任一步失败 → 整事务回滚（audit 与 grant 替换都不生效），调用方据此返回 500 audit_failed。
 */
export async function replaceUserGrantsWithAudit(
  tenantId: string,
  userIdentityId: string,
  grants: Array<{ actionCode: ActionCode; resourceScope: ResourceScope }>,
  auditInput: Pick<AppendAdminAuditLogInput, "actorUserId" | "targetId" | "metadata"> & {
    action: AppendAdminAuditLogInput["action"];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. 目标用户的 user 主体绑定
    const bindings = await tx
      .select({ id: principalBinding.id })
      .from(principalBinding)
      .where(
        and(
          eq(principalBinding.tenantId, tenantId),
          eq(principalBinding.userIdentityId, userIdentityId),
          eq(principalBinding.subjectType, "user"),
        ),
      );
    const bindingIds = bindings.map((b) => b.id);

    // 2. 撤销当前有效绑定
    if (bindingIds.length > 0) {
      const now = new Date();
      await tx
        .update(roleActionBinding)
        .set({ validUntil: now })
        .where(
          and(
            eq(roleActionBinding.tenantId, tenantId),
            inArray(roleActionBinding.principalBindingId, bindingIds),
            or(isNull(roleActionBinding.validUntil), gt(roleActionBinding.validUntil, now)),
          ),
        );
    }

    // 3. 按所选模板授予（去重后；挂第一个 user 绑定，与 resolver 对齐）。
    if (grants.length > 0 && bindingIds.length > 0) {
      // 上方已校验 bindingIds.length > 0，这里 undefined 在逻辑上不可达（避免 non-null 断言）。
      const principalBindingId = bindingIds[0];
      if (principalBindingId === undefined) {
        throw new Error("settings: bindingIds 非空但首元素缺失（逻辑错误）");
      }
      const now = new Date();
      await tx.insert(roleActionBinding).values(
        grants.map((g) => ({
          id: randomUUID(),
          tenantId,
          principalBindingId,
          actionCode: g.actionCode,
          resourceScopeJson: JSON.stringify(g.resourceScope, ["type", "wildcard", "ids"]),
          validFrom: now,
          validUntil: null,
        })),
      );
    }

    // 4. succeeded 审计（同事务；写失败 → 回滚）
    await appendAdminAuditLog(
      {
        actorUserId: auditInput.actorUserId,
        action: auditInput.action,
        targetType: "user",
        targetId: auditInput.targetId,
        outcome: "succeeded",
        metadata: auditInput.metadata,
      },
      tx,
    );
  });
}
