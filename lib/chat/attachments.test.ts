import type { ChatMessage } from "@/lib/types";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_TEXT_PREFIX,
  isAttachmentTextPart,
  normalizeAttachmentParts,
} from "./attachments";

describe("normalizeAttachmentParts", () => {
  it("data-attachment 保留展示数据，并追加模型可读 text part", () => {
    const message: ChatMessage = {
      id: "m1",
      role: "user",
      parts: [
        {
          type: "data-attachment",
          data: { filename: "spec.md", text: "# Spec", charCount: 6 },
        },
        { type: "text", text: "请按附件实现" },
      ],
    };

    const normalized = normalizeAttachmentParts(message);

    expect(normalized.parts).toHaveLength(3);
    expect(normalized.parts[0]).toEqual(message.parts[0]);
    expect(normalized.parts[1]).toMatchObject({
      type: "text",
      text: `${ATTACHMENT_TEXT_PREFIX} spec.md (6 字符)]\n# Spec`,
    });
    const attachmentTextPart = normalized.parts[1];
    expect(attachmentTextPart).toBeDefined();
    if (!attachmentTextPart) throw new Error("expected attachment text part");
    expect(isAttachmentTextPart(attachmentTextPart)).toBe(true);
    expect(normalized.parts[2]).toEqual({ type: "text", text: "请按附件实现" });
  });

  it("兼容旧 attachment part，归一化成 data-attachment + text", () => {
    const legacy = {
      id: "m1",
      role: "user",
      parts: [
        {
          type: "attachment",
          filename: "old.txt",
          text: "legacy",
          charCount: 6,
        },
      ],
    } as unknown as ChatMessage;

    const normalized = normalizeAttachmentParts(legacy);

    expect(normalized.parts[0]).toEqual({
      type: "data-attachment",
      data: { filename: "old.txt", text: "legacy", charCount: 6 },
    });
    expect(normalized.parts[1]).toMatchObject({
      type: "text",
      text: `${ATTACHMENT_TEXT_PREFIX} old.txt (6 字符)]\nlegacy`,
    });
  });
});
