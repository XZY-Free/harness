import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Topic 01 production wiring", () => {
  it("shared production executor registers tool.call through the ToolCall application service", () => {
    const factory = source("lib/runtime/harness-loop/platform-action-executors.ts");
    const executor = source("lib/runtime/harness-loop/tool-action-executor.ts");
    expect(factory).toContain('"tool.call": createToolActionExecutor');
    expect(executor).toContain('from "@/lib/capability/application/execute-harness-tool-call"');
    expect(executor).not.toMatch(/fetch\(|providerEndpoint|endpointRef/);
    const hostedApplication = source("lib/capability/application/execute-harness-tool-call.ts");
    const externalGateway = source("app/gateway/v1/tool-calls/route.ts");
    expect(hostedApplication).toContain("applyToolCall");
    expect(externalGateway).toContain("applyToolCall");
    expect(externalGateway).not.toContain("createToolCall");
  });

  it("Tool worker 真实拥有 Provider、Effect 与 durable continuation", () => {
    const worker = source("lib/capability/tool-execution-worker.ts");
    const provider = source("lib/capability/provider-executor.ts");
    const bootstrap = source("scripts/workers/tool-execution-worker.ts");
    const roleFactory = source("lib/workers/production-worker-role.ts");
    expect(worker).toContain("claimNextQueuedToolCall");
    expect(worker).toContain("reconcileEffect");
    expect(worker).toContain('eventType: "tool_call.continuation.requested"');
    expect(provider).toContain('method: "POST"');
    expect(bootstrap).toContain('runProductionWorkerProcess("tool-execution-worker")');
    expect(roleFactory).toContain("createToolExecutionWorker");
  });

  it("Hosted and External paths use the same catalog-aware production factory", () => {
    const hosted = source("lib/runtime/application/production-resume-harness-invocation.ts");
    const external = source("app/gateway/v1/capability-actions/route.ts");
    expect(hosted).toContain("createPlatformHarnessActionExecutors");
    expect(external).toContain("createPlatformHarnessActionExecutors");
    expect(hosted).toContain("capabilityCatalog");
    expect(external).toContain("capabilityCatalog");
  });

  it("Harness validates every action against the frozen catalog before executor dispatch", () => {
    const loop = source("lib/runtime/harness-loop/loop.ts");
    expect(loop).toContain("validateHarnessActionAgainstCatalog");
    expect(loop.indexOf("validateHarnessActionAgainstCatalog")).toBeLessThan(
      loop.indexOf("this.executeAction(historyEntry"),
    );
  });

  it("identity wiring freezes once and recovers from ExecutionBinding without gateway fallback", () => {
    const dispatcher = source("lib/runtime/dispatcher.ts");
    const retry = source("lib/runtime/retry/dispatch-queued-invocation-attempt.ts");
    const hostedResume = source("lib/runtime/application/resume-harness-invocation.ts");
    const external = source("app/gateway/v1/capability-actions/route.ts");
    const startBuilder = source("lib/runtime/application/build-runtime-start-request.ts");
    const agentResume = source("app/gateway/v1/agent-calls/[call_id]/resume/route.ts");

    expect(dispatcher).toContain("freezeTrustedExecutionSubject");
    expect(retry).toContain("recoverTrustedExecutionSubject(binding");
    expect(hostedResume).toContain("recoverTrustedExecutionSubject(binding");
    expect(external).toContain("recoverTrustedExecutionSubject(binding");
    expect(agentResume).toContain("recoverTrustedExecutionSubject(binding");
    expect(startBuilder).not.toContain("executionSubject");
    expect(`${external}\n${agentResume}`).not.toContain(
      'executionSubjectFromServiceIdentity(principal.tenantId, "gateway")',
    );
  });

  it("AgentCall ingress、取消与用户恢复共用唯一状态转换入口", () => {
    const ingress = source("lib/agents/calls/application/ingest-agent-call-events.ts");
    const transition = source("lib/agents/calls/persistence/apply-agent-call-transition.ts");
    const cancel = source("lib/agents/calls/application/cancel-agent-call.ts");
    const resume = source("lib/agents/calls/application/resume-agent-call.ts");
    expect(ingress).toContain("applyAgentCallEvent");
    expect(cancel).toContain("transitionAgentCall");
    expect(resume).toContain("transitionAgentCall");
    expect(transition).toContain("controlPlaneOutboxEvent");
    expect(transition).toContain("beforeVersionNo");
    expect(transition).toContain("afterVersionNo");
  });

  it("Continuation worker 进入正式启动入口并调用唯一 Harness resume 能力", () => {
    const bootstrap = source("scripts/workers/control-plane-outbox-worker.ts");
    const roleFactory = source("lib/workers/production-worker-role.ts");
    const worker = source("lib/runtime/continuation/production-invocation-continuation-worker.ts");
    const resume = source("lib/runtime/application/production-resume-harness-invocation.ts");
    const resumeCore = source("lib/runtime/application/resume-harness-invocation.ts");
    const adapter = source("lib/runtime/adapters/hosted-adapter.ts");
    expect(bootstrap).toContain('runProductionWorkerProcess("control-plane-outbox-worker")');
    expect(roleFactory).toContain("createProductionInvocationContinuationWorker");
    expect(roleFactory).toContain("continuationWorker.pollOnce()");
    expect(worker).toContain("resumeHarnessInvocation");
    expect(resume).toContain("createResumeHarnessInvocation");
    expect(resumeCore).toContain("recoverTrustedExecutionSubject");
    expect(resume).toContain("createHttpRuntimeClient().resumeInvocation");
    expect(adapter).toContain("new HostedHarnessLoop");
    expect(adapter).not.toContain("Resume 不需要额外事件");
  });

  it("External Runtime 默认生产入口创建绑定 HTTP transport 且不回退 Hosted", () => {
    const dispatcher = source("lib/runtime/employee-turn-dispatcher.ts");
    const transport = source("lib/runtime/transport/http-harness-runtime-transport.ts");
    expect(dispatcher).toContain("createHttpHarnessRuntimeTransport({ endpoint, auth })");
    for (const method of [
      "probeCapabilities",
      "startInvocation",
      "cancelInvocation",
      "resumeInvocation",
      "steerInvocation",
    ]) {
      expect(transport).toContain(`client.${method}`);
    }
    expect(dispatcher).not.toContain("external_endpoint_fallback_hosted");
  });

  it("Runtime retry 默认 lane 调用持久化 Attempt 服务而不是伪造失败", () => {
    const worker = source("lib/runtime/retry/runtime-dispatch-retry-worker.ts");
    const service = source("lib/runtime/retry/dispatch-persisted-queued-invocation-attempt.ts");
    expect(worker).toContain(
      "deps.dispatchPersistedAttempt ?? dispatchPersistedQueuedInvocationAttempt",
    );
    expect(worker).toContain("await persistedAttemptDispatcher(attempt.id)");
    expect(worker).not.toContain("runtime_unavailable");
    expect(service).toContain("createHttpHarnessRuntimeTransport");
    expect(service).toContain("dispatchQueuedInvocationAttempt");
  });

  it("四类 durable Worker 都由统一生产 role factory 与镜像入口启动", () => {
    const roles = source("lib/workers/production-worker-role.ts");
    const entrypoint = source("scripts/workers/worker-entrypoint.ts");
    const compose = source("deploy/production/compose.yaml");
    for (const role of [
      "hosted-provisioning-worker",
      "control-plane-outbox-worker",
      "runtime-dispatch-retry-worker",
      "tool-execution-worker",
    ]) {
      expect(roles).toContain(`"${role}"`);
      expect(compose).toContain(`WORKER_ROLE: ${role}`);
    }
    expect(entrypoint).toContain("runProductionWorkerProcess");
  });
});
