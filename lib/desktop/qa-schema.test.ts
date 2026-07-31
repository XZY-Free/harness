/**
 * V10 Phase 7-5：QA 统一 schema 测试。
 *
 * 验证 `lib/desktop/qa-schema.ts` 的类型与运行时形状：
 * - 类型对齐：`ConsoleEntry` / `NetworkEntry`（来自 `lib/desktop/redaction.ts`）与
 *   `QaConsoleMessage` / `QaNetworkResponse` 字段一致，可双向赋值
 * - 运行时形状：构造 `QaFailure` / `QaCheckResult` / `QaGateResult` / `QaCaptureResult`
 *   对象，验证字段集合符合 schema 定义
 * - 事件 payload：`QaCheckPassedPayload` / `QaCheckFailedPayload` 含 `runner` 字段
 */

import type {
  QaCaptureResult,
  QaCheckFailedPayload,
  QaCheckId,
  QaCheckKind,
  QaCheckPassedPayload,
  QaCheckResult,
  QaConsoleLevel,
  QaConsoleMessage,
  QaFailure,
  QaGateResult,
  QaNetworkResponse,
  QaPage,
  QaPageHooks,
  QaRunner,
  QaStorageState,
  QaViewport,
} from "@/lib/desktop/qa-schema";
import type { ConsoleEntry, NetworkEntry } from "@/lib/desktop/redaction";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("qa-schema 类型导出", () => {
  it("QaCheckKind 涵盖所有检查种类", () => {
    const kinds: QaCheckKind[] = ["browser", "responsive", "a11y", "gate", "verdict"];
    expect(kinds).toHaveLength(5);
  });

  it("QaRunner 区分 Web Playwright 与 Desktop CDP", () => {
    const runners: QaRunner[] = ["web-playwright", "desktop-cdp"];
    expect(runners).toHaveLength(2);
  });

  it("QaConsoleLevel 含 pageerror", () => {
    const levels: QaConsoleLevel[] = ["error", "warning", "pageerror", "log", "info"];
    expect(levels).toHaveLength(5);
  });
});

describe("qa-schema 与 redaction ConsoleEntry/NetworkEntry 对齐", () => {
  it("QaConsoleMessage 与 ConsoleEntry 字段一致（可赋值）", () => {
    const entry: ConsoleEntry = {
      level: "error",
      text: "boom",
      url: "http://x/",
      lineNumber: 42,
    };
    const msg: QaConsoleMessage = entry;
    expect(msg.level).toBe("error");
    expect(msg.text).toBe("boom");
    expect(msg.url).toBe("http://x/");
    expect(msg.lineNumber).toBe(42);
    // 反向赋值也应成立（结构同构）
    const back: ConsoleEntry = msg;
    expect(back.level).toBe("error");
  });

  it("QaNetworkResponse 是 NetworkEntry 的子集（url/status 必填，富信息可选，无 body）", () => {
    const entry: NetworkEntry = {
      url: "http://x/api",
      method: "GET",
      status: 200,
      statusText: "OK",
      mimeType: "application/json",
      duration: 12,
      body: null,
    };
    const resp: QaNetworkResponse = {
      url: entry.url,
      status: entry.status,
      method: entry.method,
      statusText: entry.statusText,
      mimeType: entry.mimeType,
      duration: entry.duration,
    };
    expect(resp.url).toBe("http://x/api");
    expect(resp.method).toBe("GET");
    expect(resp.status).toBe(200);
    // NetworkEntry 可赋值给 QaNetworkResponse（NetworkEntry 必填字段更多，
    // 满足 QaNetworkResponse 的所有必填项；反向不可——QaNetworkResponse 的
    // method 可选，可能为 undefined，不满足 NetworkEntry 的 method 必填约束）
    expectTypeOf<NetworkEntry>().toMatchTypeOf<QaNetworkResponse>();
    expectTypeOf<QaNetworkResponse>().not.toMatchTypeOf<NetworkEntry>();
  });
});

