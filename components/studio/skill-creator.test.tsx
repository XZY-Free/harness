import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillCreator } from "./skill-creator";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

beforeEach(() => refresh.mockReset());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SkillCreator", () => {
  it("用中文复选项选择工具，提交时仍发送后端所需的稳定标识", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillCreator />);
    fireEvent.click(screen.getByRole("button", { name: "新建技能" }));

    expect(screen.getByRole("group", { name: "可用工具" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "写入文件" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "运行命令" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("writeFile");
    expect(document.body.textContent).not.toContain("runCommand");

    fireEvent.click(screen.getByRole("checkbox", { name: "运行命令" }));
    fireEvent.change(screen.getByLabelText("技能标识"), { target: { value: "report-helper" } });
    fireEvent.click(screen.getByRole("button", { name: "创建技能" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).tools).toEqual([
      "writeFile",
      "readFile",
      "listFiles",
      "runTests",
      "reportReady",
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
