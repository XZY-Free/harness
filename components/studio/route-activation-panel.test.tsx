/**
 * RouteActivationPanel「发布给员工」连续激活流程测试（07 §12 + 员工发布闭环）。
 *
 * 业务不变量：
 * - 管理员不手填 RouteSet id / route_group_id / 原始 UUID；
 * - RuntimeRevision 只按 agent_contract_snapshot_id 精确匹配，不按名称推断；
 * - 一次点击 = 先 ensure RouteSet（POST create-or-reuse），再激活（PUT + If-Match）；
 * - 激活唯一 route 固定 primary/10000/0，且不自动发布 AgentRevision/RuntimeRevision。
 *
 * fetch mock 只作为边界服务器；不 mock 组件内部的 control-plane client。
 */
import { RouteActivationPanel } from "@/components/studio/route-activation-panel";
import {
  SNAP_MATCHING,
  SNAP_MISMATCHED,
  agentFixture,
  agentRevisionFixture,
  errorEnvelopeResponse,
  runtimeFixture,
  runtimeRevisionFixture,
} from "@/components/studio/test-support/route-activation-fixtures";
import type {
  AgentDTO,
  AgentRevisionSummaryDTO,
  RuntimeDTO,
  RuntimeRevisionDTO,
} from "@/lib/control-plane-client";
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
    agent_id: "agent-1",
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
  runtimes: RuntimeDTO[];
  runtimeRevisions: Record<string, RuntimeRevisionDTO[]>;
  ensureFail?: boolean;
  activateFail?: boolean;
}

/** 默认场景：唯一精确匹配（arev-1 + rtrv-1），相似名 Runtime snapshot 不匹配。 */
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
    runtimes: [runtimeFixture()],
    runtimeRevisions: {
      "rt-1": [
        runtimeRevisionFixture(),
        runtimeRevisionFixture({
          id: "rtrv-draft",
          revision_no: 3,
          revision_state: "draft",
        }),
      ],
    },
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
    if (url === "/admin/api/v1/runtimes") {
      return Response.json({ items: fixture.runtimes, total: fixture.runtimes.length });
    }
    for (const [agentId, revisions] of Object.entries(fixture.agentRevisions)) {
      if (url === `/admin/api/v1/agents/${agentId}/revisions`) {
        return Response.json({ items: revisions, total: revisions.length });
      }
    }
    for (const [runtimeId, revisions] of Object.entries(fixture.runtimeRevisions)) {
      if (url === `/admin/api/v1/runtimes/${runtimeId}/revisions`) {
        return Response.json({ items: revisions, total: revisions.length });
      }
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
        return errorEnvelopeResponse(
          "BUSINESS_CONSTRAINT_VIOLATION",
          "RuntimeRevision 未绑定该 AgentRevision 的合同快照",
          400,
        );
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
  // 等资产加载完成：期望的 Agent 业务名称可见（各用例 fixture 不同；子串匹配）。
  await waitFor(() => expect(screen.getByText(new RegExp(expectedAgentName))).toBeTruthy());
}

function enabledOptionValues(): string[] {
  return Array.from(document.querySelectorAll("option"))
    .filter((option) => !(option as HTMLOptionElement).disabled)
    .map((option) => (option as HTMLOptionElement).value);
}

