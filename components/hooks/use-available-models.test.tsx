import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAvailableModels } from "./use-available-models";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe("useAvailableModels", () => {
  it("从真实模型接口读取列表和默认模型", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            models: [{ id: "glm-5.2" }, { id: "qwen3-coder-plus" }],
            defaultModel: "glm-5.2",
          },
        }),
        { status: 200 },
      ),
    );

    const { result } = renderHook(() => useAvailableModels());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models).toEqual([{ id: "glm-5.2" }, { id: "qwen3-coder-plus" }]);
    expect(result.current.defaultModel).toBe("glm-5.2");
  });

  it("接口失败时明确返回空列表，不伪造模型", async () => {
    fetchMock.mockResolvedValueOnce(new Response("failed", { status: 503 }));

    const { result } = renderHook(() => useAvailableModels());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models).toEqual([]);
    expect(result.current.defaultModel).toBeNull();
    expect(result.current.error).toBe("模型列表加载失败");
  });
});
