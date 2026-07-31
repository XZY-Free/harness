"use client";

import { apiFetch } from "@/lib/api-fetch";
import { useEffect, useState } from "react";

export interface AvailableModel {
  readonly id: string;
}

export interface AvailableModelsState {
  readonly models: readonly AvailableModel[];
  readonly defaultModel: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export function useAvailableModels(): AvailableModelsState {
  const [state, setState] = useState<AvailableModelsState>({
    models: [],
    defaultModel: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        const response = await apiFetch("/api/models", {
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("models request failed");

        const body = (await response.json()) as {
          ok?: boolean;
          data?: {
            models?: Array<{ id?: unknown }>;
            defaultModel?: unknown;
          };
        };
        const models = (body.data?.models ?? [])
          .filter((model): model is { id: string } => typeof model.id === "string")
          .map((model) => ({ id: model.id }));
        const defaultModel =
          typeof body.data?.defaultModel === "string" ? body.data.defaultModel : null;

        setState({
          models,
          defaultModel,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          models: [],
          defaultModel: null,
          loading: false,
          error: "模型列表加载失败",
        });
      }
    };

    void load();
    return () => controller.abort();
  }, []);

  return state;
}
