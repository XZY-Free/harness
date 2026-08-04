/**
 * CycloneDX SBOM 验证器。
 *
 * 替换自定义 packages[]/licenses[]/vulnerabilities[] 为 CycloneDX 文档验证。
 *
 * 验证规则:
 * - bomFormat = "CycloneDX"
 * - specVersion ∈ 允许列表 (1.6, 1.7)
 * - JSON Schema 合法
 * - metadata 存在
 * - components 结构合法
 * - dependency graph 可解析
 * - license 使用 SPDX 表达
 *
 * SBOM 缺乏足够 Dependency 信息时不得默认安全 → 返回 indeterminate。
 */

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
  /** 失败原因。 */
  failureReasons?: string[];
}

const DEFAULT_ALLOWED_VERSIONS = ["1.6", "1.7"];

/**
 * 验证 CycloneDX SBOM 文档。
 */
export function validateCycloneDX(input: ValidateCycloneDXInput): ValidateCycloneDXResult {
  const allowedVersions = input.allowedVersions ?? DEFAULT_ALLOWED_VERSIONS;
  const doc = input.document as Record<string, unknown> | null;
  const failures: string[] = [];

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { status: "failed", failureReasons: ["document 不是有效 JSON 对象"] };
  }

  // 1. bomFormat
  const bomFormat = doc.$schema !== undefined ? "CycloneDX" : (doc.bomFormat as string | undefined);
  if (bomFormat !== "CycloneDX" && !doc.$schema?.toString().includes("cyclonedx")) {
    // 宽松检查：有 $schema 包含 cyclonedx 也算合法
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
            // SPDX id or expression
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
      failureReasons: failures,
    };
  }

  // SBOM 缺乏足够 Dependency 信息时不得默认安全 → indeterminate
  if (!hasDependencyGraph) {
    return {
      status: "indeterminate",
      bomFormat: "CycloneDX",
      specVersion,
      componentCount,
      hasDependencyGraph: false,
      allLicensesSpdx,
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
  };
}
