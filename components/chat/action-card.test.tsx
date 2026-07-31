import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * V5-C1：ActionCard 测试。
 *
 * 覆盖：
 * - writeFile 成功 → 渲染「查看文件」按钮，点击上抛 { kind: "file", path }
 * - readFile 成功 → 同上
 * - reportReady 成功（output.url）→ 渲染「打开运行页」按钮，点击上抛 { kind: "app" }（V9 阶段 5）
 * - startPreview 成功 → 同上
 * - 失败工具（output.ok=false）→ 不渲染查看按钮
 * - 无 onOpenWorkspace 回调 → 不渲染按钮
 * - 未识别工具（runCommand 等）→ 不渲染按钮
 * - output 无 path/url → 不渲染按钮
 */

vi.mock("@/lib/i18n", () => ({ toolLabel: (name: string) => name }));

import { ActionCard } from "./action-card";

afterEach(() => {
  cleanup();
});

describe("ActionCard V5-C1 查看产物入口", () => {
  it("writeFile 成功 → 渲染查看文件按钮，点击上抛 file 视图", () => {
    const onOpen = vi.fn();
    render(
      <ActionCard
        type="tool-writeFile"
        part={{ output: { ok: true, path: "src/app.js", bytes: 14 } }}
        onOpenWorkspace={onOpen}
      />,
    );
    const btn = screen.getByRole("button", { name: "查看文件" });
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledWith({ kind: "file", path: "src/app.js" });
  });

  it("readFile 成功 → 渲染查看文件按钮", () => {
    const onOpen = vi.fn();
    render(
      <ActionCard
        type="tool-readFile"
        part={{ output: { ok: true, path: "README.md", content: "# hi" } }}
        onOpenWorkspace={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看文件" }));
    expect(onOpen).toHaveBeenCalledWith({ kind: "file", path: "README.md" });
  });

  it("reportReady 成功 → 渲染打开运行页按钮，点击上抛 app 视图（V9 阶段 5）", () => {
    const onOpen = vi.fn();
    render(
      <ActionCard
        type="tool-reportReady"
        part={{ output: { ok: true, url: "/preview/t1/", summary: "完成" } }}
        onOpenWorkspace={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开运行页" }));
    expect(onOpen).toHaveBeenCalledWith({ kind: "app" });
  });

  it("startPreview 成功 → 渲染打开运行页按钮", () => {
    const onOpen = vi.fn();
    render(
      <ActionCard
        type="tool-startPreview"
        part={{ output: { ok: true, url: "/preview/t1/", port: 3001, kind: "static" } }}
        onOpenWorkspace={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开运行页" }));
    expect(onOpen).toHaveBeenCalledWith({ kind: "app" });
  });

  it("失败工具 → 不渲染查看按钮（output.ok=false）", () => {
    const onOpen = vi.fn();
    render(
      <ActionCard
        type="tool-writeFile"
        part={{ output: { ok: false, path: "x.txt", error: "disk full" } }}
        onOpenWorkspace={onOpen}
      />,
    );
    expect(screen.queryByRole("button", { name: /查看/ })).toBeNull();
  });

  it("V5-C2: 失败工具不展示 output.error 原文（含 stdout/stderr/路径）", () => {
    render(
      <ActionCard
        type="tool-runCommand"
        part={{
          input: { command: "rm -rf /" },
          output: {
            ok: false,
            error:
              "Command failed: rm -rf /\nstderr: Permission denied\nat /internal/path/runCommand.ts:42",
          },
        }}
      />,
    );
    // 不应出现原始 error / command / stderr / 内部路径
    expect(screen.queryByText(/rm -rf/)).toBeNull();
    expect(screen.queryByText(/stderr/)).toBeNull();
    expect(screen.queryByText(/Permission denied/)).toBeNull();
    expect(screen.queryByText(/internal\/path/)).toBeNull();
    // 应显示员工可读摘要
    expect(screen.getByText("命令执行失败")).not.toBeNull();
  });

  it("V5-C2: writeFile 失败显示「文件写入失败」摘要", () => {
    render(
      <ActionCard
        type="tool-writeFile"
        part={{ output: { ok: false, path: "src/app.js", error: "EACCES" } }}
      />,
    );
    expect(screen.getByText("文件写入失败")).not.toBeNull();
    expect(screen.queryByText("EACCES")).toBeNull();
  });

  it("V5-C2: reportReady 失败显示「预览自检未通过」摘要", () => {
    render(
      <ActionCard
        type="tool-reportReady"
        part={{ output: { ok: false, error: "QA gate failed: 白屏 detected" } }}
      />,
    );
    expect(screen.getByText("预览自检未通过")).not.toBeNull();
    expect(screen.queryByText(/QA gate/)).toBeNull();
    expect(screen.queryByText(/白屏/)).toBeNull();
  });

  it("V5-C2: 未识别工具失败 → 默认「执行失败」摘要", () => {
    render(
      <ActionCard
        type="tool-unknownTool"
        part={{ output: { ok: false, error: "internal stack trace" } }}
      />,
    );
    expect(screen.getByText("执行失败")).not.toBeNull();
    expect(screen.queryByText(/internal stack trace/)).toBeNull();
  });

  it("V5-C2: 失败工具隐藏 input.command（可能含 token/凭据）", () => {
    render(
      <ActionCard
        type="tool-runCommand"
        part={{
          input: { command: "curl -H 'Authorization: Bearer secret-token' http://internal/api" },
          output: { ok: false, error: "exit 1" },
        }}
      />,
    );
    expect(screen.queryByText(/secret-token/)).toBeNull();
    expect(screen.queryByText(/Bearer/)).toBeNull();
    expect(screen.getByText("命令执行失败")).not.toBeNull();
  });

  it("V5-C2: 失败工具仍显示文件路径（员工自己会话的路径不算敏感）", () => {
    render(
      <ActionCard
        type="tool-writeFile"
        part={{ input: { path: "src/app.js" }, output: { ok: false, error: "disk full" } }}
      />,
    );
    expect(screen.getByText("src/app.js")).not.toBeNull();
    expect(screen.getByText("文件写入失败")).not.toBeNull();
  });

  it("未提供 onOpenWorkspace → 不渲染按钮（即使工具成功）", () => {
    render(
      <ActionCard
        type="tool-writeFile"
        part={{ output: { ok: true, path: "src/app.js", bytes: 14 } }}
      />,
    );
    expect(screen.queryByRole("button", { name: /查看/ })).toBeNull();
  });

  it("未识别工具（runCommand 等）→ 不渲染查看按钮", () => {
    const onOpen = vi.fn();
    render(
      <ActionCard
        type="tool-runCommand"
        part={{ output: { ok: true, exitCode: 0, stdout: "ok" } }}
        onOpenWorkspace={onOpen}
      />,
    );
    expect(screen.queryByRole("button", { name: /查看/ })).toBeNull();
  });

  it("V5 收口: 成功命令工具也不展示 input.command（可能含 token/凭据）", () => {
    render(
      <ActionCard
        type="tool-runCommand"
        part={{
          input: { command: "curl -H 'Authorization: Bearer secret-token' http://internal/api" },
          output: { ok: true, exitCode: 0, stdout: "ok" },
        }}
      />,
    );
    expect(screen.queryByText(/secret-token/)).toBeNull();
    expect(screen.queryByText(/Authorization/)).toBeNull();
    expect(screen.queryByText(/curl/)).toBeNull();
  });

  it("writeFile output.path 非字符串 → 不渲染按钮（防御）", () => {
    const onOpen = vi.fn();
    render(
      <ActionCard
        type="tool-writeFile"
        part={{ output: { ok: true, path: 123 } }}
        onOpenWorkspace={onOpen}
      />,
    );
    expect(screen.queryByRole("button", { name: /查看/ })).toBeNull();
  });

  it("reportReady output 缺失 → 不渲染按钮", () => {
    const onOpen = vi.fn();
    render(<ActionCard type="tool-reportReady" part={{ output: null }} onOpenWorkspace={onOpen} />);
    expect(screen.queryByRole("button", { name: /查看/ })).toBeNull();
  });
});
