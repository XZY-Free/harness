/**
 * UserActionItem（input 类型）External A2A input-required → Web submit 主流程组件测试（RED）。
 *
 * 已知生产缺口（不修改生产代码，先写失败测试）：
 * 1. UserActionItem 通过 useUserAction.resolve(item.id, ...) 提交，而 UserActionRequest 的
 *    真实 id 在 ThreadItem.contentJson.request_id（且 item.id != request.id），真实页面会 404。
 * 2. 提交按钮不按 input_schema（required/minLength/maxLength）校验，空白输入也会发起网络请求，
 *    把 UserActionRequest/Invocation 消费掉后 transport 才失败，用户无法重试。
 * 3. 字段无 title 时 label 直接显示技术键 `text`。
 *
 * 约束：真实 DOM 交互（fireEvent），mock fetch，不调用组件内部函数。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserActionItem } from "./user-action-item";

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string", minLength: 1, maxLength: 20_000, pattern: "\\S" } },
};

/** 真实形态：item.id 与 content.request_id 是两个不同的 id（连续真实流程）。 */
function makeInputItem(overrides?: Record<string, unknown>) {
  return {
    id: "item-1",
    turn_id: "turn-1",
    item_sequence: 1,
    item_type: "user_action" as const,
    item_state: "pending" as const,
    content: {
      kind: "user_action.requested",
      request_type: "input",
      purpose: "a2a_input_required",
      state: "pending",
      prompt: "请提供请假事由",
      request_id: "request-1",
      input_schema: INPUT_SCHEMA,
      ...overrides,
    },
    created_at: new Date().toISOString(),
  };
}

function makeFetchMock() {
  return vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ ok: true, data: { request_id: "request-1", resolution: "submit" } }),
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UserActionItem input submit 主流程", () => {
  it("提交使用 content.request_id（request-1）而非 item.id，body 为精确脱敏对象", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<UserActionItem threadId="thread-1" item={makeInputItem()} />);

    const input = container.querySelector<HTMLInputElement>("#ua-input-item-1-text");
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { value: "年休假，明天一天" } });

    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // RED：当前实现用 item.id，真实页面 404。
    expect(url).toBe("/api/v1/threads/thread-1/user-actions/request-1/resolve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      resolution: "submit",
      response_redacted: { text: "年休假，明天一天" },
    });
    expect(url).not.toContain("item-1");
  });

  it("空白输入：提交按钮禁用且零网络请求", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<UserActionItem threadId="thread-1" item={makeInputItem()} />);

    const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
    // RED：当前实现不按 minLength:1 校验，按钮可点击且会发请求。
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("字段无 title 时 label 不暴露技术键 text（默认中文 label）", () => {
    vi.stubGlobal("fetch", makeFetchMock());

    render(<UserActionItem threadId="thread-1" item={makeInputItem()} />);

    // 不暴露裸技术键 `text`，回落到中文默认 label「补充信息」。
    expect(screen.queryByText(/^text\*?$/)).toBeNull();
    expect(screen.getByText(/补充信息\*?/)).toBeTruthy();
  });

  it("content.request_id 缺失：fail-closed，所有按钮不可用、零网络，显示可恢复中文提示（绝不 fallback 到 item.id）", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<UserActionItem threadId="thread-1" item={makeInputItem({ request_id: undefined })} />);

    expect(screen.getByText(/操作信息不完整/)).toBeTruthy();

    const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
    const cancel = screen.getByRole("button", { name: "取消" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    fireEvent.click(submit);
    fireEvent.click(cancel);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("content.request_id 空白字符串：同样 fail-closed，零网络", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<UserActionItem threadId="thread-1" item={makeInputItem({ request_id: "   " })} />);

    const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("item-1"))).toBe(true);
  });
});

describe("UserActionItem input schema omitted/required 语义与 fail-closed", () => {
  const OPTIONAL_NOTE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 20_000, pattern: "\\S" },
      note: { type: "string", maxLength: 100 },
    },
  };

  const REQUIRED_BOOLEAN_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["text", "consent"],
    properties: {
      text: { type: "string", minLength: 1, pattern: "\\S" },
      consent: { type: "boolean" },
    },
  };

  it("可选 note 留空：不阻塞提交，body 精确省略 note 键", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <UserActionItem
        threadId="thread-1"
        item={makeInputItem({ input_schema: OPTIONAL_NOTE_SCHEMA })}
      />,
    );
    fireEvent.change(container.querySelector<HTMLInputElement>("#ua-input-item-1-text")!, {
      target: { value: "年休假，明天一天" },
    });

    const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.response_redacted).toEqual({ text: "年休假，明天一天" });
  });

  it("可选 note 填写：trim 后包含在提交对象中", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <UserActionItem
        threadId="thread-1"
        item={makeInputItem({ input_schema: OPTIONAL_NOTE_SCHEMA })}
      />,
    );
    fireEvent.change(container.querySelector<HTMLInputElement>("#ua-input-item-1-text")!, {
      target: { value: "年休假，明天一天" },
    });
    fireEvent.change(container.querySelector<HTMLInputElement>("#ua-input-item-1-note")!, {
      target: { value: "  备注内容  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.response_redacted).toEqual({ text: "年休假，明天一天", note: "备注内容" });
  });

  it("必填 boolean 未选择：提交禁用零网络；选择否提交布尔 false 而非字符串", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <UserActionItem
        threadId="thread-1"
        item={makeInputItem({ input_schema: REQUIRED_BOOLEAN_SCHEMA })}
      />,
    );
    fireEvent.change(container.querySelector<HTMLInputElement>("#ua-input-item-1-text")!, {
      target: { value: "年休假，明天一天" },
    });

    // boolean 未显式选择：必填不满足。
    const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();

    // 显式选择「否」：提交实际布尔值 false。
    const consent = container.querySelector<HTMLSelectElement>("#ua-input-item-1-consent");
    expect(consent).toBeTruthy();
    fireEvent.change(consent!, { target: { value: "false" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.response_redacted).toEqual({ text: "年休假，明天一天", consent: false });
    expect(typeof body.response_redacted.consent).toBe("boolean");
  });

  const UNSUSABLE_SCHEMAS: Array<[string, unknown]> = [
    ["缺失 input_schema", undefined],
    ["空 properties", { type: "object", additionalProperties: false, properties: {} }],
    [
      "不支持的字段类型",
      { type: "object", properties: { text: { type: "array" } }, required: ["text"] },
    ],
  ];

  it.each(UNSUSABLE_SCHEMAS)(
    "input_schema %s：提交禁用、显示中文 fail-closed 提示、零网络、取消仍可用",
    async (_name, input_schema) => {
      const fetchMock = makeFetchMock();
      vi.stubGlobal("fetch", fetchMock);

      render(<UserActionItem threadId="thread-1" item={makeInputItem({ input_schema })} />);

      expect(screen.getByText(/输入定义不可用/)).toBeTruthy();
      const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
      const cancel = screen.getByRole("button", { name: "取消" }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      expect(cancel.disabled).toBe(false); // 取消只受 request_id 约束
      fireEvent.click(submit);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetchMock).not.toHaveBeenCalled();
      cleanup();
    },
  );

  it("非法正则 pattern：fail-closed，提交禁用零网络", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <UserActionItem
        threadId="thread-1"
        item={makeInputItem({
          input_schema: {
            type: "object",
            required: ["text"],
            properties: { text: { type: "string", pattern: "[" } },
          },
        })}
      />,
    );

    const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
