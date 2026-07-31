import { createHash } from "node:crypto";
import { aiConfig, memoryConfig } from "@/lib/config";
import { normalizeMemoryText } from "./text";

/**
 * V3.3b Stage B：embedding provider 抽象 + 确定性 fake provider + cosine。
 *
 * 用户指令：检索必须是 lexical recall + semantic embedding rerank 混合；
 * provider disabled/stale/error 必须进入 manifest/UI 可观测，**不允许静默伪装成功**。
 * 测试用 deterministic fake embedding，不请求真实网络。
 */

export type EmbeddingProviderStatus = "ready" | "disabled" | "stale" | "error";

export type EmbeddingResult = {
  vector: number[];
  dim: number;
  status: EmbeddingProviderStatus;
  error?: string;
};

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  /** 是否就绪（配置缺失 / 开关关闭 → false）。 */
  isReady(): boolean;
  /**
   * embed 文本。失败时返回 status=error + error message，**不抛**（不静默伪装成功）。
   * ready 时返回 status=ready + vector。
   */
  embed(text: string): Promise<EmbeddingResult>;
}

/** cosine 相似度（-1..1）。维度不一致 / 空向量 → 0（防御）。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Deterministic fake embedding（测试用，不请求真实网络）。
 * 同一文本 → 同一向量（基于 sha256），dim=16，值域 [-1,1]。
 * 真实 provider（OpenAI 等）后续接入，实现同接口；本阶段用 fake 保证可测、可复现。
 */
export class DeterministicFakeEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  private readonly dim: number;
  constructor(name = "fake-deterministic", model = "fake-1", dim = 16) {
    this.name = name;
    this.model = model;
    this.dim = dim;
  }
  isReady(): boolean {
    return true;
  }
  async embed(text: string): Promise<EmbeddingResult> {
    const norm = normalizeMemoryText(text);
    const vector = Array.from({ length: this.dim }, (_, i) => {
      const h = createHash("sha256").update(`${i}:${norm}`).digest("hex");
      return (Number.parseInt(h.slice(0, 8), 16) / 0xffffffff) * 2 - 1;
    });
    return { vector, dim: this.dim, status: "ready" };
  }
}

/** 永久 disabled provider（配置缺失 / 开关关闭）。retrieve 时 status=disabled，fallback lexical。 */
export class DisabledEmbeddingProvider implements EmbeddingProvider {
  readonly name = "disabled";
  readonly model = "none";
  isReady(): boolean {
    return false;
  }
  async embed(_text?: string): Promise<EmbeddingResult> {
    return { vector: [], dim: 0, status: "disabled", error: "embedding provider disabled" };
  }
}

/** 抛错 provider（模拟真实 provider 网络错误）。status=error，不静默伪装。 */
export class ErrorEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  constructor(name = "error-provider", model = "err-1") {
    this.name = name;
    this.model = model;
  }
  isReady(): boolean {
    return true;
  }
  async embed(_text?: string): Promise<EmbeddingResult> {
    return { vector: [], dim: 0, status: "error", error: "embedding provider request failed" };
  }
}

/**
 * OpenAI-compatible 真实 embedding provider（运行时用；测试不请求网络）。
 *
 * 复用 aiConfig.baseUrl / aiConfig.apiKey，但模型用 `MEMORY_EMBEDDING_MODEL`
 * （**绝不偷偷复用 chat model**——计划 §1 决策）。调用 `/embeddings` 端点。
 * 失败返回 status=error + 脱敏 errorMessage（不含 API key），不抛（不静默伪装成功）。
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai-compatible";
  readonly model: string;
  constructor(model: string) {
    this.model = model;
  }
  isReady(): boolean {
    // model 为空 → 不 ready（工厂会 fallback 到 DisabledProvider，双保险）。
    return this.model !== "";
  }
  async embed(text: string): Promise<EmbeddingResult> {
    try {
      const base = aiConfig.baseUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aiConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      if (!res.ok) {
        return {
          vector: [],
          dim: 0,
          status: "error",
          error: `embeddings HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const vec = body.data?.[0]?.embedding ?? [];
      if (vec.length === 0) {
        return { vector: [], dim: 0, status: "error", error: "empty embedding vector" };
      }
      const dim = memoryConfig.embeddingDimension;
      if (dim !== 0 && dim !== vec.length) {
        return {
          vector: [],
          dim: 0,
          status: "error",
          error: `dimension mismatch: expected ${dim}, got ${vec.length}`,
        };
      }
      return { vector: vec, dim: vec.length, status: "ready" };
    } catch (e) {
      return {
        vector: [],
        dim: 0,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

/**
 * 解析当前 embedding provider（工厂）。
 *
 * - `!memoryConfig.embeddingsEnabled` 或 `embeddingModel` 空 → `DisabledEmbeddingProvider`
 *   （status=disabled，lexical fallback，可观测；不偷偷用 chat model）。
 * - 否则 → `OpenAICompatibleEmbeddingProvider(MEMORY_EMBEDDING_MODEL)`。
 *
 * 测试通过显式注入 fake provider 覆盖，不请求真实网络。
 */
export function resolveEmbeddingProvider(): EmbeddingProvider {
  if (!memoryConfig.embeddingsEnabled || memoryConfig.embeddingModel === "") {
    return new DisabledEmbeddingProvider();
  }
  return new OpenAICompatibleEmbeddingProvider(memoryConfig.embeddingModel);
}

/**
 * 对一条 memory 的 normalized text 生成 embedding（indexMemory 用）。
 * provider disabled/error 时返回结构化 status，**不抛**（memory 仍可创建，semanticStatus 诚实）。
 */
export async function embedMemoryText(text: string): Promise<EmbeddingResult> {
  return resolveEmbeddingProvider().embed(normalizeMemoryText(text));
}

/**
 * 对检索 query 生成 embedding（retrieveMemories semantic rerank 用）。
 * 与 embedMemoryText 同接口（query 也 normalize）；命名区分用途，未来可分模型/分端点。
 */
export async function embedMemoryQuery(text: string): Promise<EmbeddingResult> {
  return resolveEmbeddingProvider().embed(normalizeMemoryText(text));
}

/** 测试专用：用注入 provider 包一层 embedMemoryText（便于 deterministic fake 覆盖）。 */
export async function embedMemoryTextWith(
  provider: EmbeddingProvider,
  text: string,
): Promise<EmbeddingResult> {
  return provider.embed(normalizeMemoryText(text));
}
