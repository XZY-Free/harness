import {
  type ConsoleEntry,
  DEFAULT_LIMITS,
  type NetworkEntry,
  type RedactedFormField,
  SENSITIVE_FIELD_NAMES,
  SENSITIVE_HEADERS,
  isSensitiveFieldName,
  isSensitiveHeader,
  redactCommandResult,
  redactFormField,
  sanitizeConsoleEntry,
  sanitizeDomSummary,
  sanitizeHeaders,
  sanitizeNetworkEntry,
  sanitizeUrl,
  truncateEntries,
  truncateText,
} from "@/lib/desktop/redaction";
import { describe, expect, it } from "vitest";

describe("DEFAULT_LIMITS", () => {
  it("暴露规格默认上限", () => {
    expect(DEFAULT_LIMITS.maxTextLength).toBe(2000);
    expect(DEFAULT_LIMITS.maxPageTextLength).toBe(5000);
    expect(DEFAULT_LIMITS.maxConsoleEntries).toBe(50);
    expect(DEFAULT_LIMITS.maxNetworkEntries).toBe(50);
    expect(DEFAULT_LIMITS.maxDomBytes).toBe(50000);
  });
});

describe("SENSITIVE_FIELD_NAMES / SENSITIVE_HEADERS", () => {
  it("包含规格要求的敏感字段名", () => {
    expect(SENSITIVE_FIELD_NAMES).toContain("password");
    expect(SENSITIVE_FIELD_NAMES).toContain("passwd");
    expect(SENSITIVE_FIELD_NAMES).toContain("pwd");
    expect(SENSITIVE_FIELD_NAMES).toContain("secret");
    expect(SENSITIVE_FIELD_NAMES).toContain("token");
    expect(SENSITIVE_FIELD_NAMES).toContain("authorization");
    expect(SENSITIVE_FIELD_NAMES).toContain("auth");
    expect(SENSITIVE_FIELD_NAMES).toContain("apikey");
    expect(SENSITIVE_FIELD_NAMES).toContain("api_key");
    expect(SENSITIVE_FIELD_NAMES).toContain("creditcard");
    expect(SENSITIVE_FIELD_NAMES).toContain("cardnumber");
    expect(SENSITIVE_FIELD_NAMES).toContain("cvv");
    expect(SENSITIVE_FIELD_NAMES).toContain("cvc");
  });

  it("包含规格要求的敏感响应头", () => {
    expect(SENSITIVE_HEADERS).toContain("set-cookie");
    expect(SENSITIVE_HEADERS).toContain("authorization");
    expect(SENSITIVE_HEADERS).toContain("cookie");
    expect(SENSITIVE_HEADERS).toContain("proxy-authorization");
    expect(SENSITIVE_HEADERS).toContain("x-api-key");
    expect(SENSITIVE_HEADERS).toContain("x-auth-token");
  });
});

describe("isSensitiveFieldName", () => {
  it("匹配 password/passwd/pwd/secret/token/authorization/auth/apikey/api_key/creditcard/cardnumber/cvv/cvc", () => {
    expect(isSensitiveFieldName("password")).toBe(true);
    expect(isSensitiveFieldName("passwd")).toBe(true);
    expect(isSensitiveFieldName("pwd")).toBe(true);
    expect(isSensitiveFieldName("secret")).toBe(true);
    expect(isSensitiveFieldName("token")).toBe(true);
    expect(isSensitiveFieldName("authorization")).toBe(true);
    expect(isSensitiveFieldName("auth")).toBe(true);
    expect(isSensitiveFieldName("apikey")).toBe(true);
    expect(isSensitiveFieldName("api_key")).toBe(true);
    expect(isSensitiveFieldName("creditcard")).toBe(true);
    expect(isSensitiveFieldName("cardnumber")).toBe(true);
    expect(isSensitiveFieldName("cvv")).toBe(true);
    expect(isSensitiveFieldName("cvc")).toBe(true);
  });

  it("不区分大小写", () => {
    expect(isSensitiveFieldName("PASSWORD")).toBe(true);
    expect(isSensitiveFieldName("Token")).toBe(true);
    expect(isSensitiveFieldName("Api-Key")).toBe(false); // 不是子串
    expect(isSensitiveFieldName("APIKEY")).toBe(true);
  });

  it("匹配包含敏感关键词的字段名（user_password、apiKey 等）", () => {
    expect(isSensitiveFieldName("user_password")).toBe(true);
    expect(isSensitiveFieldName("oldToken")).toBe(true);
    expect(isSensitiveFieldName("api_key_id")).toBe(true);
    expect(isSensitiveFieldName("creditCardNumber")).toBe(true);
    expect(isSensitiveFieldName("Authorization-Header")).toBe(true);
  });

  it("不匹配 name/email/username/title", () => {
    expect(isSensitiveFieldName("name")).toBe(false);
    expect(isSensitiveFieldName("email")).toBe(false);
    expect(isSensitiveFieldName("username")).toBe(false);
    expect(isSensitiveFieldName("title")).toBe(false);
  });

  it("空字符串返回 false", () => {
    expect(isSensitiveFieldName("")).toBe(false);
  });
});

