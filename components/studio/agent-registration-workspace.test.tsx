import { AgentRegistrationWorkspace } from "@/components/studio/agent-registration-workspace";
import type {
  AgentContractSnapshotDTO,
  AgentDTO,
  RegisterAgentContractResponse,
  RuntimeDTO,
  RuntimeRevisionDTO,
} from "@/lib/control-plane-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  visibility_policy_id: null,
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

// ─── fixture：真实 Runtime 登记与发布链路（external_endpoint + conf-1） ──────

const runtime: RuntimeDTO = {
  id: "rt-1",
  tenant_id: "tenant-1",
  runtime_key: "hr-runtime",
  display_name: "HR 外部运行服务",
  kind: "external",
  lifecycle_state: "draft",
  owner_user_id: "user-1",
  current_revision_id: "rtr-1",
  version_no: 3,
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:00:00.000Z",
};

const runtimeRevision: RuntimeRevisionDTO = {
  id: "rtr-1",
  runtime_id: "rt-1",
  revision_no: 1,
  revision_state: "draft",
  protocol_type: "a2a",
  protocol_contract_revision: "a2a@1",
  runtime_evidence_kind: "external_endpoint",
  runtime_target_digest: `sha256:${"d".repeat(64)}`,
  endpoint_ref: "https://agent.example.com",
  artifact_id: null,
  artifact_digest: null,
  artifact_ref: null,
  config_hash: `sha256:${"f".repeat(64)}`,
  runtime_capabilities: { measured: { features: { streaming_transport: "pass" } } },
  agent_contract_snapshot_id: "snap-0001",
  identity_mode: "bearer",
  credential_ref_id: "cred-1",
  network_zone: "public",
  attestation_ids: [],
  publication_record_id: null,
  withdrawal_record_id: null,
  latest_valid_conformance_run_id: "conf-1",
  latest_valid_conformance_overall_result: "passed",
  publication_conformance_run_id: null,
  execution_eligible: false,
  ineligibility_reasons: [],
  created_at: "2026-08-26T00:00:00.000Z",
  published_at: null,
};

const registerRuntimeResponse = {
  agent_id: "agent-1",
  agent_contract_snapshot_id: "snap-0001",
  runtime_id: "rt-1",
  runtime_revision_id: "rtr-1",
  runtime_key: "hr-runtime",
  runtime_endpoint: "https://agent.example.com",
  protocol: { type: "a2a", contract_revision: "a2a@1" },
  verification_state: "verified",
  verified_at: "2026-08-26T00:00:00.000Z",
  runtime_target_digest: `sha256:${"d".repeat(64)}`,
  evidence_digest: `sha256:${"e".repeat(64)}`,
  config_hash: `sha256:${"f".repeat(64)}`,
  measured: {
    agent_card: {
      protocol_version: "pass",
      transport: "pass",
      streaming_consistency: "pass",
    },
    basic_invocation: { status: "pass" },
    features: {
      streaming_transport: "pass",
      incremental_content: "not_applicable",
      input_required: "pass",
      resume: "pass",
      cancel: "not_applicable",
      durable_task_recovery: "not_measured",
    },
  },
};

const publishResponse = {
  id: "rtr-1",
  revision_state: "published" as const,
  published_at: "2026-08-26T01:00:00.000Z",
  publication_record_id: "pub-1",
  conformance_run_id: "conf-1",
  audit_event_id: "audit-1",
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
let runtimeRegistered = false;
let runtimePublished = false;
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
    if (url === "/admin/api/v1/agents/agent-1/runtime-registrations" && method === "POST") {
      runtimeRegistered = true;
      return Response.json(registerRuntimeResponse);
    }
    if (url === "/admin/api/v1/runtimes") {
      return Response.json({
        items: runtimeRegistered ? [runtime] : [],
        total: runtimeRegistered ? 1 : 0,
      });
    }
    if (url === "/admin/api/v1/runtimes/rt-1/revisions") {
      return Response.json({
        items: runtimePublished
          ? [
              {
                ...runtimeRevision,
                revision_state: "published",
                publication_record_id: "pub-1",
                published_at: "2026-08-26T01:00:00.000Z",
              },
            ]
          : [runtimeRevision],
        total: 1,
      });
    }
    if (url === "/admin/api/v1/runtime-revisions/rtr-1/publish" && method === "POST") {
      runtimePublished = true;
      return Response.json(publishResponse);
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
  return (screen.getByLabelText(label) as HTMLSelectElement).value;
}

function publishPosts(): Array<{ body: unknown; headers: Headers }> {
  return fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url) === "/admin/api/v1/runtime-revisions/rtr-1/publish" && init?.method === "POST",
    )
    .map(([, init]) => ({
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    }));
}

