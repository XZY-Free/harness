/**
 * RouteActivationPanel「发布给员工」连续激活流程测试（07 §12 + 员工发布闭环）。
 *
 * 专题01 冻结架构：所有 Agent 是 black-box A2A 0.3.0，AgentRevision 只冻结合同，
 * 绝不承载端点权威。Agent 端点权威只存在于 Agent Route target：
 * - 用户选择 published AgentRevision + 填端点 URL + 网络区域 + 身份模式；
 * - bearer 必须从真实 credential GET 选择已有 CredentialRef 摘要；none 携带
 *   credential_ref_id:null；无 raw secret 输入；
 * - 一次点击 = 先 ensure Agent RouteSet（target:{kind:'agent',agent_id}），
 *   再激活（nested target，无 runtime_revision_id 字段）；
 * - 本面板绝不 GET runtime，也绝不接收/选择 RuntimeRevision。
 *
 * fetch mock 只作为边界服务器；不 mock 组件内部的 control-plane client。
 */
import { RouteActivationPanel } from "@/components/studio/route-activation-panel";
import {
  agentFixture,
  agentRevisionFixture,
  credentialFixture,
  errorEnvelopeResponse,
} from "@/components/studio/test-support/route-activation-fixtures";
import type { AgentDTO, AgentRevisionSummaryDTO } from "@/lib/control-plane-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

interface RecordedCall {
  method: string;
  url: string;
  init?: RequestInit;
}

let calls: RecordedCall[];

const ACTIVATION_RESPONSE = {
  route_set_id: "route-set-1",
  route_set_version_no: 8,
  activations: [
    {
      route_id: "route-1",
      route_revision_id: "rrev-1",
      route_activation_id: "ract-1",
      activation_state: "active",
      route_group_id: "primary",
      previous_route_revision_id: null,
      previous_route_activation_id: null,
    },
  ],
  affected_new_invocations_only: true,
};

function routeSetEnsureResponse() {
  return {
    id: "route-set-1",
    target: { kind: "agent", agent_id: "agent-1" },
    route_scope_key: "default",
    route_scope: {},
    version_no: 7,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    created: true,
  };
}

interface BackendFixture {
  agents: AgentDTO[];
  agentRevisions: Record<string, AgentRevisionSummaryDTO[]>;
  credentials?: Array<ReturnType<typeof credentialFixture>>;
  ensureFail?: boolean;
  activateFail?: boolean;
}

/** 默认场景：唯一 published AgentRevision（arev-1）+ 一个可用 CredentialRef。 */
function defaultFixture(): BackendFixture {
  return {
    agents: [agentFixture()],
    agentRevisions: {
      "agent-1": [
        agentRevisionFixture(),
        agentRevisionFixture({
          id: "arev-draft",
          revision_no: 4,
          revision_state: "draft",
        }),
      ],
    },
    credentials: [credentialFixture()],
  };
}

function stubBackend(fixture: BackendFixture) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, init });
    if (url === "/admin/api/v1/agents") {
      return Response.json({ items: fixture.agents, total: fixture.agents.length });
    }
    for (const [agentId, revisions] of Object.entries(fixture.agentRevisions)) {
      if (url === `/admin/api/v1/agents/${agentId}/revisions`) {
        return Response.json({ items: revisions, total: revisions.length });
      }
    }
    if (url === "/admin/api/v1/credential-refs") {
      return Response.json({
        items: fixture.credentials ?? [],
        total: fixture.credentials?.length ?? 0,
      });
    }
    if (method === "POST" && url === "/admin/api/v1/deployment-route-sets") {
      if (fixture.ensureFail) {
        return errorEnvelopeResponse(
          "OPERATION_PAYLOAD_CONFLICT",
          "route_scope 与既有 RouteSet 不一致",
          409,
        );
      }
      return Response.json(routeSetEnsureResponse(), { status: 201 });
    }
    if (method === "PUT" && url === "/admin/api/v1/deployment-route-sets/route-set-1/activation") {
      if (fixture.activateFail) {
        return errorEnvelopeResponse("BUSINESS_CONSTRAINT_VIOLATION", "端点事实不合法", 400);
      }
      return Response.json(ACTIVATION_RESPONSE);
    }
    return Response.json({ items: [], total: 0 });
  });
}

async function loadPanel(fixture: BackendFixture, expectedAgentName: string) {
  stubBackend(fixture);
  render(<RouteActivationPanel canManage />);
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getByText(new RegExp(expectedAgentName))).toBeTruthy());
}

