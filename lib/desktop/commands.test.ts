import {
  ACTION_COMMANDS,
  ALLOWED_COMMANDS,
  type ActionCommand,
  type AllowedCommand,
  COMMAND_TO_TOOL,
  READ_COMMANDS,
  type ReadCommand,
  TOOL_TO_COMMAND,
  commandPayloadSchemas,
  isActionCommand,
  isAllowedCommand,
  isReadCommand,
  toolToCommand,
  validateCommandPayload,
} from "@/lib/desktop/commands";
import { describe, expect, it } from "vitest";

describe("READ_COMMANDS", () => {
  it("包含 Phase 6 读取命令集", () => {
    expect(READ_COMMANDS).toContain("browser.getTabs");
    expect(READ_COMMANDS).toContain("browser.getPageMetadata");
    expect(READ_COMMANDS).toContain("browser.screenshot");
    expect(READ_COMMANDS).toContain("browser.snapshot");
    expect(READ_COMMANDS).toContain("browser.getAccessibilityTree");
    expect(READ_COMMANDS).toContain("browser.getConsole");
    expect(READ_COMMANDS).toContain("browser.getNetwork");
  });

  it("所有命令为非空字符串", () => {
    for (const cmd of READ_COMMANDS) {
      expect(typeof cmd).toBe("string");
      expect(cmd.length).toBeGreaterThan(0);
    }
  });

  it("命令不重复", () => {
    const set = new Set<string>(READ_COMMANDS);
    expect(set.size).toBe(READ_COMMANDS.length);
  });
});

describe("ACTION_COMMANDS", () => {
  it("包含 Phase 6 操作命令集", () => {
    expect(ACTION_COMMANDS).toContain("browser.navigate");
    expect(ACTION_COMMANDS).toContain("browser.click");
    expect(ACTION_COMMANDS).toContain("browser.doubleClick");
    expect(ACTION_COMMANDS).toContain("browser.type");
    expect(ACTION_COMMANDS).toContain("browser.press");
    expect(ACTION_COMMANDS).toContain("browser.select");
    expect(ACTION_COMMANDS).toContain("browser.scroll");
    expect(ACTION_COMMANDS).toContain("browser.newTab");
    expect(ACTION_COMMANDS).toContain("browser.closeTab");
    expect(ACTION_COMMANDS).toContain("browser.switchTab");
    expect(ACTION_COMMANDS).toContain("browser.reload");
    expect(ACTION_COMMANDS).toContain("browser.goBack");
    expect(ACTION_COMMANDS).toContain("browser.goForward");
    expect(ACTION_COMMANDS).toContain("browser.uploadWorkspaceFile");
  });

  it("命令不重复", () => {
    const set = new Set<string>(ACTION_COMMANDS);
    expect(set.size).toBe(ACTION_COMMANDS.length);
  });
});

describe("ALLOWED_COMMANDS", () => {
  it("等于 READ_COMMANDS + ACTION_COMMANDS", () => {
    expect([...ALLOWED_COMMANDS]).toEqual([...READ_COMMANDS, ...ACTION_COMMANDS]);
  });

  it("读取类和操作类不重叠", () => {
    const readSet = new Set<string>(READ_COMMANDS);
    for (const cmd of ACTION_COMMANDS) {
      expect(readSet.has(cmd)).toBe(false);
    }
  });

  it("命令不重复", () => {
    const set = new Set<string>(ALLOWED_COMMANDS);
    expect(set.size).toBe(ALLOWED_COMMANDS.length);
  });
});

describe("TOOL_TO_COMMAND / COMMAND_TO_TOOL", () => {
  it("V9 工具名映射到 V10 命令名", () => {
    expect(TOOL_TO_COMMAND.browserGetTabs).toBe("browser.getTabs");
    expect(TOOL_TO_COMMAND.browserSnapshot).toBe("browser.snapshot");
    expect(TOOL_TO_COMMAND.browserGetConsole).toBe("browser.getConsole");
    expect(TOOL_TO_COMMAND.browserGetNetwork).toBe("browser.getNetwork");
    expect(TOOL_TO_COMMAND.browserScreenshot).toBe("browser.screenshot");
    expect(TOOL_TO_COMMAND.browserGetPageText).toBe("browser.getPageMetadata");
    expect(TOOL_TO_COMMAND.browserNavigate).toBe("browser.navigate");
    expect(TOOL_TO_COMMAND.browserClick).toBe("browser.click");
    expect(TOOL_TO_COMMAND.browserType).toBe("browser.type");
    expect(TOOL_TO_COMMAND.browserScroll).toBe("browser.scroll");
    expect(TOOL_TO_COMMAND.browserPressKey).toBe("browser.press");
    expect(TOOL_TO_COMMAND.browserSelectOption).toBe("browser.select");
    expect(TOOL_TO_COMMAND.browserUploadFile).toBe("browser.uploadWorkspaceFile");
  });

  it("反向映射一致", () => {
    for (const [tool, cmd] of Object.entries(TOOL_TO_COMMAND)) {
      expect(COMMAND_TO_TOOL[cmd as AllowedCommand]).toBe(tool);
    }
  });
});

