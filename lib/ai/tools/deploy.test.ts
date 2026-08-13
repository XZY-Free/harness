import { computeArgFingerprint } from "@/lib/permission/approval";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TID = "test-deploy-tools";

const queryMocks = vi.hoisted(() => ({
  createToolRun: vi.fn(),
  appendThreadEvent: vi.fn(),
  finishToolRunSuccess: vi.fn(),
  finishToolRunFailure: vi.fn(),
  listPermissionRules: vi.fn(),
  findMatchingApprovals: vi.fn(),
  consumeOnceApproval: vi.fn(),
  requestApprovalAtomic: vi.fn(),
  updateThreadStatus: vi.fn(),
  getDeployment: vi.fn(),
  listDeploymentsByThread: vi.fn(),
  updateDeployment: vi.fn(),
  createDeployment: vi.fn(),
  claimDeployingSlot: vi.fn(),
  getLatestDeployedByThread: vi.fn(),
  getThreadById: vi.fn(),
}));
vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: vi.fn() }));
// P1-20: decryptCicdToken 现 fail-closed(拒明文);测试用 identity mock 模拟已解密
vi.mock("@/lib/runtime/secret-crypto", () => ({
  decryptCicdToken: (s: string | null | undefined) => s ?? null,
}));
vi.mock("@/lib/db/queries", () => ({
  createToolRun: queryMocks.createToolRun,
  appendThreadEvent: queryMocks.appendThreadEvent,
  finishToolRunSuccess: queryMocks.finishToolRunSuccess,
  finishToolRunFailure: queryMocks.finishToolRunFailure,
  listPermissionRules: queryMocks.listPermissionRules,
  findMatchingApprovals: queryMocks.findMatchingApprovals,
  consumeOnceApproval: queryMocks.consumeOnceApproval,
  requestApprovalAtomic: queryMocks.requestApprovalAtomic,
  updateThreadStatus: queryMocks.updateThreadStatus,
  getDeployment: queryMocks.getDeployment,
  listDeploymentsByThread: queryMocks.listDeploymentsByThread,
  updateDeployment: queryMocks.updateDeployment,
  createDeployment: queryMocks.createDeployment,
  claimDeployingSlot: queryMocks.claimDeployingSlot,
  getLatestDeployedByThread: queryMocks.getLatestDeployedByThread,
  getThreadById: queryMocks.getThreadById,
}));

const cicdMocks = vi.hoisted(() => ({
  isCicdConfigured: vi.fn(),
  queryStatus: vi.fn(),
  triggerDeploy: vi.fn(),
  triggerRollback: vi.fn(),
}));
vi.mock("@/lib/deploy/cicd-target", () => ({
  isCicdConfigured: cicdMocks.isCicdConfigured,
  queryStatus: cicdMocks.queryStatus,
  triggerDeploy: cicdMocks.triggerDeploy,
  triggerRollback: cicdMocks.triggerRollback,
}));

vi.mock("@/lib/deploy/artifact", () => ({
  buildArtifact: vi.fn(),
  persistArtifact: vi.fn(),
  summarizeEnv: vi.fn(),
}));

import { buildDeployTools } from "./deploy";

type ToolLike = { execute?: (...args: never[]) => unknown };
function callExecute(tool: ToolLike, input: unknown): Promise<unknown> {
  if (!tool.execute) throw new Error("tool.execute missing");
  return Promise.resolve(tool.execute(input as never, { toolCallId: "t", messages: [] } as never));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMocks.createToolRun.mockResolvedValue({ id: "run-1", threadId: TID, status: "running" });
  queryMocks.appendThreadEvent.mockResolvedValue(undefined);
  queryMocks.finishToolRunSuccess.mockResolvedValue(undefined);
  queryMocks.finishToolRunFailure.mockResolvedValue(undefined);
  queryMocks.listPermissionRules.mockResolvedValue([]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
  queryMocks.consumeOnceApproval.mockResolvedValue(true);
  queryMocks.requestApprovalAtomic.mockResolvedValue({
    run: { id: "run-ask", status: "awaiting_approval" },
    approval: { id: "apr-1" },
  });
  queryMocks.updateThreadStatus.mockResolvedValue(undefined);
  queryMocks.updateDeployment.mockImplementation(
    async (_id: string, patch: Record<string, unknown>) => ({
      id: "dep-1",
      threadId: TID,
      environment: "staging",
      commitSha: null,
      imageTag: null,
      artifactRef: null,
      cicdJobId: "job-1",
      cicdJobUrl: "https://ci/job/1",
      status: "deploying",
      previousDeploymentId: null,
      deployedAt: null,
      rolledBackAt: null,
      errorMessage: null,
      createdAt: new Date(),
      ...patch,
    }),
  );
  queryMocks.getThreadById.mockResolvedValue({ id: TID, userId: "u1" });
});

