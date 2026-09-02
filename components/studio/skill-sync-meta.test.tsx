import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillSyncMeta } from "./skill-sync-meta";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

beforeEach(() => refresh.mockReset());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SkillSyncMeta", () => {
  it("停止同步使用明确确认窗口，确认前不归档本地副本", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SkillSyncMeta
        skillId="skill-1"
        skillName="报告助手"
        syncState="active"
        remoteAssetId="private-asset-id"
        remoteName="report-helper"
        remoteDisplayName="报告助手"
        remoteVersion="2.0.0"
        remoteContentHash="private-content-hash"
        lastSyncedAt="2026-09-02 10:00"
        lastError={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "停止同步" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("确认停止同步“报告助手”？")).toBeTruthy();
    expect(screen.getByText(/已有任务和历史版本仍可查看/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认停止同步" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/studio/api/skills/skill-1/unsync", {
      method: "POST",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("private-asset-id");
    expect(document.body.textContent).not.toContain("private-content-hash");
  });
});
