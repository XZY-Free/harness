/**
 * S13-W06 验收矩阵生成器。
 *
 * 职责：
 * - 从契约对象（OpenAPI / Event Catalog / Error Catalog / Runtime Conformance）生成完整验收矩阵。
 * - 每个契约项 × 每个维度 = 一个矩阵项；总项数 = 63×6 + events×6 + errors×2 + 16×1。
 * - 根据契约特性（Idempotency-Key / ETag）决定 HTTP 维度是否 required；未 required 的项自动跳过。
 * - Runtime 一致性维度 mandatory 标记来自 MANDATORY_GATE_CASES（4 项 mandatory，其余 12 项可选）。
 *
 * 设计原则：
 * - 生成器为纯函数，输入契约对象，输出矩阵项数组，便于测试与缓存。
 * - 不直接读文件；文件加载由 loadContractsFromFiles 提供，便于在测试中使用内存契约。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MANDATORY_GATE_CASES } from "@/lib/runtimes/domain/runtime-conformance";
import {
  ALL_ERROR_MAPPING_DIMENSIONS,
  ALL_HTTP_OPERATION_DIMENSIONS,
  ALL_PERSISTENT_EVENT_DIMENSIONS,
  ALL_RUNTIME_CONFORMANCE_DIMENSIONS,
  type AcceptanceMatrixCategory,
  type AcceptanceMatrixItem,
} from "@/lib/v11/acceptance/matrix-contract";

// ─── 契约对象类型（从 JSON 解析后的结构子集） ────────────────

/** OpenAPI 文档（仅关心 paths 与 operationId/parameters）。 */
export interface OpenApiContract {
  readonly paths: Record<
    string,
    Record<
      string,
      {
        readonly operationId?: string;
        readonly tags?: readonly string[];
        readonly parameters?: readonly {
          readonly name?: string;
          readonly in?: string;
          readonly required?: boolean;
        }[];
      }
    >
  >;
}

/** Event Catalog。 */
export interface EventCatalogContract {
  readonly events: Record<
    string,
    {
      readonly streams: readonly string[];
      readonly version: number;
      readonly required_refs: readonly string[];
      readonly skippable_for_projection: boolean;
    }
  >;
}

/** Error Catalog。 */
export interface ErrorCatalogContract {
  readonly errors: Record<
    string,
    {
      readonly http: number;
      readonly retryable: boolean;
    }
  >;
}

/** Runtime Conformance Suite。 */
export interface RuntimeConformanceContract {
  readonly required_cases: readonly {
    readonly id: string;
    readonly given?: string;
    readonly when?: string;
    readonly expect?: readonly string[];
  }[];
}

/** 全部契约集合。 */
export interface ContractBundle {
  readonly openapi: OpenApiContract;
  readonly eventCatalog: EventCatalogContract;
  readonly errorCatalog: ErrorCatalogContract;
  readonly runtimeConformance: RuntimeConformanceContract;
}

// ─── 发布基线计数（用于检测契约数量偏差） ────────────────────

/**
 * 发布基线计数（来自 13-migration-cutover-and-release.md §完成判定）。
 *
 * 用于 baselineCountCheck：若契约实际数量与基线不符，发布门禁失败。
 * 注意：基线反映发布时的事实数量，契约文件可能因迭代略多或略少；
 *       校验失败时报告偏差但不直接阻断矩阵生成。
 */
export const RELEASE_BASELINE_COUNTS = {
  httpOperations: 63,
  persistentEvents: 91,
  errorMappings: 49,
  runtimeConformanceCases: 16,
} as const;

// ─── 契约加载（从文件） ────────────────────────────────────

/** 契约文件默认根目录。 */
export const DEFAULT_CONTRACTS_DIR = "docs/solutions/v11-agentkit-platform/contracts";

/**
 * 从默认契约目录加载全部契约。
 * @param repoRoot 仓库根目录（默认 process.cwd()）。
 */
export function loadContractsFromFiles(repoRoot: string = process.cwd()): ContractBundle {
  const dir = resolve(repoRoot, DEFAULT_CONTRACTS_DIR);
  return {
    openapi: JSON.parse(readFileSync(resolve(dir, "v11.openapi.json"), "utf8")),
    eventCatalog: JSON.parse(readFileSync(resolve(dir, "event-catalog.json"), "utf8")),
    errorCatalog: JSON.parse(readFileSync(resolve(dir, "error-codes.json"), "utf8")),
    runtimeConformance: JSON.parse(readFileSync(resolve(dir, "runtime-conformance.json"), "utf8")),
  };
}

// ─── HTTP operation 契约项提取 ─────────────────────────────

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

/** 从 OpenAPI 提取 HTTP operation 契约项。 */
export function extractHttpOperations(openapi: OpenApiContract) {
  const items = [];
  for (const [path, methods] of Object.entries(openapi.paths)) {
    for (const [methodLower, spec] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(methodLower as (typeof HTTP_METHODS)[number])) {
        continue;
      }
      const operationId = spec.operationId ?? `${methodLower}:${path}`;
      const tag = spec.tags?.[0] ?? "untagged";
      const params = spec.parameters ?? [];
      const supportsIdempotency = params.some(
        (p) => p.name === "Idempotency-Key" && p.in === "header",
      );
      // ETag 乐观锁检测：If-Match header 或 ETag 出现在响应 schema
      // OpenAPI 文本中包含 "If-Match" 或 "etag" 即认为支持乐观锁
      const specJson = JSON.stringify(spec);
      const hasOptimisticLock =
        specJson.includes("If-Match") || specJson.includes('"etag"') || specJson.includes('"ETag"');
      items.push({
        operationId,
        method: methodLower.toUpperCase(),
        path,
        tag,
        supportsIdempotency,
        hasOptimisticLock,
      });
    }
  }
  return items;
}