describe("deployStatus", () => {
  it("CI/CD 状态查询失败时不再吞掉错误", async () => {
    queryMocks.listDeploymentsByThread.mockResolvedValue([
      {
        id: "dep-1",
        threadId: TID,
        environment: "staging",
        commitSha: null,
        imageTag: null,
        artifactRef: null,
        cicdJobId: "job-1",
        cicdJobUrl: "https://ci/job/1",
        status: "deploying",
        previousDeploymentId: null,
        deployedAt: null,
        rolledBackAt: null,
        errorMessage: null,
        createdAt: new Date(),
      },
    ]);
    cicdMocks.queryStatus.mockRejectedValue(new Error("status backend down"));

    const tools = buildDeployTools(TID);
    const r = await callExecute(tools.deployStatus, {});
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining("CI/CD 状态查询失败"),
      deploymentId: "dep-1",
      status: "deploying",
    });
  });
});

// S1（09-P1-5）：deployToEnvironment 并发控制——同 thread 已有 deploying → 拒绝
// deployToEnvironment 默认 ask，测试注入既定 approved 升级 allow 才能进入 runner
describe("deployToEnvironment 并发控制", () => {
  function approvedApproval(input: Record<string, unknown>) {
    return [
      {
        id: "apr-deploy",
        threadId: TID,
        permissionKey: "tool.deployToEnvironment",
        argFingerprint: computeArgFingerprint("tool.deployToEnvironment", input),
        status: "approved",
        approvedScope: "always",
        expiresAt: null,
      },
    ];
  }

  it("已有 deploying 状态 deployment → 拒绝（ok:false），不触发 CI/CD", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue(
      approvedApproval({ environment: "staging" }),
    );
    // P1-8: claimDeployingSlot 原子返回 busy,防并发触发多次 CI/CD
    queryMocks.claimDeployingSlot.mockResolvedValueOnce({ busy: true });
    cicdMocks.isCicdConfigured.mockReturnValue(true);

    const tools = buildDeployTools(TID);
    const r = (await callExecute(tools.deployToEnvironment, {
      environment: "staging",
    })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("部署正在进行中");
    // claim 被调用但未触发 CI/CD
    expect(queryMocks.claimDeployingSlot).toHaveBeenCalled();
    expect(cicdMocks.triggerDeploy).not.toHaveBeenCalled();
  });

  it("无 deploying 状态 deployment → 通过（创建 + 触发 CI/CD）", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue(
      approvedApproval({ environment: "staging" }),
    );
    queryMocks.listDeploymentsByThread.mockResolvedValue([
      {
        id: "dep-old",
        threadId: TID,
        environment: "staging",
        commitSha: null,
        imageTag: null,
        artifactRef: null,
        cicdJobId: "job-old",
        cicdJobUrl: "https://ci/job/old",
        status: "deployed",
        previousDeploymentId: null,
        deployedAt: new Date(),
        rolledBackAt: null,
        errorMessage: null,
        createdAt: new Date(),
      },
    ]);
    cicdMocks.isCicdConfigured.mockReturnValue(true);
    queryMocks.claimDeployingSlot.mockResolvedValue({
      deployment: {
        id: "dep-new",
        threadId: TID,
        environment: "staging",
        commitSha: null,
        imageTag: null,
        artifactRef: null,
        cicdJobId: null,
        cicdJobUrl: null,
        status: "pending",
        previousDeploymentId: null,
        deployedAt: null,
        rolledBackAt: null,
        errorMessage: null,
        createdAt: new Date(),
      },
    });
    cicdMocks.triggerDeploy.mockResolvedValue({
      cicdJobId: "job-new",
      cicdJobUrl: "https://ci/job/new",
    });

    const tools = buildDeployTools(TID);
    const r = (await callExecute(tools.deployToEnvironment, {
      environment: "staging",
    })) as { ok: boolean; deploymentId?: string };
    expect(r.ok).toBe(true);
    expect(r.deploymentId).toBe("dep-new");
    expect(queryMocks.claimDeployingSlot).toHaveBeenCalled();
    expect(cicdMocks.triggerDeploy).toHaveBeenCalled();
  });

  // S1（09-P2-3）：per-thread cicdApiToken 透传给 triggerDeploy
  it("thread 配置 cicdApiToken → triggerDeploy 收到 threadCicdToken", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue(
      approvedApproval({ environment: "staging" }),
    );
    queryMocks.listDeploymentsByThread.mockResolvedValue([]);
    cicdMocks.isCicdConfigured.mockReturnValue(true);
    queryMocks.getThreadById.mockResolvedValue({
      id: TID,
      userId: "u1",
      cicdApiToken: "thread-secret-token",
    });
    queryMocks.claimDeployingSlot.mockResolvedValue({
      deployment: {
        id: "dep-tok",
        threadId: TID,
        environment: "staging",
        commitSha: null,
        imageTag: null,
        artifactRef: null,
        cicdJobId: null,
        cicdJobUrl: null,
        status: "pending",
        previousDeploymentId: null,
        deployedAt: null,
        rolledBackAt: null,
        errorMessage: null,
        createdAt: new Date(),
      },
    });
    cicdMocks.triggerDeploy.mockResolvedValue({
      cicdJobId: "job-tok",
      cicdJobUrl: "https://ci/job/tok",
    });

    const tools = buildDeployTools(TID);
    const r = (await callExecute(tools.deployToEnvironment, {
      environment: "staging",
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(cicdMocks.triggerDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ threadCicdToken: "thread-secret-token" }),
    );
  });

  it("thread 无 cicdApiToken → triggerDeploy 收到 threadCicdToken=undefined（回退全局）", async () => {
    queryMocks.findMatchingApprovals.mockResolvedValue(
      approvedApproval({ environment: "staging" }),
    );
    queryMocks.listDeploymentsByThread.mockResolvedValue([]);
    cicdMocks.isCicdConfigured.mockReturnValue(true);
    queryMocks.getThreadById.mockResolvedValue({
      id: TID,
      userId: "u1",
      cicdApiToken: null,
    });
    queryMocks.claimDeployingSlot.mockResolvedValue({
      deployment: {
        id: "dep-notok",
        threadId: TID,
        environment: "staging",
        commitSha: null,
        imageTag: null,
        artifactRef: null,
        cicdJobId: null,
        cicdJobUrl: null,
        status: "pending",
        previousDeploymentId: null,
        deployedAt: null,
        rolledBackAt: null,
        errorMessage: null,
        createdAt: new Date(),
      },
    });
    cicdMocks.triggerDeploy.mockResolvedValue({
      cicdJobId: "job-notok",
      cicdJobUrl: "https://ci/job/notok",
    });

    const tools = buildDeployTools(TID);
    const r = (await callExecute(tools.deployToEnvironment, {
      environment: "staging",
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    // threadCicdToken undefined → cicd-target 内回退到全局 deployConfig.cicdApiToken
    expect(cicdMocks.triggerDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ threadCicdToken: undefined }),
    );
  });
});

