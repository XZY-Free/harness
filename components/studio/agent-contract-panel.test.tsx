import { AgentContractPanel } from "@/components/studio/agent-contract-panel";
import type { AgentDescriptorSnapshotDTO } from "@/lib/control-plane-client";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

function snapshotFixture(): AgentDescriptorSnapshotDTO {
  return {
    id: "snap-0001-full",
    agent_id: "agent-1",
    descriptor_kind: "agent_card",
    protocol_type: "a2a",
    protocol_contract_revision: "a2a@1",
    provider_descriptor_digest: "sha256:p",
    capability_manifest_digest: "sha256:c",
    invocation_context_contract_digest: "sha256:i",
    normalized_capability_manifest: {
      capabilities: [
        {
          capability_key: "leave_task",
          display_name: "假勤休假",
          description: "年假/调休查询与申请",
          tags: ["hr"],
          examples: ["我今年还有多少年假？"],
        },
      ],
    },
    invocation_context_contract: {
      required: [{ context_kind: "execution_subject", declaration_source: "provider_declared" }],
      preferred: [{ context_kind: "timezone", declaration_source: "operator_declared" }],
      accepted: [],
    },
    contract_section_provenance: { capability: "operator_declared" },
    provider_declared_revision_ref: null,
    captured_at: "2026-08-25T00:00:00.000Z",
    created_by: "admin-1",
  };
}

describe("AgentContractPanel（09 §4/§5）", () => {
  it("展示 Capability Manifest（能力名称/描述/标签/示例，非函数列表）", async () => {
    const loadDescriptors = vi.fn().mockResolvedValue({ items: [snapshotFixture()] });
    render(<AgentContractPanel agentId="agent-1" loadDescriptors={loadDescriptors} />);

    await waitFor(() => {
      expect(screen.getByText("假勤休假")).toBeTruthy();
    });
    expect(screen.getByText(/年假\/调休查询与申请/)).toBeTruthy();
    expect(screen.getByText(/#hr/)).toBeTruthy();
    expect(screen.getByText(/我今年还有多少年假？/)).toBeTruthy();
    expect(loadDescriptors).toHaveBeenCalledWith("agent-1");
  });

  it("三组 Context Contract + operator_declared 标『管理员登记』", async () => {
    const loadDescriptors = vi.fn().mockResolvedValue({ items: [snapshotFixture()] });
    render(<AgentContractPanel agentId="agent-1" loadDescriptors={loadDescriptors} />);

    await waitFor(() => {
      expect(screen.getByText(/execution_subject/)).toBeTruthy();
    });
    expect(screen.getAllByText(/Agent 声明/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("管理员登记").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/timezone/).length).toBeGreaterThanOrEqual(1);
  });

  it("无 Snapshot 时显示空态（Agent 未登记外部合同）", async () => {
    const loadDescriptors = vi.fn().mockResolvedValue({ items: [] });
    render(<AgentContractPanel agentId="agent-1" loadDescriptors={loadDescriptors} />);

    await waitFor(() => {
      expect(screen.getByText("暂无外部合同")).toBeTruthy();
    });
  });
});
