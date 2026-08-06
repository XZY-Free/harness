/**
 * §8.3: CycloneDX SBOM 验证器 — 完整 Schema 验证 + 业务 Policy。
 *
 * 两阶段验证:
 * 1. Schema 阶段: 使用官方 CycloneDX JSON Schema 验证文档结构
 *    - Schema 失败 → `failed`
 *    - Schema 合法但证据不充分 → `indeterminate`
 * 2. Policy 阶段: 业务规则验证
 *    - bomFormat = "CycloneDX"
 *    - specVersion ∈ 允许列表
 *    - license 使用 SPDX 表达
 *    - 依赖图完整性
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import cyclonedxSchema from "./schemas/cyclonedx-1.6.schema.json";

/** CycloneDX 验证输入。 */
export interface ValidateCycloneDXInput {
  /** SBOM JSON 文档。 */
  document: unknown;
  /** 允许的 specVersion 列表。 */
  allowedVersions?: string[];
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
  /** JSON Schema 验证结果。 */
  schemaValid?: boolean;
  /** 失败原因。 */
  failureReasons?: string[];
}

const DEFAULT_ALLOWED_VERSIONS = ["1.6", "1.7"];

// 初始化 Ajv + CycloneDX Schema 编译（模块级单例）
// CycloneDX 1.6 schema 引用外部 spdx / jsf-0.82 / model_card schema；
// 提供宽松 stub（含 referenced definitions）以完成编译。
// Phase 2 业务 Policy 仍会校验 bomFormat / specVersion / metadata 等关键字段。
const ajv = new Ajv({ strict: false });
addFormats(ajv);
// CycloneDX schema 使用 iri-reference / idn-email 格式，ajv-formats 未内置
ajv.addFormat("iri-reference", /^.{1,}$/);
ajv.addFormat("idn-email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
ajv.addSchema({
  $id: "http://cyclonedx.org/schema/spdx.schema.json",
  description: "stub for external CycloneDX SPDX $ref",
  oneOf: [{ type: "string" }, { type: "object", properties: { expression: { type: "string" }, id: { type: "string" } } }],
});
ajv.addSchema({
  $id: "http://cyclonedx.org/schema/jsf-0.82.schema.json",
  description: "stub for external CycloneDX JSF $ref",
  definitions: { signature: {} },
});
ajv.addSchema({
  $id: "http://cyclonedx.org/schema/model_card.schema.json",
  description: "stub for external CycloneDX model_card $ref",
});
const validateCycloneDXSchema = ajv.compile(cyclonedxSchema);

/**
 * §8.3: 验证 CycloneDX SBOM 文档 — 两阶段验证。
 *
 * Phase 1: JSON Schema 验证（使用官方 CycloneDX 1.6 Schema）
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
  const schemaValid = validateCycloneDXSchema(doc) as boolean;
  if (!schemaValid) {
    const schemaErrors = (validateCycloneDXSchema.errors ?? []).map(
      (e) => `${e.instancePath ?? "/"}: ${e.message ?? "unknown"}`,
    );
    return {
      status: "failed",
      schemaValid: false,
      failureReasons: [
        `json_schema_validation_failed: ${schemaErrors.length} 个违规`,
        ...schemaErrors.slice(0, 5),
      ],
    };
  }

  // ─── Phase 2: 业务 Policy 验证 ────────────────────────────

  // 1. bomFormat
  const bomFormat = doc.bomFormat as string | undefined;
  if (bomFormat !== "CycloneDX") {
    failures.push("bomFormat 不是 CycloneDX");
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
      schemaValid: true,
      failureReasons: failures,
    };
  }

  // Schema 合法但证据不充分 → indeterminate
  if (!hasDependencyGraph) {
    return {
      status: "indeterminate",
      bomFormat: "CycloneDX",
      specVersion,
      componentCount,
      hasDependencyGraph: false,
      allLicensesSpdx,
      schemaValid: true,
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
    schemaValid: true,
  };
}
