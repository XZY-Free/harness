import type { EventBatchSink } from "@/lib/runtime/adapters/hosted-adapter";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";

/** Adapter 协议 conformance 专用端口；不进入生产 gateway。 */
export function createConformanceHostedApplicationService(params: {
  eventBatchSink: EventBatchSink;
}): HostedRuntimeApplicationService {
  return {
    async start({ invocationId }) {
      return { status: "resumed", invocationId, runtime: "hosted" };
    },
    async resume({ invocationId }) {
      return { status: "resumed", invocationId, runtime: "hosted" };
    },
    async cancel({ invocationId, reason }) {
      await params.eventBatchSink({
        invocationId,
        authority: {
          invocationId,
          runtimeRevisionId: invocationId,
          attemptId: invocationId,
          ownershipId: invocationId,
          leaseEpoch: "1",
          sessionBindingId: invocationId,
        },
        events: [
          {
            eventId: invocationId,
            producerSequence: "1",
            type: "execution.cancelled",
            schemaVersion: 1,
            payload: {
              cancelledBy: "conformance_control",
              reason: reason ?? "conformance_cancel",
            },
          },
        ],
      });
    },
    async steer() {},
  };
}