describe("RouteActivationPanel「发布给员工」（连续激活流程）", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    calls = [];
  });

  afterEach(cleanup);

  it("展示 Agent/Runtime 业务名称与版本号，不出现手填 RouteSet id / route_group_id 输入，UUID 不作为可见主标签", async () => {
    await loadPanel(defaultFixture(), "HR 智能体");

    // 管理员不应手填 RouteSet id 或 route_group_id。
    expect(screen.queryByLabelText("route_set_id")).toBeNull();
    expect(screen.queryByLabelText("route_group_id")).toBeNull();

    // Agent 选项以业务名称 + 版本号展示，而非 UUID。
    const agentOption = screen.getByRole("option", { name: /HR 智能体/ }) as HTMLOptionElement;
    expect(agentOption.textContent).toMatch(/HR 智能体/);
    expect(agentOption.textContent).toMatch(/3/);
    expect(agentOption.textContent).not.toContain("agent-1");
    expect(agentOption.textContent).not.toContain("arev-1");

    // Runtime 选项同样以业务名称 + 版本号展示。
    const runtimeOption = screen.getByRole("option", {
      name: /HR 真实 Runtime/,
    }) as HTMLOptionElement;
    expect(runtimeOption.textContent).toMatch(/HR 真实 Runtime/);
    expect(runtimeOption.textContent).toMatch(/2/);
    expect(runtimeOption.textContent).not.toContain("rtrv-1");
    expect(runtimeOption.textContent).not.toContain("rt-1");
  });

  it("选定智能体版本后所有 published Runtime 均可选（不再按 snapshot 过滤）；draft Revision 不可选", async () => {
    // 多个 published Runtime：专题01 冻结架构下不再按 contract snapshot 过滤，
    // 选定智能体版本后全部运行服务都作为可选运行服务出现。
    await loadPanel(
      {
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
        runtimes: [
          runtimeFixture(),
          runtimeFixture({
            id: "rt-2",
            runtime_key: "hr-similar-runtime",
            display_name: "HR 相似 Runtime",
            current_revision_id: "rtrv-2",
          }),
        ],
        runtimeRevisions: {
          "rt-1": [
            runtimeRevisionFixture(),
            runtimeRevisionFixture({
              id: "rtrv-draft",
              revision_no: 3,
              revision_state: "draft",
            }),
          ],
          "rt-2": [
            runtimeRevisionFixture({
              id: "rtrv-2",
              runtime_id: "rt-2",
              revision_no: 5,
            }),
          ],
        },
      },
      "HR 智能体",
    );

    // 两个 published Runtime（含名称相似者）都是可选运行服务，不再被排除。
    const enabledValues = enabledOptionValues();
    expect(enabledValues).toContain("rtrv-1");
    expect(enabledValues).toContain("rtrv-2");
    // draft AgentRevision / draft RuntimeRevision 不可作为可选值。
    expect(enabledValues).not.toContain("arev-draft");
    expect(enabledValues).not.toContain("rtrv-draft");
  });

  it("一次点击先 ensure 默认 scope RouteSet，再用返回 version 激活唯一 route（primary/10000/0），且不自动发布 Revision", async () => {
    await loadPanel(defaultFixture(), "HR 智能体");

    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(screen.getByText(/员工新会话现在可以选择该智能体/)).toBeTruthy());

    // 写操作顺序：先 ensure，后激活；全程只有这两次写（不自动 publish Revision）。
    const writeCalls = calls.filter((call) => call.method !== "GET");
    expect(writeCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST /admin/api/v1/deployment-route-sets",
      "PUT /admin/api/v1/deployment-route-sets/route-set-1/activation",
    ]);

    // ensure：严格 body + Idempotency-Key。
    const ensureInit = writeCalls[0]?.init;
    expect(JSON.parse(String(ensureInit?.body))).toEqual({
      agent_id: "agent-1",
      route_scope_key: "default",
      route_scope: {},
    });
    const ensureKey = new Headers(ensureInit?.headers).get("idempotency-key");
    expect(ensureKey).toBeTruthy();

    // 激活：If-Match 使用 ensure 返回的 version 7，新 Idempotency-Key。
    const activateInit = writeCalls[1]?.init;
    expect(new Headers(activateInit?.headers).get("if-match")).toBe("route-set-7");
    const activateKey = new Headers(activateInit?.headers).get("idempotency-key");
    expect(activateKey).toBeTruthy();
    expect(activateKey).not.toBe(ensureKey);

    const activateBody = JSON.parse(String(activateInit?.body));
    expect(activateBody.expected_version_no).toBe(7);
    expect(activateBody.routes).toEqual([
      expect.objectContaining({
        route_group_id: "primary",
        agent_revision_id: "arev-1",
        runtime_revision_id: "rtrv-1",
        traffic_weight: 10000,
        priority_no: 0,
      }),
    ]);
  });

  it("没有可用的 published Runtime 时按钮禁用并显示中文原因，不出现成功文案", async () => {
    await loadPanel(
      {
        agents: [
          agentFixture({
            id: "agent-9",
            display_name: "财务智能体",
            current_revision_id: "arev-9",
          }),
        ],
        agentRevisions: {
          "agent-9": [
            agentRevisionFixture({
              id: "arev-9",
              agent_id: "agent-9",
              revision_no: 1,
            }),
          ],
        },
        // 唯一 published AgentRevision 自动选中，但没有任何 published Runtime 可用。
        runtimes: [runtimeFixture()],
        runtimeRevisions: {
          "rt-1": [runtimeRevisionFixture({ revision_state: "draft" })],
        },
      },
      "财务智能体",
    );

    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // 清楚的纯中文原因（明确提到没有可用运行服务，不暴露 Runtime 术语）。
    expect(document.body.textContent ?? "").toMatch(/没有可用的运行服务/);
    expect(document.body.textContent ?? "").toMatch(/请先发布运行服务/);
    expect(screen.queryByText(/员工新会话现在可以选择该智能体/)).toBeNull();

    // 未发生任何写请求。
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });

  it("ensure RouteSet 失败时显示中文错误，不出现成功文案", async () => {
    await loadPanel({ ...defaultFixture(), ensureFail: true }, "HR 智能体");

    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/失败|错误|冲突/));
    expect(screen.queryByText(/员工新会话现在可以选择该智能体/)).toBeNull();
    // ensure 失败后不得继续激活。
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("激活失败时显示中文错误，不出现成功文案", async () => {
    await loadPanel({ ...defaultFixture(), activateFail: true }, "HR 智能体");

    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/失败|错误|冲突/));
    expect(screen.queryByText(/员工新会话现在可以选择该智能体/)).toBeNull();
  });
});

