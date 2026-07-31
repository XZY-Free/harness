import { describe, expect, it } from "vitest";
import { parseDesktopRoute } from "./desktop-route";

describe("parseDesktopRoute", () => {
  it("将 /desktop 解析为会话入口", () => {
    expect(parseDesktopRoute("/desktop")).toEqual({ kind: "home" });
  });

  it("将 /desktop/new 解析为显式创建空会话的入口", () => {
    expect(parseDesktopRoute("/desktop/new")).toEqual({ kind: "new" });
  });

  it("仅接受 UUID 会话深链", () => {
    expect(parseDesktopRoute("/desktop/chat/6c34a4f3-1b47-4acb-9b2e-7bdbff3e04cf")).toEqual({
      kind: "thread",
      threadId: "6c34a4f3-1b47-4acb-9b2e-7bdbff3e04cf",
    });
  });

  it("拒绝非桌面路由和非法会话标识", () => {
    expect(parseDesktopRoute("/studio")).toEqual({ kind: "not-found" });
    expect(parseDesktopRoute("/desktop/chat/not-a-uuid")).toEqual({ kind: "not-found" });
  });
});
