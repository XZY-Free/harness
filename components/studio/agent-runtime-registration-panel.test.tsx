import { AgentRuntimeRegistrationPanel } from "@/components/studio/agent-runtime-registration-panel";
import type { AgentContractSnapshotDTO } from "@/lib/control-plane-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function snapshotFixture(
  overrides?: Partial<AgentContractSnapshotDTO["interaction"]>,
): AgentContractSnapshotDTO {
  return {
    snapshot_id: "snap-0001",
    contract_version: "1.0.0",
    public_agent_version: "1.0.0",
    protocol_type: "a2a",
    protocol_contract_revision: "a2a@1",
    contract_digest: `sha256:${"a".repeat(64)}`,
    capability_digest: `sha256:${"b".repeat(64)}`,
    context_digest: `sha256:${"c".repeat(64)}`,
    interaction: {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
      supported_locales: ["zh-CN"],
      ...overrides,
    },
    capabilities: [],
    invocation_context: [],
    result_contract: { fields: [], error_codes: [], notes: { "zh-CN": null, en: null } },
    captured_at: "2026-08-25T00:00:00.000Z",
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(cleanup);

function stubBackend(contracts: AgentContractSnapshotDTO[]) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/admin/api/v1/agents") {
      return Response.json({ items: [{ id: "agent-1", display_name: "HR 智能体" }], total: 1 });
    }
    if (url === "/admin/api/v1/credential-refs") {
      return Response.json({
        items: [
          {
            id: "cred-1",
            provider: "oauth",
            fingerprint: "fp",
            lifecycle_state: "active",
            expires_at: null,
          },
        ],
        total: 1,
      });
    }
    if (url === "/admin/api/v1/agents/agent-1/contracts") {
      return Response.json({ items: contracts, total: contracts.length });
    }
    return Response.json({ items: [], total: 0 });
  });
}

async function selectAgentAndSnapshot() {
  await waitFor(() => expect(screen.getByLabelText("登记运行服务的智能体")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("登记运行服务的智能体"), { target: { value: "agent-1" } });
  await waitFor(() => expect(screen.getByLabelText("运行服务使用的合同")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("运行服务使用的合同"), {
    target: { value: "snap-0001" },
  });
}

describe("AgentRuntimeRegistrationPanel（07 §7–§9）", () => {
  it("刷新成功后清除旧智能体列表错误并恢复登记表单", async () => {
    let failAgents = true;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/admin/api/v1/agents") {
        if (failAgents) throw new Error("temporary failure");
        return Response.json({ items: [{ id: "agent-1", display_name: "HR 智能体" }], total: 1 });
      }
      if (url === "/admin/api/v1/credential-refs") {
        return Response.json({ items: [], total: 0 });
      }
      return Response.json({ items: [], total: 0 });
    });

    const view = render(<AgentRuntimeRegistrationPanel refreshToken={0} />);
    await waitFor(() => expect(screen.getByText("智能体列表加载失败")).toBeTruthy());

    failAgents = false;
    view.rerender(<AgentRuntimeRegistrationPanel refreshToken={1} />);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("登记运行服务的智能体") as HTMLSelectElement).options.length,
      ).toBe(2),
    );
    expect(screen.queryByText("智能体列表加载失败")).toBeNull();
  });

  it("bearer 模式只显示已有 CredentialRef 选择，不存在 Secret 文本框", async () => {
    stubBackend([snapshotFixture()]);

    render(<AgentRuntimeRegistrationPanel />);
    await selectAgentAndSnapshot();
    fireEvent.change(screen.getByLabelText("authentication_mode"), { target: { value: "bearer" } });

    expect(screen.getByLabelText("credential_ref_id")).toBeTruthy();
    // 禁止任何 Secret 输入（07 §7）。
    expect(screen.queryByLabelText(/secret/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/secret/i)).toBeNull();
  });

  it("probe 字段按 Snapshot interaction 动态显示（cancel=false 不显示）", async () => {
    stubBackend([snapshotFixture()]);

    render(<AgentRuntimeRegistrationPanel />);
    await selectAgentAndSnapshot();

    expect(screen.getByLabelText("conformance_basic_input")).toBeTruthy();
    // input_required=true / resume=true 显示；cancel=false 不显示。
    expect(screen.getByLabelText("conformance_input_required_input")).toBeTruthy();
    expect(screen.getByLabelText("conformance_resume_start_input")).toBeTruthy();
    expect(screen.getByLabelText("conformance_resume_input")).toBeTruthy();
    expect(screen.queryByLabelText("conformance_cancel_input")).toBeNull();
  });

  it("登记成功展示 §9 结果字段与 measured 矩阵", async () => {
    stubBackend([snapshotFixture()]);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/admin/api/v1/agents/agent-1/runtime-registrations") {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("idempotency-key")).toBeTruthy();
        return Response.json({
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
        });
      }
      if (url === "/admin/api/v1/agents") {
        return Response.json({ items: [{ id: "agent-1", display_name: "HR" }], total: 1 });
      }
      if (url === "/admin/api/v1/credential-refs") {
        return Response.json({ items: [], total: 0 });
      }
      if (url === "/admin/api/v1/agents/agent-1/contracts") {
        return Response.json({ items: [snapshotFixture()], total: 1 });
      }
      return Response.json({ items: [], total: 0 });
    });

    render(<AgentRuntimeRegistrationPanel />);
    await selectAgentAndSnapshot();

    fireEvent.change(screen.getByLabelText("runtime_endpoint"), {
      target: { value: "https://agent.example.com" },
    });
    fireEvent.change(screen.getByLabelText("conformance_basic_input"), {
      target: { value: "你好" },
    });
    fireEvent.change(screen.getByLabelText("conformance_input_required_input"), {
      target: { value: "需要什么" },
    });
    fireEvent.change(screen.getByLabelText("conformance_resume_start_input"), {
      target: { value: "开始" },
    });
    fireEvent.change(screen.getByLabelText("conformance_resume_input"), {
      target: { value: "继续" },
    });

    const submit = screen.getByRole("button", { name: /登记 Runtime/ }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(screen.getByText("Registration Result")).toBeTruthy());
    expect(screen.getByText(/rt-1/)).toBeTruthy();
    expect(screen.getByText(/runtimeTargetDigest/)).toBeTruthy();
    // measured 矩阵：input_required=pass。
    expect(screen.getByText(/input_required/)).toBeTruthy();
  });
});
