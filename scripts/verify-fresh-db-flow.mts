/** Canonical Seed 后在同一空库验证 Thread 与无 Thread Job 的新执行模型闭环。 */
import { randomUUID } from "node:crypto";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn, getTurnById } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { seedDefaultIdentity } from "@/lib/db/seed";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { attemptPreparationClaimForTest } from "@/lib/executions/test-support/preparation-fixtures";
import {
  seedPreparedJobRuntimeAttempt,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { getJobById } from "@/lib/job/job-queries";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { tenant as tenantTable } from "@/lib/persistence/schema/identity";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { createMockRuntimeClient } from "@/lib/runtime/runtime-client";
import { PROTOCOL_VERSION } from "@/lib/runtime/runtime-protocol";
import { createProductionWorkerRole } from "@/lib/workers/production-worker-role";
import { eq } from "drizzle-orm";

function required<T>(value: T | null | undefined, name: string): T {
  if (value == null) throw new Error(`[fresh-db-flow] ${name} 缺失`);
  return value;
}

async function execute(input: {
  tenantId: string;
  invocation: Parameters<typeof startRuntimeInvocation>[0]["invocation"];
  binding: Parameters<typeof startRuntimeInvocation>[0]["binding"];
  attempt: Parameters<typeof startRuntimeInvocation>[0]["attempt"];
  output: string;
}): Promise<void> {
  const revision = required(
    await getRuntimeRevisionById(input.binding.runtimeRevisionId),
    "RuntimeRevision",
  );
  const capabilitiesDigest = expectedCapabilityManifestDigest({
    runtimeRevisionId: revision.id,
    runtimeCapabilitiesJson: revision.runtimeCapabilitiesJson,
  });
  let startedSequence: string | null = null;
  const client = createMockRuntimeClient({
    async startInvocation({ request }) {
      startedSequence = request.producerSequenceStart;
      const remoteSessionRef = `fresh-session:${request.authority.ownershipId}`;
      const remoteExecutionRef = `fresh-execution:${request.authority.ownershipId}`;
      await ingressRuntimeEvents({
        tenantId: input.tenantId,
        invocationId: input.invocation.id,
        batch: {
          protocolVersion: PROTOCOL_VERSION,
          authority: request.authority,
          events: [
            {
              eventId: randomUUID(),
              producerSequence: request.producerSequenceStart,
              type: "execution.started",
              schemaVersion: 1,
              payload: {
                intentKey: `start:${request.authority.ownershipId}`,
                semanticRequestDigest: request.semanticRequestDigest,
                remoteSessionRef,
                remoteExecutionRef,
                capabilitiesDigest,
              },
            },
          ],
        },
      });
      return {
        protocolVersion: PROTOCOL_VERSION,
        authority: request.authority,
        semanticRequestDigest: request.semanticRequestDigest,
        accepted: true,
        remoteSessionRef,
        remoteExecutionRef,
        capabilitiesDigest,
        acceptedAt: Date.now(),
      };
    },
  });
  const started = await startRuntimeInvocation({
    tenantId: input.tenantId,
    invocation: input.invocation,
    binding: input.binding,
    attempt: input.attempt,
    sourceOperationKey: `invocation:${input.invocation.id}`,
    preparationClaim: await attemptPreparationClaimForTest(input.attempt.id),
    runtimeClient: client,
    runtimeEndpoint: "https://fresh-db-runtime.example.invalid",
    auth: { mode: "none" },
    callbackEndpoints: {
      events: "https://fresh-db-runtime.example.invalid/events",
      heartbeat: "https://fresh-db-runtime.example.invalid/heartbeat",
      context: "https://fresh-db-runtime.example.invalid/context",
      capabilityActions: "https://fresh-db-runtime.example.invalid/capability-actions",
      toolCalls: "https://fresh-db-runtime.example.invalid/tool-calls",
      userActions: "https://fresh-db-runtime.example.invalid/user-actions",
    },
  });
  if (!startedSequence) throw new Error("[fresh-db-flow] Runtime 未自报 started");
  const sequence = BigInt(startedSequence);
  await ingressRuntimeEvents({
    tenantId: input.tenantId,
    invocationId: input.invocation.id,
    batch: {
      protocolVersion: PROTOCOL_VERSION,
      authority: started.authority,
      events: [
        {
          eventId: randomUUID(),
          producerSequence: String(sequence + 1n),
          type: "response.completed",
          schemaVersion: 1,
          payload: { text: input.output, item_type: "assistant_message", finish_reason: "stop" },
        },
        {
          eventId: randomUUID(),
          producerSequence: String(sequence + 2n),
          type: "execution.completed",
          schemaVersion: 1,
          payload: { finish_reason: "execution.completed" },
        },
      ],
    },
  });
  const final = required(
    await getInvocationById(input.tenantId, input.invocation.id),
    "Invocation",
  );
  if (final.executionState !== "completed") {
    throw new Error(`[fresh-db-flow] Invocation 未完成（${final.executionState}）`);
  }
}

async function main(): Promise<void> {
  const seedTenants = await db.select().from(tenantTable);
  if (seedTenants.length !== 1) throw new Error("[fresh-db-flow] Canonical Seed 租户数不为一");
  const identity = await seedDefaultIdentity();
  if (identity.tenantId !== seedTenants[0]?.id) {
    throw new Error("[fresh-db-flow] 产品身份未复用 Canonical Seed 租户");
  }
  const created = await createThread({
    tenantId: identity.tenantId,
    ownerUserId: identity.userIdentityId,
    actorId: identity.userIdentityId,
    title: "Fresh DB Thread",
  });
  const accepted = await acceptUserMessageTurn({
    tenantId: identity.tenantId,
    threadId: created.thread.id,
    ownerUserId: identity.userIdentityId,
    actorId: identity.userIdentityId,
    content: { text: "fresh database thread input" },
  });
  const thread = await seedPreparedRuntimeAttempt({
    tenantId: identity.tenantId,
    thread: {
      threadId: created.thread.id,
      turnId: accepted.turn.id,
      triggerItemId: accepted.item.id,
    },
  });
  await execute({ ...thread, output: "fresh database thread output" });
  const completedTurn = required(await getTurnById(identity.tenantId, accepted.turn.id), "Turn");
  if (completedTurn.turnState !== "completed") {
    throw new Error(`[fresh-db-flow] Thread Turn 未完成（${completedTurn.turnState}）`);
  }
  const job = await seedPreparedJobRuntimeAttempt({ tenantId: identity.tenantId });
  if (
    job.invocation.threadId !== null ||
    job.invocation.turnId !== null ||
    job.invocation.jobId !== job.job.id
  ) {
    throw new Error("[fresh-db-flow] Job 误关联 Thread/Turn");
  }
  await execute({ ...job, output: "fresh database job output" });
  const worker = createProductionWorkerRole("job-worker");
  await worker.pollOnce();
  const completedJob = required(await getJobById(identity.tenantId, job.job.id), "Job");
  if (completedJob.jobState !== "completed" || !completedJob.resultHash) {
    throw new Error(`[fresh-db-flow] Job 未完成（${completedJob.jobState}）`);
  }
  const [savedThread] = await db
    .select()
    .from(threadTable)
    .where(eq(threadTable.id, created.thread.id));
  const [savedTurn] = await db.select().from(turnTable).where(eq(turnTable.id, accepted.turn.id));
  if (!savedThread || !savedTurn) throw new Error("[fresh-db-flow] Thread 产品事实丢失");
  console.log("[fresh-db-flow] PASS canonical seed -> Thread terminal -> no-Thread Job terminal");
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("[fresh-db-flow] FAIL", error);
  process.exit(1);
});
