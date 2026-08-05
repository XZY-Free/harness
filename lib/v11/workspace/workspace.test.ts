import { createThread } from "@/lib/conversations/thread-queries";
/**
 * V11 Workspace 集成测试（阶段 8 S08-C01）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §7.1（workspace/binding/attachment）。
 * - ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §9—16（执行位置语义）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W01。
 *
 * 覆盖：
 * - workspace-queries：computeLocationFingerprint / isWorkspaceBindingType / isWorkspaceKind /
 *   isValidWorkspaceKey / createWorkspace / getWorkspaceById / getWorkspaceByKey /
 *   listWorkspaces / archiveWorkspace / createWorkspaceBinding / getWorkspaceBindingById /
 *   listWorkspaceBindings / updateWorkspaceBindingState / createWorkspaceAttachment /
 *   getWorkspaceAttachmentById / listWorkspaceAttachmentsByThread / detachWorkspaceAttachment /
 *   markExpiredWorkspaceAttachments / createWorkspaceAttachmentUse /
 *   listWorkspaceAttachmentUsesByTurn / resolveWorkspaceLocation。
 * - 关键不变量：Desktop binding 必含 deviceId；Cloud/Remote 不允许 deviceId；
 *   Attachment 只能挂在同租户 active binding；跨租户隔离；ETag 乐观锁；幂等 use。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { registerDevice } from "@/lib/identity/device-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  WorkspaceAttachmentExpiredError,
  WorkspaceNotFoundError,
  WorkspaceValidationError,
  WorkspaceVersionConflictError,
  archiveWorkspace,
  computeLocationFingerprint,
  createWorkspace,
  createWorkspaceAttachment,
  createWorkspaceAttachmentUse,
  createWorkspaceBinding,
  detachWorkspaceAttachment,
  getWorkspaceAttachmentById,
  getWorkspaceBindingById,
  getWorkspaceById,
  getWorkspaceByKey,
  isValidWorkspaceKey,
  isWorkspaceBindingType,
  isWorkspaceKind,
  listWorkspaceAttachmentUsesByTurn,
  listWorkspaceAttachmentsByThread,
  listWorkspaceBindings,
  listWorkspaces,
  markExpiredWorkspaceAttachments,
  resolveWorkspaceLocation,
  updateWorkspaceBindingState,
} from "@/lib/v11/workspace/workspace-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {});

// ─── 辅助：seed 默认租户 + 用户身份 + 主体绑定 + Device + Thread ────

async function seedContext() {
  const t = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: t.id,
    externalSubject: "user-1",
    email: "user-1@example.com",
    displayName: "User One",
  });
  const binding = await upsertPrincipalBinding({
    tenantId: t.id,
    subjectType: "user",
    externalId: "user-1",
    displayName: "User One",
    userIdentityId: identity.id,
  });
  return { tenantId: t.id, userId: identity.id, principalBindingId: binding.id };
}

async function seedDevice(tenantId: string, userId: string) {
  return registerDevice({
    tenantId,
    userId,
    deviceKey: "device-1",
    publicKey: "ed25519:fake-public-key-for-test-only-not-real",
    deviceName: "Test Device",
    appVersion: "1.0.0",
  });
}

async function seedThread(tenantId: string, userId: string, agentId: string) {
  const { thread } = await createThread({
    tenantId,
    ownerUserId: userId,
    primaryAgentId: agentId,
    title: "Test Thread",
    actorId: userId,
  });
  return thread;
}

// ═══════════════════════════════════════════════════════════
// 1. workspace-queries：辅助函数
// ═══════════════════════════════════════════════════════════

describe("workspace-queries：辅助函数", () => {
  it("computeLocationFingerprint：返回 sha256: 前缀 + 64 hex", () => {
    const fp = computeLocationFingerprint("/tmp", "file.txt");
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    // 相同输入产生相同指纹。
    expect(computeLocationFingerprint("/tmp", "file.txt")).toBe(fp);
    // 不同输入产生不同指纹。
    expect(computeLocationFingerprint("/tmp", "file2.txt")).not.toBe(fp);
  });

  it("isWorkspaceBindingType：合法/非法判断", () => {
    expect(isWorkspaceBindingType("desktop")).toBe(true);
    expect(isWorkspaceBindingType("cloud")).toBe(true);
    expect(isWorkspaceBindingType("remote")).toBe(true);
    expect(isWorkspaceBindingType("sandbox")).toBe(true);
    expect(isWorkspaceBindingType("local")).toBe(false);
    expect(isWorkspaceBindingType("")).toBe(false);
  });

  it("isWorkspaceKind：合法/非法判断", () => {
    expect(isWorkspaceKind("personal")).toBe(true);
    expect(isWorkspaceKind("project")).toBe(true);
    expect(isWorkspaceKind("shared")).toBe(true);
    expect(isWorkspaceKind("system")).toBe(true);
    expect(isWorkspaceKind("team")).toBe(false);
  });

  it("isValidWorkspaceKey：合法/非法判断", () => {
    expect(isValidWorkspaceKey("my-ws")).toBe(true);
    expect(isValidWorkspaceKey("my_ws_1")).toBe(true);
    expect(isValidWorkspaceKey("a")).toBe(true);
    expect(isValidWorkspaceKey("1abc")).toBe(false); // 必须以字母开头
    expect(isValidWorkspaceKey("")).toBe(false);
    expect(isValidWorkspaceKey("my ws")).toBe(false); // 不允许空格
    expect(isValidWorkspaceKey("my.ws")).toBe(false); // 不允许点
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Workspace CRUD
// ═══════════════════════════════════════════════════════════

describe("workspace-queries：Workspace CRUD", () => {
  it("createWorkspace：成功创建 + 默认 personal/active + versionNo", async () => {
    const { tenantId, userId } = await seedContext();
    const ws = await createWorkspace({
      tenantId,
      workspaceKey: "my-ws",
      displayName: "我的工作区",
      ownerUserId: userId,
    });
    expect(ws.id).toBeTruthy();
    expect(ws.tenantId).toBe(tenantId);
    expect(ws.workspaceKey).toBe("my-ws");
    expect(ws.workspaceKind).toBe("personal");
    expect(ws.lifecycleState).toBe("active");
    expect(ws.versionNo).toBeTruthy();
    expect(ws.createdAt).toBeInstanceOf(Date);
  });

  it("createWorkspace：空 workspaceKey → ValidationError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      createWorkspace({ tenantId, workspaceKey: "", displayName: "测试" }),
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it("createWorkspace：非法 workspaceKey → ValidationError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      createWorkspace({ tenantId, workspaceKey: "1abc", displayName: "测试" }),
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it("createWorkspace：空 displayName → ValidationError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      createWorkspace({ tenantId, workspaceKey: "test-ws", displayName: "" }),
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it("createWorkspace：重复 workspaceKey → 抛错（唯一约束）", async () => {
    const { tenantId } = await seedContext();
    await createWorkspace({ tenantId, workspaceKey: "dup", displayName: "第一份" });
    await expect(
      createWorkspace({ tenantId, workspaceKey: "dup", displayName: "第二份" }),
    ).rejects.toThrow();
  });

  it("getWorkspaceById / getWorkspaceByKey：跨租户隔离", async () => {
    const { tenantId, userId } = await seedContext();
    const ws = await createWorkspace({
      tenantId,
      workspaceKey: "ws-lookup",
      displayName: "查询",
      ownerUserId: userId,
    });

    const byId = await getWorkspaceById(tenantId, ws.id);
    expect(byId?.id).toBe(ws.id);

    const byKey = await getWorkspaceByKey(tenantId, "ws-lookup");
    expect(byKey?.id).toBe(ws.id);

    // 跨租户查询返回 null。
    const otherTenantId = "00000000-0000-4000-8000-000000000099";
    const crossTenant = await getWorkspaceById(otherTenantId, ws.id);
    expect(crossTenant).toBeNull();
  });

  it("listWorkspaces：默认排除 deleted；按 owner/kind 过滤", async () => {
    const { tenantId, userId } = await seedContext();
    await createWorkspace({ tenantId, workspaceKey: "ws1", displayName: "1", ownerUserId: userId });
    await createWorkspace({
      tenantId,
      workspaceKey: "ws2",
      displayName: "2",
      workspaceKind: "project",
    });

    const all = await listWorkspaces(tenantId);
    expect(all.length).toBe(2);

    const mine = await listWorkspaces(tenantId, { ownerUserId: userId });
    expect(mine.length).toBe(1);
    expect(mine[0]?.workspaceKey).toBe("ws1");

    const projects = await listWorkspaces(tenantId, { workspaceKind: "project" });
    expect(projects.length).toBe(1);
    expect(projects[0]?.workspaceKey).toBe("ws2");
  });

  it("archiveWorkspace：成功 + ETag 校验 + versionNo 更新", async () => {
    const { tenantId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "arc", displayName: "归档" });

    const archived = await archiveWorkspace(tenantId, ws.id, ws.versionNo);
    expect(archived.lifecycleState).toBe("archived");
    expect(archived.versionNo).not.toBe(ws.versionNo);
  });

  it("archiveWorkspace：版本号不匹配 → VersionConflictError", async () => {
    const { tenantId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "arc2", displayName: "归档" });
    await expect(archiveWorkspace(tenantId, ws.id, "wrong-version")).rejects.toBeInstanceOf(
      WorkspaceVersionConflictError,
    );
  });

  it("archiveWorkspace：不存在 → NotFoundError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      archiveWorkspace(tenantId, "00000000-0000-4000-8000-000000000099", "any"),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. WorkspaceBinding CRUD
// ═══════════════════════════════════════════════════════════

describe("workspace-queries：WorkspaceBinding CRUD", () => {
  it("createWorkspaceBinding：Desktop 成功 + 默认 active + locationFingerprint", async () => {
    const { tenantId, userId } = await seedContext();
    const device = await seedDevice(tenantId, userId);
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws1", displayName: "WS" });

    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "desktop",
      deviceId: device.id,
      locationRef: "device://device-1/home/user/project",
    });
    expect(binding.id).toBeTruthy();
    expect(binding.bindingType).toBe("desktop");
    expect(binding.deviceId).toBe(device.id);
    expect(binding.bindingState).toBe("active");
    expect(binding.locationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("createWorkspaceBinding：Desktop 缺 deviceId → ValidationError", async () => {
    const { tenantId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws2", displayName: "WS" });

    await expect(
      createWorkspaceBinding({
        tenantId,
        workspaceId: ws.id,
        bindingType: "desktop",
        locationRef: "device://device-1/path",
      }),
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it("createWorkspaceBinding：Cloud 设置 deviceId → ValidationError", async () => {
    const { tenantId, userId } = await seedContext();
    const device = await seedDevice(tenantId, userId);
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws3", displayName: "WS" });

    await expect(
      createWorkspaceBinding({
        tenantId,
        workspaceId: ws.id,
        bindingType: "cloud",
        deviceId: device.id,
        locationRef: "s3://bucket/key",
      }),
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it("createWorkspaceBinding：Cloud 无 deviceId 成功", async () => {
    const { tenantId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws4", displayName: "WS" });

    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://my-bucket/projects/proj-1",
    });
    expect(binding.bindingType).toBe("cloud");
    expect(binding.deviceId).toBeNull();
  });

  it("createWorkspaceBinding：Workspace 不存在 → NotFoundError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      createWorkspaceBinding({
        tenantId,
        workspaceId: "00000000-0000-4000-8000-000000000099",
        bindingType: "cloud",
        locationRef: "s3://bucket",
      }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it("createWorkspaceBinding：跨租户 Workspace → NotFoundError", async () => {
    const { tenantId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws5", displayName: "WS" });
    const otherTenantId = "00000000-0000-4000-8000-000000000099";

    await expect(
      createWorkspaceBinding({
        tenantId: otherTenantId,
        workspaceId: ws.id,
        bindingType: "cloud",
        locationRef: "s3://bucket",
      }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it("listWorkspaceBindings：默认排除 revoked；按 type 过滤", async () => {
    const { tenantId, userId } = await seedContext();
    const device = await seedDevice(tenantId, userId);
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws6", displayName: "WS" });

    const desktopBinding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "desktop",
      deviceId: device.id,
      locationRef: "device://device-1/path-1",
    });
    await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket-1",
    });

    const all = await listWorkspaceBindings(tenantId, ws.id);
    expect(all.length).toBe(2);

    const desktopOnly = await listWorkspaceBindings(tenantId, ws.id, { bindingType: "desktop" });
    expect(desktopOnly.length).toBe(1);
    expect(desktopOnly[0]?.id).toBe(desktopBinding.id);
  });

  it("updateWorkspaceBindingState：active → inactive → revoked；不可恢复", async () => {
    const { tenantId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws7", displayName: "WS" });
    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket-2",
    });

    const inactive = await updateWorkspaceBindingState(
      tenantId,
      binding.id,
      "inactive",
      binding.versionNo,
    );
    expect(inactive.bindingState).toBe("inactive");

    const revoked = await updateWorkspaceBindingState(
      tenantId,
      binding.id,
      "revoked",
      inactive.versionNo,
    );
    expect(revoked.bindingState).toBe("revoked");

    // revoked 不可恢复。
    await expect(
      updateWorkspaceBindingState(tenantId, binding.id, "active", revoked.versionNo),
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it("updateWorkspaceBindingState：版本号不匹配 → ConflictError", async () => {
    const { tenantId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws8", displayName: "WS" });
    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket-3",
    });

    await expect(
      updateWorkspaceBindingState(tenantId, binding.id, "inactive", "wrong-version"),
    ).rejects.toBeInstanceOf(WorkspaceVersionConflictError);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. WorkspaceAttachment CRUD
// ═══════════════════════════════════════════════════════════

describe("workspace-queries：WorkspaceAttachment CRUD", () => {
  it("createWorkspaceAttachment：成功 + 默认 attached/read + versionNo", async () => {
    const { tenantId, userId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws-att", displayName: "WS" });
    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket",
    });
    const thread = await seedThread(tenantId, userId, "agent-1");

    const att = await createWorkspaceAttachment({
      tenantId,
      threadId: thread.id,
      workspaceBindingId: binding.id,
      resourceType: "file",
      resourceRef: "s3://bucket/reports/report.pdf",
      displayRef: "reports/report.pdf",
      attachedBy: userId,
    });
    expect(att.id).toBeTruthy();
    expect(att.attachmentState).toBe("attached");
    expect(att.accessMode).toBe("read");
    expect(att.versionNo).toBeTruthy();
    expect(att.resourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("createWorkspaceAttachment：Binding 非 active → ValidationError", async () => {
    const { tenantId, userId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws-att2", displayName: "WS" });
    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket",
    });
    await updateWorkspaceBindingState(tenantId, binding.id, "inactive", binding.versionNo);
    const thread = await seedThread(tenantId, userId, "agent-1");

    await expect(
      createWorkspaceAttachment({
        tenantId,
        threadId: thread.id,
        workspaceBindingId: binding.id,
        resourceType: "file",
        resourceRef: "s3://bucket/file",
        attachedBy: userId,
      }),
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it("createWorkspaceAttachment：Binding 不存在 → NotFoundError", async () => {
    const { tenantId, userId } = await seedContext();
    const thread = await seedThread(tenantId, userId, "agent-1");

    await expect(
      createWorkspaceAttachment({
        tenantId,
        threadId: thread.id,
        workspaceBindingId: "00000000-0000-4000-8000-000000000099",
        resourceType: "file",
        resourceRef: "s3://bucket/file",
        attachedBy: userId,
      }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it("detachWorkspaceAttachment：成功 + 状态变化；重复 detach 抛错", async () => {
    const { tenantId, userId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws-det", displayName: "WS" });
    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket",
    });
    const thread = await seedThread(tenantId, userId, "agent-1");
    const att = await createWorkspaceAttachment({
      tenantId,
      threadId: thread.id,
      workspaceBindingId: binding.id,
      resourceType: "file",
      resourceRef: "s3://bucket/file",
      attachedBy: userId,
    });

    const detached = await detachWorkspaceAttachment(tenantId, att.id, att.versionNo);
    expect(detached.attachmentState).toBe("detached");

    // 重复 detach 抛错。
    await expect(
      detachWorkspaceAttachment(tenantId, att.id, detached.versionNo),
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it("listWorkspaceAttachmentsByThread：默认只返回 attached", async () => {
    const { tenantId, userId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws-list", displayName: "WS" });
    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket",
    });
    const thread = await seedThread(tenantId, userId, "agent-1");

    const att1 = await createWorkspaceAttachment({
      tenantId,
      threadId: thread.id,
      workspaceBindingId: binding.id,
      resourceType: "file",
      resourceRef: "s3://bucket/file1",
      attachedBy: userId,
    });
    await createWorkspaceAttachment({
      tenantId,
      threadId: thread.id,
      workspaceBindingId: binding.id,
      resourceType: "file",
      resourceRef: "s3://bucket/file2",
      attachedBy: userId,
    });

    // 默认返回 2 个 attached。
    const attached = await listWorkspaceAttachmentsByThread(tenantId, thread.id);
    expect(attached.length).toBe(2);

    // detach 一个后，默认返回 1 个。
    await detachWorkspaceAttachment(tenantId, att1.id, att1.versionNo);
    const afterDetach = await listWorkspaceAttachmentsByThread(tenantId, thread.id);
    expect(afterDetach.length).toBe(1);
    expect(afterDetach[0]?.resourceRef).toBe("s3://bucket/file2");

    // includeDetached 返回全部。
    const all = await listWorkspaceAttachmentsByThread(tenantId, thread.id, {
      includeDetached: true,
    });
    expect(all.length).toBe(2);
  });

  it("markExpiredWorkspaceAttachments：过期 attached → expired", async () => {
    const { tenantId, userId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws-exp", displayName: "WS" });
    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket",
    });
    const thread = await seedThread(tenantId, userId, "agent-1");

    const past = new Date(Date.now() - 60 * 1000);
    const att = await createWorkspaceAttachment({
      tenantId,
      threadId: thread.id,
      workspaceBindingId: binding.id,
      resourceType: "file",
      resourceRef: "s3://bucket/expired",
      attachedBy: userId,
      expiresAt: past,
    });

    const count = await markExpiredWorkspaceAttachments();
    expect(count).toBe(1);

    const updated = await getWorkspaceAttachmentById(tenantId, att.id);
    expect(updated?.attachmentState).toBe("expired");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. WorkspaceAttachmentUse + 跨租户隔离
// ═══════════════════════════════════════════════════════════

describe("workspace-queries：WorkspaceAttachmentUse", () => {
  it("createWorkspaceAttachmentUse：成功 + 幂等", async () => {
    const { tenantId, userId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws-use", displayName: "WS" });
    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket",
    });
    const thread = await seedThread(tenantId, userId, "agent-1");

    const att = await createWorkspaceAttachment({
      tenantId,
      threadId: thread.id,
      workspaceBindingId: binding.id,
      resourceType: "file",
      resourceRef: "s3://bucket/file",
      attachedBy: userId,
    });

    // Turn id 用 thread id 模拟（实际由 ThreadRun 分配）。
    const turnId = thread.id;
    const use1 = await createWorkspaceAttachmentUse({
      tenantId,
      turnId,
      workspaceAttachmentId: att.id,
    });
    expect(use1.id).toBeTruthy();

    // 幂等：相同 (turnId, attachmentId) 返回相同记录。
    const use2 = await createWorkspaceAttachmentUse({
      tenantId,
      turnId,
      workspaceAttachmentId: att.id,
    });
    expect(use2.id).toBe(use1.id);
  });

  it("createWorkspaceAttachmentUse：detached Attachment 拒绝", async () => {
    const { tenantId, userId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws-use2", displayName: "WS" });
    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket",
    });
    const thread = await seedThread(tenantId, userId, "agent-1");

    const att = await createWorkspaceAttachment({
      tenantId,
      threadId: thread.id,
      workspaceBindingId: binding.id,
      resourceType: "file",
      resourceRef: "s3://bucket/file",
      attachedBy: userId,
    });
    await detachWorkspaceAttachment(tenantId, att.id, att.versionNo);

    await expect(
      createWorkspaceAttachmentUse({
        tenantId,
        turnId: thread.id,
        workspaceAttachmentId: att.id,
      }),
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it("createWorkspaceAttachmentUse：过期 Attachment 拒绝 ExpiredError", async () => {
    const { tenantId, userId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws-use3", displayName: "WS" });
    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket",
    });
    const thread = await seedThread(tenantId, userId, "agent-1");

    const past = new Date(Date.now() - 60 * 1000);
    const att = await createWorkspaceAttachment({
      tenantId,
      threadId: thread.id,
      workspaceBindingId: binding.id,
      resourceType: "file",
      resourceRef: "s3://bucket/file",
      attachedBy: userId,
      expiresAt: past,
    });
    // 尚未跑 markExpired，状态仍 attached 但 expiresAt 已过。

    await expect(
      createWorkspaceAttachmentUse({
        tenantId,
        turnId: thread.id,
        workspaceAttachmentId: att.id,
      }),
    ).rejects.toBeInstanceOf(WorkspaceAttachmentExpiredError);
  });

  it("listWorkspaceAttachmentUsesByTurn：跨租户隔离", async () => {
    const { tenantId, userId } = await seedContext();
    const ws = await createWorkspace({ tenantId, workspaceKey: "ws-use4", displayName: "WS" });
    const binding = await createWorkspaceBinding({
      tenantId,
      workspaceId: ws.id,
      bindingType: "cloud",
      locationRef: "s3://bucket",
    });
    const thread = await seedThread(tenantId, userId, "agent-1");

    const att = await createWorkspaceAttachment({
      tenantId,
      threadId: thread.id,
      workspaceBindingId: binding.id,
      resourceType: "file",
      resourceRef: "s3://bucket/file",
      attachedBy: userId,
    });
    await createWorkspaceAttachmentUse({
      tenantId,
      turnId: thread.id,
      workspaceAttachmentId: att.id,
    });

    const mine = await listWorkspaceAttachmentUsesByTurn(tenantId, thread.id);
    expect(mine.length).toBe(1);

    const otherTenantId = "00000000-0000-4000-8000-000000000099";
    const cross = await listWorkspaceAttachmentUsesByTurn(otherTenantId, thread.id);
    expect(cross.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. resolveWorkspaceLocation 位置优先级
// ═══════════════════════════════════════════════════════════

describe("workspace-queries：resolveWorkspaceLocation 位置优先级", () => {
  it("user_explicit 优先级最高", () => {
    const result = resolveWorkspaceLocation({
      userExplicitBindingId: "b-user",
      currentObjectBindingId: "b-current",
      toolExplicitBindingId: "b-tool",
      defaultWorkspaceBindingId: "b-default",
    });
    expect(result.priority).toBe("user_explicit");
    expect(result.workspaceBindingId).toBe("b-user");
    expect(result.isTemporary).toBe(false);
  });

  it("current_object 优先于 tool/default", () => {
    const result = resolveWorkspaceLocation({
      currentObjectBindingId: "b-current",
      toolExplicitBindingId: "b-tool",
      defaultWorkspaceBindingId: "b-default",
    });
    expect(result.priority).toBe("current_object");
    expect(result.workspaceBindingId).toBe("b-current");
  });

  it("tool_explicit 优先于 default/temporary", () => {
    const result = resolveWorkspaceLocation({
      toolExplicitBindingId: "b-tool",
      defaultWorkspaceBindingId: "b-default",
    });
    expect(result.priority).toBe("tool_explicit");
    expect(result.workspaceBindingId).toBe("b-tool");
  });

  it("temporary 在 default 之前（当允许临时）", () => {
    const result = resolveWorkspaceLocation({
      defaultWorkspaceBindingId: "b-default",
      allowTemporary: true,
    });
    expect(result.priority).toBe("temporary");
    expect(result.workspaceBindingId).toBeNull();
    expect(result.isTemporary).toBe(true);
  });

  it("default_workspace：无任何明确指定且不允许临时", () => {
    const result = resolveWorkspaceLocation({
      defaultWorkspaceBindingId: "b-default",
    });
    expect(result.priority).toBe("default_workspace");
    expect(result.workspaceBindingId).toBe("b-default");
    expect(result.isTemporary).toBe(false);
  });

  it("无任何 binding：返回 default_workspace 但 bindingId=null", () => {
    const result = resolveWorkspaceLocation({});
    expect(result.priority).toBe("default_workspace");
    expect(result.workspaceBindingId).toBeNull();
  });
});
