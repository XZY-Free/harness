import {
  type LiveHttpClient,
  LiveJoinStepError,
  runLiveExternalAgentJoin,
} from "@/scripts/integration/live-external-agent";
/**
 * Generic Live External Agent Runner 编排测试（06 §13）。
 *
 * 只测 Runner 编排（不启动全仓）：假的 SnowHarness HTTP Server（内存实现，
 * 按 path/method 路由）证明：
 * - 请求顺序正确（R1 合同 → R2 AgentRevision → R3 Runtime Registration →
 *   R4 GET 投影 + Publish → R5 RouteSet/激活 → R6 Catalog）；
 * - Runner 只经 HTTP client，不 import db/stores/persistence；
 * - 幂等键稳定派生 `<run-id>:<step>`；
 * - bearer 模式不接 raw token（配置层 fail closed）；
 * - Publish 使用真实 Registration→GET 返回的 ConformanceRun（不伪造）；
 * - 任一步失败 fail closed（抛 LiveJoinStepError，不继续后续步骤）；
 * - 输出 sanitized evidence（无 token/私钥/DSSE envelope/合同原文）。
 */
import type { LiveExternalAgentConfig } from "@/scripts/integration/live-external-agent-config";
import { resolveLiveExternalAgentConfig } from "@/scripts/integration/live-external-agent-config";
import { describe, expect, it } from "vitest";

const CONTRACT = {
  contract_version: "1.0.0",
  agent: { id: "generic-agent", name: { "zh-CN": "通用黑盒智能体" }, version: "1.0.0" },
  interaction: {
    streaming_transport: true,
    incremental_content: false,
    input_required: true,
    resume: true,
    cancel: false,
  },
  capabilities: [],
  invocation_context: [],
};

function makeConfig(overrides: Partial<LiveExternalAgentConfig> = {}): LiveExternalAgentConfig {
  return {
    baseUrl: "http://snow.test",
    contractFile: "/tmp/agent-contract.json",
    runtimeEndpoint: "http://provider.test",
    runtimeAuthMode: "none",
    runtimeCredentialRefId: null,
    basicInput: "常规问题",
    inputRequiredInput: "我想请假",
    resumeStartInput: "我想请年假",
    resumeInput: "明天一天",
    expectCancelSupported: false,
    exercise: false,
    protocolContractRevision: "0.3.0",
    adminBearerToken: null,
    httpTimeoutMs: 5_000,
    catalogWaitMs: 5_000,
    invocationWaitMs: 5_000,
    ...overrides,
  };
}

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
}

/** 假 SnowHarness HTTP Server：按正式 API 合同路由并记录全部请求。 */
class FakeSnowHarnessServer implements LiveHttpClient {
  readonly requests: RecordedRequest[] = [];
  /** 按步骤注入失败（step 前缀匹配 path）。 */
  failAt: string | null = null;
  /** R4 GET 投影返回的 latest_valid run（与 registration 一致才能发布）。 */
  latestValidConformanceRunId = "run-1";
  private catalogReady = false;

  request(params: {
    method: "GET" | "POST" | "PUT";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    ifMatch?: string;
  }): Promise<{ status: number; body: unknown }> {
    this.requests.push({
      method: params.method,
      path: params.path,
      body: params.body,
      idempotencyKey: params.idempotencyKey,
      ifMatch: params.ifMatch,
    });
    if (this.failAt && params.path.includes(this.failAt)) {
      return Promise.resolve({
        status: 422,
        body: { error: { code: "BUSINESS_CONSTRAINT_VIOLATION", message: "injected failure" } },
      });
    }
    const { method, path } = params;
    if (method === "POST" && path === "/admin/api/v1/agent-registrations") {
      return ok({
        agent: { id: "agent-1", agent_key: "generic-agent" },
        contract: { snapshot_id: "snap-1", contract_digest: "sha256:aa" },
      });
    }
    if (method === "POST" && path === "/admin/api/v1/agents/agent-1/revisions") {
      return ok({
        id: "agent-rev-1",
        revision_no: 1,
        revision_state: "draft",
        etag: "agent-revision-1",
      });
    }
    if (method === "POST" && path === "/admin/api/v1/agent-revisions/agent-rev-1/publish") {
      return ok({ id: "agent-rev-1", revision_state: "published", audit_event_id: "audit-1" });
    }
    if (method === "POST" && path === "/admin/api/v1/agents/agent-1/runtime-registrations") {
      return ok({
        runtime_id: "rt-1",
        runtime_revision_id: "rtr-1",
        conformance_run_id: "run-1",
        conformance_overall_result: "passed",
        conformance_case_count: 6,
      });
    }
    if (method === "GET" && path === "/admin/api/v1/runtime-revisions/rtr-1") {
      return ok({
        id: "rtr-1",
        revision_no: 1,
        latest_valid_conformance_run_id: this.latestValidConformanceRunId,
        latest_valid_conformance_overall_result:
          this.latestValidConformanceRunId === "run-1" ? "passed" : null,
        runtime_capabilities: { effective: { cancel: false } },
      });
    }
    if (method === "GET" && path === "/admin/api/v1/runtimes/rt-1") {
      return ok({ id: "rt-1", version_no: 1 });
    }
    if (method === "POST" && path === "/admin/api/v1/runtime-revisions/rtr-1/publish") {
      return ok({
        id: "rtr-1",
        revision_state: "published",
        publication_record_id: "pub-1",
        conformance_run_id: "run-1",
      });
    }
    if (method === "POST" && path === "/admin/api/v1/deployment-route-sets") {
      return ok({ id: "rs-1", version_no: 1 });
    }
    if (method === "PUT" && path === "/admin/api/v1/deployment-route-sets/rs-1/activation") {
      return ok({
        activations: [
          { route_id: "route-1", route_revision_id: "rr-1", route_activation_id: "ra-1" },
        ],
      });
    }
    if (method === "GET" && path.startsWith("/api/v1/catalog/options")) {
      if (!this.catalogReady) {
        this.catalogReady = true;
        return ok({ items: [] });
      }
      return ok({
        items: [{ agent_id: "agent-1", id: "agent-1", lifecycle_state: "active" }],
      });
    }
    return Promise.resolve({ status: 404, body: { error: { code: "RESOURCE_NOT_FOUND" } } });
  }
}

