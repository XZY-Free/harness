import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PromptDiff, diffLines } from "./prompt-diff";

afterEach(cleanup);

describe("PromptDiff", () => {
  it("保留稳定的行级差异顺序", () => {
    expect(diffLines("第一行\n旧内容", "第一行\n新内容")).toEqual([
      { type: "same", text: "第一行" },
      { type: "del", text: "旧内容" },
      { type: "add", text: "新内容" },
    ]);
  });

  it("除颜色与符号外，为新增和删除内容提供可访问文本", () => {
    render(
      <PromptDiff
        versions={[
          { id: "v1", version: 1, promptTemplate: "第一行\n旧内容" },
          { id: "v2", version: 2, promptTemplate: "第一行\n新内容" },
        ]}
      />,
    );

    expect(screen.getByText("删除", { selector: ".sr-only" })).toBeTruthy();
    expect(screen.getByText("新增", { selector: ".sr-only" })).toBeTruthy();
    expect(screen.getByLabelText("较早版本")).toBeTruthy();
    expect(screen.getByLabelText("较新版本")).toBeTruthy();
  });
});
