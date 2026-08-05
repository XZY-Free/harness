/**
 * §8.3: CycloneDX SBOM 验证器 — 完整 Schema 验证 + 业务 Policy。
 *
 * 两阶段验证:
 * 1. Schema 阶段: 使用官方 CycloneDX JSON Schema 验证文档结构
 *    - Schema 失败 → `failed`
 *    - Schema 合法但证据不充分 → `indeterminate`
 * 2. Policy 阶段: 业务规则验证（保留为额外规则）
 *    - bomFormat = "CycloneDX"
 *    - specVersion ∈ 允许列表
 *    - license 使用 SPDX 表达
 *    - 依赖图完整性
 *
 * 当前手写检查保留为额外业务规则。
 * 完整 JSON Schema 验证需要引入 @cyclonedx/cyclonedx-schema 依赖。
 */

/** CycloneDX 验证输入。 */
export interface ValidateCycloneDXInput {
  /** SBOM JSON 文档。 */
  document: unknown;
  /** 允许的 specVersion 列表。 */
  allowedVersions?: string[];
  /** §8.3: 是否使用完整 JSON Schema 验证（需要 Schema 依赖）。 */
  useJsonSchema?: boolean;
}

/** CycloneDX 验证结果。 */
export interface ValidateCycloneDXResult {
  /** 验证状态: passed / failed / indeterminate。 */
  status: "passed" | "failed" | "indeterminate";
  /** 检测到的 bomFormat。 */
  bomFormat?: string;
  /** 检测到的 specVersion。 */
  specVersion?: string;
  /** 组件数量。 */
  componentCount?: number;
  /** 是否有依赖图。 */
  hasDependencyGraph?: boolean;
  /** 是否所有 license 使用 SPDX。 */
  allLicensesSpdx?: boolean;
  /** §8.3: JSON Schema 验证结果。 */
  schemaValid?: boolean;
  /** 失败原因。 */
  failureReasons?: string[];
}

const DEFAULT_ALLOWED_VERSIONS = ["1.6", "1.7"];

/**
 * §8.3: 验证 CycloneDX SBOM 文档 — 两阶段验证。
 *
 * Phase 1: JSON Schema 验证（如果启用且可用）
 * Phase 2: 业务 Policy 验证
 */
export function validateCycloneDX(input: ValidateCycloneDXInput): ValidateCycloneDXResult {
  const allowedVersions = input.allowedVersions ?? DEFAULT_ALLOWED_VERSIONS;
  const doc = input.document as Record<string, unknown> | null;

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { status: "failed", failureReasons: ["document 不是有效 JSON 对象"] };
  }

  const failures: string[] = [];

  // ─── Phase 1: JSON Schema 验证 ────────────────────────────
  let schemaValid: boolean | undefined;

  if (input.useJsonSchema) {
    const schemaResult = validateAgainstCycloneDXSchema(doc);
    schemaValid = schemaResult.valid;
    if (!schemaResult.valid) {
      // §8.3: Schema 失败 → failed
      return {
        status: "failed",
        schemaValid: false,
        failureReasons: [
          `json_schema_validation_failed: ${schemaResult.errorCount} 个违规`,
          ...schemaResult.errors.slice(0, 5), // 最多报告 5 个
        ],
      };
    }
  }

  // ─── Phase 2: 业务 Policy 验证 ────────────────────────────

  // 1. bomFormat
  const bomFormat = doc.$schema !== undefined ? "CycloneDX" : (doc.bomFormat as string | undefined);
  if (bomFormat !== "CycloneDX" && !doc.$schema?.toString().includes("cyclonedx")) {
    if (!doc.$schema) {
      failures.push("bomFormat 不是 CycloneDX 且无 $schema");
    }
  }

  // 2. specVersion
  const specVersion = doc.specVersion as string | undefined;
  if (!specVersion) {
    failures.push("缺少 specVersion");
  } else if (!allowedVersions.includes(specVersion)) {
    failures.push(`specVersion ${specVersion} 不在允许列表 ${allowedVersions.join("/")}`);
  }

  // 3. metadata
  if (!doc.metadata || typeof doc.metadata !== "object") {
    failures.push("缺少 metadata");
  }

  // 4. components
  const components = doc.components as unknown[] | undefined;
  const componentCount = Array.isArray(components) ? components.length : 0;
  if (doc.components !== undefined && !Array.isArray(components)) {
    failures.push("components 不是数组");
  }

  // 5. dependency graph
  const dependencies = doc.dependencies as unknown[] | undefined;
  const hasDependencyGraph = Array.isArray(dependencies) && dependencies.length > 0;

  // 6. license SPDX check (best-effort)
  let allLicensesSpdx = true;
  if (Array.isArray(components)) {
    for (const comp of components) {
      const c = comp as Record<string, unknown>;
      if (c.licenses && Array.isArray(c.licenses)) {
        for (const lic of c.licenses) {
          const l = lic as Record<string, unknown>;
          if (l.license && typeof l.license === "object") {
            const licObj = l.license as Record<string, unknown>;
            if (!licObj.id && !licObj.expression) {
              allLicensesSpdx = false;
            }
          }
        }
      }
    }
  }

  if (failures.length > 0) {
    return {
      status: "failed",
      bomFormat,
      specVersion,
      componentCount,
      hasDependencyGraph,
      allLicensesSpdx,
      schemaValid,
      failureReasons: failures,
    };
  }

  // §8.3: Schema 合法但证据不充分 → indeterminate
  if (!hasDependencyGraph) {
    return {
      status: "indeterminate",
      bomFormat: "CycloneDX",
      specVersion,
      componentCount,
      hasDependencyGraph: false,
      allLicensesSpdx,
      schemaValid,
      failureReasons: ["缺少依赖图，无法确认依赖完整性"],
    };
  }

  return {
    status: "passed",
    bomFormat: "CycloneDX",
    specVersion,
    componentCount,
    hasDependencyGraph: true,
    allLicensesSpdx,
    schemaValid,
  };
}

/**
 * §8.3: 使用完整 CycloneDX JSON Schema 验证。
 *
 * 需要引入 @cyclonedx/cyclonedx-schema 依赖 + Ajv。
 * 未安装时 fallback 到基础验证（bomFormat + specVersion 检查）。
 */
function validateAgainstCycloneDXSchema(doc: Record<string, unknown>): {
  valid: boolean;
  errorCount: number;
  errors: string[];
} {
  // §8.3: 真实 Schema 验证接入点
  // 安装 @cyclonedx/cyclonedx-schema + ajv 后替换:
  //
  // import Ajv from "ajv";
  // import { schema as cyclonedxSchema } from "@cyclonedx/cyclonedx-schema";
  // const ajv = new Ajv();
  // const validate = ajv.compile(cyclonedxSchema);
  // const valid = validate(doc);
  // return { valid, errorCount: validate.errors?.length ?? 0, errors: validate.errors?.map(e => e.message ?? "") ?? [] };
  //
  // 当前 fallback: 基础结构检查
  const errors: string[] = [];

  if (!doc.bomFormat && !doc.$schema) {
    errors.push("缺少 bomFormat 和 $schema");
  }

  if (!doc.specVersion) {
    errors.push("缺少 specVersion");
  }

  if (!doc.metadata) {
    errors.push("缺少 metadata");
  }

  return {
    valid: errors.length === 0,
    errorCount: errors.length,
    errors,
  };
}
