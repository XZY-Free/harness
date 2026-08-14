import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchAvailableModels: vi.fn(),
  resolveEmployeePrincipal: vi.fn(),
}));

vi.mock("@/lib/ai/models", () => ({
  fetchAvailableModels: mocks.fetchAvailableModels,
}));

vi.mock("@/lib/conversations/route-helpers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/conversations/route-helpers")>();
  return {
    ...original,
    resolveEmployeePrincipal: mocks.resolveEmployeePrincipal,
  };
});

import { AuthenticationError } from "@/lib/identity/resolver";
import { GET } from "./route";

describe("GET /api/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEmployeePrincipal.mockResolvedValue({ userIdentityId: "user-1" });
    mocks.fetchAvailableModels.mockResolvedValue([{ id: "model-1" }]);
  });

  it("使用正式员工身份链读取模型列表", async () => {
    const response = await GET(new Request("http://localhost/api/models") as never);

    expect(response.status).toBe(200);
    expect(mocks.resolveEmployeePrincipal).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { models: [{ id: "model-1" }] },
    });
  });

  it("只把身份错误映射为 401", async () => {
    mocks.resolveEmployeePrincipal.mockRejectedValue(
      new AuthenticationError("missing_identity", "缺少 SSO 用户标识"),
    );

    const response = await GET(new Request("http://localhost/api/models") as never);
    expect(response.status).toBe(401);
  });

  it("数据库等非身份异常向上抛出，不伪装成 401", async () => {
    const databaseError = new Error("UserIdentity table unavailable");
    mocks.resolveEmployeePrincipal.mockRejectedValue(databaseError);

    await expect(GET(new Request("http://localhost/api/models") as never)).rejects.toBe(
      databaseError,
    );
  });
});