function ok(body: unknown): Promise<{ status: number; body: unknown }> {
  return Promise.resolve({ status: 200, body });
}

const sleep = async () => {};

describe("runLiveExternalAgentJoin（编排）", () => {
  it("完整成功序列：请求顺序正确 + 幂等键稳定 + 输出 sanitized evidence", async () => {
    const server = new FakeSnowHarnessServer();
    const evidence = await runLiveExternalAgentJoin({
      config: makeConfig(),
      contract: CONTRACT,
      client: server,
      runId: "run-x",
      sleep,
    });

    expect(evidence).toMatchObject({
      run_id: "run-x",
      agent_id: "agent-1",
      contract_snapshot_id: "snap-1",
      agent_revision_id: "agent-rev-1",
      runtime_id: "rt-1",
      runtime_revision_id: "rtr-1",
      conformance_run_id: "run-1",
      runtime_publication_record_id: "pub-1",
      route_set_id: "rs-1",
      route_revision_id: "rr-1",
    });

    // 请求顺序：合同 → agent revision → publish → runtime registration →
    // GET revision（轮询+最终）→ GET runtime → publish → route set → 激活 → catalog。
    const paths = server.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths.indexOf("POST /admin/api/v1/agent-registrations")).toBeLessThan(
      paths.indexOf("POST /admin/api/v1/agents/agent-1/revisions"),
    );
    expect(paths.indexOf("POST /admin/api/v1/agents/agent-1/runtime-registrations")).toBeLessThan(
      paths.indexOf("GET /admin/api/v1/runtime-revisions/rtr-1"),
    );
    expect(paths.indexOf("GET /admin/api/v1/runtime-revisions/rtr-1")).toBeLessThan(
      paths.indexOf("POST /admin/api/v1/runtime-revisions/rtr-1/publish"),
    );
    expect(paths.indexOf("PUT /admin/api/v1/deployment-route-sets/rs-1/activation")).toBeLessThan(
      paths.indexOf("GET /api/v1/catalog/options?resource_type=agent"),
    );

    // 幂等键稳定派生（重跑同 runId 可复用）。
    const idempotencyKeys = server.requests
      .map((r) => r.idempotencyKey)
      .filter((k): k is string => Boolean(k));
    expect(idempotencyKeys).toEqual([
      "run-x:contract",
      "run-x:agent-revision-create",
      "run-x:agent-publish",
      "run-x:runtime-registration",
      "run-x:runtime-publish",
      "run-x:route-set",
      "run-x:route-activation",
    ]);

    // Publish 使用真实 GET 返回的 ConformanceRun + external attestation=null。
    const publish = server.requests.find(
      (r) => r.path === "/admin/api/v1/runtime-revisions/rtr-1/publish",
    );
    expect(publish?.body).toEqual({
      expected_version_no: 1,
      attestation_id: null,
      conformance_run_id: "run-1",
    });
    expect(publish?.ifMatch).toBe("runtime-revision-1");

    // cancel=false：registration conformance 不携带 cancel probe。
    const registration = server.requests.find(
      (r) => r.path === "/admin/api/v1/agents/agent-1/runtime-registrations",
    );
    expect(registration?.body).toMatchObject({
      runtime_endpoint: "http://provider.test",
      authentication: { mode: "none", credential_ref_id: null },
      conformance: {
        basic: { input: "常规问题" },
        input_required: { input: "我想请假" },
        resume: { start_input: "我想请年假", resume_input: "明天一天" },
      },
    });
    expect((registration?.body as Record<string, unknown>).conformance).not.toHaveProperty(
      "cancel",
    );

    // sanitized：无 token/合同原文/DSSE envelope。
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("contract_version");
    expect(serialized).not.toContain("payloadType");
    expect(serialized).not.toContain("Bearer");
  });

  it("R4 投影无 latest_valid run → fail closed（不发布、不建路由）", async () => {
    const server = new FakeSnowHarnessServer();
    server.latestValidConformanceRunId = "run-other";
    await expect(
      runLiveExternalAgentJoin({
        config: makeConfig({ catalogWaitMs: 200 }),
        contract: CONTRACT,
        client: server,
        runId: "run-y",
        sleep,
      }),
    ).rejects.toBeInstanceOf(LiveJoinStepError);
    expect(
      server.requests.some((r) => r.path === "/admin/api/v1/runtime-revisions/rtr-1/publish"),
    ).toBe(false);
    expect(server.requests.some((r) => r.path === "/admin/api/v1/deployment-route-sets")).toBe(
      false,
    );
  });

  it("任一步失败（R3 注册 422）→ fail closed，不进入 R4", async () => {
    const server = new FakeSnowHarnessServer();
    server.failAt = "runtime-registrations";
    await expect(
      runLiveExternalAgentJoin({
        config: makeConfig(),
        contract: CONTRACT,
        client: server,
        runId: "run-z",
        sleep,
      }),
    ).rejects.toBeInstanceOf(LiveJoinStepError);
    expect(server.requests.some((r) => r.path === "/admin/api/v1/runtime-revisions/rtr-1")).toBe(
      false,
    );
  });

  it("conformance_overall_result != passed → fail closed", async () => {
    const server = new FakeSnowHarnessServer();
    // 覆写 registration 响应为 failed 结果。
    const original = server.request.bind(server);
    server.request = (params) => {
      if (params.path.endsWith("runtime-registrations")) {
        server.requests.push(params as RecordedRequest);
        return Promise.resolve({
          status: 201,
          body: {
            runtime_id: "rt-1",
            runtime_revision_id: "rtr-1",
            conformance_run_id: "run-1",
            conformance_overall_result: "failed",
          },
        });
      }
      return original(params);
    };
    await expect(
      runLiveExternalAgentJoin({
        config: makeConfig(),
        contract: CONTRACT,
        client: server,
        runId: "run-f",
        sleep,
      }),
    ).rejects.toMatchObject({ step: "R3-runtime-registration" });
  });
});