describe("isSensitiveHeader", () => {
  it("匹配 set-cookie/authorization/cookie/proxy-authorization/x-api-key/x-auth-token", () => {
    expect(isSensitiveHeader("set-cookie")).toBe(true);
    expect(isSensitiveHeader("authorization")).toBe(true);
    expect(isSensitiveHeader("cookie")).toBe(true);
    expect(isSensitiveHeader("proxy-authorization")).toBe(true);
    expect(isSensitiveHeader("x-api-key")).toBe(true);
    expect(isSensitiveHeader("x-auth-token")).toBe(true);
  });

  it("不区分大小写", () => {
    expect(isSensitiveHeader("Set-Cookie")).toBe(true);
    expect(isSensitiveHeader("Authorization")).toBe(true);
    expect(isSensitiveHeader("COOKIE")).toBe(true);
  });

  it("不匹配 content-type/content-length/accept", () => {
    expect(isSensitiveHeader("content-type")).toBe(false);
    expect(isSensitiveHeader("content-length")).toBe(false);
    expect(isSensitiveHeader("accept")).toBe(false);
  });

  it("空字符串返回 false", () => {
    expect(isSensitiveHeader("")).toBe(false);
  });
});

describe("redactFormField", () => {
  it("返回 { name, type, value: '[REDACTED]' }", () => {
    const redacted = redactFormField("password", "password", "super-secret-value");
    expect(redacted.name).toBe("password");
    expect(redacted.type).toBe("password");
    expect(redacted.value).toBe("[REDACTED]");
  });

  it("无论 value 是什么类型都返回固定 [REDACTED]", () => {
    expect(redactFormField("token", "text", "abc123").value).toBe("[REDACTED]");
    expect(redactFormField("cvv", "text", 123).value).toBe("[REDACTED]");
    expect(redactFormField("creditcard", "text", null).value).toBe("[REDACTED]");
    expect(redactFormField("creditcard", "text", undefined).value).toBe("[REDACTED]");
    expect(redactFormField("creditcard", "text", { nested: "value" }).value).toBe("[REDACTED]");
  });

  it("即使非敏感字段也被脱敏（函数不区分字段名，调用方判断）", () => {
    const redacted: RedactedFormField = redactFormField("username", "text", "alice");
    expect(redacted.value).toBe("[REDACTED]");
    expect(redacted.type).toBe("text");
  });

  it("保留传入的 type 字段", () => {
    expect(redactFormField("password", "password", "x").type).toBe("password");
    expect(redactFormField("email", "email", "x@y.z").type).toBe("email");
    expect(redactFormField("otp", "text", "123456").type).toBe("text");
  });
});

