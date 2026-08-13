import {
  API_STATUS,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  decodeCursor,
  encodeCursor,
  etagHeader,
  generateRequestId,
  getRequestId,
  jsonError,
  jsonOk,
  omitThreadSecrets,
  parseIfMatch,
  resourceNotFound,
} from "@/lib/http";
import { describe, expect, it } from "vitest";

describe("http legacy helpers", () => {
  it("jsonOk 返回 ok:true + data", async () => {
    const res = jsonOk({ a: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { a: 1 } });
  });
  it("jsonError 返回指定 status + error", async () => {
    const res = jsonError(400, "bad_request", "缺少参数");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "bad_request", message: "缺少参数" },
    });
  });

  it("omitThreadSecrets 剥离 cicdApiToken(P1-5)", () => {
    const thread = {
      id: "t1",
      title: "x",
      cicdApiToken: "enc:deadbeef",
      status: "idle",
    };
    const safe = omitThreadSecrets(thread);
    expect(safe).not.toHaveProperty("cicdApiToken");
    expect(safe).toEqual({ id: "t1", title: "x", status: "idle" });
    // 原对象未被修改
    expect(thread.cicdApiToken).toBe("enc:deadbeef");
  });
});

describe("request id", () => {
  it("getRequestId 透传 X-Request-ID", () => {
    const req = new Request("https://x.test/api", {
      headers: { [REQUEST_ID_HEADER]: "req_abc" },
    });
    expect(getRequestId(req)).toBe("req_abc");
  });
  it("getRequestId 缺失时生成 req_ 前缀 id", () => {
    const req = new Request("https://x.test/api");
    const id = getRequestId(req);
    expect(id).toMatch(/^req_/);
    expect(id.length).toBeGreaterThan(10);
  });
  it("generateRequestId 唯一", () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).not.toBe(b);
  });
  it("getRequestId 去除空白", () => {
    const req = new Request("https://x.test/api", {
      headers: { [REQUEST_ID_HEADER]: "  req_spaced  " },
    });
    expect(getRequestId(req)).toBe("req_spaced");
  });
});

describe("error envelope", () => {
  it("apiError 用错误码目录的 http 与 retryable", async () => {
    const res = apiError("TURN_ALREADY_TERMINAL", "本轮已结束", {
      requestId: "req_1",
    });
    // TURN_ALREADY_TERMINAL -> 409, retryable false
    expect(res.status).toBe(API_STATUS.CONFLICT);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "TURN_ALREADY_TERMINAL",
        message: "本轮已结束",
        request_id: "req_1",
        retryable: false,
      },
    });
    // 响应回带 X-Request-ID
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("req_1");
  });

  it("apiError 支持 details 且 retryable 透传（RATE_LIMITED 可重试）", async () => {
    const res = apiError("RATE_LIMITED", "请求过多", {
      requestId: "req_2",
      details: { retry_after_ms: 500 },
    });
    expect(res.status).toBe(API_STATUS.RATE_LIMITED);
    const body = await res.json();
    expect(body.error.retryable).toBe(true);
    expect(body.error.details).toEqual({ retry_after_ms: 500 });
  });

  it("apiError ETAG_MISMATCH 映射 412 且可重试", async () => {
    const res = apiError("ETAG_MISMATCH", "版本冲突", { requestId: "req_3" });
    expect(res.status).toBe(API_STATUS.PRECONDITION_FAILED);
    expect((await res.json()).error.retryable).toBe(true);
  });

  it("resourceNotFound 返回 RESOURCE_NOT_FOUND + 隐藏式 404", async () => {
    const res = resourceNotFound("req_4");
    expect(res.status).toBe(API_STATUS.NOT_FOUND);
    const body = await res.json();
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(body.error.request_id).toBe("req_4");
  });
});

describe("success response", () => {
  it("apiSuccess 直接返回资源，无 ok 包裹", async () => {
    const res = apiSuccess({ id: "thr_1", status: "idle" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "thr_1", status: "idle" });
  });
  it("apiSuccess 支持自定义 init（如 202 异步命令）", async () => {
    const res = apiSuccess({ turn_id: "t1", status: "queued" }, { status: 202 });
    expect(res.status).toBe(202);
  });
});

describe("ETag / If-Match", () => {
  it("parseIfMatch 去引号与 W/ 前缀", () => {
    const req = new Request("https://x.test/api", {
      headers: { "if-match": 'W/"abc123"' },
    });
    expect(parseIfMatch(req)).toBe("abc123");
  });
  it("parseIfMatch 缺失返回 null", () => {
    const req = new Request("https://x.test/api");
    expect(parseIfMatch(req)).toBeNull();
  });
  it("etagHeader 构造强验证引号 ETag", () => {
    expect(etagHeader("v1")).toEqual({ etag: '"v1"' });
  });
});

describe("opaque cursor", () => {
  it("encodeCursor 输出不透明 base64url，可 round-trip", () => {
    const cursor = encodeCursor({ id: "evt_42", seq: 42 });
    expect(cursor).not.toContain("{");
    expect(decodeCursor(cursor)).toEqual({ id: "evt_42", seq: 42 });
  });
  it("decodeCursor 非法输入抛错", () => {
    expect(() => decodeCursor("!!!not-base64url-json")).toThrow();
  });
});

describe("status boundaries", () => {
  it("覆盖 400/401/403/404/409/412/413/422/429/503", () => {
    expect(API_STATUS).toEqual({
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      PRECONDITION_FAILED: 412,
      PAYLOAD_TOO_LARGE: 413,
      UNPROCESSABLE: 422,
      RATE_LIMITED: 429,
      UNAVAILABLE: 503,
    });
  });
});
