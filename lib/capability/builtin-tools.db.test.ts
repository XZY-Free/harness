import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { beforeEach, expect, it } from "vitest";
import { registerBuiltinTools } from "./builtin-tools";
import { getCurrentToolSchemaRevision, listTools, updateTool } from "./tool-queries";

beforeEach(async () => {
  await resetDatabase(db);
});

it("登记真实内置工具，重复执行不产生新版本，也不重新启用已停用工具", async () => {
  const tenant = await ensureDefaultTenant();
  const owner = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "builtin-owner",
    email: "builtin-owner@example.com",
    displayName: "Builtin Owner",
  });
  const input = { tenantId: tenant.id, ownerUserId: owner.id };
  await registerBuiltinTools(input);
  const first = await listTools({ tenantId: tenant.id, limit: 100 });
  expect(first.items.map((tool) => tool.toolKey).sort()).toEqual([
    "shell",
    "web-fetch",
    "web-search",
  ]);
  for (const tool of first.items) {
    expect(tool.lifecycleState).toBe("enabled");
    const revision = await getCurrentToolSchemaRevision({ tenantId: tenant.id, toolId: tool.id });
    expect(revision?.revisionState).toBe("published");
    expect(revision?.executionContractJson).toMatchObject({
      sideEffectMode: tool.toolKey === "shell" ? "write" : "read",
      providerOperationMetadata: { operation: tool.toolKey.replace("-", "_") },
    });
  }
  const disabled = first.items[0]!;
  await updateTool({
    tenantId: tenant.id,
    toolId: disabled.id,
    expectedVersionNo: disabled.versionNo,
    lifecycleState: "disabled",
  });
  await registerBuiltinTools(input);
  const second = await listTools({ tenantId: tenant.id, limit: 100 });
  expect(second.items.map((tool) => [tool.id, tool.currentSchemaRevisionId]).sort()).toEqual(
    first.items.map((tool) => [tool.id, tool.currentSchemaRevisionId]).sort(),
  );
  expect(second.items.find((tool) => tool.id === disabled.id)?.lifecycleState).toBe("disabled");
});
