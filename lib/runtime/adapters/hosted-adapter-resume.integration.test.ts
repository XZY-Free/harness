import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { describe, expect, it, vi } from "vitest";
import { createHostedAdapter } from "./hosted-adapter";

describe("Hosted Adapter durable resume", () => {
  it("全新 Adapter 不依赖旧实例 Map，直接把 invocationId 交给 durable service", async () => {
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
      invocationId: "inv-resume-from-db",
      resumePayload: { request_id: "uar-1" },
    });

    expect(result.resume_state).toBe("accepted");
    expect(resume).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      invocationId: "inv-resume-from-db",
      idempotencyKey: "hosted-resume:inv-resume-from-db",
      resumePayload: { request_id: "uar-1" },
    });
  });
});
