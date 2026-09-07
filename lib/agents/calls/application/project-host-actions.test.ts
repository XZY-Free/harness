import {
  HostActionProjectionAuthorizationError,
  projectHostActionForThread,
} from "@/lib/agents/calls/application/project-host-actions";
import type { HostAction } from "@/lib/agents/calls/transport/a2a/host-control-contract";
import { describe, expect, it } from "vitest";

const platformPolicy = {
  externalAllowedHosts: ["docs.example.test", "support.example.test"],
};

function action(overrides: Partial<HostAction> = {}): HostAction {
  return {
    action_id: "open-thread",
    action_type: "navigate",
    title: "打开当前会话",
    label: "打开",
    description: null,
    target_key: "thread.current",
    url: null,
    web_path: null,
    client_support: { web: true, desktop: true },
    ...overrides,
  };
}

describe("projectHostActionForThread", () => {
  it("只为当前会话 owner 将 catalog 目标投影成真实 /chat/:threadId 路径", () => {
    expect(
      projectHostActionForThread(action(), {
        tenantId: "tenant-1",
        threadId: "thread-1",
        threadOwnerUserId: "user-1",
        executionSubject: { tenantId: "tenant-1", subjectType: "user", subjectId: "user-1" },
        platformPolicy,
      }),
    ).toMatchObject({ web_path: "/chat/thread-1", url: null });
  });

  it("拒绝非 owner 或 service 主体把 thread.current 投影为可导航路径", () => {
    for (const executionSubject of [
      { tenantId: "tenant-1", subjectType: "user" as const, subjectId: "user-2" },
      { tenantId: "tenant-1", subjectType: "service" as const, subjectId: "service-1" },
    ]) {
      expect(() =>
        projectHostActionForThread(action(), {
          tenantId: "tenant-1",
          threadId: "thread-1",
          threadOwnerUserId: "user-1",
          executionSubject,
          platformPolicy,
        }),
      ).toThrow(HostActionProjectionAuthorizationError);
    }
  });

  it("持久化前再次拒绝未登记的外链 host，防止绕过 A2A 解析器", () => {
    expect(() =>
      projectHostActionForThread(
        action({
          action_type: "open_external_link",
          target_key: null,
          url: "https://untrusted.example.test/path",
        }),
        {
          tenantId: "tenant-1",
          threadId: "thread-1",
          threadOwnerUserId: "user-1",
          executionSubject: { tenantId: "tenant-1", subjectType: "user", subjectId: "user-1" },
          platformPolicy,
        },
      ),
    ).toThrow("Host Action 外链非法");
  });

  it("拒绝已删除的专用支持动作", () => {
    expect(() =>
      projectHostActionForThread(
        {
          ...action(),
          action_type: "offer_human_support",
          target_key: null,
          url: "https://support.example.test/help-a",
        } as unknown as HostAction,
        {
          tenantId: "tenant-1",
          threadId: "thread-1",
          threadOwnerUserId: "user-1",
          executionSubject: { tenantId: "tenant-1", subjectType: "user", subjectId: "user-1" },
          platformPolicy,
        },
      ),
    ).toThrow("Host Action 类型非法");
  });
});
