/**
 * Thread 环境选择在**默认生产调度链**上的应用事实（schema-design §5.2.20）。
 *
 * 证明的是生产写入，不是仓储方法本身：
 * - 生效选择（`accepted_for_next_invocation`）被真实 `dispatchInvocationForTurn` 采用，
 *   ExecutionBinding 冻结的 Revision = 该选择声明的 Revision；
 * - 同一个调用把选择推进到 `applied` 并回填 `firstAppliedInvocationId`；
 * - `applied` 之后它仍是后续默认选择（后续 Invocation 继续冻结同一 Revision），
 *   首用锚点只有一条（重复调度幂等）。
 *
 * 受控替身只在 Docker/Provider 边界：本用例不发起 Runtime 传输（不传 runtimeClient），
 * 因此 Provisioner 的返回值不参与任何断言，仅用于满足 MANAGED 组合的必需依赖。
 */
import { randomUUID } from "node:crypto";
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createEnvironmentDefinition,
  createEnvironmentRevision,
} from "@/lib/environment/environment-definition-store";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import type { EnvironmentRevisionInput } from "@/lib/environment/environment-revision";
import {
  getEnvironmentChangeRequestById,
  requestEnvironmentSelection,
} from "@/lib/environment/environment-selection";
import { threadTable } from "@/lib/persistence/schema/conversation";
import type { EnvironmentLease } from "@/lib/persistence/schema/environment";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

function revisionInput(
  overrides: Partial<EnvironmentRevisionInput> = {},
): EnvironmentRevisionInput {
  return {
    environmentType: "sandbox",
    filesystemPolicyJson: { writeRoots: ["workspace"] },
    networkPolicyJson: { egress: "deny_all" },
    resourceLimitsJson: { cpu: 2, memoryMb: 2048 },
    secretPolicyJson: { inject: "none" },
    executionTarget: { kind: "container", image: "snowharness/test:latest" },
    requiredCapabilities: { isolation: true },
    createdByType: "user",
    createdById: "test-admin",
    ...overrides,
  };
}

/** Docker/Provider 边界替身：本套件不发起 Runtime 传输，故其返回值不被消费。 */
const boundaryProvisioner: EnvironmentProvisioner = {
  async provision() {
    return { id: randomUUID(), tenantId: "unused" } as unknown as EnvironmentLease;
  },
  async revalidate() {
    return { id: randomUUID(), tenantId: "unused" } as unknown as EnvironmentLease;
  },
  async cleanup() {
    return { state: "released" as const, cleanupCount: 1 };
  },
};

describe("Environment selection application on the production dispatch chain", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  async function seedThreadWithSelection(selectionSuffix: string) {
    const context = await seedDispatchableTurn({ contentSuffix: selectionSuffix });
    const definition = await createEnvironmentDefinition({
      tenantId: context.tenantId,
      environmentKey: `dispatch-selection-${selectionSuffix}`,
      displayName: "调度选择环境",
      revision: revisionInput(),
    });
    await db
      .update(threadTable)
      .set({ defaultEnvironmentDefinitionId: definition.id })
      .where(and(eq(threadTable.tenantId, context.tenantId), eq(threadTable.id, context.threadId)));
    const requested = await createEnvironmentRevision(
      context.tenantId,
      definition.id,
      revisionInput({ environmentType: "cloud" }),
    );
    const selection = await requestEnvironmentSelection({
      tenantId: context.tenantId,
      threadId: context.threadId,
      requestedRevisionId: requested.id,
      requestedBy: context.ownerId,
    });
    return { context, definition, requested, selection };
  }

  it("ENV-APPLY-01: the default dispatcher freezes the selected revision and records the first application", async () => {
    const { context, requested, selection } = await seedThreadWithSelection("apply01");
    const dispatch = await dispatchInvocationForTurn({
      tenantId: context.tenantId,
      turnId: context.turnId,
      executionSubject: {
        tenantId: context.tenantId,
        subjectType: "user",
        subjectId: context.ownerId,
      },
      environmentProvisioner: boundaryProvisioner,
    });
    if (!dispatch.dispatched || !dispatch.binding) throw new Error("调度未发生");
    // Binding 真实冻结了选择声明的 Revision（不是 Definition 的 currentRevision）。
    expect(dispatch.binding.environmentDefinitionRevisionId).toBe(requested.id);
    expect(dispatch.binding.environmentMode).toBe("MANAGED");
    // 同一次调用把选择推进到 applied 并回填首用锚点。
    const applied = await getEnvironmentChangeRequestById(context.tenantId, selection.id);
    expect(applied?.requestState).toBe("applied");
    expect(applied?.firstAppliedInvocationId).toBe(dispatch.invocation?.id);
  });

  it("ENV-APPLY-02: an applied selection keeps driving later invocations with one first-application anchor", async () => {
    const { context, requested, selection } = await seedThreadWithSelection("apply02");
    const first = await dispatchInvocationForTurn({
      tenantId: context.tenantId,
      turnId: context.turnId,
      executionSubject: {
        tenantId: context.tenantId,
        subjectType: "user",
        subjectId: context.ownerId,
      },
      environmentProvisioner: boundaryProvisioner,
    });
    if (!first.dispatched || !first.invocation) throw new Error("首个调度未发生");
    const secondTurn = await acceptUserMessageTurn({
      tenantId: context.tenantId,
      threadId: context.threadId,
      ownerUserId: context.ownerId,
      content: { text: "第二轮：沿用同一环境选择" },
      actorId: context.ownerId,
    });
    const second = await dispatchInvocationForTurn({
      tenantId: context.tenantId,
      turnId: secondTurn.turn.id,
      executionSubject: {
        tenantId: context.tenantId,
        subjectType: "user",
        subjectId: context.ownerId,
      },
      environmentProvisioner: boundaryProvisioner,
    });
    if (!second.dispatched || !second.invocation || !second.binding)
      throw new Error("第二个调度未发生");

    // 长期生效：第二个 Invocation 继续冻结同一选择的 Revision。
    expect(second.binding.environmentDefinitionRevisionId).toBe(requested.id);
    // 首次应用记录只有一条，不被后续 Invocation 改写。
    const final = await getEnvironmentChangeRequestById(context.tenantId, selection.id);
    expect(final?.requestState).toBe("applied");
    expect(final?.firstAppliedInvocationId).toBe(first.invocation.id);
    expect(final?.versionNo).toBe(2);
  });
});
