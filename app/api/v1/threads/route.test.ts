import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveEmployeePrincipal: vi.fn(),
  listThreadsForUser: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock("@/lib/conversations/route-helpers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/conversations/route-helpers")>();
  return { ...original, resolveEmployeePrincipal: mocks.resolveEmployeePrincipal };
});
vi.mock("@/lib/conversations/thread-queries", () => ({
  listThreadsForUser: mocks.listThreadsForUser,
  createThread: vi.fn(),
}));
vi.mock("@/lib/agents/persistence/agent-queries", () => ({
  listAgents: mocks.listAgents,
  getAgentById: vi.fn(),
}));

import { aiConfig } from "@/lib/config";
import { GET } from "./route";

describe("GET /api/v1/threads（Desktop/Web shell）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEmployeePrincipal.mockResolvedValue({
      tenantId: "tenant-1",
      userIdentityId: "viewer-1",
    });
    mocks.listThreadsForUser.mockResolvedValue([]);
    mocks.listAgents.mockResolvedValue([]);
  });

  it("把服务端配置事实源 aiConfig.chatModel 投影为 default_model_ref", async () => {
    const response = await GET(new Request("http://localhost/api/v1/threads") as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { default_model_ref: string };
    expect(body.default_model_ref).toBe(aiConfig.chatModel);
    expect(body.default_model_ref.length).toBeGreaterThan(0);
  });
});
