import { describe, expect, it } from "vitest";
import {
  type BrowserNavAction,
  MAX_URL_LENGTH,
  isValidNavUrl,
  normalizeUrl,
  validateNavAction,
} from "./nav-actions";

/**
 * V10 Phase 4：导航操作命令单元测试。
 *
 * 覆盖：
 * - isValidNavUrl：http/https、协议白名单、长度、类型校验
 * - validateNavAction：navigate/back/forward/reload/stop 校验与字段检查
 * - normalizeUrl：补全协议、trim、无法标准化的输入
 */

describe("nav-actions isValidNavUrl (V10 Phase 4)", () => {
  it("http URL 返回 true", () => {
    expect(isValidNavUrl("http://example.com")).toBe(true);
  });

  it("https URL 返回 true", () => {
    expect(isValidNavUrl("https://example.com")).toBe(true);
  });

  it("空字符串返回 false", () => {
    expect(isValidNavUrl("")).toBe(false);
  });

  it("非字符串返回 false（number）", () => {
    expect(isValidNavUrl(42)).toBe(false);
  });

  it("非字符串返回 false（null）", () => {
    expect(isValidNavUrl(null)).toBe(false);
  });

  it("非字符串返回 false（undefined）", () => {
    expect(isValidNavUrl(undefined)).toBe(false);
  });

  it("非字符串返回 false（object）", () => {
    expect(isValidNavUrl({ url: "https://example.com" })).toBe(false);
  });

  it("file URL 返回 false", () => {
    expect(isValidNavUrl("file:///etc/passwd")).toBe(false);
  });

  it("data URL 返回 false", () => {
    expect(isValidNavUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("blob URL 返回 false", () => {
    expect(isValidNavUrl("blob:https://example.com/abc-123")).toBe(false);
  });

  it("javascript URL 返回 false", () => {
    expect(isValidNavUrl("javascript:alert(1)")).toBe(false);
  });

  it("无效 URL（无协议）返回 false", () => {
    expect(isValidNavUrl("example.com")).toBe(false);
  });

  it("无效 URL（纯文本）返回 false", () => {
    expect(isValidNavUrl("not a url at all")).toBe(false);
  });

  it(`超长 URL（> MAX_URL_LENGTH = ${MAX_URL_LENGTH}）返回 false`, () => {
    const longUrl = `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`;
    expect(longUrl.length).toBeGreaterThan(MAX_URL_LENGTH);
    expect(isValidNavUrl(longUrl)).toBe(false);
  });

  it("长度正好等于 MAX_URL_LENGTH 的 URL 返回 true", () => {
    // 构造一个长度正好为 MAX_URL_LENGTH 的合法 https URL
    const base = "https://example.com/";
    const padding = "a".repeat(MAX_URL_LENGTH - base.length);
    const exact = base + padding;
    expect(exact.length).toBe(MAX_URL_LENGTH);
    expect(isValidNavUrl(exact)).toBe(true);
  });

  it("localhost URL 返回 true", () => {
    expect(isValidNavUrl("http://localhost")).toBe(true);
  });

  it("https://localhost 返回 true", () => {
    expect(isValidNavUrl("https://localhost")).toBe(true);
  });

  it("带端口的 URL 返回 true", () => {
    expect(isValidNavUrl("http://example.com:8080")).toBe(true);
  });

  it("带路径的 URL 返回 true", () => {
    expect(isValidNavUrl("https://example.com/path/to/page")).toBe(true);
  });

  it("带查询参数的 URL 返回 true", () => {
    expect(isValidNavUrl("https://example.com/search?q=hello&page=2")).toBe(true);
  });

  it("带 fragment 的 URL 返回 true", () => {
    expect(isValidNavUrl("https://example.com/page#section")).toBe(true);
  });

  it("大写 HTTPS 协议的 URL 返回 true（URL 协议不区分大小写）", () => {
    expect(isValidNavUrl("HTTPS://example.com")).toBe(true);
  });
});

describe("nav-actions validateNavAction (V10 Phase 4)", () => {
  it("navigate 命令带有效 URL 返回 ok + action", () => {
    const result = validateNavAction({
      type: "navigate",
      threadId: "thread-1",
      tabId: "tab-1",
      url: "https://example.com",
    });
    expect(result.ok).toBe(true);
    expect(result.action).toEqual({
      type: "navigate",
      threadId: "thread-1",
      tabId: "tab-1",
      url: "https://example.com",
    });
    expect(result.error).toBeUndefined();
  });

  it("navigate 命令带 http URL 返回 ok + action", () => {
    const result = validateNavAction({
      type: "navigate",
      threadId: "thread-1",
      tabId: "tab-1",
      url: "http://example.com",
    });
    expect(result.ok).toBe(true);
    expect(result.action?.type).toBe("navigate");
  });

  it("navigate 命令带无效 URL（file 协议）返回 error", () => {
    const result = validateNavAction({
      type: "navigate",
      threadId: "thread-1",
      tabId: "tab-1",
      url: "file:///etc/passwd",
    });
    expect(result.ok).toBe(false);
    expect(result.action).toBeUndefined();
    expect(result.error).toContain("URL");
  });

  it("navigate 命令带无效 URL（javascript 协议）返回 error", () => {
    const result = validateNavAction({
      type: "navigate",
      threadId: "thread-1",
      tabId: "tab-1",
      url: "javascript:alert(1)",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("URL");
  });

  it("navigate 命令缺少 url 字段返回 error", () => {
    const result = validateNavAction({
      type: "navigate",
      threadId: "thread-1",
      tabId: "tab-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("URL");
  });

  it("navigate 命令 url 为空字符串返回 error", () => {
    const result = validateNavAction({
      type: "navigate",
      threadId: "thread-1",
      tabId: "tab-1",
      url: "",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("URL");
  });

  it("navigate 命令 url 非字符串返回 error", () => {
    const result = validateNavAction({
      type: "navigate",
      threadId: "thread-1",
      tabId: "tab-1",
      url: 42,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("URL");
  });

  it("back 命令返回 ok + action", () => {
    const result = validateNavAction({
      type: "back",
      threadId: "thread-1",
      tabId: "tab-1",
    });
    expect(result.ok).toBe(true);
    expect(result.action).toEqual({
      type: "back",
      threadId: "thread-1",
      tabId: "tab-1",
    });
  });

  it("forward 命令返回 ok + action", () => {
    const result = validateNavAction({
      type: "forward",
      threadId: "thread-1",
      tabId: "tab-1",
    });
    expect(result.ok).toBe(true);
    expect(result.action?.type).toBe("forward");
  });

  it("reload 命令返回 ok + action", () => {
    const result = validateNavAction({
      type: "reload",
      threadId: "thread-1",
      tabId: "tab-1",
    });
    expect(result.ok).toBe(true);
    expect(result.action?.type).toBe("reload");
  });

  it("stop 命令返回 ok + action", () => {
    const result = validateNavAction({
      type: "stop",
      threadId: "thread-1",
      tabId: "tab-1",
    });
    expect(result.ok).toBe(true);
    expect(result.action?.type).toBe("stop");
  });

  it("back/forward/reload/stop 命令忽略多余 url 字段", () => {
    const result = validateNavAction({
      type: "reload",
      threadId: "thread-1",
      tabId: "tab-1",
      url: "should-be-ignored",
    });
    expect(result.ok).toBe(true);
    expect(result.action).toEqual({
      type: "reload",
      threadId: "thread-1",
      tabId: "tab-1",
    });
  });

  it("缺少 type 返回 error", () => {
    const result = validateNavAction({
      threadId: "thread-1",
      tabId: "tab-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("type");
  });

  it("type 为非字符串返回 error", () => {
    const result = validateNavAction({
      type: 42,
      threadId: "thread-1",
      tabId: "tab-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("type");
  });

  it("无效 type 返回 error", () => {
    const result = validateNavAction({
      type: "invalid",
      threadId: "thread-1",
      tabId: "tab-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("type");
  });

  it("缺少 threadId 返回 error", () => {
    const result = validateNavAction({
      type: "back",
      tabId: "tab-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("threadId");
  });

  it("空 threadId 返回 error", () => {
    const result = validateNavAction({
      type: "back",
      threadId: "",
      tabId: "tab-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("threadId");
  });

  it("threadId 非字符串返回 error", () => {
    const result = validateNavAction({
      type: "back",
      threadId: 42,
      tabId: "tab-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("threadId");
  });

  it("缺少 tabId 返回 error", () => {
    const result = validateNavAction({
      type: "back",
      threadId: "thread-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("tabId");
  });

  it("空 tabId 返回 error", () => {
    const result = validateNavAction({
      type: "back",
      threadId: "thread-1",
      tabId: "",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("tabId");
  });

  it("tabId 非字符串返回 error", () => {
    const result = validateNavAction({
      type: "back",
      threadId: "thread-1",
      tabId: 42,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("tabId");
  });

  it("null 输入返回 error", () => {
    const result = validateNavAction(null);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("对象");
  });

  it("undefined 输入返回 error", () => {
    const result = validateNavAction(undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("对象");
  });

  it("字符串输入返回 error（非对象）", () => {
    const result = validateNavAction("not an object");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("对象");
  });

  it("number 输入返回 error（非对象）", () => {
    const result = validateNavAction(42);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("对象");
  });

  it("数组输入返回 error（type 缺失）", () => {
    const result = validateNavAction(["navigate", "thread-1", "tab-1"]);
    expect(result.ok).toBe(false);
  });

  it("额外字段不影响校验", () => {
    const result = validateNavAction({
      type: "back",
      threadId: "thread-1",
      tabId: "tab-1",
      extra: "ignored",
    });
    expect(result.ok).toBe(true);
    expect(result.action).toEqual({
      type: "back",
      threadId: "thread-1",
      tabId: "tab-1",
    });
  });

  it("navigate 命令返回的 action 类型为 NavigateAction", () => {
    const result = validateNavAction({
      type: "navigate",
      threadId: "thread-1",
      tabId: "tab-1",
      url: "https://example.com",
    });
    expect(result.ok).toBe(true);
    const action = result.action as BrowserNavAction;
    expect(action.type).toBe("navigate");
    if (action.type === "navigate") {
      expect(action.url).toBe("https://example.com");
    }
  });
});

describe("nav-actions normalizeUrl (V10 Phase 4)", () => {
  it('"example.com" → "https://example.com"', () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
  });

  it('"http://example.com" → "http://example.com"（保持不变）', () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
  });

  it('"https://example.com" → "https://example.com"（保持不变）', () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });

  it('"  example.com  " → "https://example.com"（trim 空白）', () => {
    expect(normalizeUrl("  example.com  ")).toBe("https://example.com");
  });

  it("空字符串返回 null", () => {
    expect(normalizeUrl("")).toBeNull();
  });

  it("只有空格返回 null", () => {
    expect(normalizeUrl("    ")).toBeNull();
  });

  it('"localhost:3000" → "https://localhost:3000"', () => {
    expect(normalizeUrl("localhost:3000")).toBe("https://localhost:3000");
  });

  it('"example.com/path?q=1" → "https://example.com/path?q=1"', () => {
    expect(normalizeUrl("example.com/path?q=1")).toBe("https://example.com/path?q=1");
  });

  it('"HTTP://example.com" → "HTTP://example.com"（大写协议保持不变）', () => {
    expect(normalizeUrl("HTTP://example.com")).toBe("HTTP://example.com");
  });

  it('"https://EXAMPLE.com" → "https://EXAMPLE.com"（大写主机保持不变）', () => {
    expect(normalizeUrl("https://EXAMPLE.com")).toBe("https://EXAMPLE.com");
  });

  it('"javascript:alert(1)" 返回 null（不安全协议）', () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });

  it('"data:text/html,<x>" 返回 null（不允许 data 协议）', () => {
    expect(normalizeUrl("data:text/html,<x>")).toBeNull();
  });

  it('"  https://example.com  " → "https://example.com"（带空白的 https URL）', () => {
    expect(normalizeUrl("  https://example.com  ")).toBe("https://example.com");
  });

  it('"example.com:8080" → "https://example.com:8080"（带端口的无协议 URL）', () => {
    expect(normalizeUrl("example.com:8080")).toBe("https://example.com:8080");
  });

  it('"not a url with spaces" 返回 null（无法标准化）', () => {
    // "not a url with spaces" 补全 https:// 后是非法 URL（含空格）
    expect(normalizeUrl("not a url with spaces")).toBeNull();
  });
});
