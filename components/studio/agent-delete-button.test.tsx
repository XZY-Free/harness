import { AgentDeleteButton } from "@/components/studio/agent-delete-button";
import type { AgentDTO } from "@/lib/control-plane-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});
const agent: AgentDTO = {
  id: "a1",
  agent_key: "a1",
  display_name: "测试智能体",
  description: null,
  lifecycle_state: "enabled",
  current_revision_id: "r1",
  owner_user_id: "u1",
  version_no: 4,
  updated_at: null,
};
it("先确认影响再发送带版本条件的删除请求，成功后才移除列表项", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ id: "a1", deleted: true }), { status: 200 }),
  );
  const onDeleted = vi.fn();
  render(<AgentDeleteButton agent={agent} canDelete onDeleted={onDeleted} />);
  fireEvent.click(screen.getByRole("button", { name: "删除测试智能体" }));
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("If-Match")).toBe('"agent-4"');
});
it("无权限时解释原因，确认按钮不可用", () => {
  render(<AgentDeleteButton agent={agent} onDeleted={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "删除测试智能体" }));
  expect((screen.getByRole("button", { name: "确认删除" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
it("接口失败时保留对话框和列表，不宣告删除成功", async () => {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        error: {
          code: "BUSINESS_CONSTRAINT_VIOLATION",
          message: "referenced",
          request_id: "test",
          retryable: false,
        },
      }),
      { status: 422 },
    ),
  );
  const onDeleted = vi.fn();
  render(<AgentDeleteButton agent={agent} canDelete onDeleted={onDeleted} />);
  fireEvent.click(screen.getByRole("button", { name: "删除测试智能体" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await screen.findByRole("alert");
  expect(onDeleted).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "确认删除" })).toBeTruthy();
});