function enabledOptionValues(): string[] {
  return Array.from(document.querySelectorAll("option"))
    .filter((option) => !(option as HTMLOptionElement).disabled)
    .map((option) => (option as HTMLOptionElement).value);
}

function selectValue(labelText: string): string {
  return (screen.getByLabelText(labelText) as HTMLSelectElement).value;
}

function inputValue(labelText: string): string {
  return (screen.getByLabelText(labelText) as HTMLInputElement).value;
}

function runtimeGets(): number {
  return calls.filter(
    (call) => call.method === "GET" && call.url.startsWith("/admin/api/v1/runtimes"),
  ).length;
}

/** 切换到指定身份模式；bearer 时按标签选择已有 CredentialRef。 */
function chooseIdentity(mode: "none" | "bearer") {
  fireEvent.change(screen.getByLabelText("身份模式"), { target: { value: mode } });
}

function fillEndpointAndZone(endpoint: string, zone: string) {
  fireEvent.change(screen.getByLabelText("端点 URL"), { target: { value: endpoint } });
  fireEvent.change(screen.getByLabelText("网络区域"), { target: { value: zone } });
}

describe("RouteActivationPanel「发布给员工」— identity none（happy path）", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    calls = [];
  });

  afterEach(cleanup);

  it("展示 Agent 业务名称与版本号，提供端点 URL/网络区域/身份模式/凭证输入，无 runtime GET", async () => {
    await loadPanel(defaultFixture(), "HR 智能体");

    const agentOption = screen.getByRole("option", { name: /HR 智能体/ }) as HTMLOptionElement;
    expect(agentOption.textContent).toMatch(/HR 智能体/);
    expect(agentOption.textContent).toMatch(/3/);
    expect(agentOption.textContent).not.toContain("agent-1");
    expect(agentOption.textContent).not.toContain("arev-1");

    // 新冻结架构输入字段必须存在。
    expect(screen.getByLabelText("端点 URL")).toBeTruthy();
    expect(screen.getByLabelText("网络区域")).toBeTruthy();
    expect(screen.getByLabelText("身份模式")).toBeTruthy();

    // 不存在旧运行服务选择器，也绝不 GET runtime。
    expect(screen.queryByLabelText("运行服务版本")).toBeNull();
    expect(runtimeGets()).toBe(0);
  });

  it("identity none：填端点/网络后一次点击先 ensure nested Agent RouteSet 再激活 nested target，credential_ref_id:null", async () => {
    await loadPanel(defaultFixture(), "HR 智能体");

    // 未填端点/网络前按钮禁用、无写。
    const submitBefore = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    expect(submitBefore.disabled).toBe(true);
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("智能体版本"), { target: { value: "arev-1" } });
    fillEndpointAndZone("  https://hr.example.com/a2a  ", "  public  ");
    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(screen.getByText(/员工新会话现在可以选择该智能体/)).toBeTruthy());

    const writeCalls = calls.filter((call) => call.method !== "GET");
    expect(writeCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST /admin/api/v1/deployment-route-sets",
      "PUT /admin/api/v1/deployment-route-sets/route-set-1/activation",
    ]);

    // ensure：严格 nested body + Idempotency-Key。
    const ensureInit = writeCalls[0]?.init;
    expect(JSON.parse(String(ensureInit?.body))).toEqual({
      target: { kind: "agent", agent_id: "agent-1" },
      route_scope_key: "default",
      route_scope: {},
    });
    expect(new Headers(ensureInit?.headers).get("idempotency-key")).toBeTruthy();

    // 激活：If-Match 使用 ensure 返回 version，nested Agent target 精确事实，
    // 端点/网络已 trim，identity none 携带 credential_ref_id:null，绝无 runtime_revision_id。
    const activateInit = writeCalls[1]?.init;
    expect(new Headers(activateInit?.headers).get("if-match")).toBe("route-set-7");
    const activateBody = JSON.parse(String(activateInit?.body));
    expect(activateBody.expected_version_no).toBe(7);
    expect(activateBody.routes).toEqual([
      {
        route_group_id: "primary",
        target: {
          kind: "agent",
          agent_revision_id: "arev-1",
          endpoint_ref: "https://hr.example.com/a2a",
          identity_mode: "none",
          credential_ref_id: null,
          network_zone: "public",
        },
        traffic_weight: 10000,
        priority_no: 0,
      },
    ]);
    expect(JSON.stringify(activateBody)).not.toContain("runtime_revision_id");
  });
});

