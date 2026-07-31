import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1（09-P1-4）：sweepDeployingStatuses 专项测试。
 *
 * sweep 扫描 deploying 状态 deployment,调 queryStatus 回写终态(deployed/failed)。
 * 原 cicd-target.test 未覆盖 sweep 逻辑(代码+idle sweep 集成真,但无单测)。
 * mock @/lib/db/queries(listDeployingDeployments/updateDeployment)+ fetch(queryStatus)。
 */

const queries = vi.hoisted(() => ({
  listDeployingDeployments: vi.fn(),
  updateDeployment: vi.fn().mockResolvedValue(undefined),
  getThreadById: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/db/queries", () => ({
  listDeployingDeployments: queries.listDeployingDeployments,
  updateDeployment: queries.updateDeployment,
  getThreadById: queries.getThreadById,
}));

vi.mock("@/lib/runtime/secret-crypto", () => ({
  decryptCicdToken: vi.fn((v: string | null | undefined) => v ?? null),
}));

const origEnv = { ...process.env };

beforeEach(() => {
  process.env.DEPLOY_CICD_STATUS_URL = "https://cicd.example.com/api/status/{jobId}";
  process.env.DEPLOY_CICD_API_TOKEN = "test-token";
  queries.listDeployingDeployments.mockReset();
  queries.updateDeployment.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  Object.assign(process.env, origEnv);
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.DEPLOY_CICD_STATUS_URL;
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.DEPLOY_CICD_API_TOKEN;
  vi.restoreAllMocks();
});

describe("sweepDeployingStatuses（09-P1-4）", () => {
  it("succeeded → 更新为 deployed + deployedAt", async () => {
    queries.listDeployingDeployments.mockResolvedValue([
      { id: "d1", cicdJobId: "job-1", threadId: "t1" },
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "succeeded" }), { status: 200 }),
    );

    const { sweepDeployingStatuses } = await import("./cicd-target");
    await sweepDeployingStatuses();

    expect(queries.updateDeployment).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "deployed" }),
    );
    expect(queries.updateDeployment.mock.calls[0]?.[1]?.deployedAt).toBeInstanceOf(Date);
  });

  it("failed → 更新为 failed + errorMessage", async () => {
    queries.listDeployingDeployments.mockResolvedValue([
      { id: "d2", cicdJobId: "job-2", threadId: "t1" },
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "failed", message: "build error" }), { status: 200 }),
    );

    const { sweepDeployingStatuses } = await import("./cicd-target");
    await sweepDeployingStatuses();

    expect(queries.updateDeployment).toHaveBeenCalledWith(
      "d2",
      expect.objectContaining({ status: "failed", errorMessage: "build error" }),
    );
  });

  it("running → 不更新(保持 deploying,下次 sweep 再试)", async () => {
    queries.listDeployingDeployments.mockResolvedValue([
      { id: "d3", cicdJobId: "job-3", threadId: "t1" },
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "running" }), { status: 200 }),
    );

    const { sweepDeployingStatuses } = await import("./cicd-target");
    await sweepDeployingStatuses();

    expect(queries.updateDeployment).not.toHaveBeenCalled();
  });

  it("无 cicdJobId → 跳过(不查状态)", async () => {
    queries.listDeployingDeployments.mockResolvedValue([
      { id: "d4", cicdJobId: null, threadId: "t1" },
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const { sweepDeployingStatuses } = await import("./cicd-target");
    await sweepDeployingStatuses();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(queries.updateDeployment).not.toHaveBeenCalled();
  });

  it("queryStatus 抛错 → 保持 deploying,不阻塞其他 deployment", async () => {
    queries.listDeployingDeployments.mockResolvedValue([
      { id: "d5", cicdJobId: "job-5", threadId: "t1" },
      { id: "d6", cicdJobId: "job-6", threadId: "t1" },
    ]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "succeeded" }), { status: 200 }))
      .mockRejectedValueOnce(new Error("network"));

    const { sweepDeployingStatuses } = await import("./cicd-target");
    await sweepDeployingStatuses();

    // d5 成功更新,d6 查询失败保持 deploying(不阻塞)
    expect(queries.updateDeployment).toHaveBeenCalledTimes(1);
    expect(queries.updateDeployment).toHaveBeenCalledWith(
      "d5",
      expect.objectContaining({ status: "deployed" }),
    );
  });

  it("无 deploying deployment → 不查不更新", async () => {
    queries.listDeployingDeployments.mockResolvedValue([]);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const { sweepDeployingStatuses } = await import("./cicd-target");
    await sweepDeployingStatuses();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(queries.updateDeployment).not.toHaveBeenCalled();
  });
});
