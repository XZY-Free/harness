import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { getDeviceForUser } from "@/lib/identity/device-queries";
import { device } from "@/lib/persistence/schema/device";
import { workspace, workspaceBinding } from "@/lib/persistence/schema/workspace";
import { and, eq } from "drizzle-orm";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export class DesktopWorkspaceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopWorkspaceUnavailableError";
  }
}

export interface DesktopWorkspaceRegistration {
  workspaceId: string;
  bindingId: string;
  displayName: string;
}

/**
 * 把已由 Desktop 验证过的本地目录登记为逻辑 Workspace。
 * 服务端只保存设备绑定后的指纹；本机绝对路径留在 Desktop SQLite。
 */
export async function ensureDesktopWorkspace(input: {
  tenantId: string;
  userId: string;
  deviceKey: string;
  displayName: string;
  locationFingerprint: string;
}): Promise<DesktopWorkspaceRegistration> {
  if (!SHA256.test(input.locationFingerprint)) {
    throw new DesktopWorkspaceUnavailableError("目录指纹无效");
  }
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 256) {
    throw new DesktopWorkspaceUnavailableError("目录名称无效");
  }

  const device = await getDeviceForUser(input.tenantId, input.deviceKey, input.userId);
  if (!device || device.deviceState !== "active") {
    throw new DesktopWorkspaceUnavailableError("当前设备尚未注册或已被撤销");
  }

  const workspaceKey = `desktop_${input.locationFingerprint.slice("sha256:".length, 39)}`;
  return db.transaction(async (tx) => {
    await tx.insert(workspace).ignore().values({
      tenantId: input.tenantId,
      ownerUserId: input.userId,
      workspaceKey,
      displayName,
      workspaceKind: "personal",
    });

    const [workspaceRow] = await tx
      .select()
      .from(workspace)
      .where(and(eq(workspace.tenantId, input.tenantId), eq(workspace.workspaceKey, workspaceKey)))
      .for("update")
      .limit(1);
    if (
      !workspaceRow ||
      workspaceRow.ownerUserId !== input.userId ||
      workspaceRow.lifecycleState !== "active"
    ) {
      throw new DesktopWorkspaceUnavailableError("本地目录 Workspace 不可用");
    }

    const [existingBinding] = await tx
      .select()
      .from(workspaceBinding)
      .where(
        and(
          eq(workspaceBinding.tenantId, input.tenantId),
          eq(workspaceBinding.workspaceId, workspaceRow.id),
          eq(workspaceBinding.deviceId, device.id),
          eq(workspaceBinding.bindingType, "desktop"),
          eq(workspaceBinding.locationFingerprint, input.locationFingerprint),
          eq(workspaceBinding.bindingState, "active"),
        ),
      )
      .limit(1);

    const bindingId = existingBinding?.id ?? randomUUID();
    if (!existingBinding) {
      await tx.insert(workspaceBinding).values({
        id: bindingId,
        tenantId: input.tenantId,
        workspaceId: workspaceRow.id,
        bindingType: "desktop",
        deviceId: device.id,
        locationRef: input.locationFingerprint,
        locationFingerprint: input.locationFingerprint,
        bindingState: "active",
        lastVerifiedAt: new Date(),
      });
    } else {
      await tx
        .update(workspaceBinding)
        .set({ lastVerifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(workspaceBinding.id, existingBinding.id));
    }

    await tx
      .update(workspace)
      .set({ defaultBindingId: bindingId, displayName, updatedAt: new Date() })
      .where(eq(workspace.id, workspaceRow.id));

    return { workspaceId: workspaceRow.id, bindingId, displayName };
  });
}

/** 解析 Thread 默认 Workspace 的有效 Binding；任一事实失配都 fail closed。 */
export async function resolveWorkspaceBindingId(
  tenantId: string,
  workspaceId: string,
  ownerUserId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ bindingId: workspaceBinding.id })
    .from(workspace)
    .innerJoin(
      workspaceBinding,
      and(
        eq(workspaceBinding.id, workspace.defaultBindingId),
        eq(workspaceBinding.workspaceId, workspace.id),
        eq(workspaceBinding.tenantId, workspace.tenantId),
      ),
    )
    .innerJoin(
      device,
      and(eq(device.id, workspaceBinding.deviceId), eq(device.tenantId, workspaceBinding.tenantId)),
    )
    .where(
      and(
        eq(workspace.tenantId, tenantId),
        eq(workspace.id, workspaceId),
        eq(workspace.ownerUserId, ownerUserId),
        eq(workspace.lifecycleState, "active"),
        eq(workspaceBinding.bindingState, "active"),
        eq(device.deviceState, "active"),
      ),
    )
    .limit(1);
  return row?.bindingId ?? null;
}
