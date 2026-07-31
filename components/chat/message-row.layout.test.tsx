import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageRow } from "./message-row";

vi.mock("@/lib/chat/attachments", () => ({
  isAttachmentDataPart: () => false,
  isAttachmentTextPart: () => false,
}));
vi.mock("@/lib/chat/internal-tools", () => ({
  isInternalToolPart: () => false,
}));
vi.mock("@/components/markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => children ?? null,
}));
vi.mock("@/components/icons", () => ({
  Icon: new Proxy(
    {},
    {
      get: () => () => null,
    },
  ),
}));

const baseHandlers = {
  onEditTextChange: vi.fn(),
  onConfirmEdit: vi.fn(),
  onCancelEdit: vi.fn(),
  onStartEdit: vi.fn(),
  onCopy: vi.fn(),
  onRegenerate: vi.fn(),
};

afterEach(() => {
  cleanup();
});

describe("MessageRow 响应式布局", () => {
  it("user 消息不使用大容器百分比固定宽度", () => {
    render(
      <MessageRow
        message={{
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "这是用户消息" }],
        }}
        isLastAssistant={false}
        isStreamingThis={false}
        isEditing={false}
        isLastUser
        editText=""
        busy={false}
        {...baseHandlers}
      />,
    );

    const content = screen.getByTestId("message-content");
    expect(content.className).toContain("max-w-[85%]");
    expect(content.className).not.toContain("w-3/5");
  });

  it("assistant 消息按主栏比例伸缩，与 user 消息保持对称宽度", () => {
    render(
      <MessageRow
        message={{
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "这是 AI 回复" }],
        }}
        isLastAssistant
        isStreamingThis={false}
        isEditing={false}
        isLastUser={false}
        editText=""
        busy={false}
        {...baseHandlers}
      />,
    );

    const content = screen.getByTestId("message-content");
    expect(content.className).toContain("w-[85%]");
    expect(content.className).toContain("max-sm:w-full");
    expect(content.className).not.toContain("w-4/5");
  });
});
