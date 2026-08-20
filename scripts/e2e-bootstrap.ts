/**
 * e2e 正式链引导（在 dev server 启动前执行）。
 *
 * 建出可执行的默认 Agent 正式链，使 Web / Desktop 客户端发送的首条消息能真正走通
 * Route Resolver → ExecutionBinding → Runtime，而不是在
 * `POST /api/v1/threads/{id}/turns` 因 `dispatched=false` 抛错。
 *
 * 全程调用正式服务与正式验签器（见 `lib/test-support/seed-executable-default-agent.ts`
 * 的 §11.2 合规说明）。由 `scripts/e2e-start.mts` 以子进程方式调用，
 * DATABASE_URL 由父进程注入。
 */
import { seedExecutableDefaultAgent } from "@/lib/test-support/seed-executable-default-agent";

async function main(): Promise<void> {
  const context = await seedExecutableDefaultAgent();
  if (context.created) {
    console.log(
      `[e2e-bootstrap] 正式链就绪：agent=${context.agentId} agentRevision=${context.agentRevisionId} ` +
        `runtimeRevision=${context.runtimeRevisionId} route=${context.routeId}`,
    );
  } else {
    console.log(`[e2e-bootstrap] 正式链已存在，幂等跳过：agent=${context.agentId}`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("[e2e-bootstrap] 失败：", error);
  process.exit(1);
});
