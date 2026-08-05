import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { listItemsByThread } from "@/lib/v11/conversation/thread-item-queries";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { acceptUserMessageTurn, getTurnById } from "@/lib/v11/conversation/turn-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { dispatchEmployeeTurn } from "@/lib/v11/runtime/employee-turn-dispatcher";
import { subscribeThreadTransientEvents } from "@/lib/v11/runtime/transient-event-bus";
import { installTrustedHostedControlPlaneEvidenceForTest } from "@/lib/v11/test-support/trusted-hosted-control-plane-evidence";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
  restoreEvidence = installTrustedHostedControlPlaneEvidenceForTest();
});

afterEach(() => {
  restoreEvidence();
});

let restoreEvidence: () => void;

describe("dispatchEmployeeTurn", () => {
  it("接纳的 Turn 会经内置 Hosted Runtime 生成并持久化真实 Agent 回复", async () => {
    const tenant = await ensureDefaultTenant();
    const owner = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "employee-turn-owner",
      email: "employee-turn-owner@example.com",
      displayName: "Employee Turn Owner",
    });
    const agent = await createAgent({
      tenantId: tenant.id,
      agentKey: "default",
      displayName: "默认助手",
      ownerUserId: owner.id,
      lifecycleState: "enabled",
    });
    const { thread } = await createThread({
      tenantId: tenant.id,
      ownerUserId: owner.id,
      primaryAgentId: agent.id,
      actorId: owner.id,
    });
    const { turn } = await acceptUserMessageTurn({
      tenantId: tenant.id,
      threadId: thread.id,
      ownerUserId: owner.id,
      content: { text: "请确认已经接通" },
      actorId: owner.id,
    });
    const deltas: string[] = [];
    const unsubscribe = subscribeThreadTransientEvents(thread.id, (event) => {
      if (event.type === "response.delta") deltas.push(event.payload.delta as string);
    });

    const dispatched = await dispatchEmployeeTurn({
      tenantId: tenant.id,
      threadId: thread.id,
      turnId: turn.id,
      modelRef: "test-model",
      modelFn: async (message, context) => {
        await context.emitTextDelta?.("真实执行器");
        await context.emitTextDelta?.(`回复：${message}`);
        return `真实执行器回复：${message}`;
      },
    });
    await dispatched.completion;
    unsubscribe();

    const updatedTurn = await getTurnById(tenant.id, turn.id);
    const items = await listItemsByThread(tenant.id, thread.id);
    expect(dispatched.dispatched).toBe(true);
    expect(deltas).toEqual(["真实执行器", "回复：请确认已经接通"]);
    expect(updatedTurn?.turnState).toBe("completed");
    expect(items.find((item) => item.itemType === "agent_message")?.contentJson).toMatchObject({
      text: "真实执行器回复：请确认已经接通",
      model_ref: "test-model",
    });
  });
});
