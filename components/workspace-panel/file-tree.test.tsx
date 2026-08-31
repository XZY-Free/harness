import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FILE_TREE_REFRESH_MS, FileTree } from "./file-tree";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FileTree 工作区同步", () => {
  it("面板打开后自动发现后续写入，并保留可折叠目录", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount += 1;
      const files = callCount === 1 ? ["index.html"] : ["index.html", "css/style.css", "js/app.js"];
      return {
        ok: true,
        json: async () => ({ ok: true, data: { threadId: "t1", files } }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<FileTree threadId="t1" selectedPath="index.html" onSelectPath={vi.fn()} />);

    expect(await screen.findByText("index.html")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("style.css")).toBeTruthy(), {
      timeout: FILE_TREE_REFRESH_MS + 1500,
    });
    expect(screen.getByText("app.js")).toBeTruthy();

    const cssFolder = screen.getByRole("button", { name: "css" });
    expect(cssFolder.getAttribute("aria-expanded")).toBe("true");
    expect(cssFolder.querySelector(".lucide-folder-open")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "index.html" }).querySelector(".lucide-file-code-corner"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "style.css" }).querySelector(".lucide-file-code-corner"),
    ).not.toBeNull();
    fireEvent.click(cssFolder);
    await waitFor(() => expect(cssFolder.getAttribute("aria-expanded")).toBe("false"));
    expect(cssFolder.querySelector(".lucide-folder")).not.toBeNull();
    expect(screen.queryByText("style.css")).toBeNull();
  });
});
