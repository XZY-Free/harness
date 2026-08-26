import { AgentRegistrationWorkspace } from "@/components/studio/agent-registration-workspace";
import type {
  AgentContractSnapshotDTO,
  AgentDTO,
  RegisterAgentContractResponse,
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

// ─── fetch mock：登记前后有状态切换（初始无 Agent，登记后返回 HR） ─────────────

let registered = false;

function stubBackend() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/admin/api/v1/agent-registrations" && init?.method === "POST") {
      registered = true;
      return Response.json(registerResponse);
    }
    if (url === "/admin/api/v1/agents") {
      return Response.json({
        items: registered ? [hrAgent] : [],
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
    if (url === "/admin/api/v1/agents/agent-1/revisions") {
      return Response.json({ items: [], total: 0 });
    }
    return Response.json({ items: [], total: 0 });
  });
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
    expect(screen.getByLabelText("创建版本的智能体")).toBeTruthy();
    expect(screen.getByLabelText("创建版本使用的合同")).toBeTruthy();
    expect(screen.getByLabelText("登记运行服务的智能体")).toBeTruthy();
    expect(screen.getByLabelText("运行服务使用的合同")).toBeTruthy();

    // 旧的重名 aria-label="agent" 必须消失。
    expect(screen.queryAllByLabelText("agent")).toHaveLength(0);

    // 守卫：合同登记入口不得新增 URL/Git/source/secret 输入（Runtime endpoint 是独立后续输入，允许存在）。
    expect(screen.queryByLabelText(/git/i)).toBeNull();
    expect(screen.queryByLabelText(/source/i)).toBeNull();
    expect(screen.queryByLabelText(/secret/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/secret/i)).toBeNull();
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
});
