import { ExecutionAuthorityError } from "@/lib/executions/domain/execution-authority";
import { ingressErrorToResponse } from "@/lib/runtime/route-helpers";
import { describe, expect, it } from "vitest";

describe("Runtime route error boundary", () => {
  it("returns an explicit access denial when an authenticated stale executor reaches Ingress", async () => {
    const response = await ingressErrorToResponse(
      new ExecutionAuthorityError("NotCurrentExecutor", "ExecutionOwnership 已被新的执行者接管"),
      "request-runtime-authority",
    );

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      error: {
        code: "ACCESS_DENIED",
        request_id: "request-runtime-authority",
        details: { code: "NotCurrentExecutor" },
      },
    });
  });
});
