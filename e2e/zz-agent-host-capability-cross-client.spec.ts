/**
 * 外部 Agent 宿主能力跨端 E2E。
 *
 * 真实 MySQL、真实 Next server、真实 Electron、真实 A2A HTTP Provider：
 * Web 看到外部 Agent 的 confirmation → Desktop 审批 → Web 不刷新收敛 resolved
 * → 同一 AgentCall/task/context 恢复并产生第二个 confirmation。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_PORT } from "../playwright.config";
import { launchDesktopApp } from "./support/launch-desktop";

function e2eRuntimeDescriptorPath(): string {
  return resolve(process.env.TMPDIR ?? "/tmp", `snow-harness-e2e-${E2E_PORT}.json`);
}

async function loadE2eHarness() {
  const descriptor = JSON.parse(readFileSync(e2eRuntimeDescriptorPath(), "utf8")) as {
    databaseUrl?: unknown;
  };
  if (typeof descriptor.databaseUrl !== "string" || descriptor.databaseUrl.length === 0) {
    throw new Error("E2E MySQL 运行描述缺失");
  }
  // Playwright 与 Next webServer 是不同进程；在 import DB module 前接入同一个临时容器。
  process.env.DATABASE_URL = descriptor.databaseUrl;

  const [
    { db },
    { DEFAULT_USER_ID },
    { ensureDefaultTenant },
    { getUserIdentityBySubject },
    { EXECUTION_FIXTURE_CONTRACT, seedAgentCallExecutionScenario },
    { createAgentActionExecutor },
    { createResolveRoute },
    { mysqlRouteEligibilityResolutionStore },
    { executionSubjectFromUserIdentity },
    { createProductionInvocationContinuationWorker },
    { resumeAgentCallFromUserAction },
    { agentCallTable },
    { userActionRequestTable },
    { and, eq },
  ] = await Promise.all([
    import("@/lib/db/client"),
    import("@/lib/constants"),
    import("@/lib/identity/tenant-queries"),
    import("@/lib/identity/user-identity-queries"),
    import("@/lib/agents/calls/test/agent-call-execution-fixtures"),
    import("@/lib/agents/calls/application/agent-action-executor"),
    import("@/lib/routes/application/resolve-route"),
    import("@/lib/routes/persistence/mysql-route-eligibility-resolution-store"),
    import("@/lib/runtime/transport/execution-subject"),
    import("@/lib/runtime/continuation/production-invocation-continuation-worker"),
    import("@/lib/agents/calls/application/resume-agent-call-from-user-action"),
    import("@/lib/persistence/schema/agent-calls"),
    import("@/lib/persistence/schema/user-action-request"),
    import("drizzle-orm"),
  ]);
  return {
    db,
    DEFAULT_USER_ID,
    ensureDefaultTenant,
    getUserIdentityBySubject,
    EXECUTION_FIXTURE_CONTRACT,
    seedAgentCallExecutionScenario,
    createAgentActionExecutor,
    createResolveRoute,
    mysqlRouteEligibilityResolutionStore,
    executionSubjectFromUserIdentity,
    createProductionInvocationContinuationWorker,
    resumeAgentCallFromUserAction,
    agentCallTable,
    userActionRequestTable,
    and,
    eq,
  };
}

test("外部 Agent confirmation：Web 展示 → Desktop 审批 → Web 收敛 → same AgentCall 第二次确认", async ({
  page,
}) => {
  const harness = await loadE2eHarness();
  const tenant = await harness.ensureDefaultTenant();
  const owner = await harness.getUserIdentityBySubject(tenant.id, harness.DEFAULT_USER_ID);
  if (!owner) throw new Error("E2E 默认员工身份不存在");

  const actionId = `e2e-agent-confirmation-${randomUUID()}`;
  const scenario = await harness.seedAgentCallExecutionScenario({
    tenantId: tenant.id,
    threadOwnerUserId: owner.id,
    sourceRef: actionId,
    providerScenario: "confirmation_chain",
    contract: {
      ...harness.EXECUTION_FIXTURE_CONTRACT,
      interaction: {
        ...harness.EXECUTION_FIXTURE_CONTRACT.interaction,
        input_required: true,
        resume: true,
      },
    },
    agentInterfaceRequirements: {
      host_controls: { confirmation_action_keys: ["hr.leave.submit"] },
    },
  });
  const executionSubject = harness.executionSubjectFromUserIdentity(tenant.id, owner.id);
  const continuationWorker = harness.createProductionInvocationContinuationWorker(
    "e2e-agent-host-capability",
  );
  const desktop = await launchDesktopApp();

  try {
    // 先打开真实 Web 会话，再由真实 AgentCall/A2A 事件写入用户确认请求。
    await page.goto(`/chat/${scenario.threadId}`);
    await expect(page.getByLabel("消息输入框")).toBeEnabled({ timeout: 90_000 });

    const execute = harness.createAgentActionExecutor({
      tenantId: tenant.id,
      executionSubject,
      resolveRoute: harness.createResolveRoute({
        store: harness.mysqlRouteEligibilityResolutionStore,
      }),
      transportChannel: "hosted",
    });
    const started = await execute(
      {
        actionId,
        stepNo: 1,
        actionType: "agent.call",
        purposeCode: "submit_leave",
        shortPurpose: "提交请假",
        payload: { agentId: scenario.agentId, task: "提交我的年假申请" },
      },
      {
        invocationId: scenario.parentInvocationId,
        tenantId: tenant.id,
        threadId: scenario.threadId,
        turnId: scenario.turnId,
        actionDigest: `sha256:${"f".repeat(64)}`,
      },
    );
    const callId = started.pending?.callId;
    expect(callId).toBe(scenario.callId);
    if (!callId) throw new Error("AgentCall 未创建");

    await expect
      .poll(async () => {
        const [call] = await harness.db
          .select({ state: harness.agentCallTable.state })
          .from(harness.agentCallTable)
          .where(harness.eq(harness.agentCallTable.id, callId));
        return call?.state;
      })
      .toBe("waiting_user");
    await continuationWorker.pollOnce();

    // Web 不刷新，必须通过真实 Timeline/SSE 收到外部 Agent 的结构化确认。
    await expect(
      page.getByLabel("对话时间线").getByText("提交请假申请", { exact: true }),
    ).toBeVisible({
      timeout: 90_000,
    });
    await expect(page.getByLabel("操作预览")).toBeVisible();
    await expect(page.getByText("年假", { exact: true })).toBeVisible();

    const desktopWindow = await desktop.app.firstWindow();
    const rendererOrigin = new URL(desktopWindow.url()).origin;
    await desktopWindow.goto(`${rendererOrigin}/desktop/chat/${scenario.threadId}`);
    await expect(
      desktopWindow.getByLabel("对话时间线").getByText("提交请假申请", { exact: true }),
    ).toBeVisible({ timeout: 90_000 });
    await desktopWindow.getByRole("button", { name: "确认", exact: true }).click();

    // Desktop 经正式 :resolve API 写 Authority；两端均不刷新，Web 由 Event 收敛。
    await expect(
      desktopWindow
        .getByRole("log", { name: "对话时间线" })
        .locator("span")
        .filter({ hasText: "已同意" })
        .first(),
    ).toBeVisible({ timeout: 90_000 });
    await expect(
      page
        .getByRole("log", { name: "对话时间线" })
        .locator("span")
        .filter({ hasText: "已同意" })
        .first(),
    ).toBeVisible({ timeout: 90_000 });

    const [resolvedFirst] = await harness.db
      .select()
      .from(harness.userActionRequestTable)
      .where(
        harness.and(
          harness.eq(harness.userActionRequestTable.invocationId, scenario.parentInvocationId),
          harness.eq(harness.userActionRequestTable.requestState, "resolved"),
        ),
      )
      .limit(1);
    if (!resolvedFirst) throw new Error("首个 confirmation 未解析");
    expect(resolvedFirst.harnessActionId).not.toBe(actionId);

    // E2E server 不后台常驻 continuation worker；这里同步驱动与生产同一个 worker/service。
    const resumed = await harness.resumeAgentCallFromUserAction({
      tenantId: tenant.id,
      request: resolvedFirst,
      responseRedactedJson: resolvedFirst.responseRedactedJson,
      executionSubject,
    });
    expect(resumed).toMatchObject({ resumed: true, callId, state: "waiting_user" });
    await continuationWorker.pollOnce();

    await expect(page.getByText("确认第二项请假操作")).toBeVisible({ timeout: 90_000 });
    const requests = await harness.db
      .select()
      .from(harness.userActionRequestTable)
      .where(harness.eq(harness.userActionRequestTable.invocationId, scenario.parentInvocationId));
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((request) => request.harnessActionId)).size).toBe(2);
    expect(scenario.provider.captured).toHaveLength(2);
    expect(scenario.provider.captured[1]).toMatchObject({
      resume: true,
      taskId: (resolvedFirst.promptJson as Record<string, unknown>).task_id,
      contextId: (resolvedFirst.promptJson as Record<string, unknown>).context_id,
    });
  } finally {
    continuationWorker.stop();
    delete process.env[scenario.credentialEnvVar];
    await scenario.provider.close();
    await desktop.dispose();
  }
});
