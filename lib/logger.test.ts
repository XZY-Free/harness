import { logger, redactPaths, redactSensitiveFields } from "@/lib/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

describe("logger", () => {
  it("info 输出含 level/msg/字段的 JSON 行", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("hello", { threadId: "t1" });
    expect(spy).toHaveBeenCalledOnce();
    const firstArg = spy.mock.calls[0]?.[0];
    expect(typeof firstArg).toBe("string");
    const entry = JSON.parse(firstArg as string);
    expect(entry).toMatchObject({ level: "info", msg: "hello", threadId: "t1" });
    expect(typeof entry.ts).toBe("string");
  });

  it("error 走 console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("boom", { code: "x" });
    const firstArg = spy.mock.calls[0]?.[0];
    const entry = JSON.parse(firstArg as string);
    expect(entry).toMatchObject({ level: "error", msg: "boom", code: "x" });
  });
});

describe("logger S01-W03 敏感字段脱敏", () => {
  it("authorization/cookie/credential/token 类字段置 [REDACTED]", () => {
    const out = redactSensitiveFields({
      authorization: "Bearer abc",
      cookie: "snow_session=xyz",
      credential: "user:pass",
      access_token: "tok_1",
      password: "s3cr3t",
      normalField: "keep",
    });
    expect(out).toEqual({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      credential: "[REDACTED]",
      access_token: "[REDACTED]",
      password: "[REDACTED]",
      normalField: "keep",
    });
  });

  it("业务 code/state 不被脱敏（仅 OAuth 一次性值脱敏）", () => {
    const out = redactSensitiveFields({
      code: "TURN_ALREADY_TERMINAL",
      state: "completed",
      auth_code: "oc_1",
      oauth_state: "os_1",
      nonce: "n_1",
    });
    expect(out).toEqual({
      code: "TURN_ALREADY_TERMINAL",
      state: "completed",
      auth_code: "[REDACTED]",
      oauth_state: "[REDACTED]",
      nonce: "[REDACTED]",
    });
  });

  it("字段名大小写不敏感", () => {
    const out = redactSensitiveFields({ Authorization: "x", TOKEN: "y" });
    expect(out).toEqual({ Authorization: "[REDACTED]", TOKEN: "[REDACTED]" });
  });

  it("嵌套对象递归脱敏", () => {
    const out = redactSensitiveFields({
      request: { headers: { authorization: "Bearer z", accept: "application/json" } },
    });
    expect(out).toEqual({
      request: { headers: { authorization: "[REDACTED]", accept: "application/json" } },
    });
  });

  it("数组内对象递归脱敏", () => {
    const out = redactSensitiveFields({ items: [{ token: "t" }, { ok: true }] });
    expect(out).toEqual({ items: [{ token: "[REDACTED]" }, { ok: true }] });
  });
});

describe("logger S01-W03 本地绝对路径脱敏", () => {
  it("redactPaths 替换 /Users/ /home/ /tmp/ 等绝对路径", () => {
    expect(redactPaths("opened /Users/bob/secret.key")).toBe("opened [PATH]");
    expect(redactPaths("config at /home/app/config.yml done")).toBe("config at [PATH] done");
    expect(redactPaths("tmp file /tmp/x.log")).toBe("tmp file [PATH]");
  });

  it("redactPaths 不影响相对路径与普通文本", () => {
    expect(redactPaths("relative path ./lib/http.ts")).toBe("relative path ./lib/http.ts");
    expect(redactPaths("no path here")).toBe("no path here");
  });

  it("logger 把消息与字段中的本地路径替换为 [PATH]", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("reading /Users/alice/.env", { path: "/etc/passwd" });
    const entry = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(entry.msg).toBe("reading [PATH]");
    expect(entry.path).toBe("[PATH]");
  });
});
