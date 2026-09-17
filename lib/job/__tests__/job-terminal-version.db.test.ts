/**
 * R04：Job 终态桥与 Invocation 终态必须共用同一个最终版本。
 *
 * 走真实 RuntimeEventIngress（而不是直接调用 transitionInvocation），因为此前的确定性
 * 缺陷正出在 Ingress 尾部：终态写入与 Job 桥提交之后，还有一个无条件的 `versionNo + 1`
 * 批次水位更新，使 JobCommand.payloadJson.terminalVersion 落后于 Invocation.versionNo，
 * 真实消费者按严格版本比较会把合法的终态命令判为 InputDigestMismatch。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  acquireTestRuntimeAuthority,
  seedPreparedJobRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { consumeJobCommand } from "@/lib/job/job-command-consumer";
import { getJobById } from "@/lib/job/job-queries";
import { executionOwnershipTable, invocationTable } from "@/lib/persistence/schema/executions";
import { jobCommandTable } from "@/lib/persistence/schema/job";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/** R02 §3：该夹具 Session 冻结的发布能力证据（Hosted Revision 的能力名列表）。 */
const RUNTIME_CAPABILITIES_JSON = ["event_stream"];

async function startJobRuntime() {
  const fixture = await seedPreparedJobRuntimeAttempt();
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
  });
  const activationEvidence = {
    kind: "job-terminal-version-test",
    ownershipId: acquired.ownership.id,
  };
  await db
    .update(executionOwnershipTable)
    .set({
      activationEvidence,
      activationDigest: protocolDigest(activationEvidence),
      activatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(executionOwnershipTable.id, acquired.ownership.id));

  const semanticRequest = { invocationId: fixture.invocation.id, fixture: "job-terminal" };
  const semanticRequestDigest = protocolDigest(semanticRequest);
  const remoteSessionRef = `runtime-session:${acquired.session.id}`;
  const remoteExecutionRef = `runtime-execution:${fixture.invocation.id}`;
  // R02 §3：Hosted 接纳回执的摘要来自冻结发布证据（Session 与事件必须同源）。
  const capabilitiesDigest = expectedCapabilityManifestDigest({
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
  });
  await applyRuntimeSessionDispatchForTest(fixture.tenantId, acquired.session.id, {
    bindingState: "dispatching",
    semanticRequestJson: semanticRequest,
    semanticRequestDigest,
    remoteSessionRef,
    remoteExecutionRef,
    transportAcknowledgement: { capabilitiesDigest },
  });
  await ingressRuntimeEvents({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    batch: {
      protocolVersion: 3,
      authority: acquired.authority,
      events: [
        {
          eventId: randomUUID(),
          producerSequence: "1",
          type: "execution.started",
          schemaVersion: 1,
          payload: {
            intentKey: acquired.session.startIntentKey,
            semanticRequestDigest,
            remoteSessionRef,
            remoteExecutionRef,
            capabilitiesDigest,
          },
        },
      ],
    },
  });
  return { fixture, acquired };
}

describe("Job terminal bridge version", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  it("JOB-TERMINAL-01: Runtime 终态事件经真实 Ingress 后，JobCommand 版本与 Invocation 最终版本一致", async () => {
    const { fixture, acquired } = await startJobRuntime();
    const resultRef = "artifact://job/terminal-version";
    const resultDigest = protocolDigest({ result: "terminal-version" });

    await ingressRuntimeEvents({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      batch: {
        protocolVersion: 3,
        authority: acquired.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "2",
            type: "execution.completed",
            schemaVersion: 1,
            payload: { resultRef, resultDigest },
          },
        ],
      },
    });

    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, fixture.tenantId),
          eq(invocationTable.id, fixture.invocation.id),
        ),
      );
    expect(invocation?.executionState).toBe("completed");

    const [command] = await db
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.tenantId, fixture.tenantId),
          eq(jobCommandTable.jobId, fixture.job.id),
          eq(jobCommandTable.commandType, "execution_terminal"),
        ),
      );
    expect(command).toBeTruthy();
    const payload = command?.payloadJson as Record<string, unknown>;
    // 终态版本必须等于 Invocation 最终提交版本——桥之后不得再有版本推进。
    expect(payload.terminalVersion).toBe(invocation?.versionNo);
    expect(payload.terminalState).toBe("completed");

    const consumed = await consumeJobCommand({
      tenantId: fixture.tenantId,
      commandId: command?.id ?? "",
    });
    expect(consumed.outcome).toBe("terminal_applied");
    expect(consumed.job.jobState).toBe("completed");
    const job = await getJobById(fixture.tenantId, fixture.job.id);
    expect(job?.resultRef).toBe(resultRef);
    expect(job?.resultHash).toBe(resultDigest);
  });
});
