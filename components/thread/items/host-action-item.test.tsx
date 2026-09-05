import type { ClientItem } from "@/lib/client/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HostActionItem } from "./host-action-item";

afterEach(cleanup);

function item(action: Record<string, unknown>): ClientItem {
  return {
    id: "host-action-item-1",
    turn_id: "turn-1",
    item_sequence: 1,
    item_type: "host_action",
    item_state: "completed",
    content: { kind: "host_action", ...action },
    created_at: "2026-09-05T00:00:00.000Z",
  };
}

describe("HostActionItem", () => {
  it("navigate 只渲染服务端登记路径，历史回放不自动导航", () => {
    render(
      <HostActionItem
        item={item({
          action_id: "action-1",
          action_type: "navigate",
          title: "打开当前会话",
          label: "打开",
          description: "查看当前会话",
          target_key: "thread.current",
          web_path: "/threads",
          url: null,
        })}
      />,
    );
    const button = screen.getByRole("button", { name: "打开" });
    expect(button).toBeTruthy();
    expect(screen.getByText("查看当前会话")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("外链使用新窗口和 noopener，人工帮助入口无业务副作用", () => {
    render(
      <HostActionItem
        item={item({
          action_id: "action-2",
          action_type: "open_external_link",
          title: "打开帮助文档",
          label: "查看文档",
          description: null,
          target_key: null,
          web_path: null,
          url: "https://docs.example.com/help",
        })}
      />,
    );
    const link = screen.getByRole("link", { name: "查看文档" });
    expect(link.getAttribute("href")).toBe("https://docs.example.com/help");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");

    cleanup();
    render(
      <HostActionItem
        item={item({
          action_id: "action-3",
          action_type: "offer_human_support",
          title: "联系人工支持",
          label: "联系支持",
          description: null,
          target_key: null,
          web_path: null,
          url: null,
        })}
      />,
    );
    expect(screen.getByText("当前未配置人工入口")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "当前未配置人工入口" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