describe("resolveLiveExternalAgentConfig（黑盒输入约束）", () => {
  const BASE_ENV = {
    SNOW_LIVE_BASE_URL: "http://snow.test",
    SNOW_LIVE_AGENT_CONTRACT_FILE: "/tmp/contract.json",
    SNOW_LIVE_RUNTIME_ENDPOINT: "http://provider.test",
    SNOW_LIVE_BASIC_INPUT: "常规问题",
  };

  it("bearer 模式只接受 CredentialRef ID，不接受 raw token", () => {
    expect(() =>
      resolveLiveExternalAgentConfig({ ...BASE_ENV, SNOW_LIVE_RUNTIME_AUTH_MODE: "bearer" }),
    ).toThrow(/CredentialRef/);
    expect(
      resolveLiveExternalAgentConfig({
        ...BASE_ENV,
        SNOW_LIVE_RUNTIME_AUTH_MODE: "bearer",
        SNOW_LIVE_RUNTIME_CREDENTIAL_REF_ID: "cred-1",
      }).runtimeCredentialRefId,
    ).toBe("cred-1");
  });

  it("禁止输入（provider 源码/框架/employee id/raw token）fail closed", () => {
    for (const key of [
      "SNOW_LIVE_PROVIDER_SOURCE_DIR",
      "SNOW_LIVE_PROVIDER_REPO",
      "SNOW_LIVE_PROVIDER_GIT_SHA",
      "SNOW_LIVE_FRAMEWORK",
      "SNOW_LIVE_VEDAK",
      "SNOW_LIVE_AGENTKIT",
      "SNOW_LIVE_EMPLOYEE_ID",
      "SNOW_LIVE_RAW_BEARER_TOKEN",
    ]) {
      expect(() => resolveLiveExternalAgentConfig({ ...BASE_ENV, [key]: "x" }), key).toThrow(
        /禁止/,
      );
    }
  });

  it("缺必填项 fail closed", () => {
    expect(() => resolveLiveExternalAgentConfig({})).toThrow(/SNOW_LIVE_BASE_URL/);
  });
});