describe("RouteActivationPanel「发布给员工」— bearer identity & 输入门控", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    calls = [];
  });

  afterEach(cleanup);

  it("bearer：必须从真实 credential GET 选择已有 CredentialRef，激活 nested target 携带所选 id，无 secret 字段", async () => {
    await loadPanel(defaultFixture(), "HR 智能体");

    chooseIdentity("bearer");
    fillEndpointAndZone("https://hr.example.com/a2a", "public");

    // bearer 下未选凭证：按钮禁用、无写。
    const submitBefore = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    expect(submitBefore.disabled).toBe(true);
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);

    // 凭证明细来自真实 GET 的摘要（非机密：provider/fingerprint），不存在 secret 输入。
    const credentialOption = screen.getByRole("option", {
      name: /a2a-bearer/,
    }) as HTMLOptionElement;
    expect(credentialOption.textContent).toMatch(/a2a-bearer/);
    expect(credentialOption.textContent).toMatch(/abcd1234/);
    expect(screen.queryByLabelText(/secret/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/secret/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("访问凭证"), { target: { value: "cred-1" } });

    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(screen.getByText(/员工新会话现在可以选择该智能体/)).toBeTruthy());
    const writeCalls = calls.filter((call) => call.method !== "GET");
    const activateBody = JSON.parse(String(writeCalls[1]?.init?.body));
    expect(activateBody.routes[0].target).toEqual({
      kind: "agent",
      agent_revision_id: "arev-1",
      endpoint_ref: "https://hr.example.com/a2a",
      identity_mode: "bearer",
      credential_ref_id: "cred-1",
      network_zone: "public",
    });
    expect(JSON.stringify(activateBody)).not.toContain("runtime_revision_id");
    // 任何地方不得发送 raw secret 值。
    expect(JSON.stringify(writeCalls.map((c) => c.init?.body))).not.toContain("secret-value");
  });

  it("端点/网络为空或空白，或 bearer 未选凭证：按钮禁用且无任何写", async () => {
    await loadPanel(defaultFixture(), "HR 智能体");

    // 空端点 + 空网络。
    expect((screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);

    // 只填端点、留空网络 → 仍禁用。
    fillEndpointAndZone("https://hr.example.com/a2a", "");
    expect((screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);

    // 网络填空白字符串（仅空格）→ 视为未填，禁用。
    fireEvent.change(screen.getByLabelText("网络区域"), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    // bearer 未选凭证：即使端点/网络齐全仍禁用。
    chooseIdentity("bearer");
    fireEvent.change(screen.getByLabelText("网络区域"), { target: { value: "public" } });
    expect((screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });

  it("identity 从 bearer 切到 none：清空凭证选择并发送 credential_ref_id:null", async () => {
    await loadPanel(defaultFixture(), "HR 智能体");

    chooseIdentity("bearer");
    fillEndpointAndZone("https://hr.example.com/a2a", "public");
    fireEvent.change(screen.getByLabelText("访问凭证"), { target: { value: "cred-1" } });
    expect(selectValue("访问凭证")).toBe("cred-1");

    // 切回 none：凭证被清空，且发送 none/null。
    chooseIdentity("none");
    await waitFor(() => expect(screen.queryByLabelText("访问凭证")).toBeNull());
    expect(screen.queryByRole("option", { name: /a2a-bearer/ })).toBeNull();

    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/员工新会话现在可以选择该智能体/)).toBeTruthy());

    const activateBody = JSON.parse(String(calls.filter((c) => c.method === "PUT")[0]?.init?.body));
    expect(activateBody.routes[0].target).toEqual({
      kind: "agent",
      agent_revision_id: "arev-1",
      endpoint_ref: "https://hr.example.com/a2a",
      identity_mode: "none",
      credential_ref_id: null,
      network_zone: "public",
    });
  });
});

