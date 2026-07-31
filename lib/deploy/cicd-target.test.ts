import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.8 Stage D：CI/CD webhook 交接测试。
 *
 * 覆盖：triggerDeploy / queryStatus / triggerRollback / 失败重试 / 超时 / 未配置错误。
 */

const origEnv = { ...process.env };

beforeEach(() => {
  process.env.DEPLOY_CICD_WEBHOOK_URL = "https://cicd.example.com/api/deploy";
  process.env.DEPLOY_CICD_STATUS_URL = "https://cicd.example.com/api/status/{jobId}";
  process.env.DEPLOY_CICD_API_TOKEN = "test-token";
  process.env.DEPLOY_ENVIRONMENTS = "staging,prod";
  process.env.DEPLOY_TIMEOUT_MS = "5000";
  process.env.DEPLOY_MAX_RETRIES = "2";
});

afterEach(() => {
  for (const k of [
    "DEPLOY_CICD_WEBHOOK_URL",
    "DEPLOY_CICD_STATUS_URL",
    "DEPLOY_CICD_API_TOKEN",
    "DEPLOY_ENVIRONMENTS",
    "DEPLOY_TIMEOUT_MS",
    "DEPLOY_MAX_RETRIES",
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, origEnv);
  vi.restoreAllMocks();
});

describe("isCicdConfigured", () => {
  it("webhook URL 已配置 → true", async () => {
    const { isCicdConfigured } = await import("./cicd-target");
    expect(isCicdConfigured()).toBe(true);
  });

  it("webhook URL 未配置 → false", async () => {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.DEPLOY_CICD_WEBHOOK_URL;
    const { isCicdConfigured } = await import("./cicd-target");
    expect(isCicdConfigured()).toBe(false);
  });
});

describe("triggerDeploy", () => {
  it("成功触发部署 → 返回 cicdJobId + cicdJobUrl", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ cicdJobId: "job-123", cicdJobUrl: "https://cicd.example.com/jobs/123" }),
        {
          status: 200,
        },
      ),
    );

    const { triggerDeploy } = await import("./cicd-target");
    const result = await triggerDeploy({
      environment: "staging",
      commitSha: "abc123",
      imageTag: "v1.0.0",
    });

    expect(result.cicdJobId).toBe("job-123");
    expect(result.cicdJobUrl).toBe("https://cicd.example.com/jobs/123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 验证请求包含鉴权 header
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("webhook 未配置 → 明确错误", async () => {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.DEPLOY_CICD_WEBHOOK_URL;
    const { triggerDeploy } = await import("./cicd-target");
    await expect(triggerDeploy({ environment: "staging" })).rejects.toThrow(
      /DEPLOY_CICD_WEBHOOK_URL 未配置/,
    );
  });

  it("4xx 错误不重试", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("Bad Request", { status: 400 }));

    const { triggerDeploy } = await import("./cicd-target");
    await expect(triggerDeploy({ environment: "staging" })).rejects.toThrow(/400/);
    // 4xx 不重试，只调一次
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx 错误重试", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Server Error", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cicdJobId: "job-456" }), { status: 200 }),
      );

    const { triggerDeploy } = await import("./cicd-target");
    const result = await triggerDeploy({ environment: "staging" });

    expect(result.cicdJobId).toBe("job-456");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("响应缺少 cicdJobId → 错误", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const { triggerDeploy } = await import("./cicd-target");
    await expect(triggerDeploy({ environment: "staging" })).rejects.toThrow(/缺少 cicdJobId/);
  });

  // S1（09-P2-3）：per-thread cicdToken 优先于全局
  it("threadCicdToken 优先于全局 DEPLOY_CICD_API_TOKEN", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ cicdJobId: "job-thread" }), { status: 200 }),
      );

    const { triggerDeploy } = await import("./cicd-target");
    await triggerDeploy({
      environment: "staging",
      threadCicdToken: "thread-override-token",
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer thread-override-token",
    });
  });

  it("无 threadCicdToken → 回退全局 DEPLOY_CICD_API_TOKEN", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ cicdJobId: "job-global" }), { status: 200 }),
      );

    const { triggerDeploy } = await import("./cicd-target");
    await triggerDeploy({ environment: "staging" });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });
});

describe("queryStatus", () => {
  it("成功查询 job 状态", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ status: "succeeded", url: "https://cicd.example.com/jobs/123" }),
        {
          status: 200,
        },
      ),
    );

    const { queryStatus } = await import("./cicd-target");
    const result = await queryStatus("job-123");

    expect(result.status).toBe("succeeded");
    expect(result.url).toBe("https://cicd.example.com/jobs/123");
  });

  it("status URL 未配置 → 错误", async () => {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.DEPLOY_CICD_STATUS_URL;
    const { queryStatus } = await import("./cicd-target");
    await expect(queryStatus("job-123")).rejects.toThrow(/DEPLOY_CICD_STATUS_URL 未配置/);
  });

  it("未知状态 → 默认 pending", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "unknown_state" }), { status: 200 }),
    );

    const { queryStatus } = await import("./cicd-target");
    const result = await queryStatus("job-123");
    expect(result.status).toBe("pending");
  });
});

describe("triggerRollback", () => {
  it("触发回滚 → 返回新 job id", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ cicdJobId: "rollback-job-1" }), { status: 200 }),
      );

    const { triggerRollback } = await import("./cicd-target");
    const result = await triggerRollback({
      environment: "prod",
      previousDeploymentId: "dep-123",
      previousCommitSha: "abc123",
    });

    expect(result.cicdJobId).toBe("rollback-job-1");
    // 验证 body 包含 rollback action
    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(init?.body as string);
    expect(body.action).toBe("rollback");
    expect(body.previousDeploymentId).toBe("dep-123");
  });
});
