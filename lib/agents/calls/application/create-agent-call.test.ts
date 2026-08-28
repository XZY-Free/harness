/**
 * createAgentCall 应用服务集成测试 — 真实 MySQL。
 *
 * 目标不变量：
 * 1. createAgentCall 幂等：同 (parentInvocationId, logicalCallKey) 只创建一次。
 * 2. 复用 CapabilityUse(type=agent) 账本：不新建第二套 AgentUse 日志。
 * 3. AgentCallBinding 冻结证据不可变（bindingHash 可验证）。
 * 4. cross-tenant fail-closed：parent Invocation 异租户 → 拒绝。
 */
import { randomUUID } from "node:crypto";
import { createCreateAgentCall } from "@/lib/agents/calls/application/create-agent-call";
import { computeAgentCallBindingHash } from "@/lib/agents/calls/domain/agent-call-binding";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import {
  seedInvocation,
  seedTenant,
  validBindingConfig,
} from "@/lib/agents/calls/test/agent-call-test-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { capabilityUseTable } from "@/lib/persistence/schema/capability-use";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-28T00:00:00.000Z");
const createAgentCall = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });

beforeEach(async () => {
  await resetDatabase(db);
});

describe("createAgentCall 应用服务", () => {
  it("创建 AgentCall + 冻结 Binding + 写 CapabilityUse(type=agent)", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    const binding = validBindingConfig();
    const result = await createAgentCall({
      tenantId,
      parentInvocationId: parentId,
      agentId: "agent-1",
      agentRevisionId: "agent-rev-1",
      sourceType: "user_selected",
      sourceRef: "turn-1",
      logicalCallKey: "required-agent:turn-1:agent-1",
      binding,
      now: NOW,
    });

    expect(result.created).toBe(true);
    expect(result.call.parentInvocationId).toBe(parentId);

    // CapabilityUse(type=agent) 已写入（复用现有账本）。
    const [use] = await db
      .select()
      .from(capabilityUseTable)
      .where(
        and(
          eq(capabilityUseTable.tenantId, tenantId),
          eq(capabilityUseTable.invocationId, parentId),
          eq(capabilityUseTable.capabilityType, "agent"),
        ),
      )
      .limit(1);
    expect(use?.capabilityId).toBe("agent-1");
    expect(use?.revisionId).toBe("agent-rev-1");
    expect(use?.sourceType).toBe("user_selected");
  });

  it("幂等：同 (parentInvocationId, logicalCallKey) 重试不重复创建远端 Task", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    const cmd = {
      tenantId,
      parentInvocationId: parentId,
      agentId: "agent-1",
      agentRevisionId: "agent-rev-1",
      sourceType: "user_selected" as const,
      sourceRef: "turn-1",
      logicalCallKey: "required-agent:turn-1:agent-1",
      binding: validBindingConfig(),
      now: NOW,
    };
    const first = await createAgentCall(cmd);
    const second = await createAgentCall(cmd);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.call.id).toBe(first.call.id);
    // CapabilityUse 幂等：只写一次。
    const uses = await db
      .select()
      .from(capabilityUseTable)
      .where(eq(capabilityUseTable.invocationId, parentId));
    expect(uses.length).toBe(1);
  });

  it("Binding 证据冻结：bindingHash 与重新计算一致", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    const binding = validBindingConfig();
    const result = await createAgentCall({
      tenantId,
      parentInvocationId: parentId,
      agentId: "agent-1",
      agentRevisionId: "agent-rev-1",
      sourceType: "user_selected",
      sourceRef: "turn-1",
      logicalCallKey: "required-agent:turn-1:agent-1",
      binding,
      now: NOW,
    });
    const frozen = await mysqlAgentCallStore.getBinding({ callId: result.call.id, tenantId });
    expect(frozen).toEqual(binding);
    expect(computeAgentCallBindingHash(frozen as ReturnType<typeof validBindingConfig>)).toBe(
      computeAgentCallBindingHash(binding),
    );
  });

  it("cross-tenant fail-closed：parent Invocation 异租户 → 拒绝", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const parentA = await seedInvocation(tenantA);
    await expect(
      createAgentCall({
        tenantId: tenantB,
        parentInvocationId: parentA,
        agentId: "agent-1",
        agentRevisionId: "agent-rev-1",
        sourceType: "user_selected",
        sourceRef: "turn-1",
        logicalCallKey: "required-agent:turn-1:agent-1",
        binding: validBindingConfig(),
        now: NOW,
      }),
    ).rejects.toThrow(/parent Invocation .* 不存在或不属于租户/);
  });
});