describe("commandPayloadSchemas", () => {
  it("每个 ALLOWED_COMMANDS 都有对应 schema", () => {
    for (const cmd of ALLOWED_COMMANDS) {
      expect(commandPayloadSchemas[cmd]).toBeDefined();
    }
  });

  // ── 读取类 schema ──

  it("browser.getTabs schema 接受 { threadId }", () => {
    const schema = commandPayloadSchemas["browser.getTabs"];
    expect(schema.safeParse({ threadId: "t1" }).success).toBe(true);
  });

  it("browser.getTabs schema 拒绝缺少 threadId", () => {
    const schema = commandPayloadSchemas["browser.getTabs"];
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("browser.snapshot schema 接受 { threadId, tabId, maxTextLength? }", () => {
    const schema = commandPayloadSchemas["browser.snapshot"];
    expect(schema.safeParse({ threadId: "t1", tabId: "tab1" }).success).toBe(true);
    expect(schema.safeParse({ threadId: "t1", tabId: "tab1", maxTextLength: 2000 }).success).toBe(
      true,
    );
  });

  it("browser.snapshot schema 拒绝 maxTextLength > 10000", () => {
    const schema = commandPayloadSchemas["browser.snapshot"];
    expect(schema.safeParse({ threadId: "t1", tabId: "tab1", maxTextLength: 20000 }).success).toBe(
      false,
    );
  });

  it("browser.getConsole schema 限制 limit ≤ 200", () => {
    const schema = commandPayloadSchemas["browser.getConsole"];
    expect(schema.safeParse({ threadId: "t1", tabId: "tab1", limit: 200 }).success).toBe(true);
    expect(schema.safeParse({ threadId: "t1", tabId: "tab1", limit: 201 }).success).toBe(false);
  });

  it("browser.getNetwork schema 接受 filter 可选", () => {
    const schema = commandPayloadSchemas["browser.getNetwork"];
    expect(schema.safeParse({ threadId: "t1", tabId: "tab1" }).success).toBe(true);
    expect(schema.safeParse({ threadId: "t1", tabId: "tab1", filter: "failed" }).success).toBe(
      true,
    );
    expect(schema.safeParse({ threadId: "t1", tabId: "tab1", filter: "invalid" }).success).toBe(
      false,
    );
  });

  // ── 操作类 schema ──

  it("browser.navigate schema 接受 { threadId, tabId, url }", () => {
    const schema = commandPayloadSchemas["browser.navigate"];
    expect(
      schema.safeParse({ threadId: "t1", tabId: "tab1", url: "https://example.com" }).success,
    ).toBe(true);
  });

  it("browser.navigate schema 拒绝缺少 url", () => {
    const schema = commandPayloadSchemas["browser.navigate"];
    expect(schema.safeParse({ threadId: "t1", tabId: "tab1" }).success).toBe(false);
  });

  it("browser.click schema 接受 x/y + 可选 button/description", () => {
    const schema = commandPayloadSchemas["browser.click"];
    expect(schema.safeParse({ threadId: "t1", tabId: "tab1", x: 100, y: 200 }).success).toBe(true);
    expect(
      schema.safeParse({
        threadId: "t1",
        tabId: "tab1",
        x: 100,
        y: 200,
        button: "right",
        description: "点击删除",
      }).success,
    ).toBe(true);
  });

  it("browser.click schema 拒绝无效 button", () => {
    const schema = commandPayloadSchemas["browser.click"];
    expect(
      schema.safeParse({ threadId: "t1", tabId: "tab1", x: 0, y: 0, button: "invalid" }).success,
    ).toBe(false);
  });

  it("browser.type schema 接受 text + 可选 selector", () => {
    const schema = commandPayloadSchemas["browser.type"];
    expect(schema.safeParse({ threadId: "t1", tabId: "tab1", text: "hello" }).success).toBe(true);
    expect(
      schema.safeParse({ threadId: "t1", tabId: "tab1", text: "hello", selector: "#input" })
        .success,
    ).toBe(true);
  });

  it("browser.newTab schema 接受 { threadId, url }", () => {
    const schema = commandPayloadSchemas["browser.newTab"];
    expect(schema.safeParse({ threadId: "t1", url: "https://example.com" }).success).toBe(true);
  });

  it("browser.uploadWorkspaceFile schema 要求 selector + downloadUrl", () => {
    const schema = commandPayloadSchemas["browser.uploadWorkspaceFile"];
    expect(
      schema.safeParse({
        threadId: "t1",
        tabId: "tab1",
        selector: "input[type=file]",
        downloadUrl: "http://localhost:3000/api/threads/t1/workspace/download?token=abc",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ threadId: "t1", tabId: "tab1", selector: "input[type=file]" }).success,
    ).toBe(false);
  });
});

describe("isAllowedCommand", () => {
  it("已知命令返回 true", () => {
    expect(isAllowedCommand("browser.getTabs")).toBe(true);
    expect(isAllowedCommand("browser.navigate")).toBe(true);
    expect(isAllowedCommand("browser.uploadWorkspaceFile")).toBe(true);
  });

  it("未知命令返回 false", () => {
    expect(isAllowedCommand("browser.evaluateArbitraryJavaScript")).toBe(false);
    expect(isAllowedCommand("browser.readCookies")).toBe(false);
    expect(isAllowedCommand("unknown")).toBe(false);
    expect(isAllowedCommand("")).toBe(false);
  });
});

describe("isReadCommand / isActionCommand", () => {
  it("isReadCommand 对读取类返回 true", () => {
    expect(isReadCommand("browser.getTabs")).toBe(true);
    expect(isReadCommand("browser.snapshot")).toBe(true);
    expect(isReadCommand("browser.screenshot")).toBe(true);
  });

  it("isReadCommand 对操作类返回 false", () => {
    expect(isReadCommand("browser.navigate")).toBe(false);
    expect(isReadCommand("browser.click")).toBe(false);
  });

  it("isActionCommand 对操作类返回 true", () => {
    expect(isActionCommand("browser.navigate")).toBe(true);
    expect(isActionCommand("browser.click")).toBe(true);
    expect(isActionCommand("browser.uploadWorkspaceFile")).toBe(true);
  });

  it("isActionCommand 对读取类返回 false", () => {
    expect(isActionCommand("browser.getTabs")).toBe(false);
    expect(isActionCommand("browser.snapshot")).toBe(false);
  });
});

describe("toolToCommand", () => {
  it("V9 工具名映射到 V10 命令名", () => {
    expect(toolToCommand("browserGetTabs")).toBe("browser.getTabs");
    expect(toolToCommand("browserNavigate")).toBe("browser.navigate");
    expect(toolToCommand("browserClick")).toBe("browser.click");
  });

  it("未知工具名返回 null", () => {
    expect(toolToCommand("unknownTool")).toBeNull();
  });
});

describe("validateCommandPayload", () => {
  it("合法 payload 返回 ok + 解析后的 payload", () => {
    const result = validateCommandPayload("browser.getTabs", { threadId: "t1" });
    expect(result.ok).toBe(true);
  });

  it("未知命令返回 unknown_command", () => {
    const result = validateCommandPayload("browser.unknown", { threadId: "t1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unknown_command");
    }
  });

  it("非法 payload 返回 invalid_payload", () => {
    const result = validateCommandPayload("browser.getTabs", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_payload");
    }
  });

  it("禁止的命令 browser.evaluateArbitraryJavaScript 返回 unknown_command", () => {
    const result = validateCommandPayload("browser.evaluateArbitraryJavaScript", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unknown_command");
    }
  });

  it("禁止的命令 browser.readCookies 返回 unknown_command", () => {
    const result = validateCommandPayload("browser.readCookies", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unknown_command");
    }
  });

  it("禁止的命令 browser.readAuthorizationHeader 返回 unknown_command", () => {
    const result = validateCommandPayload("browser.readAuthorizationHeader", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unknown_command");
    }
  });
});
