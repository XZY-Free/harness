import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillDeleteButton } from "./skill-delete-button";

const push = vi.fn();
const refresh = vi.fn();
const toastError = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({ error: toastError }),
}));

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SkillDeleteButton", () => {
  it("明确说明归档会保留历史记录，确认后才发送软删除请求", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillDeleteButton skillId="skill-1" skillName="报告助手" />);
    fireEvent.click(screen.getByRole("button", { name: "归档技能" }));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("确认归档“报告助手”？")).toBeTruthy();
    expect(screen.getByText(/已有任务和历史版本仍可查看/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/studio/api/skills/skill-1", { method: "DELETE" });
    expect(push).toHaveBeenCalledWith("/studio/skills");
  });
});
