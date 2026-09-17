import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { describe, expect, it, vi } from "vitest";
import { createHostedAdapter } from "./hosted-adapter";

describe("Hosted Adapter durable resume", () => {
  it("全新 Adapter 不依赖旧实例 Map，直接把 invocationId 交给 durable service", async () => {
    const authority = {
      invocationId: "00000000-0000-4000-8000-000000000021",
      runtimeRevisionId: "00000000-0000-4000-8000-000000000022",
      attemptId: "00000000-0000-4000-8000-000000000023",
      ownershipId: "00000000-0000-4000-8000-000000000024",
      leaseEpoch: "1",
      sessionBindingId: "00000000-0000-4000-8000-000000000025",
    } as const;
    const resume = vi.fn(async ({ invocationId }: { invocationId: string }) => ({
      status: "resumed" as const,
      invocationId,
      runtime: "hosted" as const,
      completed: true,
    }));
    const service: HostedRuntimeApplicationService = {
      start: vi.fn(),
      resume,
      cancel: vi.fn(),
      steer: vi.fn(),
    };

    createHostedAdapter({
      platformEndpoint: "in-process://platform",
      platformAuthToken: "old-instance-token",
      tenantId: "tenant-1",
      applicationService: service,
    });
    const freshAdapter = createHostedAdapter({
      platformEndpoint: "in-process://platform",
      platformAuthToken: "fresh-instance-token",
      tenantId: "tenant-1",
      applicationService: service,
    });

    const result = await freshAdapter.handleResume({
      invocationId: authority.invocationId,
      authority,
      resumePayload: { requestId: "uar-1" },
    });

    expect(result.response.accepted).toBe(true);
    // R02 §2：全新 Adapter 也必须把冻结 tuple 一路交到 durable service。
    expect(resume).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      invocationId: authority.invocationId,
      authority,
      idempotencyKey: `hosted-resume:${authority.invocationId}`,
      resumePayload: { requestId: "uar-1" },
    });
  });
});
