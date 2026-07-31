import { describe, expect, it } from "vitest";
import {
  ALLOWED_PERMISSIONS,
  BLOCKED_SCHEMES,
  checkUrlSafety,
  decideCertificateError,
  decideDownload,
  decideExternalProtocol,
  decidePermission,
  decidePopup,
  isServerUrl,
} from "./permission-policy";

describe("permission-policy decidePermission (V10 Phase 4)", () => {
  it("fullscreen 返回 granted（演示/会议需要）", () => {
    expect(decidePermission("fullscreen", "https://example.com")).toBe("granted");
  });

  it("display-capture 返回 granted（屏幕共享需要）", () => {
    expect(decidePermission("display-capture", "https://example.com")).toBe("granted");
  });

  it("clipboard-sanitized-write 返回 granted（复制粘贴需要）", () => {
    expect(decidePermission("clipboard-sanitized-write", "https://example.com")).toBe("granted");
  });

  it("notifications 返回 denied（默认拒绝）", () => {
    expect(decidePermission("notifications", "https://example.com")).toBe("denied");
  });

  it("media 返回 denied（默认拒绝摄像头/麦克风）", () => {
    expect(decidePermission("media", "https://example.com")).toBe("denied");
  });

  it("geolocation 返回 denied（默认拒绝位置）", () => {
    expect(decidePermission("geolocation", "https://example.com")).toBe("denied");
  });

  it("midiSysex 返回 denied", () => {
    expect(decidePermission("midiSysex", "https://example.com")).toBe("denied");
  });

  it("pointerLock 返回 denied", () => {
    expect(decidePermission("pointerLock", "https://example.com")).toBe("denied");
  });

  it("openExternal 返回 denied", () => {
    expect(decidePermission("openExternal", "https://example.com")).toBe("denied");
  });

  it("openHidden 返回 denied", () => {
    expect(decidePermission("openHidden", "https://example.com")).toBe("denied");
  });

  it("clipboard-read 返回 denied（读取剪贴板默认拒绝）", () => {
    expect(decidePermission("clipboard-read", "https://example.com")).toBe("denied");
  });

  it("speaker-selection 返回 denied", () => {
    expect(decidePermission("speaker-selection", "https://example.com")).toBe("denied");
  });

  it("window-management 返回 denied", () => {
    expect(decidePermission("window-management", "https://example.com")).toBe("denied");
  });

  it("unknown 返回 denied（未知权限默认拒绝）", () => {
    expect(decidePermission("unknown", "https://example.com")).toBe("denied");
  });

  it("requestingUrl 不影响决策（白名单优先）", () => {
    expect(decidePermission("fullscreen", "https://any-other.com")).toBe("granted");
  });
});

describe("permission-policy decidePopup (V10 Phase 4)", () => {
  it("任意 URL 返回 deny（默认拒绝弹窗）", () => {
    expect(decidePopup("https://example.com")).toBe("deny");
  });

  it("http URL 返回 deny", () => {
    expect(decidePopup("http://localhost:3000/popup")).toBe("deny");
  });

  it("https URL 返回 deny", () => {
    expect(decidePopup("https://example.com/popup")).toBe("deny");
  });

  it("空字符串 URL 返回 deny", () => {
    expect(decidePopup("")).toBe("deny");
  });

  it("恶意 URL 返回 deny", () => {
    expect(decidePopup("https://evil.example.com/track")).toBe("deny");
  });
});

describe("permission-policy decideExternalProtocol (V10 Phase 4)", () => {
  it("http URL 返回 allow（在 WebContentsView 内导航）", () => {
    expect(decideExternalProtocol("http://example.com")).toBe("allow");
  });

  it("https URL 返回 allow", () => {
    expect(decideExternalProtocol("https://example.com")).toBe("allow");
  });

  it("mailto URL 返回 prompt（需用户确认）", () => {
    expect(decideExternalProtocol("mailto:user@example.com")).toBe("prompt");
  });

  it("tel URL 返回 prompt", () => {
    expect(decideExternalProtocol("tel:+8613800138000")).toBe("prompt");
  });

  it("custom scheme 返回 prompt", () => {
    expect(decideExternalProtocol("myapp://open")).toBe("prompt");
  });

  it("无效 URL 返回 deny", () => {
    expect(decideExternalProtocol("not a url")).toBe("deny");
  });

  it("空字符串 URL 返回 deny", () => {
    expect(decideExternalProtocol("")).toBe("deny");
  });
});

describe("permission-policy decideCertificateError (V10 Phase 4)", () => {
  it("自签名证书返回 deny（fail-closed）", () => {
    expect(decideCertificateError({ subject: "CN=self-signed" }, "certificate self-signed")).toBe(
      "deny",
    );
  });

  it("过期证书返回 deny", () => {
    expect(decideCertificateError({ subject: "CN=expired" }, "certificate expired")).toBe("deny");
  });

  it("空错误字符串返回 deny", () => {
    expect(decideCertificateError({}, "")).toBe("deny");
  });

  it("null 证书返回 deny", () => {
    expect(decideCertificateError(null, "unknown")).toBe("deny");
  });
});

