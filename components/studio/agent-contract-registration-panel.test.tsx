import { AgentContractRegistrationPanel } from "@/components/studio/agent-contract-registration-panel";
import type { RegisterAgentContractResponse } from "@/lib/control-plane-client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// ─── fixture：通用合法 agent-contract.json（HR 结构，不依赖外部仓路径） ───────

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
    protocol_contract_revision: "0.3.0",
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

// ─── File 帮助函数：只在内存构造 File，不读用户真实文件系统 ─────────────────

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

function getFileInput(): HTMLInputElement {
  return screen.getByLabelText("选择智能体合同文件") as HTMLInputElement;
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(cleanup);

describe("AgentContractRegistrationPanel（合同文件导入）", () => {
  it("无 textarea/protocol 手填字段，唯一文件输入，禁止 URL/Git/source/endpoint/Credential", () => {
    render(<AgentContractRegistrationPanel />);

    // 目标形态：仅一个 file input，可访问名“选择智能体合同文件”，accept 仅 JSON。
    expect(screen.getAllByLabelText("选择智能体合同文件")).toHaveLength(1);
    expect(getFileInput().getAttribute("accept")).toBe(".json,application/json");

    // 不再有手贴 contract_json 的 textarea 与 protocol 技术字段输入。
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryByLabelText(/protocol/)).toBeNull();
    expect(screen.queryByLabelText(/contract_json/i)).toBeNull();

    // 禁止源码/URL/endpoint/凭证字段（07 §4 守卫，不弱化）。
    expect(screen.queryByLabelText(/url/i)).toBeNull();
    expect(screen.queryByLabelText(/git/i)).toBeNull();
    expect(screen.queryByLabelText(/source/i)).toBeNull();
    expect(screen.queryByLabelText(/endpoint/i)).toBeNull();
    expect(screen.queryByLabelText(/credential/i)).toBeNull();
    expect(screen.queryByLabelText(/secret/i)).toBeNull();
  });

  it("初始提交禁用；选择合法 JSON 后异步解析展示预览并启用提交", async () => {
    render(<AgentContractRegistrationPanel />);

    const submit = screen.getByRole("button", { name: "登记合同" });
    expect(submit).toBeTruthy();
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    selectFile(getFileInput(), makeFile(hrContractJson));

    // 异步解析后展示中文预览：名称/稳定标识/版本/合同版本/能力数量/交互能力摘要。
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "登记合同" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    expect(screen.getByText("企业人力智能助手")).toBeTruthy();
    expect(screen.queryByText(/hr-assistant/)).toBeNull();
    expect(screen.getAllByText(/1\.0\.0/).length).toBeGreaterThan(0);
    expect(screen.getByText(/2\s*项/)).toBeTruthy();
    expect(screen.getByText(/流式/)).toBeTruthy();
    // 只读“通信协议”显示 A2A 0.3.0，不暴露 protocol_type 等内部术语。
    expect(screen.getByText(/A2A 0\.3\.0/)).toBeTruthy();
    expect(screen.queryByText(/protocol_type/)).toBeNull();
    expect(screen.queryByText(/contract_json/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("提交协议版本与 AgentCard 的 0.3.0 一致，保留原合同字段及 Idempotency-Key", async () => {
    fetchMock.mockResolvedValue(Response.json(registerResponse));

    const onRegistered = vi.fn();
    render(<AgentContractRegistrationPanel onRegistered={onRegistered} />);

    selectFile(getFileInput(), makeFile(hrContractJson));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "登记合同" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "登记合同" }));

    // 成功结果：中文展示智能体名称与“已登记”，不出现 snapshot id/digest。
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toContain("已登记");
    expect(screen.getByText(/企业人力智能助手/)).toBeTruthy();
    expect(screen.queryByText(/snap-0001/)).toBeNull();
    expect(screen.queryByText(/digest/)).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(input)).toBe("/admin/api/v1/agent-registrations");
    expect(new Headers(init.headers).get("idempotency-key")).toBeTruthy();

    // wire：恰为 protocol + contract；不得夹带 filename/path/raw_contract/contract_json。
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      protocol: { type: "a2a", contract_revision: "0.3.0" },
      contract: hrContract,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /filename|file_path|"path"|raw_contract|contract_json/i,
    );

    // 成功后清空文件与预览、按钮重新禁用，并以完整 response 调用 onRegistered 一次。
    expect(getFileInput().files?.length ?? 0).toBe(0);
    expect(screen.queryByText(/hr-assistant/)).toBeNull();
    expect((screen.getByRole("button", { name: "登记合同" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(onRegistered).toHaveBeenCalledTimes(1);
    expect(onRegistered).toHaveBeenCalledWith(registerResponse);
  });

  it.each([
    ["非法 JSON", makeFile("{not json")],
    ["顶层数组", makeFile(JSON.stringify([{ agent: {} }]))],
    ["顶层 null", makeFile("null")],
    ["空文件", makeFile("")],
    ["非 .json 类型", makeFile(hrContractJson, "agent-contract.txt", "text/plain")],
    [
      "伪装 JSON MIME 的非 .json 文件",
      makeFile(hrContractJson, "agent-contract.bin", "application/json"),
    ],
    [
      "超过 1 MiB",
      new File([new Uint8Array(1024 * 1024 + 1)], "big.json", { type: "application/json" }),
    ],
  ])("%s 前端中文拒绝且零 fetch，重新选择合法文件后错误清除", async (_label, file) => {
    render(<AgentContractRegistrationPanel />);

    selectFile(getFileInput(), file);
    // 中文错误提示（非空），且未发起任何请求。
    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/错误|失败|不符合|不支持|超过|为空/);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "登记合同" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    // 重新选择合法文件：错误清除、预览恢复。
    selectFile(getFileInput(), makeFile(hrContractJson));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "登记合同" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    expect(screen.getByText("企业人力智能助手")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("后选文件会使仍在读取的旧文件失效，旧结果不得覆盖新错误", async () => {
    render(<AgentContractRegistrationPanel />);

    let resolveSlowRead: ((value: string) => void) | undefined;
    const slowFile = makeFile(hrContractJson, "slow.json");
    Object.defineProperty(slowFile, "text", {
      value: () =>
        new Promise<string>((resolve) => {
          resolveSlowRead = resolve;
        }),
    });

    selectFile(getFileInput(), slowFile);
    selectFile(getFileInput(), makeFile(hrContractJson, "latest.txt", "text/plain"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    await act(async () => {
      resolveSlowRead?.(hrContractJson);
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("企业人力智能助手")).toBeNull();
    expect((screen.getByRole("button", { name: "登记合同" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("后端 schema 错误显示中文提示，不泄露 raw stack/code", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: {
            code: "REQUEST_SCHEMA_INVALID",
            message: "unknown key `evil`",
            request_id: "req-1",
            retryable: false,
          },
        },
        { status: 400 },
      ),
    );

    render(<AgentContractRegistrationPanel />);
    selectFile(getFileInput(), makeFile(hrContractJson));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "登记合同" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "登记合同" }));

    await waitFor(() => expect(screen.getByText(/合同内容不符合规范/)).toBeTruthy());
    // 不回显后端原始 message/code/stack。
    expect(screen.queryByText(/REQUEST_SCHEMA_INVALID/)).toBeNull();
    expect(screen.queryByText(/unknown key/)).toBeNull();
  });
});