describe("qa-schema 运行时形状", () => {
  it("QaFailure 含 type/viewport/detail/artifactPath 字段", () => {
    const failure: QaFailure = {
      type: "console_error",
      viewport: 1280,
      detail: "TypeError: x is undefined",
      artifactPath: "t/qa/b1-1280.png",
    };
    expect(failure.type).toBe("console_error");
    expect(failure.viewport).toBe(1280);
  });

  it("QaCheckResult 含 kind 与 runner 字段", () => {
    const result: QaCheckResult = {
      ok: false,
      kind: "browser",
      failures: [{ type: "console_error", viewport: 1280, detail: "boom" }],
      viewports: [1280],
      durationMs: 42,
      artifactPath: "t/qa/b1.json",
      runner: "web-playwright",
    };
    expect(result.kind).toBe("browser");
    expect(result.runner).toBe("web-playwright");
  });

  it("QaGateResult 保留 skipped/error/evidencePath 语义", () => {
    const result: QaGateResult = {
      ok: false,
      skipped: false,
      kind: "gate",
      failures: [{ type: "browser_unavailable", detail: "未安装" }],
      error: "QA gate 启用但 Playwright 浏览器不可用",
      evidencePath: null,
      durationMs: 5,
      runner: "web-playwright",
    };
    expect(result.skipped).toBe(false);
    expect(result.error).toContain("Playwright");
  });

  it("QaCaptureResult 单 viewport 无 failures 字段", () => {
    const result: QaCaptureResult = {
      ok: true,
      viewport: 1280,
      durationMs: 30,
      screenshotPath: "t/qa/cap-1280.png",
      runner: "web-playwright",
    };
    expect(result.viewport).toBe(1280);
    expect(result.ok).toBe(true);
    // QaCaptureResult 不含 failures 字段（截图结果无失败列表，仅 ok/error 二态）
    expect("failures" in result).toBe(false);
  });

  it("QaCheckPassedPayload 含 runner 字段", () => {
    const payload: QaCheckPassedPayload = {
      checkId: "b1",
      kind: "browser",
      viewports: [1280],
      durationMs: 42,
      artifactPath: "t/qa/b1.json",
      runner: "web-playwright",
    };
    expect(payload.runner).toBe("web-playwright");
  });

  it("QaCheckFailedPayload 含 runner 字段", () => {
    const payload: QaCheckFailedPayload = {
      checkId: "b1",
      kind: "browser",
      viewports: [1280],
      failures: [{ type: "blank", detail: "白屏" }],
      durationMs: 42,
      artifactPath: null,
      runner: "desktop-cdp",
    };
    expect(payload.runner).toBe("desktop-cdp");
  });
});

describe("qa-schema QaPage 接口", () => {
  it("QaPage viewport 为 readonly（与 Desktop QaController 一致）", () => {
    const page: QaPage = {
      viewport: { width: 1280, height: 720 },
      goto: async () => {},
      screenshotFullPage: async () => Buffer.from(""),
      evaluate: async <T>(_script: string): Promise<T> => null as T,
      close: async () => {},
    };
    expect(page.viewport.width).toBe(1280);
    // readonly：以下应编译失败（已在 typecheck 验证）
    // page.viewport = { width: 0, height: 0 };
  });

  it("QaPageHooks 接受 QaConsoleMessage 回调", () => {
    const hooks: QaPageHooks = {
      onConsole: (msg: QaConsoleMessage) => {
        expect(msg.level).toBe("error");
      },
    };
    hooks.onConsole?.({ level: "error", text: "boom" });
  });
});

describe("qa-schema 类型兼容性编译时检查", () => {
  // 这些断言仅在编译时检查类型兼容性；运行时不执行
  it("QaViewport 与 QaStorageState 类型可构造", () => {
    const vp: QaViewport = { width: 1280, height: 720 };
    const state: QaStorageState = {
      cookies: [{ name: "s", value: "v", domain: "localhost", path: "/" }],
      origins: [{ origin: "http://localhost", localStorage: [] }],
    };
    expect(vp.width).toBe(1280);
    expect(state.cookies).toHaveLength(1);
  });

  it("QaCheckId 是 string 别名", () => {
    const id: QaCheckId = "browser-abc12345";
    expect(id).toBe("browser-abc12345");
  });

  it("expectTypeOf: QaConsoleMessage 与 ConsoleEntry 互相匹配", () => {
    expectTypeOf<QaConsoleMessage>().toMatchTypeOf<ConsoleEntry>();
    expectTypeOf<ConsoleEntry>().toMatchTypeOf<QaConsoleMessage>();
  });
});