/** 在“登记合同”之后继续完成真实 Runtime 登记（填写 endpoint + conformance 输入）。 */
async function registerRuntimeAfterContract() {
  await waitFor(() => expect(selectValue("登记运行服务的智能体")).toBe("agent-1"));
  await waitFor(() => expect(selectValue("运行服务使用的合同")).toBe("snap-0001"));

  fireEvent.change(screen.getByLabelText("运行服务地址"), {
    target: { value: "https://agent.example.com" },
  });
  fireEvent.change(screen.getByLabelText("基础对话输入"), {
    target: { value: "你好" },
  });
  fireEvent.change(screen.getByLabelText("需要补充信息时的输入"), {
    target: { value: "需要什么" },
  });
  fireEvent.change(screen.getByLabelText("恢复会话的起始输入"), {
    target: { value: "开始" },
  });
  fireEvent.change(screen.getByLabelText("恢复会话的继续输入"), {
    target: { value: "继续" },
  });

  const submit = screen.getByRole("button", { name: /登记运行服务/ }) as HTMLButtonElement;
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(runtimeRegistered).toBe(true));
}

/** 全权限渲染，并完成“导入合同 → 登记成功”的连续交接前置动作。 */
async function renderWorkspaceAndRegisterContract(
  props?: Partial<Parameters<typeof AgentRegistrationWorkspace>[0]>,
) {
  render(
    <AgentRegistrationWorkspace
      canReadAgents
      canRegisterContract
      canManageRevisions
      canRegisterRuntime
      {...props}
    />,
  );

  // 初始档案：空列表（暂无智能体），不是加载失败。
  await waitFor(() => expect(screen.getByText("暂无智能体")).toBeTruthy());

  const fileInput = screen.getByLabelText("选择智能体合同文件") as HTMLInputElement;
  selectFile(fileInput, makeFile(hrContractJson));
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "登记合同" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "登记合同" }));
  await waitFor(() => expect(screen.getByText(/已登记/)).toBeTruthy());
}

beforeEach(() => {
  fetchMock.mockReset();
  registered = false;
  runtimeRegistered = false;
  runtimePublished = false;
  agentRevisionCreated = false;
  agentRevisionPublished = false;
  stubBackend();
});

afterEach(cleanup);

