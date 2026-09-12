import { describe, expect, it, vi } from "vitest";
import { collectModelText } from "./model-text-stream";

async function* stream(
  parts: Array<{ type: string; text?: string; error?: unknown; finishReason?: string }>,
) {
  for (const part of parts) yield part;
}

describe("collectModelText", () => {
  it("拼接文本增量并逐段转发，返回 finishReason", async () => {
    const emit = vi.fn();
    const collected = await collectModelText(
      stream([
        { type: "text-delta", text: "真实" },
        { type: "text-delta", text: "回复" },
        { type: "finish", finishReason: "stop" },
      ]),
      emit,
    );
    expect(collected.text).toBe("真实回复");
    expect(collected.finishReason).toBe("stop");
    expect(emit).toHaveBeenNthCalledWith(1, "真实");
    expect(emit).toHaveBeenNthCalledWith(2, "回复");
  });

  it("截断终结原因原样返回，由调用方决定重试或失败", async () => {
    const collected = await collectModelText(
      stream([
        { type: "text-delta", text: "残缺" },
        { type: "finish", finishReason: "length" },
      ]),
      vi.fn(),
    );
    expect(collected.text).toBe("残缺");
    expect(collected.finishReason).toBe("length");
  });

  it("流未携带 finish part 时标记 unknown", async () => {
    const collected = await collectModelText(
      stream([{ type: "text-delta", text: "早断" }]),
      vi.fn(),
    );
    expect(collected.finishReason).toBe("unknown");
  });

  it("模型流中的错误必须抛出，不能以空文本伪装完成", async () => {
    const modelError = new Error("Access denied");
    await expect(
      collectModelText(stream([{ type: "error", error: modelError }]), vi.fn()),
    ).rejects.toBe(modelError);
  });

  it("无正文的正常结束也按失败关闭", async () => {
    await expect(
      collectModelText(stream([{ type: "finish", finishReason: "stop" }]), vi.fn()),
    ).rejects.toThrow("模型未返回正文");
  });
});
