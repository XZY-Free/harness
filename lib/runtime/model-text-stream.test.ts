import { describe, expect, it, vi } from "vitest";
import { collectModelText } from "./model-text-stream";

async function* stream(parts: Array<{ type: string; text?: string; error?: unknown }>) {
  for (const part of parts) yield part;
}

describe("collectModelText", () => {
  it("拼接文本增量并逐段转发", async () => {
    const emit = vi.fn();
    await expect(
      collectModelText(
        stream([
          { type: "text-delta", text: "真实" },
          { type: "text-delta", text: "回复" },
          { type: "finish" },
        ]),
        emit,
      ),
    ).resolves.toBe("真实回复");
    expect(emit).toHaveBeenNthCalledWith(1, "真实");
    expect(emit).toHaveBeenNthCalledWith(2, "回复");
  });

  it("模型流中的错误必须抛出，不能以空文本伪装完成", async () => {
    const modelError = new Error("Access denied");
    await expect(
      collectModelText(stream([{ type: "error", error: modelError }]), vi.fn()),
    ).rejects.toBe(modelError);
  });

  it("无正文的正常结束也按失败关闭", async () => {
    await expect(collectModelText(stream([{ type: "finish" }]), vi.fn())).rejects.toThrow(
      "模型未返回正文",
    );
  });
});