describe("truncateText", () => {
  it("短于 maxLength 原样返回", () => {
    expect(truncateText("hello", 10)).toBe("hello");
    expect(truncateText("hi", 100)).toBe("hi");
  });

  it("等于 maxLength 原样返回（不截断）", () => {
    expect(truncateText("hello", 5)).toBe("hello");
  });

  it("超出 maxLength 截断并加 ...", () => {
    const result = truncateText("abcdefghij", 5);
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("截断后总长度不超过 maxLength", () => {
    const result = truncateText("a".repeat(100), 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith("...")).toBe(true);
  });

  it("空字符串原样返回", () => {
    expect(truncateText("", 10)).toBe("");
  });

  it("maxLength 为 0 时返回空字符串", () => {
    expect(truncateText("hello", 0)).toBe("");
  });

  it("maxLength 小于 3 时不超出 maxLength", () => {
    expect(truncateText("hello", 2).length).toBeLessThanOrEqual(2);
    expect(truncateText("hello", 1).length).toBeLessThanOrEqual(1);
  });
});

describe("truncateEntries", () => {
  it("少于 maxEntries 原样返回", () => {
    expect(truncateEntries([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it("等于 maxEntries 原样返回", () => {
    expect(truncateEntries([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it("超出 maxEntries 截断到 maxEntries", () => {
    expect(truncateEntries([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
    expect(
      truncateEntries(
        Array.from({ length: 100 }, (_, i) => i),
        10,
      ),
    ).toHaveLength(10);
  });

  it("空数组返回空数组", () => {
    expect(truncateEntries([], 10)).toEqual([]);
  });

  it("maxEntries 为 0 返回空数组", () => {
    expect(truncateEntries([1, 2, 3], 0)).toEqual([]);
  });

  it("保留对象引用和顺序", () => {
    const a = { id: 1 };
    const b = { id: 2 };
    const c = { id: 3 };
    const result = truncateEntries([a, b, c], 2);
    expect(result).toEqual([a, b]);
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(b);
  });
});

describe("sanitizeHeaders", () => {
  it("移除 set-cookie/authorization/cookie，保留 content-type", () => {
    const result = sanitizeHeaders({
      "content-type": "application/json",
      "set-cookie": "session=abc",
      authorization: "Bearer token123",
      cookie: "session=abc",
    });
    expect(result["content-type"]).toBe("application/json");
    expect(result["set-cookie"]).toBeUndefined();
    expect(result.authorization).toBeUndefined();
    expect(result.cookie).toBeUndefined();
  });

  it("移除 proxy-authorization/x-api-key/x-auth-token", () => {
    const result = sanitizeHeaders({
      "proxy-authorization": "Basic xyz",
      "x-api-key": "key123",
      "x-auth-token": "token456",
      "content-length": "100",
    });
    expect(result["proxy-authorization"]).toBeUndefined();
    expect(result["x-api-key"]).toBeUndefined();
    expect(result["x-auth-token"]).toBeUndefined();
    expect(result["content-length"]).toBe("100");
  });

  it("不区分大小写匹配敏感头", () => {
    const result = sanitizeHeaders({
      "Set-Cookie": "session=abc",
      AUTHORIZATION: "Bearer xyz",
      CoOkIe: "session=abc",
    });
    expect(result["Set-Cookie"]).toBeUndefined();
    expect(result.AUTHORIZATION).toBeUndefined();
    expect(result.CoOkIe).toBeUndefined();
  });

  it("空对象返回空对象", () => {
    expect(sanitizeHeaders({})).toEqual({});
  });

  it("无不敏感头时返回相同内容（新对象）", () => {
    const input = { "content-type": "text/html", accept: "*/*" };
    const result = sanitizeHeaders(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input); // 应是新对象
  });
});

describe("sanitizeConsoleEntry", () => {
  it("移除 stack trace 中的文件路径细节", () => {
    const entry: ConsoleEntry = {
      level: "error",
      text: "Error: something failed\n    at foo (http://example.com/app.js:10:5)\n    at bar (http://example.com/lib.js:20:10)",
    };
    const result = sanitizeConsoleEntry(entry);
    expect(result.text).toContain("Error: something failed");
    expect(result.text).not.toContain("app.js");
    expect(result.text).not.toContain("lib.js");
    expect(result.text).not.toContain("example.com");
  });

  it("保留单行消息（无 stack trace）", () => {
    const entry: ConsoleEntry = {
      level: "log",
      text: "just a log message",
    };
    expect(sanitizeConsoleEntry(entry).text).toBe("just a log message");
  });

  it("保留 level/url/lineNumber", () => {
    const entry: ConsoleEntry = {
      level: "warning",
      text: "warn\n    at fn (http://x.com/a.js:1:1)",
      url: "http://x.com/a.js",
      lineNumber: 1,
    };
    const result = sanitizeConsoleEntry(entry);
    expect(result.level).toBe("warning");
    expect(result.url).toBe("http://x.com/a.js");
    expect(result.lineNumber).toBe(1);
  });

  it("对 pageerror 也移除 stack trace", () => {
    const entry: ConsoleEntry = {
      level: "pageerror",
      text: "TypeError: x is undefined\n    at handler (http://app.com/bundle.js:42:15)",
    };
    const result = sanitizeConsoleEntry(entry);
    expect(result.text).not.toContain("bundle.js");
    expect(result.text).toContain("TypeError: x is undefined");
  });

  it("不修改原对象（返回新对象）", () => {
    const entry: ConsoleEntry = {
      level: "error",
      text: "Error\n    at x (http://y.com/a.js:1:1)",
    };
    const original = { ...entry, text: entry.text };
    sanitizeConsoleEntry(entry);
    expect(entry).toEqual(original);
  });
});

describe("sanitizeNetworkEntry", () => {
  it("body 置为 null（默认不读取）", () => {
    const entry: NetworkEntry = {
      url: "https://api.example.com/users",
      method: "GET",
      status: 200,
      body: '{"token":"secret"}',
    };
    const result = sanitizeNetworkEntry(entry);
    expect(result.body).toBeNull();
  });

  it("headers 脱敏（移除敏感头）", () => {
    const entry: NetworkEntry = {
      url: "https://api.example.com/users",
      method: "GET",
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "session=abc",
        authorization: "Bearer xyz",
      },
    };
    const result = sanitizeNetworkEntry(entry);
    expect(result.headers?.["content-type"]).toBe("application/json");
    expect(result.headers?.["set-cookie"]).toBeUndefined();
    expect(result.headers?.authorization).toBeUndefined();
  });

  it("URL 脱敏（移除敏感查询参数）", () => {
    const entry: NetworkEntry = {
      url: "https://api.example.com/users?token=secret&format=json",
      method: "GET",
      status: 200,
    };
    const result = sanitizeNetworkEntry(entry);
    expect(result.url).not.toContain("token=secret");
    expect(result.url).toContain("format=json");
  });

  it("保留 method/status/statusText/mimeType/duration", () => {
    const entry: NetworkEntry = {
      url: "https://api.example.com/users",
      method: "POST",
      status: 201,
      statusText: "Created",
      mimeType: "application/json",
      duration: 123,
    };
    const result = sanitizeNetworkEntry(entry);
    expect(result.method).toBe("POST");
    expect(result.status).toBe(201);
    expect(result.statusText).toBe("Created");
    expect(result.mimeType).toBe("application/json");
    expect(result.duration).toBe(123);
  });

  it("无 headers 字段时不添加 headers", () => {
    const entry: NetworkEntry = {
      url: "https://api.example.com",
      method: "GET",
      status: 200,
    };
    const result = sanitizeNetworkEntry(entry);
    expect(result.headers).toBeUndefined();
  });

  it("不修改原对象", () => {
    const entry: NetworkEntry = {
      url: "https://api.example.com?token=secret",
      method: "GET",
      status: 200,
      body: "original",
      headers: { authorization: "Bearer x" },
    };
    const original = JSON.parse(JSON.stringify(entry));
    sanitizeNetworkEntry(entry);
    expect(entry).toEqual(original);
  });
});

describe("sanitizeDomSummary", () => {
  it("移除 onclick 等 inline event handlers", () => {
    const html = '<button onclick="alert(1)">Click</button>';
    const result = sanitizeDomSummary(html);
    expect(result).not.toContain("onclick");
    expect(result).not.toContain("alert(1)");
    expect(result).toContain("<button");
    expect(result).toContain("Click");
  });

  it("移除 onload/onerror/onmouseover 等 inline handlers", () => {
    const html =
      '<img src="x" onerror="evil()" onload="init()" onmouseover="hover()">' +
      '<div oninput="capture()">text</div>';
    const result = sanitizeDomSummary(html);
    expect(result).not.toContain("onerror");
    expect(result).not.toContain("onload");
    expect(result).not.toContain("onmouseover");
    expect(result).not.toContain("oninput");
    expect(result).not.toContain("evil()");
    expect(result).not.toContain("init()");
    expect(result).not.toContain("capture()");
  });

  it("移除 data: URI", () => {
    const html = '<img src="data:image/png;base64,ABCDEF">';
    const result = sanitizeDomSummary(html);
    expect(result).not.toContain("data:");
    expect(result).not.toContain("ABCDEF");
  });

  it("移除 data: URI 出现在 href 中", () => {
    const html = '<a href="data:text/html;base64,PGh0bWw+">click</a>';
    const result = sanitizeDomSummary(html);
    expect(result).not.toContain("data:");
  });

  it("保留普通属性和文本", () => {
    const html = '<a href="https://example.com" class="link">visit</a>';
    const result = sanitizeDomSummary(html);
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('class="link"');
    expect(result).toContain("visit");
  });

  it("处理单引号包裹的属性", () => {
    const html = "<button onclick='evil()'>x</button>";
    const result = sanitizeDomSummary(html);
    expect(result).not.toContain("onclick");
    expect(result).not.toContain("evil()");
  });

  it("空字符串返回空字符串", () => {
    expect(sanitizeDomSummary("")).toBe("");
  });

  it("无 inline handler / data URI 的 HTML 原样返回", () => {
    const html = '<div class="container"><p>hello</p></div>';
    expect(sanitizeDomSummary(html)).toBe(html);
  });
});

describe("sanitizeUrl", () => {
  it("移除 query string 中的 token 参数", () => {
    const result = sanitizeUrl("https://example.com/api?token=secret&format=json");
    expect(result).not.toContain("token=secret");
    expect(result).toContain("format=json");
  });

  it("移除 query string 中的 password 参数", () => {
    const result = sanitizeUrl("https://example.com/login?password=secret&user=alice");
    expect(result).not.toContain("password=secret");
    expect(result).toContain("user=alice");
  });

  it("移除多个敏感参数", () => {
    const result = sanitizeUrl(
      "https://example.com/api?token=abc&password=def&authorization=ghi&format=json",
    );
    expect(result).not.toContain("token=");
    expect(result).not.toContain("password=");
    expect(result).not.toContain("authorization=");
    expect(result).toContain("format=json");
  });

  it("参数名大小写不敏感", () => {
    const result = sanitizeUrl("https://example.com/api?TOKEN=secret&format=json");
    expect(result).not.toContain("TOKEN=secret");
    expect(result).toContain("format=json");
  });

  it("无 query string 原样返回", () => {
    expect(sanitizeUrl("https://example.com/api")).toBe("https://example.com/api");
  });

  it("无非敏感参数时移除尾部 ?", () => {
    const result = sanitizeUrl("https://example.com/api?token=secret");
    expect(result).not.toContain("?");
    expect(result).not.toContain("token");
  });

  it("无敏感参数原样返回", () => {
    expect(sanitizeUrl("https://example.com/api?format=json&page=1")).toBe(
      "https://example.com/api?format=json&page=1",
    );
  });

  it("无效 URL 原样返回（不抛错）", () => {
    const result = sanitizeUrl("not-a-valid-url");
    expect(result).toBe("not-a-valid-url");
  });

  it("空字符串原样返回", () => {
    expect(sanitizeUrl("")).toBe("");
  });
});

describe("redactCommandResult", () => {
  it("browser.getConsole 对每个条目应用 sanitizeConsoleEntry 并截断", () => {
    const entries: ConsoleEntry[] = [
      {
        level: "error",
        text: "Error: x\n    at fn (http://x.com/a.js:1:1)",
      },
      {
        level: "log",
        text: "clean message",
      },
    ];
    const result = redactCommandResult("browser.getConsole", entries) as ConsoleEntry[];
    expect(result).toHaveLength(2);
    expect(result[0]?.text).not.toContain("a.js");
    expect(result[1]?.text).toBe("clean message");
  });

  it("browser.getConsole 对 { entries: [...] } 形状的结果应用脱敏", () => {
    const result = redactCommandResult("browser.getConsole", {
      entries: [{ level: "error", text: "Error\n    at fn (http://x.com/a.js:1:1)" }],
    }) as { entries: ConsoleEntry[] };
    expect(result.entries[0]?.text).not.toContain("a.js");
  });

  it("browser.getConsole 截断到 DEFAULT_LIMITS.maxConsoleEntries", () => {
    const entries: ConsoleEntry[] = Array.from({ length: 100 }, (_, i) => ({
      level: "log" as const,
      text: `msg-${i}`,
    }));
    const result = redactCommandResult("browser.getConsole", entries) as ConsoleEntry[];
    expect(result).toHaveLength(DEFAULT_LIMITS.maxConsoleEntries);
    expect(result[0]?.text).toBe("msg-0");
  });

  it("browser.getNetwork 对每个条目应用 sanitizeNetworkEntry", () => {
    const entries: NetworkEntry[] = [
      {
        url: "https://api.example.com?token=secret",
        method: "GET",
        status: 200,
        body: "should-be-hidden",
        headers: { authorization: "Bearer x", "content-type": "application/json" },
      },
    ];
    const result = redactCommandResult("browser.getNetwork", entries) as NetworkEntry[];
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBeNull();
    expect(result[0]?.headers?.authorization).toBeUndefined();
    expect(result[0]?.headers?.["content-type"]).toBe("application/json");
    expect(result[0]?.url).not.toContain("token=secret");
  });

  it("browser.getNetwork 截断到 DEFAULT_LIMITS.maxNetworkEntries", () => {
    const entries: NetworkEntry[] = Array.from({ length: 100 }, (_, i) => ({
      url: `https://api.example.com/${i}`,
      method: "GET",
      status: 200,
    }));
    const result = redactCommandResult("browser.getNetwork", entries) as NetworkEntry[];
    expect(result).toHaveLength(DEFAULT_LIMITS.maxNetworkEntries);
  });

  it("browser.snapshot 对字符串结果应用 sanitizeDomSummary + 截断", () => {
    const longHtml = `<div onclick="evil()">${"x".repeat(DEFAULT_LIMITS.maxTextLength + 100)}</div>`;
    const result = redactCommandResult("browser.snapshot", longHtml) as string;
    expect(result).not.toContain("onclick");
    expect(result.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxTextLength);
  });

  it("browser.snapshot 对 { html } 形状结果应用脱敏", () => {
    const result = redactCommandResult("browser.snapshot", {
      html: '<button onclick="evil()">x</button>',
    }) as { html: string };
    expect(result.html).not.toContain("onclick");
  });

  it("browser.getAccessibilityTree 对字符串结果应用 sanitizeDomSummary", () => {
    const result = redactCommandResult(
      "browser.getAccessibilityTree",
      '<button onclick="evil()">x</button>',
    ) as string;
    expect(result).not.toContain("onclick");
  });

  it("browser.getPageMetadata 对 { text } 形状结果应用 maxPageTextLength 截断", () => {
    const longText = "a".repeat(DEFAULT_LIMITS.maxPageTextLength + 100);
    const result = redactCommandResult("browser.getPageMetadata", {
      text: longText,
    }) as { text: string };
    expect(result.text.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxPageTextLength);
  });

  it("browser.screenshot 移除原始字节（base64 / data / bytes 字段）", () => {
    const result = redactCommandResult("browser.screenshot", {
      format: "png",
      data: "iVBORw0KGgoAAAANSUhEUg==",
    }) as { format: string; data?: unknown; ref?: string };
    expect(result.data).toBeUndefined();
    expect(result.format).toBe("png");
    expect(result.ref).toBeDefined();
  });

  it("browser.screenshot 字符串结果替换为引用占位", () => {
    const result = redactCommandResult("browser.screenshot", "iVBORw0KGgoAAAANSUhEUg==");
    expect(result).not.toBe("iVBORw0KGgoAAAANSUhEUg==");
    expect(typeof result).toBe("object");
  });

  it("browser.getTabs 对每个 tab 的 url 应用 sanitizeUrl", () => {
    const result = redactCommandResult("browser.getTabs", [
      { id: "tab1", url: "https://example.com?token=secret" },
      { id: "tab2", url: "https://example.com/clean" },
    ]) as Array<{ id: string; url: string }>;
    expect(result[0]?.url).not.toContain("token=secret");
    expect(result[1]?.url).toBe("https://example.com/clean");
  });

  it("null 结果原样返回", () => {
    expect(redactCommandResult("browser.getConsole", null)).toBeNull();
  });

  it("undefined 结果原样返回", () => {
    expect(redactCommandResult("browser.getConsole", undefined)).toBeUndefined();
  });

  it("未知命令原样返回结果", () => {
    const result = { foo: "bar" };
    expect(redactCommandResult("browser.unknown", result)).toBe(result);
  });
});
