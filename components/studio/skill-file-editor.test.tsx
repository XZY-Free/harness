import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillFileEditor } from "./skill-file-editor";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

function jsonResponse(data: unknown, ok = true) {
  return Promise.resolve({ ok, json: async () => data });
}

beforeEach(() => {
  refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SkillFileEditor", () => {
  it("未保存时切换文件需要确认，保存工作副本不会自动发布版本", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({ data: { files: ["SKILL.md", "notes.md"] } }))
      .mockImplementationOnce(() =>
        jsonResponse({ data: { path: "SKILL.md", content: "初始内容" } }),
      )
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        expect(init?.method).toBe("PUT");
        return jsonResponse({ data: { path: "SKILL.md" } });
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillFileEditor skillId="skill-1" skillName="报告助手" canWrite />);
    fireEvent.click(await screen.findByRole("button", { name: "SKILL.md" }));
    const editor = await screen.findByRole("textbox", { name: "文件内容" });
    fireEvent.change(editor, { target: { value: "已修改" } });

    fireEvent.click(screen.getByRole("button", { name: "notes.md" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("放弃未保存的修改？")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "保存工作副本" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("status").textContent).toContain("工作副本已保存，尚未发布");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("确认放弃后才读取目标文件并切换", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({ data: { files: ["SKILL.md", "notes.md"] } }))
      .mockImplementationOnce(() =>
        jsonResponse({ data: { path: "SKILL.md", content: "初始内容" } }),
      )
      .mockImplementationOnce(() =>
        jsonResponse({ data: { path: "notes.md", content: "目标内容" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillFileEditor skillId="skill-1" skillName="报告助手" canWrite />);
    fireEvent.click(await screen.findByRole("button", { name: "SKILL.md" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "文件内容" }), {
      target: { value: "未保存内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "notes.md" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并切换" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect((screen.getByRole("textbox", { name: "文件内容" }) as HTMLTextAreaElement).value).toBe(
      "目标内容",
    );
  });

  it("发布版本使用独立操作，并刷新版本信息", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({ data: { files: [] } }))
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        return jsonResponse({ data: { version: 2, commitSha: "abcdef123456" } });
      })
      .mockImplementationOnce(() => jsonResponse({ data: { files: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillFileEditor skillId="skill-1" skillName="报告助手" canWrite />);
    fireEvent.click(screen.getByRole("button", { name: "发布新版本" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/studio/api/skills/skill-1/versions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.getByRole("status").textContent).toContain("版本 2 已发布");
  });

  it("只读技能不展示保存与发布操作", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({ data: { files: ["SKILL.md"] } }))
      .mockImplementationOnce(() =>
        jsonResponse({ data: { path: "SKILL.md", content: "只读内容" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillFileEditor skillId="skill-1" skillName="报告助手" canWrite={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "SKILL.md" }));

    expect(await screen.findByRole("textbox", { name: "文件内容" })).toHaveProperty(
      "readOnly",
      true,
    );
    expect(screen.queryByRole("button", { name: "保存工作副本" })).toBeNull();
    expect(screen.queryByRole("button", { name: "发布新版本" })).toBeNull();
  });
});