/** 多 published AgentRevision 场景：唯一自动选中不生效，preferred 必须显式交接。 */
function multiPublishedFixture(): BackendFixture {
  return {
    agents: [agentFixture()],
    agentRevisions: {
      "agent-1": [
        agentRevisionFixture(),
        agentRevisionFixture({
          id: "arev-other",
          revision_no: 5,
          agent_contract_snapshot_id: SNAP_MISMATCHED,
        }),
      ],
    },
    runtimes: [
      runtimeFixture(),
      runtimeFixture({
        id: "rt-2",
        runtime_key: "hr-similar-runtime",
        display_name: "HR 相似 Runtime",
        current_revision_id: "rtrv-2",
      }),
    ],
    runtimeRevisions: {
      "rt-1": [runtimeRevisionFixture()],
      "rt-2": [
        runtimeRevisionFixture({
          id: "rtrv-2",
          runtime_id: "rt-2",
          revision_no: 5,
        }),
      ],
    },
  };
}

function selectValue(labelText: string): string {
  return (screen.getByLabelText(labelText) as HTMLSelectElement).value;
}

describe("RouteActivationPanel（上游发布交接：refreshToken + preferred）", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    calls = [];
  });

  afterEach(cleanup);

  it("refreshToken 变化重新 GET 真实列表后按 preferred 选中，点击仅执行 ensure+activate 且 ID 来自真实 GET", async () => {
    const fixture = multiPublishedFixture();
    stubBackend(fixture);
    const view = render(<RouteActivationPanel canManage refreshToken={0} />);
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === "GET" && call.url === "/admin/api/v1/agents").length,
      ).toBeGreaterThanOrEqual(1),
    );
    await waitFor(() => expect(screen.queryByText(/正在加载/)).toBeNull());

    // 两个 published AgentRevision：无唯一自动选中，初始未选择、按钮禁用。
    expect(selectValue("智能体版本")).toBe("");
    expect(selectValue("运行服务版本")).toBe("");
    const submitBefore = screen.getByRole("button", {
      name: /发布给员工/,
    }) as HTMLButtonElement;
    expect(submitBefore.disabled).toBe(true);

    // 上游发布成功：递增 refreshToken 并交接 preferred（均须来自真实 publish 响应）。
    view.rerender(
      <RouteActivationPanel
        canManage
        refreshToken={1}
        preferredAgentRevisionId="arev-1"
        preferredRuntimeRevisionId="rtrv-1"
      />,
    );

    await waitFor(() => expect(selectValue("智能体版本")).toBe("arev-1"));
    await waitFor(() => expect(selectValue("运行服务版本")).toBe("rtrv-1"));

    // refreshToken 变化确实重新 GET 了真实列表。
    const agentsGetsAfter = calls.filter(
      (call) => call.method === "GET" && call.url === "/admin/api/v1/agents",
    ).length;
    expect(agentsGetsAfter).toBeGreaterThanOrEqual(2);

    // 未点击前不得有任何路由写。
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);

    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(screen.getByText(/员工新会话现在可以选择该智能体/)).toBeTruthy());
    const writeCalls = calls.filter((call) => call.method !== "GET");
    expect(writeCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST /admin/api/v1/deployment-route-sets",
      "PUT /admin/api/v1/deployment-route-sets/route-set-1/activation",
    ]);
    const activateBody = JSON.parse(String(writeCalls[1]?.init?.body));
    expect(activateBody.routes).toEqual([
      expect.objectContaining({
        agent_revision_id: "arev-1",
        runtime_revision_id: "rtrv-1",
      }),
    ]);
  });

  it("preferred AgentRevision 不在真实 GET 中时被忽略，不造假选项，按钮禁用", async () => {
    stubBackend(multiPublishedFixture());
    const view = render(<RouteActivationPanel canManage refreshToken={0} />);
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === "GET" && call.url === "/admin/api/v1/agents").length,
      ).toBeGreaterThanOrEqual(1),
    );
    await waitFor(() => expect(screen.queryByText(/正在加载/)).toBeNull());

    // preferred AgentRevision 是不存在的 id → 无选中智能体，运行服务选项为空；
    // preferred RuntimeRevision（rtrv-2）即使存在也不会被凭 id 造假选中。
    view.rerender(
      <RouteActivationPanel
        canManage
        refreshToken={1}
        preferredAgentRevisionId="arev-ghost"
        preferredRuntimeRevisionId="rtrv-2"
      />,
    );

    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === "GET" && call.url === "/admin/api/v1/agents").length,
      ).toBeGreaterThanOrEqual(2),
    );
    // 失效 preferred 被忽略：未选择、不出现假 option。
    expect(selectValue("智能体版本")).toBe("");
    expect(enabledOptionValues()).not.toContain("arev-ghost");
    expect(enabledOptionValues()).not.toContain("rtrv-2");

    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // 没有任何路由写。
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });

  it("刷新加载失败时 fail closed：显示稳定中文错误，选择清空，按钮禁用且无写", async () => {
    stubBackend(multiPublishedFixture());
    const view = render(
      <RouteActivationPanel canManage refreshToken={0} preferredAgentRevisionId="arev-1" />,
    );
    await waitFor(() => expect(selectValue("智能体版本")).toBe("arev-1"));

    // 下一次刷新失败：不得沿用旧的可用选择。
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
      <RouteActivationPanel
        canManage
        refreshToken={1}
        preferredAgentRevisionId="arev-1"
        preferredRuntimeRevisionId="rtrv-1"
      />,
    );

    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/失败/));
    await waitFor(() => expect(selectValue("智能体版本")).toBe(""));
    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    expect(screen.queryByText(/员工新会话现在可以选择该智能体/)).toBeNull();
  });

  it("重复刷新只重新 GET，不产生写或成功文案", async () => {
    stubBackend(multiPublishedFixture());
    const view = render(
      <RouteActivationPanel canManage refreshToken={0} preferredAgentRevisionId="arev-1" />,
    );
    await waitFor(() => expect(selectValue("智能体版本")).toBe("arev-1"));

    view.rerender(
      <RouteActivationPanel
        canManage
        refreshToken={1}
        preferredAgentRevisionId="arev-1"
        preferredRuntimeRevisionId="rtrv-1"
      />,
    );
    await waitFor(() => expect(selectValue("运行服务版本")).toBe("rtrv-1"));

    view.rerender(
      <RouteActivationPanel
        canManage
        refreshToken={2}
        preferredAgentRevisionId="arev-1"
        preferredRuntimeRevisionId="rtrv-1"
      />,
    );
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === "GET" && call.url === "/admin/api/v1/agents").length,
      ).toBeGreaterThanOrEqual(3),
    );

    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    expect(screen.queryByText(/员工新会话现在可以选择该智能体/)).toBeNull();
    // 选择保持为真实有效的 preferred，没有被重复刷新破坏。
    expect(selectValue("智能体版本")).toBe("arev-1");
    expect(selectValue("运行服务版本")).toBe("rtrv-1");
  });
});
