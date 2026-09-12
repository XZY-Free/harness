import { AgentRegistrationWorkspace } from "@/components/studio/agent-registration-workspace";
import type {
  AgentContractSnapshotDTO,
  AgentDTO,
  RegisterAgentContractResponse,
} from "@/lib/control-plane-client";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// ─── fixture：合法 HR agent-contract.json（内存构造，不依赖外部仓路径） ─────────

const hrContract = {
  contract_version: "1.0.0",
  agent: {
    id: "hr-assistant",
    name: { "zh-CN": "企业人力智能助手", en: "Enterprise HR Assistant" },
    version: "1.0.0",
  },
  interaction: {
    streaming_transport: true,
    incremental_content: false,
    input_required: true,
    resume: true,
    cancel: false,
    durable_task_recovery: false,
    supported_locales: ["zh-CN"],
  },
  capabilities: [
    { key: "leave-and-attendance-service", name: { "zh-CN": "假勤与请假服务" } },
    { key: "employee-self-service", name: { "zh-CN": "员工本人信息服务" } },
  ],
  invocation_context: [{ key: "execution_subject", necessity: "preferred" }],
  result_contract: {
    fields: ["leave_balance_days"],
    error_codes: ["LEAVE_POLICY_DENIED"],
  },
} as const;

const hrContractJson = JSON.stringify(hrContract);

const registerResponse: RegisterAgentContractResponse = {
  agent: {
    id: "agent-1",
    agent_key: "hr-assistant",
    display_name: "企业人力智能助手",
    lifecycle_state: "draft",
  },
  contract: {
    snapshot_id: "snap-0001",
    contract_version: "1.0.0",
    public_agent_version: "1.0.0",
    protocol_type: "a2a",
    protocol_contract_revision: "a2a@0.3.0",
    contract_digest: "digest-contract",
    capability_digest: "digest-capability",
    context_digest: "digest-context",
    interaction: {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
      supported_locales: ["zh-CN"],
    },
    capabilities: [],
    invocation_context: [],
    result_contract: { fields: [], error_codes: [], notes: { "zh-CN": null, en: null } },
    captured_at: "2026-08-26T00:00:00.000Z",
  },
};

const hrAgent: AgentDTO = {
  id: "agent-1",
  agent_key: "hr-assistant",
  display_name: "企业人力智能助手",
  description: null,
  lifecycle_state: "draft",
  current_revision_id: null,
  owner_user_id: "user-1",
  version_no: 1,
  updated_at: "2026-08-26T00:00:00.000Z",
};

const hrSnapshot: AgentContractSnapshotDTO = {
  snapshot_id: "snap-0001",
  contract_version: "1.0.0",
  public_agent_version: "1.0.0",
  protocol_type: "a2a",
  protocol_contract_revision: "a2a@0.3.0",
  contract_digest: "digest-contract",
  capability_digest: "digest-capability",
  context_digest: "digest-context",
  interaction: registerResponse.contract.interaction,
  capabilities: [],
  invocation_context: [],
  result_contract: { fields: [], error_codes: [], notes: { "zh-CN": null, en: null } },
  captured_at: "2026-08-26T00:00:00.000Z",
};

// ─── fixture：智能体版本创建/发布与路由激活（同页闭环） ───────────────────────

const agentRevisionDraft = {
  id: "arev-1",
  agent_id: "agent-1",
  revision_no: 1,
  revision_state: "draft" as const,
  agent_contract_snapshot_id: "snap-0001",
  etag: "agent-revision-1",
};

const agentPublishResponse = {
  id: "arev-1",
  revision_state: "published" as const,
  published_at: "2026-08-27T00:00:00.000Z",
  audit_event_id: "audit-arev-1",
};

const routeSetEnsureResponse = {
  id: "route-set-1",
  agent_id: "agent-1",
  route_scope_key: "default",
  route_scope: {},
  version_no: 7,
  created_at: "2026-08-27T00:00:00.000Z",
  updated_at: "2026-08-27T00:00:00.000Z",
  created: true,
};

const routeActivationResponse = {
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

// ─── fetch mock：登记前后有状态切换（初始无 Agent，登记后返回 HR） ─────────────

let registered = false;
let agentRevisionCreated = false;
let agentRevisionPublished = false;

function stubBackend() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/admin/api/v1/agent-registrations" && method === "POST") {
      registered = true;
      return Response.json(registerResponse);
    }
    if (url === "/admin/api/v1/agents") {
      return Response.json({
        items: registered
          ? [{ ...hrAgent, current_revision_id: agentRevisionPublished ? "arev-1" : null }]
          : [],
        total: registered ? 1 : 0,
      });
    }
    if (url === "/admin/api/v1/credential-refs") {
      return Response.json({ items: [], total: 0 });
    }
    if (url === "/admin/api/v1/agents/agent-1/contracts") {
      return Response.json({
        items: registered ? [hrSnapshot] : [],
        total: registered ? 1 : 0,
      });
    }
    if (url === "/admin/api/v1/agents/agent-1/revisions" && method === "POST") {
      agentRevisionCreated = true;
      return Response.json(agentRevisionDraft);
    }
    if (url === "/admin/api/v1/agents/agent-1/revisions") {
      if (agentRevisionPublished) {
        return Response.json({
          items: [{ ...agentRevisionDraft, revision_state: "published" }],
          total: 1,
        });
      }
      return Response.json({
        items: agentRevisionCreated ? [agentRevisionDraft] : [],
        total: agentRevisionCreated ? 1 : 0,
      });
    }
    if (url === "/admin/api/v1/agent-revisions/arev-1/publish" && method === "POST") {
      agentRevisionPublished = true;
      return Response.json(agentPublishResponse);
    }
    if (url === "/admin/api/v1/deployment-route-sets" && method === "POST") {
      return Response.json(routeSetEnsureResponse, { status: 201 });
    }
    if (url === "/admin/api/v1/deployment-route-sets/route-set-1/activation" && method === "PUT") {
      return Response.json(routeActivationResponse);
    }
    return Response.json({ items: [], total: 0 });
  });
}

