import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { registerDevice, revokeDevice } from "@/lib/identity/device-queries";
import { tenant, userIdentity } from "@/lib/persistence/schema/identity";
import { resolveToolExecutionTarget } from "@/lib/runtime/resolve-tool-execution-target";
import { describe, expect, it } from "vitest";
import { ensureDesktopWorkspace, resolveWorkspaceBindingId } from "./desktop-workspace-queries";

describe("Desktop Workspace 绑定", () => {
  it("同一用户、设备和目录指纹幂等复用，并可供调度器解析", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    await db.insert(tenant).values({
      id: tenantId,
      key: `desktop-${randomUUID()}`,
      name: "Desktop workspace test",
    });
    await db.insert(userIdentity).values({
      id: userId,
      tenantId,
      externalSubject: `user-${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
    });
    await registerDevice({
      tenantId,
      userId,
      deviceKey: "device-key-1",
      publicKey: "public-key",
      deviceName: "Mac",
      appVersion: "1.0.0",
    });
    const input = {
      tenantId,
      userId,
      deviceKey: "device-key-1",
      displayName: "snow_harness",
      locationFingerprint: `sha256:${"a".repeat(64)}`,
    };

    const first = await ensureDesktopWorkspace(input);
    const second = await ensureDesktopWorkspace(input);

    expect(second).toEqual(first);
    const targetInput = {
      tenantId,
      threadId: "target-thread",
      workspaceBindingId: first.bindingId,
      ownerUserId: userId,
    };
    await expect(resolveToolExecutionTarget(targetInput)).resolves.toMatchObject({
      kind: "desktop",
      workspaceBindingId: first.bindingId,
      ownerUserId: userId,
    });
    await expect(
      resolveToolExecutionTarget({ ...targetInput, tenantId: randomUUID() }),
    ).resolves.toBeNull();
    await expect(
      resolveToolExecutionTarget({ ...targetInput, ownerUserId: randomUUID() }),
    ).resolves.toBeNull();
    await expect(resolveWorkspaceBindingId(tenantId, first.workspaceId, userId)).resolves.toBe(
      first.bindingId,
    );
    await expect(
      resolveWorkspaceBindingId(tenantId, first.workspaceId, randomUUID()),
    ).resolves.toBeNull();

    await revokeDevice(tenantId, "device-key-1");
    await expect(resolveToolExecutionTarget(targetInput)).resolves.toBeNull();
    await expect(
      resolveWorkspaceBindingId(tenantId, first.workspaceId, userId),
    ).resolves.toBeNull();
  });
});
