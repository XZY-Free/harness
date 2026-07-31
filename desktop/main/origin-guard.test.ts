import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_ORIGIN,
  getOrigin,
  isTrustedServerOrigin,
  loadAllowedOrigins,
  shouldBlockNavigation,
} from "./origin-guard";

/** 测试用受信任 origin 列表（覆盖 https / localhost / 127.0.0.1 三类）。 */
const TRUSTED = ["http://localhost:3000", "http://127.0.0.1:3000", "https://snow.example.com"];

describe("origin-guard getOrigin (V10 Phase 3)", () => {
  it("http URL 返回 origin（剥 path）", () => {
    expect(getOrigin("http://localhost:3000/desktop")).toBe("http://localhost:3000");
  });

  it("https URL 返回 origin（剥 path）", () => {
    expect(getOrigin("https://snow.example.com/path")).toBe("https://snow.example.com");
  });

  it("about:blank 返回哨兵值 about:blank", () => {
    expect(getOrigin("about:blank")).toBe("about:blank");
  });

  it("file:// 返回 null", () => {
    expect(getOrigin("file:///etc/passwd")).toBe(null);
  });

  it("data: 返回 null", () => {
    expect(getOrigin("data:text/plain,x")).toBe(null);
  });

  it("blob: 返回 null（origin 不可信）", () => {
    expect(getOrigin("blob:http://localhost:3000/uuid")).toBe(null);
  });

  it("空字符串返回 null", () => {
    expect(getOrigin("")).toBe(null);
  });

  it("无效 URL 返回 null", () => {
    expect(getOrigin("not a url")).toBe(null);
  });
});

describe("origin-guard isTrustedServerOrigin (V10 Phase 3)", () => {
  it("受信任 https origin 通过", () => {
    expect(isTrustedServerOrigin("https://snow.example.com/path", TRUSTED)).toBe(true);
  });

  it("http://localhost:3000 通过", () => {
    expect(isTrustedServerOrigin("http://localhost:3000/desktop", TRUSTED)).toBe(true);
  });

  it("http://127.0.0.1:3000 通过", () => {
    expect(isTrustedServerOrigin("http://127.0.0.1:3000/x", TRUSTED)).toBe(true);
  });

  it("非列表中的 https origin 被阻止", () => {
    expect(isTrustedServerOrigin("https://evil.example.com/x", TRUSTED)).toBe(false);
  });

  it("http://evil.com 被阻止（非 localhost http）", () => {
    expect(isTrustedServerOrigin("http://evil.com/x", TRUSTED)).toBe(false);
  });

  it("file:// 不是 server origin", () => {
    expect(isTrustedServerOrigin("file:///etc/passwd", TRUSTED)).toBe(false);
  });

  it("data: 不是 server origin", () => {
    expect(isTrustedServerOrigin("data:text/plain,x", TRUSTED)).toBe(false);
  });

  it("about:blank 不是 server origin", () => {
    expect(isTrustedServerOrigin("about:blank", TRUSTED)).toBe(false);
  });

  it("http://localhost:8080 未在列表中被阻止", () => {
    expect(isTrustedServerOrigin("http://localhost:8080/x", TRUSTED)).toBe(false);
  });

  it("空字符串被阻止", () => {
    expect(isTrustedServerOrigin("", TRUSTED)).toBe(false);
  });

  it("无效 URL 被阻止", () => {
    expect(isTrustedServerOrigin("not a url", TRUSTED)).toBe(false);
  });
});

describe("origin-guard shouldBlockNavigation (V10 Phase 3)", () => {
  it("受信任 https origin 不阻止", () => {
    expect(shouldBlockNavigation("https://snow.example.com/path", TRUSTED)).toBe(false);
  });

  it("http://localhost:3000 不阻止", () => {
    expect(shouldBlockNavigation("http://localhost:3000/desktop", TRUSTED)).toBe(false);
  });

  it("http://127.0.0.1:3000 不阻止", () => {
    expect(shouldBlockNavigation("http://127.0.0.1:3000/x", TRUSTED)).toBe(false);
  });

  it("非列表中的 https origin 阻止", () => {
    expect(shouldBlockNavigation("https://evil.example.com/x", TRUSTED)).toBe(true);
  });

  it("http://evil.com 阻止", () => {
    expect(shouldBlockNavigation("http://evil.com/x", TRUSTED)).toBe(true);
  });

  it("file:// 阻止", () => {
    expect(shouldBlockNavigation("file:///etc/passwd", TRUSTED)).toBe(true);
  });

  it("data: 阻止", () => {
    expect(shouldBlockNavigation("data:text/plain,x", TRUSTED)).toBe(true);
  });

  it("blob: 阻止", () => {
    expect(shouldBlockNavigation("blob:http://localhost:3000/uuid", TRUSTED)).toBe(true);
  });

  it("about:blank 不阻止", () => {
    expect(shouldBlockNavigation("about:blank", TRUSTED)).toBe(false);
  });

  it("空字符串 URL 阻止", () => {
    expect(shouldBlockNavigation("", TRUSTED)).toBe(true);
  });

  it("无效 URL 阻止", () => {
    expect(shouldBlockNavigation("not a url", TRUSTED)).toBe(true);
  });
});

describe("origin-guard loadAllowedOrigins (V10 Phase 3)", () => {
  it("无环境变量返回默认值 http://localhost:3000", () => {
    expect(loadAllowedOrigins({})).toEqual([DEFAULT_SERVER_ORIGIN]);
    expect(loadAllowedOrigins({})).toEqual(["http://localhost:3000"]);
  });

  it("逗号分隔的环境变量解析为列表", () => {
    expect(
      loadAllowedOrigins({ SNOW_SERVER_ORIGIN: "https://a.com,http://localhost:3000" }),
    ).toEqual(["https://a.com", "http://localhost:3000"]);
  });

  it("纯空白值回退默认", () => {
    expect(loadAllowedOrigins({ SNOW_SERVER_ORIGIN: "  " })).toEqual([DEFAULT_SERVER_ORIGIN]);
  });

  it("前后空格被 trim", () => {
    expect(
      loadAllowedOrigins({
        SNOW_SERVER_ORIGIN: " https://a.com , http://localhost:3000 ",
      }),
    ).toEqual(["https://a.com", "http://localhost:3000"]);
  });

  it("空段被过滤", () => {
    expect(
      loadAllowedOrigins({
        SNOW_SERVER_ORIGIN: "https://a.com,,http://localhost:3000,",
      }),
    ).toEqual(["https://a.com", "http://localhost:3000"]);
  });

  it("空字符串值回退默认", () => {
    expect(loadAllowedOrigins({ SNOW_SERVER_ORIGIN: "" })).toEqual([DEFAULT_SERVER_ORIGIN]);
  });
});