// V6-M1-4：rollback 不再立即标 deployed，保持 deploying 等 sweep 确认
describe("rollback 异步确认（M1-4）", () => {
  it("rollback 成功后 deployment 状态为 deploying（非 deployed），由 sweepDeployingStatuses 轮询确认", async () => {
    // 审计修复：rollback 默认 ask，需注入 approved approval 才能进入 runner
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-rollback",
        threadId: TID,
        permissionKey: "tool.rollback",
        argFingerprint: computeArgFingerprint("tool.rollback", { deploymentId: "dep-target" }),
        status: "approved",
        approvedScope: "always",
        expiresAt: null,
      },
    ]);
    queryMocks.getDeployment.mockResolvedValue({
      id: "dep-target",
      threadId: TID,
      environment: "staging",
      commitSha: "abc123",
      imageTag: null,
      artifactRef: null,
      cicdJobId: "job-old",
      cicdJobUrl: "https://ci/job/old",
      status: "deployed",
      previousDeploymentId: null,
      deployedAt: new Date(),
      rolledBackAt: null,
      errorMessage: null,
      createdAt: new Date(),
    });
    queryMocks.claimDeployingSlot.mockResolvedValue({
      deployment: {
        id: "dep-rollback",
        threadId: TID,
        environment: "staging",
        commitSha: "abc123",
        imageTag: null,
        artifactRef: null,
        cicdJobId: null,
        cicdJobUrl: null,
        status: "pending",
        previousDeploymentId: "dep-target",
        deployedAt: null,
        rolledBackAt: null,
        errorMessage: null,
        createdAt: new Date(),
      },
    });
    cicdMocks.isCicdConfigured.mockReturnValue(true);
    cicdMocks.triggerRollback.mockResolvedValue({
      cicdJobId: "job-rb",
      cicdJobUrl: "https://ci/job/rb",
    });

    const tools = buildDeployTools(TID);
    const r = (await callExecute(tools.rollback, {
      deploymentId: "dep-target",
    })) as { ok: boolean; deploymentId?: string };
    expect(r.ok).toBe(true);
    expect(r.deploymentId).toBe("dep-rollback");

    // M1-4 关键断言：updateDeployment 对 rollback deployment 的最终调用应为 "deploying"
    const updateCalls = queryMocks.updateDeployment.mock.calls.filter(
      (c: unknown[]) => c[0] === "dep-rollback",
    );
    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall).toBeDefined();
    expect(lastCall?.[1]).toMatchObject({ status: "deploying" });
    expect(lastCall?.[1]).not.toHaveProperty("deployedAt");
  });
});
