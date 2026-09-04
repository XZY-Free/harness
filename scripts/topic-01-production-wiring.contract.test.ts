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
  });

  it("Hosted and External paths use the same catalog-aware production factory", () => {
    const hosted = source("lib/runtime/employee-turn-dispatcher.ts");
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
    const hosted = source("lib/runtime/employee-turn-dispatcher.ts");
    const external = source("app/gateway/v1/capability-actions/route.ts");
    const startBuilder = source("lib/runtime/application/build-runtime-start-request.ts");
    const agentResume = source("app/gateway/v1/agent-calls/[call_id]/resume/route.ts");

    expect(dispatcher).toContain("freezeTrustedExecutionSubject");
    expect(retry).toContain("recoverTrustedExecutionSubject(binding");
    expect(hosted).toContain("recoverTrustedExecutionSubject(binding");
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
});