describe("permission-policy decideDownload (V10 Phase 4)", () => {
  it("合法 http URL 返回 allow", () => {
    expect(decideDownload("http://example.com/file.zip")).toBe("allow");
  });

  it("合法 https URL 返回 allow", () => {
    expect(decideDownload("https://example.com/file.zip")).toBe("allow");
  });

  it("无效 URL 返回 deny", () => {
    expect(decideDownload("not a url")).toBe("deny");
  });

  it("空字符串 URL 返回 deny", () => {
    expect(decideDownload("")).toBe("deny");
  });

  it("ftp URL 返回 allow（合法 URL 结构）", () => {
    expect(decideDownload("ftp://example.com/file.zip")).toBe("allow");
  });
});

describe("permission-policy checkUrlSafety (V10 Phase 4)", () => {
  it("http URL 返回 safe", () => {
    expect(checkUrlSafety("http://example.com")).toBe("safe");
  });

  it("https URL 返回 safe", () => {
    expect(checkUrlSafety("https://example.com/path")).toBe("safe");
  });

  it("file URL 返回 blocked", () => {
    expect(checkUrlSafety("file:///etc/passwd")).toBe("blocked");
  });

  it("data URL 返回 blocked", () => {
    expect(checkUrlSafety("data:text/plain,x")).toBe("blocked");
  });

  it("blob URL 返回 blocked", () => {
    expect(checkUrlSafety("blob:https://example.com/uuid")).toBe("blocked");
  });

  it("javascript URL 返回 blocked", () => {
    expect(checkUrlSafety("javascript:alert(1)")).toBe("blocked");
  });

  it("mailto URL 返回 prompt", () => {
    expect(checkUrlSafety("mailto:user@example.com")).toBe("prompt");
  });

  it("tel URL 返回 prompt", () => {
    expect(checkUrlSafety("tel:+8613800138000")).toBe("prompt");
  });

  it("无效 URL 返回 blocked", () => {
    expect(checkUrlSafety("not a url")).toBe("blocked");
  });

  it("空字符串 URL 返回 blocked", () => {
    expect(checkUrlSafety("")).toBe("blocked");
  });

  it("custom scheme 返回 prompt", () => {
    expect(checkUrlSafety("myapp://open")).toBe("prompt");
  });
});

describe("permission-policy isServerUrl (V10 Phase 4)", () => {
  it("匹配 Server origin 返回 true", () => {
    expect(isServerUrl("https://snow.example.com/path", ["https://snow.example.com"])).toBe(true);
  });

  it("不匹配返回 false", () => {
    expect(isServerUrl("https://evil.example.com/path", ["https://snow.example.com"])).toBe(false);
  });

  it("无效 URL 返回 false", () => {
    expect(isServerUrl("not a url", ["https://snow.example.com"])).toBe(false);
  });

  it("多个 Server origin 中有一个匹配返回 true", () => {
    expect(
      isServerUrl("http://localhost:3000/desktop", [
        "https://snow.example.com",
        "http://localhost:3000",
      ]),
    ).toBe(true);
  });

  it("端口不匹配返回 false", () => {
    expect(isServerUrl("http://localhost:8080", ["http://localhost:3000"])).toBe(false);
  });

  it("空 origin 列表返回 false", () => {
    expect(isServerUrl("https://snow.example.com", [])).toBe(false);
  });

  it("path 不影响 origin 匹配", () => {
    expect(
      isServerUrl("https://snow.example.com/deep/nested/path", ["https://snow.example.com"]),
    ).toBe(true);
  });
});

describe("permission-policy ALLOWED_PERMISSIONS / BLOCKED_SCHEMES 常量 (V10 Phase 4)", () => {
  it("ALLOWED_PERMISSIONS 包含 fullscreen", () => {
    expect(ALLOWED_PERMISSIONS.has("fullscreen")).toBe(true);
  });

  it("ALLOWED_PERMISSIONS 包含 display-capture", () => {
    expect(ALLOWED_PERMISSIONS.has("display-capture")).toBe(true);
  });

  it("ALLOWED_PERMISSIONS 包含 clipboard-sanitized-write", () => {
    expect(ALLOWED_PERMISSIONS.has("clipboard-sanitized-write")).toBe(true);
  });

  it("ALLOWED_PERMISSIONS 不包含 notifications", () => {
    expect(ALLOWED_PERMISSIONS.has("notifications")).toBe(false);
  });

  it("BLOCKED_SCHEMES 包含 file", () => {
    expect(BLOCKED_SCHEMES.has("file")).toBe(true);
  });

  it("BLOCKED_SCHEMES 包含 data", () => {
    expect(BLOCKED_SCHEMES.has("data")).toBe(true);
  });

  it("BLOCKED_SCHEMES 包含 blob", () => {
    expect(BLOCKED_SCHEMES.has("blob")).toBe(true);
  });

  it("BLOCKED_SCHEMES 包含 javascript", () => {
    expect(BLOCKED_SCHEMES.has("javascript")).toBe(true);
  });

  it("BLOCKED_SCHEMES 不包含 http", () => {
    expect(BLOCKED_SCHEMES.has("http")).toBe(false);
  });
});
