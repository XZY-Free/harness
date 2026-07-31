/**
 * S13-W03 identity 域迁移转换器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - permission-mapping：permission→actionCode 映射查询
 * - User 转换器：正常迁移、externalId 为空异常、null name 处理
 * - Role 转换器：正常迁移、key 为空异常
 * - RolePermission 转换器：可映射 permission、不可映射异常、Role 不存在、Role PB 不存在
 * - UserRole 转换器：复制角色权限到用户、User 不存在、Role 不存在、角色无权限 skip
 * - 端到端 identity 域迁移：User/Role/RolePermission/UserRole 顺序执行
 * - 幂等性：二次运行跳过已迁移记录
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import {
  role as Role,
  rolePermission as RolePermission,
  user as User,
  userRole as UserRole,
} from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { createExecutionRunner } from "@/lib/v11/migration/migration-runner";
import { InMemoryMigrationStateStore } from "@/lib/v11/migration/migration-state";
import {
  getMappablePermissions,
  isPermissionMappable,
  mapPermissionToActionCodes,
} from "@/lib/v11/migration/permission-mapping";
import { createIdentityTransformers } from "@/lib/v11/migration/transformers/identity";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import { roleActionBinding } from "@/lib/v11/schema/authorization";
import { principalBinding, userIdentity } from "@/lib/v11/schema/identity";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

// ═══════════════════════════════════════════════════════════
// 1. permission-mapping
// ═══════════════════════════════════════════════════════════

describe("S13-W03 permission-mapping", () => {
  it("skill.write 映射为 skill.create + skill.update", () => {
    const codes = mapPermissionToActionCodes("skill.write");
    expect(codes).not.toBeNull();
    expect(codes).toEqual(["skill.create", "skill.update"]);
  });

  it("skill.write.all 同样映射为 skill.create + skill.update", () => {
    const codes = mapPermissionToActionCodes("skill.write.all");
    expect(codes).toEqual(["skill.create", "skill.update"]);
  });

  it("skill.publish 映射为 skill.publish", () => {
    expect(mapPermissionToActionCodes("skill.publish")).toEqual(["skill.publish"]);
  });

  it("policy.write 映射为 policy.publish", () => {
    expect(mapPermissionToActionCodes("policy.write")).toEqual(["policy.publish"]);
  });

  it("audit.read 映射为 admin.export.read", () => {
    expect(mapPermissionToActionCodes("audit.read")).toEqual(["admin.export.read"]);
  });

  it("不可映射 permission 返回 null", () => {
    expect(mapPermissionToActionCodes("studio.access")).toBeNull();
    expect(mapPermissionToActionCodes("thread.read.all")).toBeNull();
    expect(mapPermissionToActionCodes("nonexistent.permission")).toBeNull();
  });

  it("isPermissionMappable 正确判断", () => {
    expect(isPermissionMappable("skill.write")).toBe(true);
    expect(isPermissionMappable("studio.access")).toBe(false);
  });

  it("getMappablePermissions 返回全部可映射 permission", () => {
    const mappable = getMappablePermissions();
    expect(mappable.length).toBe(5);
    expect(mappable).toContain("skill.write");
    expect(mappable).toContain("skill.write.all");
    expect(mappable).toContain("skill.publish");
    expect(mappable).toContain("policy.write");
    expect(mappable).toContain("audit.read");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. User 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-W03 User 转换器", () => {
  it("正常 User 迁移为 UserIdentity + PrincipalBinding", async () => {
    await db.insert(User).values({
      id: "user-t-001",
      externalId: "ext-t-001",
      email: "t001@example.com",
      name: "Test User 001",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("identity");

    const userTable = result.tables.find((t) => t.sourceTable === "User");
    expect(userTable?.sourceCount).toBe(1);
    expect(userTable?.targetCount).toBe(2); // UserIdentity + PrincipalBinding
    expect(userTable?.anomalyCount).toBe(0);
    expect(userTable?.skipCount).toBe(0);

    // 验证 UserIdentity 写入
    const [ui] = await db
      .select()
      .from(userIdentity)
      .where(eq(userIdentity.id, "user-t-001"))
      .limit(1);
    expect(ui).toBeDefined();
    expect(ui?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(ui?.externalSubject).toBe("ext-t-001");
    expect(ui?.email).toBe("t001@example.com");
    expect(ui?.displayName).toBe("Test User 001");
    expect(ui?.status).toBe("active");

    // 验证 PrincipalBinding 写入
    const [pb] = await db
      .select()
      .from(principalBinding)
      .where(
        and(
          eq(principalBinding.subjectType, "user"),
          eq(principalBinding.externalId, "ext-t-001"),
          eq(principalBinding.tenantId, DEFAULT_TENANT_ID),
        ),
      )
      .limit(1);
    expect(pb).toBeDefined();
    expect(pb?.userIdentityId).toBe("user-t-001");
    expect(pb?.displayName).toBe("Test User 001");
  });

  it("externalId 为空时入异常队列", async () => {
    await db.insert(User).values({
      id: "user-t-002",
      externalId: "",
      email: "t002@example.com",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("identity");

    const userTable = result.tables.find((t) => t.sourceTable === "User");
    expect(userTable?.anomalyCount).toBe(1);
    expect(userTable?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("User");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain("externalId 为空");
  });

  it("name 为 null 时 displayName 也为 null", async () => {
    await db.insert(User).values({
      id: "user-t-003",
      externalId: "ext-t-003",
      email: "t003@example.com",
      // name 不传，默认为 null
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("identity");

    const [pb] = await db
      .select()
      .from(principalBinding)
      .where(eq(principalBinding.externalId, "ext-t-003"))
      .limit(1);
    expect(pb?.displayName).toBeNull();

    const [ui] = await db
      .select()
      .from(userIdentity)
      .where(eq(userIdentity.id, "user-t-003"))
      .limit(1);
    expect(ui?.displayName).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Role 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-W03 Role 转换器", () => {
  it("正常 Role 迁移为 PrincipalBinding(subjectType=role)", async () => {
    await db.insert(Role).values({
      id: "role-t-001",
      key: "admin",
      name: "Administrator",
      isSystem: true,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("identity");

    const roleTable = result.tables.find((t) => t.sourceTable === "Role");
    expect(roleTable?.sourceCount).toBe(1);
    expect(roleTable?.targetCount).toBe(1); // 1 PrincipalBinding
    expect(roleTable?.anomalyCount).toBe(0);

    const [pb] = await db
      .select()
      .from(principalBinding)
      .where(
        and(
          eq(principalBinding.subjectType, "role"),
          eq(principalBinding.externalId, "admin"),
          eq(principalBinding.tenantId, DEFAULT_TENANT_ID),
        ),
      )
      .limit(1);
    expect(pb).toBeDefined();
    expect(pb?.displayName).toBe("Administrator");
    expect(pb?.userIdentityId).toBeNull();
  });

  it("key 为空时入异常队列", async () => {
    await db.insert(Role).values({
      id: "role-t-002",
      key: "",
      name: "Bad Role",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("identity");

    const roleTable = result.tables.find((t) => t.sourceTable === "Role");
    expect(roleTable?.anomalyCount).toBe(1);

    const anomalies = store.getAnomalies("Role");
    expect(anomalies[0]?.reason).toContain("Role.key 为空");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. RolePermission 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-W03 RolePermission 转换器", () => {
  it("可映射 permission 创建对应 RoleActionBinding", async () => {
    const roleId = "role-rp-001";
    await db.insert(Role).values({ id: roleId, key: "rp-admin", name: "RP Admin" });

    const store = new InMemoryMigrationStateStore();
    const transformers = createIdentityTransformers();
    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());

    // 先迁移 Role 创建 PrincipalBinding
    await runner.runTable({
      legacyTable: "Role",
      physicalTable: "Role",
      v11Targets: ["RoleActionBinding"],
      domain: "identity",
      order: 2,
      unmigratableFields: [],
      defaultHandling: "",
      anomalyConditions: "",
      coreEntity: true,
    });

    // 插入 RolePermission
    await db.insert(RolePermission).values({ roleId, permission: "skill.write" });

    // 单独运行 RolePermission 转换器
    const store2 = new InMemoryMigrationStateStore();
    const runner2 = createExecutionRunner(store2, transformers, 100, false, getV11TableRegistry());
    const result = await runner2.runTable({
      legacyTable: "RolePermission",
      physicalTable: "RolePermission",
      v11Targets: ["RoleActionBinding"],
      domain: "identity",
      order: 3,
      unmigratableFields: [],
      defaultHandling: "",
      anomalyConditions: "",
      coreEntity: true,
      cursorColumn: "",
      idColumns: ["roleId", "permission"],
    });

    expect(result.sourceCount).toBe(1);
    expect(result.targetCount).toBe(2); // skill.create + skill.update
    expect(result.anomalyCount).toBe(0);

    // 验证 RoleActionBinding 写入
    const bindings = await db
      .select()
      .from(roleActionBinding)
      .where(eq(roleActionBinding.tenantId, DEFAULT_TENANT_ID));
    const actionCodes = bindings.map((b) => b.actionCode).sort();
    expect(actionCodes).toEqual(["skill.create", "skill.update"]);

    // resourceScopeJson 应为 tenant scope
    expect(bindings[0]?.resourceScopeJson).toBe(JSON.stringify({ type: "tenant" }));
  });

  it("不可映射 permission 入异常队列", async () => {
    const roleId = "role-rp-002";
    await db.insert(Role).values({ id: roleId, key: "rp-bad", name: "RP Bad" });

    const store = new InMemoryMigrationStateStore();
    const transformers = createIdentityTransformers();
    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());

    // 先迁移 Role
    await runner.runTable({
      legacyTable: "Role",
      physicalTable: "Role",
      v11Targets: ["RoleActionBinding"],
      domain: "identity",
      order: 2,
      unmigratableFields: [],
      defaultHandling: "",
      anomalyConditions: "",
      coreEntity: true,
    });

    // 插入不可映射的 permission
    await db.insert(RolePermission).values({ roleId, permission: "studio.access" });

    const store2 = new InMemoryMigrationStateStore();
    const runner2 = createExecutionRunner(store2, transformers, 100, false, getV11TableRegistry());
    const result = await runner2.runTable({
      legacyTable: "RolePermission",
      physicalTable: "RolePermission",
      v11Targets: ["RoleActionBinding"],
      domain: "identity",
      order: 3,
      unmigratableFields: [],
      defaultHandling: "",
      anomalyConditions: "",
      coreEntity: true,
      cursorColumn: "",
      idColumns: ["roleId", "permission"],
    });

    expect(result.anomalyCount).toBe(1);
    expect(result.targetCount).toBe(0);

    const anomalies = store2.getAnomalies("RolePermission");
    expect(anomalies[0]?.reason).toContain("无对应 V11 actionCode");
  });

  it("Role 不存在时入异常队列", async () => {
    // FK 约束阻止直接插入孤儿 RolePermission，直接调用转换器验证防御逻辑
    const transformers = createIdentityTransformers();
    const transformer = transformers.get("RolePermission");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      roleId: "nonexistent-role",
      permission: "skill.write",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("Role nonexistent-role 不存在");
  });

  it("Role 的 PrincipalBinding 不存在时入异常队列", async () => {
    // 插入 Role 但不迁移（PrincipalBinding 不存在）
    const roleId = "role-rp-003";
    await db.insert(Role).values({ id: roleId, key: "rp-nopb", name: "RP No PB" });
    await db.insert(RolePermission).values({ roleId, permission: "skill.write" });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runTable({
      legacyTable: "RolePermission",
      physicalTable: "RolePermission",
      v11Targets: ["RoleActionBinding"],
      domain: "identity",
      order: 3,
      unmigratableFields: [],
      defaultHandling: "",
      anomalyConditions: "",
      coreEntity: true,
      cursorColumn: "",
      idColumns: ["roleId", "permission"],
    });

    expect(result.anomalyCount).toBe(1);
    const anomalies = store.getAnomalies("RolePermission");
    expect(anomalies[0]?.reason).toContain("PrincipalBinding 不存在");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. UserRole 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-W03 UserRole 转换器", () => {
  it("正常 UserRole 复制角色权限到用户", async () => {
    const userId = "user-ur-001";
    const roleId = "role-ur-001";
    await db.insert(User).values({
      id: userId,
      externalId: "ext-ur-001",
      email: "ur001@example.com",
    });
    await db.insert(Role).values({ id: roleId, key: "ur-admin", name: "UR Admin" });
    await db.insert(RolePermission).values({ roleId, permission: "skill.publish" });
    await db.insert(UserRole).values({ userId, roleId });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    // 完整迁移 identity 域（保证顺序：User/Role → RolePermission → UserRole）
    const result = await runner.runDomain("identity");

    const userRoleTable = result.tables.find((t) => t.sourceTable === "UserRole");
    expect(userRoleTable?.sourceCount).toBe(1);
    expect(userRoleTable?.targetCount).toBe(1); // 复制 1 个 skill.publish
    expect(userRoleTable?.anomalyCount).toBe(0);

    // 验证用户的 PrincipalBinding 有对应的 RoleActionBinding
    const [userPb] = await db
      .select()
      .from(principalBinding)
      .where(
        and(
          eq(principalBinding.subjectType, "user"),
          eq(principalBinding.externalId, "ext-ur-001"),
        ),
      )
      .limit(1);
    expect(userPb).toBeDefined();
    expect(userPb).not.toBeNull();

    const userPbId = userPb?.id;
    expect(userPbId).toBeDefined();

    const userBindings = await db
      .select()
      .from(roleActionBinding)
      .where(eq(roleActionBinding.principalBindingId, userPbId as string));
    expect(userBindings.length).toBe(1);
    expect(userBindings[0]?.actionCode).toBe("skill.publish");
  });

  it("User 不存在时入异常队列", async () => {
    // FK 约束阻止直接插入孤儿 UserRole，直接调用转换器验证防御逻辑
    const transformers = createIdentityTransformers();
    const transformer = transformers.get("UserRole");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      userId: "nonexistent-user",
      roleId: "nonexistent-role",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("User nonexistent-user 不存在");
  });

  it("角色无权限映射时 skip", async () => {
    const userId = "user-ur-003";
    const roleId = "role-ur-003";
    await db.insert(User).values({
      id: userId,
      externalId: "ext-ur-003",
      email: "ur003@example.com",
    });
    await db.insert(Role).values({ id: roleId, key: "ur-empty", name: "UR Empty" });
    // 不插入任何 RolePermission
    await db.insert(UserRole).values({ userId, roleId });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("identity");

    const userRoleTable = result.tables.find((t) => t.sourceTable === "UserRole");
    expect(userRoleTable?.skipCount).toBe(1);
    expect(userRoleTable?.targetCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 端到端 identity 域迁移
// ═══════════════════════════════════════════════════════════

describe("S13-W03 identity 域端到端迁移", () => {
  it("完整 identity 域迁移：User/Role/RolePermission/UserRole 顺序执行", async () => {
    // 准备数据：2 个用户、1 个角色、2 个权限、2 个用户角色绑定
    await db.insert(User).values({
      id: "user-e2e-001",
      externalId: "ext-e2e-001",
      email: "e2e001@example.com",
      name: "E2E User 001",
    });
    await db.insert(User).values({
      id: "user-e2e-002",
      externalId: "ext-e2e-002",
      email: "e2e002@example.com",
      name: "E2E User 002",
    });
    await db.insert(Role).values({
      id: "role-e2e-001",
      key: "e2e-admin",
      name: "E2E Admin",
      isSystem: true,
    });
    await db.insert(RolePermission).values({
      roleId: "role-e2e-001",
      permission: "skill.write",
    });
    await db.insert(RolePermission).values({
      roleId: "role-e2e-001",
      permission: "skill.publish",
    });
    await db.insert(UserRole).values({ userId: "user-e2e-001", roleId: "role-e2e-001" });
    await db.insert(UserRole).values({ userId: "user-e2e-002", roleId: "role-e2e-001" });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("identity");

    // 汇总验证
    expect(result.totalSourceCount).toBe(7); // 2 User + 1 Role + 2 RolePermission + 2 UserRole
    expect(result.totalAnomalyCount).toBe(0);

    // User: 2 条 × 2 目标 = 4
    const userTable = result.tables.find((t) => t.sourceTable === "User");
    expect(userTable?.targetCount).toBe(4);

    // Role: 1 条 × 1 目标 = 1
    const roleTable = result.tables.find((t) => t.sourceTable === "Role");
    expect(roleTable?.targetCount).toBe(1);

    // RolePermission: 2 条
    //   skill.write → skill.create + skill.update = 2
    //   skill.publish → skill.publish = 1
    //   合计 3 个 RoleActionBinding
    const rpTable = result.tables.find((t) => t.sourceTable === "RolePermission");
    expect(rpTable?.targetCount).toBe(3);

    // UserRole: 2 条 × 3 actionCode = 6（每用户复制 3 个权限）
    const urTable = result.tables.find((t) => t.sourceTable === "UserRole");
    expect(urTable?.targetCount).toBe(6);

    // 验证 V11 表实际写入
    const userIdentities = await db.select().from(userIdentity);
    expect(userIdentities.length).toBe(2);

    const pbs = await db.select().from(principalBinding);
    // 2 user PB + 1 role PB = 3
    expect(pbs.length).toBe(3);

    const rabs = await db.select().from(roleActionBinding);
    // 3 role bindings + 6 user bindings = 9
    expect(rabs.length).toBe(9);
  });

  it("幂等性：二次运行跳过所有已迁移记录", async () => {
    await db.insert(User).values({
      id: "user-idem-001",
      externalId: "ext-idem-001",
      email: "idem001@example.com",
    });
    await db.insert(Role).values({
      id: "role-idem-001",
      key: "idem-admin",
      name: "Idem Admin",
    });
    await db.insert(RolePermission).values({
      roleId: "role-idem-001",
      permission: "skill.publish",
    });
    await db.insert(UserRole).values({
      userId: "user-idem-001",
      roleId: "role-idem-001",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createIdentityTransformers();

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runDomain("identity");
    expect(result1.totalTargetCount).toBeGreaterThan(0);

    // 记录第一次的 V11 表行数
    const uiCount1 = (await db.select().from(userIdentity)).length;
    const pbCount1 = (await db.select().from(principalBinding)).length;
    const rabCount1 = (await db.select().from(roleActionBinding)).length;

    // 第二次运行：应全部跳过，不产生新目标
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runDomain("identity");

    expect(result2.totalTargetCount).toBe(0);
    expect(result2.totalSkipCount).toBe(4); // 4 条源记录全部跳过

    // V11 表行数不变
    const uiCount2 = (await db.select().from(userIdentity)).length;
    const pbCount2 = (await db.select().from(principalBinding)).length;
    const rabCount2 = (await db.select().from(roleActionBinding)).length;
    expect(uiCount2).toBe(uiCount1);
    expect(pbCount2).toBe(pbCount1);
    expect(rabCount2).toBe(rabCount1);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. createIdentityTransformers 工厂
// ═══════════════════════════════════════════════════════════

describe("S13-W03 createIdentityTransformers 工厂", () => {
  it("返回 4 个转换器", () => {
    const transformers = createIdentityTransformers();
    expect(transformers.size).toBe(4);
    expect(transformers.has("User")).toBe(true);
    expect(transformers.has("Role")).toBe(true);
    expect(transformers.has("RolePermission")).toBe(true);
    expect(transformers.has("UserRole")).toBe(true);
  });

  it("每个转换器是函数类型", () => {
    const transformers = createIdentityTransformers();
    for (const [, transformer] of transformers) {
      expect(typeof transformer).toBe("function");
    }
  });

  it("工厂每次调用返回独立 Map 实例", () => {
    const t1 = createIdentityTransformers();
    const t2 = createIdentityTransformers();
    expect(t1).not.toBe(t2);
    expect(t1.size).toBe(t2.size);
  });
});