// ─── 矩阵生成 ──────────────────────────────────────────────

/**
 * 生成完整验收矩阵。
 *
 * @param bundle 契约集合
 * @returns 全部矩阵项（按类别顺序：HTTP → Event → Error → Runtime）
 */
export function generateAcceptanceMatrix(bundle: ContractBundle): AcceptanceMatrixItem[] {
  const items: AcceptanceMatrixItem[] = [];

  // 1. HTTP operation × 6 维度
  const httpOps = extractHttpOperations(bundle.openapi);
  for (const op of httpOps) {
    for (const dim of ALL_HTTP_OPERATION_DIMENSIONS) {
      const required = isHttpDimensionRequired(dim, op);
      items.push({
        key: `${op.method} ${op.path}:${dim}`,
        category: "http_operation",
        dimension: dim,
        contractItemId: op.operationId,
        required,
        mandatory: true,
      });
    }
  }

  // 2. 持久 Event × 6 维度
  for (const [eventType, spec] of Object.entries(bundle.eventCatalog.events)) {
    for (const dim of ALL_PERSISTENT_EVENT_DIMENSIONS) {
      // projection 维度对 skippable_for_projection=true 的事件仍需验证投影器正确处理跳过
      items.push({
        key: `${eventType}:${dim}`,
        category: "persistent_event",
        dimension: dim,
        contractItemId: eventType,
        required: true,
        mandatory: true,
      });
    }
  }

  // 3. 错误映射 × 2 维度
  for (const code of Object.keys(bundle.errorCatalog.errors)) {
    for (const dim of ALL_ERROR_MAPPING_DIMENSIONS) {
      items.push({
        key: `${code}:${dim}`,
        category: "error_mapping",
        dimension: dim,
        contractItemId: code,
        required: true,
        mandatory: true,
      });
    }
  }

  // 4. Runtime 一致性 × 1 维度（16 项）
  for (const c of bundle.runtimeConformance.required_cases) {
    for (const dim of ALL_RUNTIME_CONFORMANCE_DIMENSIONS) {
      items.push({
        key: `${c.id}:${dim}`,
        category: "runtime_conformance",
        dimension: dim,
        contractItemId: c.id,
        required: true,
        mandatory: MANDATORY_GATE_CASES.includes(c.id as (typeof MANDATORY_GATE_CASES)[number]),
      });
    }
  }

  return items;
}

/** 判断 HTTP operation 维度是否 required。 */
function isHttpDimensionRequired(
  dim: string,
  op: {
    readonly supportsIdempotency: boolean;
    readonly hasOptimisticLock: boolean;
    readonly method: string;
  },
): boolean {
  switch (dim) {
    case "idempotency":
      // 仅支持 Idempotency-Key 的 operation 才跑幂等维度
      return op.supportsIdempotency;
    case "concurrency":
      // 仅支持 ETag/乐观锁的 operation 才跑并发维度
      return op.hasOptimisticLock;
    case "success":
    case "auth":
    case "error":
    case "audit":
      return true;
    default:
      return true;
  }
}

// ─── 基线计数校验 ──────────────────────────────────────────

/** 基线计数校验结果。 */
export interface BaselineCountReport {
  readonly passed: boolean;
  readonly deviations: readonly {
    readonly category: AcceptanceMatrixCategory | "total";
    readonly expected: number;
    readonly actual: number;
  }[];
}

/**
 * 校验契约数量是否符合发布基线。
 *
 * 偏差不阻断矩阵生成，但会在报告中标记以便人工审查。
 */
export function checkBaselineCounts(bundle: ContractBundle): BaselineCountReport {
  const httpCount = extractHttpOperations(bundle.openapi).length;
  const eventCount = Object.keys(bundle.eventCatalog.events).length;
  const errorCount = Object.keys(bundle.errorCatalog.errors).length;
  const conformanceCount = bundle.runtimeConformance.required_cases.length;

  const deviations = [
    {
      category: "http_operation" as const,
      expected: RELEASE_BASELINE_COUNTS.httpOperations,
      actual: httpCount,
    },
    {
      category: "persistent_event" as const,
      expected: RELEASE_BASELINE_COUNTS.persistentEvents,
      actual: eventCount,
    },
    {
      category: "error_mapping" as const,
      expected: RELEASE_BASELINE_COUNTS.errorMappings,
      actual: errorCount,
    },
    {
      category: "runtime_conformance" as const,
      expected: RELEASE_BASELINE_COUNTS.runtimeConformanceCases,
      actual: conformanceCount,
    },
  ].filter((d) => d.actual !== d.expected);

  return { passed: deviations.length === 0, deviations };
}

// ─── 矩阵统计 ─────────────────────────────────────────────

/** 矩阵统计信息。 */
export interface MatrixStats {
  readonly totalItems: number;
  readonly requiredItems: number;
  readonly skippedItems: number;
  readonly byCategory: Record<AcceptanceMatrixCategory, { total: number; required: number }>;
}

/** 计算矩阵统计信息。 */
export function getMatrixStats(items: readonly AcceptanceMatrixItem[]): MatrixStats {
  const byCategory = {
    http_operation: { total: 0, required: 0 },
    persistent_event: { total: 0, required: 0 },
    error_mapping: { total: 0, required: 0 },
    runtime_conformance: { total: 0, required: 0 },
  };

  for (const item of items) {
    byCategory[item.category].total += 1;
    if (item.required) {
      byCategory[item.category].required += 1;
    }
  }

  return {
    totalItems: items.length,
    requiredItems: items.filter((i) => i.required).length,
    skippedItems: items.filter((i) => !i.required).length,
    byCategory,
  };
}
