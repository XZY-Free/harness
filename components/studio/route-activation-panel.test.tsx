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
          agent_contract_snapshot_id: SNAP_MISMATCHED,
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

  it("名称相似但 snapshot 不匹配的 published Runtime 不可选；draft Revision 不可选；唯一匹配自动选中且按钮可用", async () => {
    await loadPanel(defaultFixture(), "HR 智能体");

    // 相似名 Runtime：要么完全不出现，要么以禁用选项出现。
    const similarOption = screen.queryByRole("option", { name: /HR 相似 Runtime/ });
    if (similarOption !== null) {
      expect((similarOption as HTMLOptionElement).disabled).toBe(true);
    }
    // draft AgentRevision / draft RuntimeRevision 不可作为可选值。
    const enabledValues = enabledOptionValues();
    expect(enabledValues).not.toContain("arev-draft");
    expect(enabledValues).not.toContain("rtrv-draft");
    expect(enabledValues).not.toContain("rtrv-2");

    // 唯一匹配 published AgentRevision + RuntimeRevision 自动选中，无需人工选择。
    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
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

  it("没有匹配的 published Runtime 时按钮禁用并显示中文原因，不出现成功文案", async () => {
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
              agent_contract_snapshot_id: SNAP_MATCHING,
            }),
          ],
        },
        runtimes: [runtimeFixture()],
        runtimeRevisions: {
          "rt-1": [runtimeRevisionFixture({ agent_contract_snapshot_id: SNAP_MISMATCHED })],
        },
      },
      "财务智能体",
    );

    const submit = screen.getByRole("button", { name: /发布给员工/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // 清楚的纯中文原因（明确提到运行服务与无法匹配，不暴露 Runtime 术语）。
    expect(document.body.textContent ?? "").toMatch(/没有匹配的运行服务/);
    expect(document.body.textContent ?? "").toMatch(/请先为该智能体版本发布对应的运行服务/);
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