describe("RouteActivationPanel「发布给员工」— 下游失败与刷新 fail-closed", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    calls = [];
  });

  afterEach(cleanup);

  it("ensure RouteSet 失败时显示中文错误、不出现成功文案，且绝无后续 PUT", async () => {
    await loadPanel({ ...defaultFixture(), ensureFail: true }, "HR 智能体");

    fillEndpointAndZone("https://hr.example.com/a2a", "public");
    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/失败|错误|冲突/));
    expect(screen.queryByText(/员工新会话现在可以选择该智能体/)).toBeNull();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("激活失败时显示中文错误、不出现成功文案", async () => {
    await loadPanel({ ...defaultFixture(), activateFail: true }, "HR 智能体");

    fillEndpointAndZone("https://hr.example.com/a2a", "public");
    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/失败|错误|冲突/));
    expect(screen.queryByText(/员工新会话现在可以选择该智能体/)).toBeNull();
  });

  it("多 published：preferred AgentRevision 只在真实 GET 中才被选中，失效 preferred 被忽略且不造假选项", async () => {
    const fixture = defaultFixture();
    fixture.agentRevisions = {
      "agent-1": [
        agentRevisionFixture(),
        agentRevisionFixture({ id: "arev-other", revision_no: 5 }),
      ],
    };
    stubBackend(fixture);
    const view = render(<RouteActivationPanel canManage refreshToken={0} />);
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === "GET" && call.url === "/admin/api/v1/agents").length,
      ).toBeGreaterThanOrEqual(1),
    );
    await waitFor(() => expect(screen.queryByText(/正在加载/)).toBeNull());

    // 两个 published 无唯一自动选中：初始未选择、按钮禁用。
    expect(selectValue("智能体版本")).toBe("");
    const submitBefore = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    expect(submitBefore.disabled).toBe(true);

    // 失效 preferred 被忽略：不出现假 option。
    view.rerender(
      <RouteActivationPanel canManage refreshToken={1} preferredAgentRevisionId="arev-ghost" />,
    );
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === "GET" && call.url === "/admin/api/v1/agents").length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(selectValue("智能体版本")).toBe("");
    expect(enabledOptionValues()).not.toContain("arev-ghost");
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);

    // 真实存在的 preferred 被选中。
    view.rerender(
      <RouteActivationPanel canManage refreshToken={2} preferredAgentRevisionId="arev-1" />,
    );
    await waitFor(() => expect(selectValue("智能体版本")).toBe("arev-1"));
  });

  it("刷新加载失败时 fail closed：清空选择、按钮禁用、无写、无成功文案", async () => {
    stubBackend(defaultFixture());
    const view = render(
      <RouteActivationPanel canManage refreshToken={0} preferredAgentRevisionId="arev-1" />,
    );
    await waitFor(() => expect(selectValue("智能体版本")).toBe("arev-1"));

    fetchMock.mockReset();
    calls = [];
    fetchMock.mockImplementation(async () =>
      Response.json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "boom",
            request_id: "req-test",
            retryable: false,
          },
        },
        { status: 500 },
      ),
    );
    view.rerender(
      <RouteActivationPanel canManage refreshToken={1} preferredAgentRevisionId="arev-1" />,
    );

    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/失败/));
    await waitFor(() => expect(selectValue("智能体版本")).toBe(""));
    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    expect(screen.queryByText(/员工新会话现在可以选择该智能体/)).toBeNull();
  });

  it("重复刷新只重新 GET，不产生写或成功文案，选择保持为真实有效 preferred", async () => {
    stubBackend(defaultFixture());
    const view = render(
      <RouteActivationPanel canManage refreshToken={0} preferredAgentRevisionId="arev-1" />,
    );
    await waitFor(() => expect(selectValue("智能体版本")).toBe("arev-1"));

    view.rerender(
      <RouteActivationPanel canManage refreshToken={1} preferredAgentRevisionId="arev-1" />,
    );
    view.rerender(
      <RouteActivationPanel canManage refreshToken={2} preferredAgentRevisionId="arev-1" />,
    );
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === "GET" && call.url === "/admin/api/v1/agents").length,
      ).toBeGreaterThanOrEqual(3),
    );

    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    expect(screen.queryByText(/员工新会话现在可以选择该智能体/)).toBeNull();
    expect(selectValue("智能体版本")).toBe("arev-1");
  });
});

describe("RouteActivationPanel「发布给员工」— 全场景零 runtime GET 守卫", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    calls = [];
  });

  afterEach(cleanup);

  it("happy path（none 与 bearer）全程不 GET runtime 资产", async () => {
    await loadPanel(defaultFixture(), "HR 智能体");
    expect(runtimeGets()).toBe(0);

    chooseIdentity("bearer");
    fillEndpointAndZone("https://hr.example.com/a2a", "public");
    fireEvent.change(screen.getByLabelText("访问凭证"), { target: { value: "cred-1" } });
    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/员工新会话现在可以选择该智能体/)).toBeTruthy());
    expect(runtimeGets()).toBe(0);
  });

  it("本面板不提供运行服务版本选择，也没有任何 runtime 相关交互", async () => {
    await loadPanel(defaultFixture(), "HR 智能体");
    expect(screen.queryByLabelText("运行服务版本")).toBeNull();
    expect(screen.queryByText(/运行服务/)).toBeNull();
    expect(runtimeGets()).toBe(0);
  });
});
