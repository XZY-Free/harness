import type { ClientItem } from "@/lib/v11/client/types";
/**
 * S10-W02：V11 Item 渲染组件测试。
 *
 * 覆盖 7 种 item_type 的关键渲染行为：
 * - UserMessageItem：user_message / user_guidance；pending 透明度；attachments 占位
 * - AgentMessageItem：pending 光标；failed 错误提示
 * - ToolCallItem：折叠/展开；状态标签；error 展示
 * - ArtifactItem：title/content_type/size 展示
 * - UserActionItem：request_type 中文映射；状态标签
 * - ChildThreadItem：state 中文映射；跳转链接
 * - JobResultItem：进度条；结果摘要；错误信息
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMessageItem } from "./items/agent-message-item";
import { ArtifactItem } from "./items/artifact-item";
import { ChildThreadItem } from "./items/child-thread-item";
import { JobResultItem } from "./items/job-result-item";
import { ToolCallItem } from "./items/tool-call-item";
import { UserActionItem } from "./items/user-action-item";
import { UserMessageItem } from "./items/user-message-item";

afterEach(() => {
  cleanup();
});

function buildItem(overrides: Partial<ClientItem> = {}): ClientItem {
  return {
    id: "item-001",
    turn_id: "turn-001",
    item_sequence: 1,
    item_type: "user_message",
    item_state: "completed",
    content: {},
    created_at: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

// ─── UserMessageItem ────────────────────────────────────

describe("UserMessageItem", () => {
  it("user_message 渲染文本", () => {
    render(<UserMessageItem item={buildItem({ content: { text: "用户消息" } })} />);
    const text = screen.getByText("用户消息");
    expect(text).not.toBeNull();
    expect(text.parentElement?.className).toContain("conversation-user-bubble");
  });

  it("text 为空时不生成假消息", () => {
    const { container } = render(<UserMessageItem item={buildItem({ content: {} })} />);
    expect(container.innerHTML).toBe("");
  });

  it("user_guidance 显示「引导」标签", () => {
    render(
      <UserMessageItem
        item={buildItem({
          item_type: "user_guidance",
          content: { text: "请更详细" },
        })}
      />,
    );
    expect(screen.getByText("请更详细")).not.toBeNull();
    expect(screen.getByText("引导")).not.toBeNull();
  });

  it("user_guidance pending 时显示「引导待确认」", () => {
    render(
      <UserMessageItem
        item={buildItem({
          item_type: "user_guidance",
          item_state: "pending",
          content: { text: "待确认引导" },
        })}
      />,
    );
    expect(screen.getByText("引导待确认")).not.toBeNull();
  });
});

// ─── AgentMessageItem ───────────────────────────────────

describe("AgentMessageItem", () => {
  it("渲染 Agent 消息文本", () => {
    render(<AgentMessageItem item={buildItem({ content: { text: "Agent 回复" } })} />);
    const text = screen.getByText("Agent 回复");
    expect(text).not.toBeNull();
    expect(text.className).toContain("conversation-copy");
  });

  it("text 为空时不生成假消息", () => {
    const { container } = render(<AgentMessageItem item={buildItem({ content: {} })} />);
    expect(container.innerHTML).toBe("");
  });

  it("item_state=failed 时显示「生成失败」", () => {
    render(
      <AgentMessageItem
        item={buildItem({
          item_state: "failed",
          content: { text: "部分回复" },
        })}
      />,
    );
    expect(screen.getByText("部分回复")).not.toBeNull();
    expect(screen.getByText("生成失败")).not.toBeNull();
  });
});

// ─── ToolCallItem ───────────────────────────────────────

describe("ToolCallItem", () => {
  it("渲染 tool_display_name 优先于 tool_name", () => {
    render(
      <ToolCallItem
        item={buildItem({
          item_type: "tool_call",
          content: {
            tool_name: "read_file",
            tool_display_name: "读取文件",
            status: "completed",
          },
        })}
      />,
    );
    expect(screen.getByText("读取文件")).not.toBeNull();
  });

  it("无 tool_display_name 时回退到 tool_name", () => {
    render(
      <ToolCallItem
        item={buildItem({
          item_type: "tool_call",
          content: { tool_name: "write_file", status: "completed" },
        })}
      />,
    );
    expect(screen.getByText("write_file")).not.toBeNull();
  });

  it("点击展开后显示 input/output/error", () => {
    render(
      <ToolCallItem
        item={buildItem({
          item_type: "tool_call",
          content: {
            tool_name: "search",
            status: "failed",
            input: { query: "test" },
            output: { results: [] },
            error: "网络超时",
          },
        })}
      />,
    );
    // 默认折叠，点击展开
    fireEvent.click(screen.getByText("search"));
    expect(screen.getByText("输入")).not.toBeNull();
    expect(screen.getByText("输出")).not.toBeNull();
    expect(screen.getByText("错误")).not.toBeNull();
    expect(screen.getByText("网络超时")).not.toBeNull();
  });

  it("pending 状态显示「执行中」", () => {
    render(
      <ToolCallItem
        item={buildItem({
          item_type: "tool_call",
          item_state: "pending",
          content: { tool_name: "running_tool" },
        })}
      />,
    );
    expect(screen.getByText("执行中")).not.toBeNull();
  });
});

// ─── ArtifactItem ───────────────────────────────────────

describe("ArtifactItem", () => {
  it("渲染 title + content_type + size", () => {
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: {
            title: "report.pdf",
            content_type: "application/pdf",
            size: 10240,
          },
        })}
      />,
    );
    expect(screen.getByText("report.pdf")).not.toBeNull();
    expect(screen.getByText(/application\/pdf/)).not.toBeNull();
    expect(screen.getByText(/10\.0 KB/)).not.toBeNull();
  });

  it("无 title 时回退「未命名文件」", () => {
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: { content_type: "text/plain" },
        })}
      />,
    );
    expect(screen.getByText("未命名文件")).not.toBeNull();
  });

  it("无 size 时不展示文件大小", () => {
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: { title: "no_size.txt", content_type: "text/plain" },
        })}
      />,
    );
    expect(screen.queryByText(/KB/)).toBeNull();
  });

  it("展示来源 Turn/Invocation/ToolCall + hash + 位置（W05）", () => {
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: {
            artifact_id: "art_001",
            display_name: "月报.xlsx",
            media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            byte_size: 48231,
            content_hash: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            content_ref: "s3://snow-artifacts/art_001/monthly.xlsx",
            visibility_scope: "thread",
            source_turn_id: "turn_001",
            source_invocation_id: "inv_001",
            source_tool_call_id: "tc_001",
          },
        })}
      />,
    );
    // 来源
    expect(screen.getByText("turn_001")).not.toBeNull();
    expect(screen.getByText("inv_001")).not.toBeNull();
    expect(screen.getByText("tc_001")).not.toBeNull();
    // hash 截断显示（sha256:abcdef0123456789…）
    expect(screen.getByText(/sha256:abcdef0123456789/)).not.toBeNull();
    // 位置去掉 scheme:// 前缀
    expect(screen.getByText(/snow-artifacts\/art_001/)).not.toBeNull();
    // visibility_scope 标签
    expect(screen.getByText("thread")).not.toBeNull();
  });

  it("默认 availability=cloud，下载按钮 enabled", () => {
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: { artifact_id: "art_002", display_name: "a.txt", media_type: "text/plain" },
        })}
      />,
    );
    const btn = screen.getByRole("button", { name: "下载" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("availability=cloud，点击按钮触发 onOpen", () => {
    let clicked: { id: string; avail: string } | null = null;
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: { artifact_id: "art_003", display_name: "a.txt", availability: "cloud" },
        })}
        onOpen={(id, avail) => {
          clicked = { id, avail };
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(clicked).toEqual({ id: "art_003", avail: "cloud" });
  });

  it("availability=local + Web 模式 → 显示「等待设备」+ 提示，按钮 disabled（不伪造本地访问）", () => {
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: {
            artifact_id: "art_004",
            display_name: "local.txt",
            availability: "local",
            device_id: "dev_laptop_01",
          },
        })}
        // 默认 isDesktop=false → Web 模式
      />,
    );
    const btn = screen.getByRole("button", { name: "等待设备" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/dev_laptop_01/)).not.toBeNull();
    expect(screen.getByText(/请在该设备打开/)).not.toBeNull();
  });

  it("availability=local + Desktop 模式 + device_id 匹配 → 「在 Desktop 打开」enabled", () => {
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: {
            artifact_id: "art_005",
            display_name: "local.txt",
            availability: "local",
            device_id: "dev_laptop_01",
          },
        })}
        isDesktop
        currentDeviceId="dev_laptop_01"
      />,
    );
    const btn = screen.getByRole("button", { name: "在 Desktop 打开" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("availability=local + Desktop 模式 + device_id 不匹配 → 等待设备 + 提示", () => {
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: {
            artifact_id: "art_006",
            display_name: "local.txt",
            availability: "local",
            device_id: "dev_laptop_01",
          },
        })}
        isDesktop
        currentDeviceId="dev_other_02"
      />,
    );
    const btn = screen.getByRole("button", { name: "等待设备" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/dev_laptop_01/)).not.toBeNull();
    expect(screen.getByText(/当前 Desktop 不是该设备/)).not.toBeNull();
  });

  it("availability=pending_device → 等待设备 + 上线提示", () => {
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: {
            artifact_id: "art_007",
            display_name: "wait.txt",
            availability: "pending_device",
            device_id: "dev_laptop_01",
          },
        })}
      />,
    );
    expect((screen.getByRole("button", { name: "等待设备" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/等待 Desktop 设备 dev_laptop_01 上线/)).not.toBeNull();
  });

  it("availability=unavailable → 暂不可用 + 提示", () => {
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: {
            artifact_id: "art_008",
            display_name: "gone.txt",
            availability: "unavailable",
          },
        })}
      />,
    );
    expect((screen.getByRole("button", { name: "暂不可用" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Artifact 暂不可用")).not.toBeNull();
  });

  it("MB 级大小正确格式化", () => {
    render(
      <ArtifactItem
        item={buildItem({
          item_type: "artifact",
          content: {
            display_name: "big.bin",
            media_type: "application/octet-stream",
            byte_size: 5 * 1024 * 1024,
          },
        })}
      />,
    );
    expect(screen.getByText(/5\.0 MB/)).not.toBeNull();
  });
});

// ─── UserActionItem ─────────────────────────────────────

describe("UserActionItem", () => {
  it("带 diff 的高影响确认按原型显示查看差异、确认写入和目标文件", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          item_state: "pending",
          content: {
            request_type: "confirmation",
            title: "写入 report.md",
            summary: "高影响操作 · +86 行 · 等待确认",
            state: "pending",
            target_path: "workspaces/sales/report.md",
            line_additions: 86,
            line_deletions: 0,
            diff: "+ | 周次 | 华东 | 华北 | 合计 |",
          },
        })}
      />,
    );

    expect(screen.getByText("workspaces/sales/report.md")).not.toBeNull();
    expect(screen.getByText("+86")).not.toBeNull();
    expect(screen.getByText("-0")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看差异" }));
    expect(screen.getByText("+ | 周次 | 华东 | 华北 | 合计 |")).not.toBeNull();
    expect(screen.getByRole("button", { name: "确认写入" })).not.toBeNull();
  });

  it("带 diff 的确认完成后保留查看差异入口", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          item_state: "completed",
          content: {
            request_type: "confirmation",
            title: "写入 report.md",
            summary: "已写入 · +86 行",
            state: "resolved",
            target_path: "workspaces/sales/report.md",
            line_additions: 86,
            line_deletions: 0,
            diff: "+ report",
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看差异 ›" }));
    expect(screen.getByText("+ report")).not.toBeNull();
  });

  it("request_type=confirmation 显示「确认请求」", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          content: { request_type: "confirmation", purpose: "确认删除文件" },
        })}
      />,
    );
    expect(screen.getByText("确认请求")).not.toBeNull();
    expect(screen.getByText("确认删除文件")).not.toBeNull();
  });

  it("request_type=auth 显示「授权请求」", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          content: { request_type: "auth", purpose: "授权访问日历" },
        })}
      />,
    );
    expect(screen.getByText("授权请求")).not.toBeNull();
  });

  it("request_type=input 显示「输入请求」", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          content: { request_type: "input", purpose: "需要补充信息" },
        })}
      />,
    );
    expect(screen.getByText("输入请求")).not.toBeNull();
  });

  it("非 handoff pending 状态显示「待处理」+ 确认/拒绝按钮（enabled）", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          item_state: "pending",
          content: { request_type: "confirmation", purpose: "待确认" },
        })}
      />,
    );
    expect(screen.getByText("待处理")).not.toBeNull();
    // 非 handoff 类型走 useV11UserAction，按钮默认 enabled（busy=false）
    const confirmBtn = screen.getByRole("button", { name: "确认" });
    const rejectBtn = screen.getByRole("button", { name: "拒绝" });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
    expect((rejectBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("request_type=grant 显示「权限授予请求」+ 同意授权/拒绝按钮", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          item_state: "pending",
          content: {
            request_type: "grant",
            purpose: "请求日历读写权限",
            scope: ["calendar:read", "calendar:write"],
            target_tool: "calendar",
            impact: "将允许 Agent 读写你的日历",
          },
        })}
      />,
    );
    expect(screen.getByText("权限授予请求")).not.toBeNull();
    expect(screen.getByText("请求日历读写权限")).not.toBeNull();
    expect(screen.getByText(/calendar:read, calendar:write/)).not.toBeNull();
    // 目标工具 + calendar 跨文本节点，用自定义 matcher 校验
    expect(
      screen.getAllByText((_, el) => el?.textContent?.includes("目标工具：calendar") === true)
        .length,
    ).toBeGreaterThan(0);
    const approveBtn = screen.getByRole("button", { name: "同意授权" });
    const denyBtn = screen.getByRole("button", { name: "拒绝" });
    expect((approveBtn as HTMLButtonElement).disabled).toBe(false);
    expect((denyBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("request_type=auth 显示「授权请求」+ 去授权链接 + 取消授权按钮", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          item_state: "pending",
          content: {
            request_type: "auth",
            purpose: "登录 Google",
            auth_url: "https://accounts.google.com/oauth/authorize",
            scope: ["google:drive"],
          },
        })}
      />,
    );
    expect(screen.getByText("授权请求")).not.toBeNull();
    const link = screen.getByRole("link", { name: "去授权" });
    expect(link.getAttribute("href")).toBe("https://accounts.google.com/oauth/authorize");
    const cancelBtn = screen.getByRole("button", { name: "取消授权" });
    expect((cancelBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("request_type=auth 无 auth_url 时显示「等待授权回调」", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          item_state: "pending",
          content: { request_type: "auth", purpose: "等待回调" },
        })}
      />,
    );
    expect(screen.getByText("等待授权回调")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "去授权" })).toBeNull();
  });

  it("request_type=input 显示输入表单 + 提交/取消按钮", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          item_state: "pending",
          content: {
            request_type: "input",
            purpose: "需要补充信息",
            input_schema: {
              type: "object",
              properties: {
                name: { type: "string", title: "姓名" },
                age: { type: "number", title: "年龄" },
              },
              required: ["name"],
            },
          },
        })}
      />,
    );
    expect(screen.getByText("输入请求")).not.toBeNull();
    expect(screen.getByText("姓名*")).not.toBeNull();
    expect(screen.getByText("年龄")).not.toBeNull();
    expect(screen.getByText("提交")).not.toBeNull();
    expect(screen.getByText("取消")).not.toBeNull();
  });

  it("state=expired 显示「已超时」+ 无操作按钮", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          item_state: "completed",
          content: {
            request_type: "confirmation",
            purpose: "已过期的请求",
            state: "expired",
          },
        })}
      />,
    );
    expect(screen.getByText("已超时")).not.toBeNull();
    expect(screen.getByText("请求已超时，未执行任何操作。")).not.toBeNull();
    // 不应该有操作按钮
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();
  });

  it("expires_at 已过时显示「已超时」+ 无操作按钮", () => {
    const past = new Date(Date.now() - 60000).toISOString();
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          item_state: "pending",
          content: {
            request_type: "confirmation",
            purpose: "已过期的请求",
            expires_at: past,
          },
        })}
      />,
    );
    expect(screen.getByText("已超时")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
  });

  it("expires_at 未来时间显示倒计时", () => {
    const future = new Date(Date.now() + 30 * 60000).toISOString(); // 30 分钟后
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          item_state: "pending",
          content: {
            request_type: "confirmation",
            purpose: "带超时的请求",
            expires_at: future,
          },
        })}
      />,
    );
    expect(screen.getByText(/分钟后超时/)).not.toBeNull();
  });

  it("handoff pending 状态显示「同意交接/拒绝」按钮（enabled）", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          id: "handoff-001",
          item_type: "user_action",
          item_state: "pending",
          content: {
            request_type: "confirmation",
            purpose: "handoff",
            target_agent_id: "agent-002",
            target_agent_display_name: "新 Agent",
            reason: "切换到更专业的 Agent",
          },
        })}
      />,
    );
    expect(screen.getByText("主 Agent 交接请求")).not.toBeNull();
    expect(screen.getByText("切换到更专业的 Agent")).not.toBeNull();
    // "目标 Agent：" 与 display_name 是两个文本节点，分别断言
    expect(screen.getByText(/目标 Agent/)).not.toBeNull();
    expect(screen.getByText("新 Agent")).not.toBeNull();
    const approveBtn = screen.getByRole("button", { name: "同意交接" });
    const rejectBtn = screen.getByRole("button", { name: "拒绝" });
    // 默认不 busy，按钮 enabled
    expect((approveBtn as HTMLButtonElement).disabled).toBe(false);
    expect((rejectBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("completed 状态显示「已完成」", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          item_state: "completed",
          content: { request_type: "confirmation", purpose: "用户已确认" },
        })}
      />,
    );
    // "已完成" 同时出现在状态标签和（可能）purpose 文案中——断言至少一处。
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.getByText("用户已确认")).not.toBeNull();
  });

  it("展示 impact 字段", () => {
    render(
      <UserActionItem
        threadId="t1"
        item={buildItem({
          item_type: "user_action",
          content: {
            request_type: "confirmation",
            purpose: "高风险",
            impact: "删除后不可恢复",
          },
        })}
      />,
    );
    expect(screen.getByText("影响：删除后不可恢复")).not.toBeNull();
  });
});

// ─── ChildThreadItem ────────────────────────────────────

describe("ChildThreadItem", () => {
  it("active 状态显示「进行中」+ 跳转链接", () => {
    render(
      <ChildThreadItem
        item={buildItem({
          item_type: "child_thread",
          content: {
            child_thread_id: "thread-002",
            target_agent_id: "agent-xxxxxxxx",
            state: "active",
          },
        })}
      />,
    );
    expect(screen.getByText("进行中")).not.toBeNull();
    const link = screen.getByRole("link", { name: /查看子任务/ });
    expect(link.getAttribute("href")).toBe("/chat/thread-002");
  });

  it("completed 状态显示「已完成」", () => {
    render(
      <ChildThreadItem
        item={buildItem({
          item_type: "child_thread",
          content: { state: "completed" },
        })}
      />,
    );
    expect(screen.getByText("已完成")).not.toBeNull();
  });

  it("cancelled 状态显示「已取消」", () => {
    render(
      <ChildThreadItem
        item={buildItem({
          item_type: "child_thread",
          content: { state: "cancelled" },
        })}
      />,
    );
    expect(screen.getByText("已取消")).not.toBeNull();
  });

  it("failed 状态显示「失败」+ error_summary", () => {
    render(
      <ChildThreadItem
        item={buildItem({
          item_type: "child_thread",
          content: {
            state: "failed",
            error_summary: "Agent 执行超时",
          },
        })}
      />,
    );
    expect(screen.getByText("失败")).not.toBeNull();
    expect(screen.getByText("Agent 执行超时")).not.toBeNull();
  });

  it("展示 summary 字段", () => {
    render(
      <ChildThreadItem
        item={buildItem({
          item_type: "child_thread",
          content: {
            state: "active",
            summary: "正在生成销售报表",
          },
        })}
      />,
    );
    expect(screen.getByText("正在生成销售报表")).not.toBeNull();
  });
});

// ─── JobResultItem ──────────────────────────────────────

describe("JobResultItem", () => {
  it("pending 状态显示「进行中」+ 进度条", () => {
    render(
      <JobResultItem
        item={buildItem({
          item_type: "job_result",
          item_state: "pending",
          content: {
            job_type: "sales_report",
            status: "running",
            progress: 0.45,
          },
        })}
      />,
    );
    expect(screen.getByText("进行中")).not.toBeNull();
    expect(screen.getByText("45%")).not.toBeNull();
  });

  it("completed 状态显示「完成」+ 结果摘要", () => {
    render(
      <JobResultItem
        item={buildItem({
          item_type: "job_result",
          item_state: "completed",
          content: {
            job_type: "data_export",
            status: "completed",
            result: { rows: 100 },
          },
        })}
      />,
    );
    expect(screen.getByText("完成")).not.toBeNull();
    expect(screen.getByText(/"rows": 100/)).not.toBeNull();
  });

  it("failed 状态显示「失败」+ error 信息", () => {
    render(
      <JobResultItem
        item={buildItem({
          item_type: "job_result",
          item_state: "failed",
          content: {
            job_type: "data_export",
            status: "failed",
            error: "导出失败：磁盘空间不足",
          },
        })}
      />,
    );
    // "失败" 同时出现在状态文案和状态标签中——断言至少一处。
    expect(screen.getAllByText("失败").length).toBeGreaterThan(0);
    expect(screen.getByText("导出失败：磁盘空间不足")).not.toBeNull();
  });

  it("job_type 缺失时回退为「Job」", () => {
    render(
      <JobResultItem
        item={buildItem({
          item_type: "job_result",
          content: {},
        })}
      />,
    );
    expect(screen.getByText("Job")).not.toBeNull();
  });
});