describe("AgentRegistrationWorkspace（导入合同后连续交接）", () => {
  it("登记合同后不 remount/不刷新：档案显示 HR 智能体，创建版本与登记运行服务的选择均为 agent-1/snap-0001", async () => {
    await renderWorkspaceAndRegisterContract();

    // 登记后（同一次挂载，无 remount）：档案区域出现 HR 智能体行（agent_key + 草稿状态）。
    await waitFor(() => expect(screen.getByText("hr-assistant")).toBeTruthy());
    expect(screen.getByText("草稿")).toBeTruthy();

    // 调用方没有 rerender；合同面板成功后允许为清空已选文件而重挂 input。
    expect(screen.getAllByLabelText("选择智能体合同文件")).toHaveLength(1);

    // 创建版本区域：智能体与合同选择都已被交接为登记结果。
    await waitFor(() => expect(selectValue("创建版本的智能体")).toBe("agent-1"));
    await waitFor(() => expect(selectValue("创建版本使用的合同")).toBe("snap-0001"));

    // 登记运行服务区域：同样交接为 agent-1 / snap-0001。
    await waitFor(() => expect(selectValue("登记运行服务的智能体")).toBe("agent-1"));
    await waitFor(() => expect(selectValue("运行服务使用的合同")).toBe("snap-0001"));

    // 选择器里确实存在对应 option（不是空值假通过）。
    const revisionAgentSelect = screen.getByLabelText("创建版本的智能体") as HTMLSelectElement;
    expect(Array.from(revisionAgentSelect.options).some((o) => o.value === "agent-1")).toBe(true);
    const revisionContractSelect = screen.getByLabelText("创建版本使用的合同") as HTMLSelectElement;
    expect(Array.from(revisionContractSelect.options).some((o) => o.value === "snap-0001")).toBe(
      true,
    );
  });

  it("四个选择器中文可访问名互不冲突，不再使用 aria-label=agent；不新增 URL/Git/source/secret 输入", async () => {
    await renderWorkspaceAndRegisterContract();

    // 互不冲突的中文可访问名（getByLabelText 在重复时会抛错，本身就是唯一性断言）。
    await waitFor(() => expect(screen.getByLabelText("创建版本的智能体")).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText("创建版本使用的合同")).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText("登记运行服务的智能体")).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText("运行服务使用的合同")).toBeTruthy());

    // 旧的重名 aria-label="agent" 必须消失。
    expect(screen.queryAllByLabelText("agent")).toHaveLength(0);

    // 守卫：合同登记入口不得新增 URL/Git/source/secret 输入（Runtime endpoint 是独立后续输入，允许存在）。
    expect(screen.queryByLabelText(/git/i)).toBeNull();
    expect(screen.queryByLabelText(/source/i)).toBeNull();
    expect(screen.queryByLabelText(/secret/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/secret/i)).toBeNull();
  });

  it("真实 Runtime 登记成功后同页出现发布按钮，须用户点击才 POST publish，body/headers 精确并刷新为已发布", async () => {
    await renderWorkspaceAndRegisterContract({ canPublishRuntime: true });
    await registerRuntimeAfterContract();

    // 同一次挂载内：后端 state 从空 runtimes 切到真实 rt-1/rtr-1 后，发布按钮出现，
    // 且聚焦显示刚登记的 revision（runtime_revision_id 交接给 RuntimeControlPanel）。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "发布运行服务版本" })).toBeTruthy(),
    );
    expect(screen.getByText("HR 外部运行服务")).toBeTruthy();
    expect(screen.getByText("本次登记")).toBeTruthy();

    // 登记成功本身不得自动 POST publish（必须由用户点击）。
    expect(publishPosts()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "发布运行服务版本" }));

    await waitFor(() => expect(publishPosts()).toHaveLength(1));
    const post = publishPosts()[0];
    if (!post) throw new Error("publish POST 未发出");
    expect(post.body).toEqual({
      expected_version_no: 3,
      attestation_id: null,
      conformance_run_id: "conf-1",
    });
    expect(post.headers.get("Idempotency-Key")).toBeTruthy();
    expect(post.headers.get("If-Match")).toBe("runtime-revision-1");

    // 发布成功后刷新为已发布状态并出现撤回入口。
    await waitFor(() => expect(screen.getByRole("button", { name: "撤回" })).toBeTruthy());
    expect(screen.getByText("已发布")).toBeTruthy();
  });

  it("canPublishRuntime=false（默认）不渲染运行版本发布区域，登记 Runtime 后也没有发布按钮与 POST", async () => {
    await renderWorkspaceAndRegisterContract();
    await registerRuntimeAfterContract();

    expect(screen.queryByRole("button", { name: "发布运行服务版本" })).toBeNull();
    expect(screen.queryByText("本次登记")).toBeNull();
    expect(publishPosts()).toHaveLength(0);
  });

  it("运行服务发布权限独立于智能体读取权限，不额外隐藏正式发布入口", async () => {
    runtimeRegistered = true;
    render(
      <AgentRegistrationWorkspace
        canReadAgents={false}
        canRegisterContract={false}
        canManageRevisions={false}
        canRegisterRuntime={false}
        canPublishRuntime
      />,
    );

    await waitFor(() => expect(screen.getByText("HR 外部运行服务")).toBeTruthy());
    expect(screen.getByRole("button", { name: "发布运行服务版本" })).toBeTruthy();
  });

  it("权限守卫：canRegisterContract=false 时合同登记区域不渲染", async () => {
    render(
      <AgentRegistrationWorkspace
        canReadAgents
        canRegisterContract={false}
        canManageRevisions
        canRegisterRuntime
      />,
    );

    await waitFor(() => expect(screen.getByText("暂无智能体")).toBeTruthy());
    expect(screen.queryByLabelText("选择智能体合同文件")).toBeNull();
    expect(screen.queryByRole("button", { name: "登记合同" })).toBeNull();
  });

  it("同一挂载内完成合同登记→创建/发布智能体版本→登记/发布运行服务→发布给员工；路由写只发生在最终点击", async () => {
    await renderWorkspaceAndRegisterContract({
      canPublishRuntime: true,
      canManageRoutes: true,
    });

    // 创建草稿版本（合同已交接为 snap-0001，草稿本身不是可发布状态）。
    const createButton = screen.getByRole("button", {
      name: "创建草稿版本",
    }) as HTMLButtonElement;
    await waitFor(() => expect(createButton.disabled).toBe(false));
    fireEvent.click(createButton);
    await waitFor(() => expect(screen.getByText(/已创建草稿版本/)).toBeTruthy());

    // 发布智能体版本：交接只能由真实 publish API 成功返回驱动。
    fireEvent.click(screen.getByRole("button", { name: "发布" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/admin/api/v1/agent-revisions/arev-1/publish" &&
            init?.method === "POST",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByText(/版本 1 已发布/)).toBeTruthy());
    // 发布后档案当前版本同步刷新，不要求用户重载页面。
    await waitFor(() => expect(screen.getByRole("cell", { name: "arev-1" })).toBeTruthy());

    // 登记并发布运行服务（真实 publish API）。
    await registerRuntimeAfterContract();
    fireEvent.click(await screen.findByRole("button", { name: "发布运行服务版本" }));
    await waitFor(() => expect(publishPosts()).toHaveLength(1));

    // 两次真实发布之前不得有任何路由写。
    expect(routeWriteCalls()).toHaveLength(0);

    // 路由面板接收并选择真实 GET 返回的 published arev-1 / rtr-1。
    await waitFor(() =>
      expect((screen.getByLabelText("智能体版本") as HTMLSelectElement).value).toBe("arev-1"),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("运行服务版本") as HTMLSelectElement).value).toBe("rtr-1"),
    );

    const submit = screen.getByRole("button", {
      name: "发布给员工",
    }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    // 点击前仍然零路由写。
    expect(routeWriteCalls()).toHaveLength(0);

    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/员工新会话现在可以选择该智能体/)).toBeTruthy());

    const writes = routeWriteCalls();
    expect(writes.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST /admin/api/v1/deployment-route-sets",
      "PUT /admin/api/v1/deployment-route-sets/route-set-1/activation",
    ]);
    const activateBody = JSON.parse(String(writes[1]?.init?.body));
    expect(activateBody.routes).toEqual([
      expect.objectContaining({
        agent_revision_id: "arev-1",
        runtime_revision_id: "rtr-1",
      }),
    ]);
  });

  it("canManageRoutes 缺省为 false：不渲染「发布给员工」路由区域且零路由写", async () => {
    await renderWorkspaceAndRegisterContract({ canPublishRuntime: true });
    await registerRuntimeAfterContract();

    expect(screen.queryByRole("button", { name: "发布给员工" })).toBeNull();
    expect(screen.queryByLabelText("智能体版本")).toBeNull();
    expect(routeWriteCalls()).toHaveLength(0);
  });
});
