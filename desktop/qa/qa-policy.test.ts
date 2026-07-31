import { describe, expect, it } from "vitest";
import {
  BLOCKED_QA_PERMISSIONS,
  type QaDecision,
  decideQaCertificateError,
  decideQaDownload,
  decideQaExternalProtocol,
  decideQaNavigation,
  decideQaPermission,
  decideQaPopup,
  isReadOnlyRequestMethod,
} from "./qa-policy";

/**
 * V10 Phase 7-4：QA read-only 策略单元测试。
 *
 * 验证：
 * - 下载一律拒绝（read-only 核心约束）
 * - 权限一律拒绝（notification/camera/mic 等）
 * - 弹窗一律拒绝
 * - 外部协议一律拒绝
 * - 证书错误一律拒绝
 * - 导航：允许 http/https，阻止 file:/data:/javascript: 等
 * - 请求方法：POST/PUT/DELETE/PATCH 一律阻断，GET/HEAD/OPTIONS 放行
 */

describe("qa-policy", () => {
  describe("decideQaDownload", () => {
    it("始终返回 deny", () => {
      expect(decideQaDownload()).toBe<QaDecision>("deny");
    });
  });

  describe("decideQaPermission", () => {
    it("对任意权限类型返回 denied", () => {
      for (const perm of BLOCKED_QA_PERMISSIONS) {
        expect(decideQaPermission(perm)).toBe("denied");
      }
    });

    it("对未知权限类型也返回 denied", () => {
      expect(decideQaPermission("unknown" as never)).toBe("denied");
    });
  });

  describe("decideQaPopup", () => {
    it("始终返回 deny", () => {
      expect(decideQaPopup()).toBe<QaDecision>("deny");
    });
  });

  describe("decideQaExternalProtocol", () => {
    it("始终返回 deny", () => {
      expect(decideQaExternalProtocol()).toBe<QaDecision>("deny");
    });
  });

  describe("decideQaCertificateError", () => {
    it("始终返回 deny", () => {
      expect(decideQaCertificateError()).toBe<QaDecision>("deny");
    });
  });

  describe("decideQaNavigation", () => {
    it("允许 http URL", () => {
      expect(decideQaNavigation("http://localhost:3000/preview/t1/")).toBe("allow");
    });

    it("允许 https URL", () => {
      expect(decideQaNavigation("https://example.com/page")).toBe("allow");
    });

    it("阻止 file: URL", () => {
      expect(decideQaNavigation("file:///etc/passwd")).toBe("deny");
    });

    it("阻止 data: URL", () => {
      expect(decideQaNavigation("data:text/html,<h1>hi</h1>")).toBe("deny");
    });

    it("阻止 javascript: URL", () => {
      expect(decideQaNavigation("javascript:alert(1)")).toBe("deny");
    });

    it("阻止 blob: URL", () => {
      expect(decideQaNavigation("blob:https://example.com/uuid")).toBe("deny");
    });

    it("对无效 URL 返回 deny", () => {
      expect(decideQaNavigation("not-a-url")).toBe("deny");
      expect(decideQaNavigation("")).toBe("deny");
    });
  });

  describe("isReadOnlyRequestMethod", () => {
    it("GET 放行", () => {
      expect(isReadOnlyRequestMethod("GET")).toBe(true);
    });

    it("HEAD 放行", () => {
      expect(isReadOnlyRequestMethod("HEAD")).toBe(true);
    });

    it("OPTIONS 放行", () => {
      expect(isReadOnlyRequestMethod("OPTIONS")).toBe(true);
    });

    it("POST 阻断", () => {
      expect(isReadOnlyRequestMethod("POST")).toBe(false);
    });

    it("PUT 阻断", () => {
      expect(isReadOnlyRequestMethod("PUT")).toBe(false);
    });

    it("DELETE 阻断", () => {
      expect(isReadOnlyRequestMethod("DELETE")).toBe(false);
    });

    it("PATCH 阻断", () => {
      expect(isReadOnlyRequestMethod("PATCH")).toBe(false);
    });

    it("大小写不敏感", () => {
      expect(isReadOnlyRequestMethod("get")).toBe(true);
      expect(isReadOnlyRequestMethod("post")).toBe(false);
    });
  });
});