function routeWriteCalls(): Array<{ method: string; url: string; init?: RequestInit }> {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes("/admin/api/v1/deployment-route-sets"))
    .map(([url, init]) => ({
      method: init?.method ?? "GET",
      url: String(url),
      init,
    }))
    .filter((call) => call.method !== "GET");
}

function makeFile(content: string, name = "agent-contract.json", type = "application/json"): File {
  return new File([content], name, { type });
}

function selectFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", {
    value: { 0: file, length: 1, item: () => file, [Symbol.iterator]: [file][Symbol.iterator] },
    configurable: true,
  });
  fireEvent.change(input);
}

function selectValue(label: string): string {
  return screen.getByLabelText(label).getAttribute("data-selected-id") ?? "";
}

function selectHiddenValue(label: string): string {
  const trigger = screen.getByLabelText(label);
  return (
    (trigger.parentElement?.querySelector('input[aria-hidden="true"]') as HTMLInputElement | null)
      ?.value ?? ""
  );
}

function renderWorkspace(props: Partial<Parameters<typeof AgentRegistrationWorkspace>[0]> = {}) {
  return render(
    <AgentRegistrationWorkspace
      canReadAgents
      canRegisterContract
      canManageRevisions
      canManageRoutes
      {...props}
    />,
  );
}
async function registerContract() {
  fireEvent.click(screen.getByRole("button", { name: "登记智能体" }));
  selectFile(
    screen.getByLabelText("选择智能体合同文件") as HTMLInputElement,
    makeFile(hrContractJson),
  );
  const button = await screen.findByRole("button", { name: "确认合同并继续" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await screen.findByRole("heading", { name: "使用设置" });
}
beforeEach(() => {
  fetchMock.mockReset();
  registered = false;
  agentRevisionCreated = false;
  agentRevisionPublished = false;
  window.history.replaceState(null, "", "/studio/resources");
  stubBackend();
});
afterEach(cleanup);

describe("智能体登记任务流程", () => {
  it("默认只展示列表和登记入口，不加载登记表单、Runtime 或路由资产", async () => {
    renderWorkspace();
    await screen.findByText("暂无智能体");
    expect(screen.getByRole("button", { name: "登记智能体" })).toBeTruthy();
    expect(screen.queryByLabelText("选择智能体合同文件")).toBeNull();
    expect(screen.queryByLabelText("调用地址")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/runtimes"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/credential-refs"))).toBe(
      false,
    );
  });
  it("点击登记只展示当前步骤；登记后自动交接权威合同，不提前发布路由", async () => {
    renderWorkspace();
    await registerContract();
    expect(screen.queryByLabelText("选择智能体合同文件")).toBeNull();
    expect(screen.queryByLabelText("调用地址")).toBeNull();
    await waitFor(() => expect(selectValue("选择服务提供方交付的接入文件")).toBe("snap-0001"));
    expect(screen.queryByLabelText("创建版本的智能体")).toBeNull();
    expect(window.location.search).toContain("agent=agent-1");
    expect(routeWriteCalls()).toHaveLength(0);
  });
  it("合同到版本再到连接发布始终在同一任务中，最终点击前不写路由", async () => {
    renderWorkspace();
    await registerContract();
    const create = await screen.findByRole("button", { name: "保存配置并继续" });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    await screen.findByRole("heading", { name: "连接与发布" });
    await waitFor(() => expect(selectHiddenValue("智能体版本")).toBe("arev-1"));
    expect(screen.queryByRole("button", { name: "保存配置并继续" })).toBeNull();
    fireEvent.change(screen.getByLabelText("调用地址"), {
      target: { value: "https://agent.example.com/a2a" },
    });
    fireEvent.change(screen.getByLabelText("网络区域"), { target: { value: "public" } });
    expect(routeWriteCalls()).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("认证方式"));
    fireEvent.click(await screen.findByRole("option", { name: "无需认证" }));
    fireEvent.click(screen.getByRole("button", { name: "发布给员工" }));
    await screen.findByText(/发布配置已提交/);
    expect(screen.queryByText(/现在可以选择该智能体/)).toBeNull();
    expect(routeWriteCalls().map((c) => c.method)).toEqual(["POST", "PUT"]);
    expect(JSON.parse(String(routeWriteCalls()[1]?.init?.body)).routes[0].target).toMatchObject({
      kind: "agent",
      agent_revision_id: "arev-1",
      credential_ref_id: null,
    });
  });
  it("刷新后从服务端已有合同恢复配置步骤；不伪造不存在的智能体", async () => {
    registered = true;
    window.history.replaceState(null, "", "/studio/resources?agent=agent-1&step=configure");
    renderWorkspace();
    await screen.findByRole("heading", { name: "使用设置" });
    await waitFor(() => expect(selectValue("选择服务提供方交付的接入文件")).toBe("snap-0001"));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("只读用户可以浏览合同，但没有登记入口", async () => {
    renderWorkspace({
      canRegisterContract: false,
      canManageRevisions: false,
      canManageRoutes: false,
    });
    await screen.findByText("暂无智能体");
    expect(screen.queryByRole("button", { name: "登记智能体" })).toBeNull();
    expect(screen.queryByLabelText("选择智能体合同文件")).toBeNull();
  });
});
