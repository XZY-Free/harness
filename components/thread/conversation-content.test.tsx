import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ClientItem } from "@/lib/client/types";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageItem } from "./items/assistant-message-item";
import { UserMessageItem } from "./items/user-message-item";
import { NewThreadPage } from "./new-thread-page";
import { ThreadInput } from "./thread-input";
import { ThreadTimeline } from "./thread-timeline";
import { TurnFailureNotice } from "./turn-failure-notice";

const globalsCss = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

/** 构造最小 ClientItem 供消息 Item 组件渲染。 */
function makeItem(type: "user_message" | "assistant_message", text: string): ClientItem {
  return {
    id: `item-${type}`,
    turn_id: "turn-1",
    item_sequence: 1,
    item_type: type,
    item_state: "completed",
    content: { text },
    created_at: "2026-08-14T00:00:00.000Z",
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 断言根内存在指定轨道类，并返回该元素（结构合同：语义 class，不读源码字符串）。 */
function firstByClass(root: HTMLElement, cls: string): HTMLElement {
  const el = root.querySelector(`.${cls}`);
  expect(el, `应包含轨道类 ${cls}`).not.toBeNull();
  return el as HTMLElement;
}

function stubModelsFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: { models: [{ id: "deepseek-v4-flash" }], defaultModel: "deepseek-v4-flash" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
}

/** 构造运行中 Turn（controls 可控）供 ThreadInput 渲染。 */
function makeRunningTurn(cancelSupported: boolean) {
  return {
    controls: {
      cancel_supported: cancelSupported,
      resume_supported: false,
      steer_supported: false,
    },
    id: "turn-running",
    preferred_agent_id: null,
    agent_use_mode: null,
    turn_sequence: 1,
    trigger_type: "message",
    trigger_ref: null,
    trigger_item_id: null,
    turn_state: "running",
    active_invocation_id: "inv-1",
    latest_invocation_id: "inv-1",
    adopted_invocation_id: null,
    final_item_id: null,
    error_code: null,
    regeneration_no: 0,
    accepted_at: "2026-08-26T00:00:00.000Z",
    started_at: "2026-08-26T00:00:01.000Z",
    waiting_at: null,
    finished_at: null,
  } as const;
}

describe("ThreadInput Stop 按钮 capability 门禁（05 §10）", () => {
  it("运行中 Turn 且 controls.cancel_supported=true → 渲染停止按钮", () => {
    stubModelsFetch();
    const { container } = render(
      <ThreadInput threadId="thread-1" latestTurn={makeRunningTurn(true)} availableAgents={[]} />,
    );
    expect(container.querySelector('[aria-label="停止任务"]')).not.toBeNull();
  });

  it("controls.cancel_supported=false → 无可点击 Stop（不发送 interrupt API）", () => {
    stubModelsFetch();
    const { container } = render(
      <ThreadInput threadId="thread-1" latestTurn={makeRunningTurn(false)} availableAgents={[]} />,
    );
    expect(container.querySelector('[aria-label="停止任务"]')).toBeNull();
  });
});

describe("消息轨道与输入轨道拆分", () => {
  it("ThreadTimeline 使用独立消息轨道 .message-track，不再使用 composer 轨道或旧共享类", () => {
    const { container } = render(<ThreadTimeline items={[]} streamStatus="idle" />);
    firstByClass(container, "message-track");
    expect(container.querySelector(".composer-track")).toBeNull();
    expect(container.querySelector(".conversation-content")).toBeNull();
  });

  it("ThreadInput composer 使用独立输入轨道 .composer-track，与消息轨道不同", () => {
    stubModelsFetch();
    const { container } = render(
      <ThreadInput threadId="t-1" latestTurn={null} availableAgents={[]} />,
    );
    const composer = firstByClass(container, "composer-track");
    expect(container.querySelector(".message-track")).toBeNull();
    expect(container.querySelector(".conversation-content")).toBeNull();
    // composer 轨道仍随 sticky 固定底部
    expect(composer.closest(".sticky")?.className).toContain("bottom-0");
  });

  it("TurnFailureNotice 使用输入轨道 .composer-track", () => {
    const { container } = render(<TurnFailureNotice turnState="failed" errorCode="X" />);
    firstByClass(container, "composer-track");
    expect(container.querySelector(".message-track")).toBeNull();
  });

  it("消息轨道与 composer 轨道是两类不同规则（Timeline 与 ThreadInput 各自轨道互不相同）", () => {
    stubModelsFetch();
    const timelineEls = render(
      <ThreadTimeline items={[]} streamStatus="idle" />,
    ).container.querySelectorAll(".message-track");
    const composerEls = render(
      <ThreadInput threadId="t-1" latestTurn={null} availableAgents={[]} />,
    ).container.querySelectorAll(".composer-track");
    expect(timelineEls.length).toBeGreaterThan(0);
    expect(composerEls.length).toBeGreaterThan(0);
    // 两类轨道是不同 DOM 元素，不共享同一容器
    expect(timelineEls[0]).not.toBe(composerEls[0]);
  });

  it("新会话空态按语义选轨道：时间线走 .message-track，错误提示走 .composer-track", () => {
    stubModelsFetch();
    const { container } = render(
      <NewThreadPage agents={[]} error="发送失败" onSubmit={async () => true} surface="web" />,
    );
    // 空态文案位于消息轨道内
    const messageTrack = firstByClass(container, "message-track");
    expect(messageTrack.textContent).toContain("还没有消息");
    // 错误提示位于输入轨道内
    const composerTrack = container.querySelector(".composer-track");
    expect(composerTrack?.textContent).toContain("发送失败");
  });
});

describe("用户/助手消息共享 message-track 宽度体系", () => {
  it("用户消息行与助手消息行都使用共享 .message-row 结构，各占同一轨道全宽", () => {
    const user = render(<UserMessageItem item={makeItem("user_message", "你好")} />).container;
    const agent = render(
      <AssistantMessageItem item={makeItem("assistant_message", "回复正文")} />,
    ).container;

    // 共享行结构：两种消息都在 .message-row 内
    expect(user.querySelector(".message-row")).not.toBeNull();
    expect(agent.querySelector(".message-row")).not.toBeNull();
  });

  it("用户/助手各自保留语义 class（conversation-user-bubble / conversation-copy）", () => {
    const user = render(<UserMessageItem item={makeItem("user_message", "你好")} />).container;
    const agent = render(
      <AssistantMessageItem item={makeItem("assistant_message", "回复正文")} />,
    ).container;

    expect(user.querySelector(".conversation-user-bubble")).not.toBeNull();
    expect(agent.querySelector(".conversation-copy")).not.toBeNull();
  });

  it("用户气泡不再用组件内重复 Tailwind max-w-[80%]，宽度只由全局 CSS 控制", () => {
    const { container } = render(<UserMessageItem item={makeItem("user_message", "你好")} />);
    const bubble = container.querySelector(".conversation-user-bubble") as HTMLElement;
    expect(bubble.className).not.toContain("max-w-[");
  });
});

describe("globals.css 消息宽度合同（读取真实样式文件）", () => {
  it("消息轨道 .message-track 不再以固定 px 限制宽度", () => {
    const trackBlock = globalsCss.match(/\.message-track\s*\{[^}]*\}/)?.[0] ?? "";
    expect(trackBlock).toContain("width: 100%");
    // 允许响应式安全 gutter（padding-inline），但消息轨道本身不得有固定 max-width px
    expect(trackBlock).not.toMatch(/max-width\s*:\s*[\d.]+px/);
  });

  it("助手正文 .conversation-copy 不再使用 76ch 固定可读宽度", () => {
    const copyBlock = globalsCss.match(/\.conversation-copy\s*\{[^}]*\}/)?.[0] ?? "";
    expect(copyBlock).not.toMatch(/max-width\s*:\s*[^;]*ch/);
  });

  it("消息宽度由相对百分比管理，且每个响应式档位 assistant % > user %", () => {
    // 用括号配平提取每个 @media 完整块（含内层嵌套花括号），避免被子块截断
    function extractMediaBlocks(css: string): string[] {
      const blocks: string[] = [];
      const re = /@media\s*\([^{]*\)\s*\{/g;
      let m: RegExpExecArray | null = re.exec(css);
      while (m !== null) {
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < css.length && depth > 0) {
          if (css[i] === "{") depth++;
          else if (css[i] === "}") depth--;
          i++;
        }
        blocks.push(css.slice(m.index, i));
        m = re.exec(css);
      }
      return blocks;
    }

    // 作用域 = 顶层 :root 默认 + 各 @media 断点
    const scopes = [globalsCss, ...extractMediaBlocks(globalsCss)];

    const userVals: number[] = [];
    const assistantVals: number[] = [];

    for (const scope of scopes) {
      const user = scope.match(/--conversation-user-max\s*:\s*([\d.]+)%/);
      const assistant = scope.match(/--conversation-assistant-max\s*:\s*([\d.]+)%/);
      if (user && assistant) {
        userVals.push(Number(user[1]));
        assistantVals.push(Number(assistant[1]));
      }
    }

    expect(userVals.length).toBeGreaterThanOrEqual(3); // 至少移动/中/宽三档
    expect(assistantVals.length).toBe(userVals.length);
    // 每个档位助手正文可用宽度都必须严格大于用户气泡上限
    for (let i = 0; i < userVals.length; i++) {
      expect(assistantVals[i]!).toBeGreaterThan(userVals[i]!);
    }
  });

  it("用户气泡上限与助手正文上限都必须是相对百分比，不用 px/ch 写死", () => {
    const bubbleBlock = globalsCss.match(/\.conversation-user-bubble\s*\{[^}]*\}/)?.[0] ?? "";
    const copyBlock = globalsCss.match(/\.conversation-copy\s*\{[^}]*\}/)?.[0] ?? "";
    expect(bubbleBlock).toMatch(/max-width\s*:\s*var\(--conversation-user-max\)/);
    expect(copyBlock).toMatch(/max-width\s*:\s*var\(--conversation-assistant-max\)/);
  });
});
