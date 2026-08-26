import { AgentContractRegistrationPanel } from "@/components/studio/agent-contract-registration-panel";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(cleanup);

describe("AgentContractRegistrationPanel（07 §4/§15）", () => {
  it("表单固定三字段：无 URL/Git/source/endpoint/Credential 输入", () => {
    fetchMock.mockResolvedValue(Response.json({ items: [], total: 0 }));
    render(<AgentContractRegistrationPanel />);

    expect(screen.getByLabelText("contract_json")).toBeTruthy();
    // 禁止源码/URL/endpoint/凭证字段（07 §4）。
    expect(screen.queryByLabelText(/url/i)).toBeNull();
    expect(screen.queryByLabelText(/git/i)).toBeNull();
    expect(screen.queryByLabelText(/source/i)).toBeNull();
    expect(screen.queryByLabelText(/endpoint/i)).toBeNull();
    expect(screen.queryByLabelText(/credential/i)).toBeNull();
  });

  it("非法 JSON 拒绝提交并提示", () => {
    render(<AgentContractRegistrationPanel />);
    fireEvent.change(screen.getByPlaceholderText("如 a2a@0.3.0"), { target: { value: "a2a@1" } });
    fireEvent.change(screen.getByLabelText("contract_json"), { target: { value: "{not json" } });
    fireEvent.click(screen.getByRole("button", { name: "登记合同" }));

    expect(screen.getByText("contract_json 不是合法 JSON")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("提交发送 protocol+contract 顶层结构并展示登记结果", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        agent: {
          id: "agent-1",
          agent_key: "hr",
          display_name: "HR 智能体",
          lifecycle_state: "draft",
        },
        contract: {
          snapshot_id: "snap-0001",
          contract_version: "1.0.0",
          public_agent_version: "1.0.0",
          protocol_type: "a2a",
          protocol_contract_revision: "a2a@1",
          contract_digest: "d",
          capability_digest: "d",
          context_digest: "d",
          interaction: {
            streaming_transport: true,
            incremental_content: false,
            input_required: false,
            resume: false,
            cancel: false,
            durable_task_recovery: false,
            supported_locales: ["zh-CN"],
          },
          capabilities: [],
          invocation_context: [],
          result_contract: { fields: [], error_codes: [], notes: { "zh-CN": null, en: null } },
          captured_at: "2026-08-26T00:00:00.000Z",
        },
      }),
    );

    render(<AgentContractRegistrationPanel />);
    fireEvent.change(screen.getByPlaceholderText("如 a2a@0.3.0"), { target: { value: "a2a@1" } });
    fireEvent.change(screen.getByLabelText("contract_json"), {
      target: { value: '{"agent_identity": {"name": "HR"}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "登记合同" }));

    await waitFor(() => expect(screen.getByText(/已登记：HR 智能体/)).toBeTruthy());

    const call = fetchMock.mock.calls[0];
    const [input, init] = call as unknown as [RequestInfo | URL, RequestInit];
    expect(String(input)).toBe("/admin/api/v1/agent-registrations");
    expect(new Headers(init.headers).get("idempotency-key")).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual({
      protocol: { type: "a2a", contract_revision: "a2a@1" },
      contract: { agent_identity: { name: "HR" } },
    });
  });
});
