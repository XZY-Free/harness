/**
 * CycloneDX SBOM 验证器 单元测试。
 */

import { describe, it, expect } from "vitest";
import { validateCycloneDX } from "@/lib/artifacts/verification/cyclonedx-validator";

describe("validateCycloneDX", () => {
  it("有效 CycloneDX 1.6 文档 → passed", () => {
    const result = validateCycloneDX({
      document: {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        metadata: { component: {} },
        components: [],
        dependencies: [{ ref: "pkg:npm/a@1.0" }],
      },
    });
    expect(result.status).toBe("passed");
    expect(result.bomFormat).toBe("CycloneDX");
    expect(result.specVersion).toBe("1.6");
    expect(result.hasDependencyGraph).toBe(true);
  });

  it("有效 CycloneDX 1.7 文档 → passed", () => {
    const result = validateCycloneDX({
      document: {
        bomFormat: "CycloneDX",
        specVersion: "1.7",
        metadata: {},
        components: [{ name: "foo", version: "1.0" }],
        dependencies: [{ ref: "pkg:npm/foo@1.0" }],
      },
    });
    expect(result.status).toBe("passed");
    expect(result.specVersion).toBe("1.7");
  });

  it("缺依赖图 → indeterminate", () => {
    const result = validateCycloneDX({
      document: {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        metadata: {},
        components: [{ name: "foo" }],
      },
    });
    expect(result.status).toBe("indeterminate");
    expect(result.hasDependencyGraph).toBe(false);
  });

  it("不支持的 specVersion → failed", () => {
    const result = validateCycloneDX({
      document: {
        bomFormat: "CycloneDX",
        specVersion: "1.4",
        metadata: {},
        components: [],
      },
    });
    expect(result.status).toBe("failed");
    expect(result.failureReasons).toBeDefined();
  });

  it("缺 metadata → failed", () => {
    const result = validateCycloneDX({
      document: {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        components: [],
      },
    });
    expect(result.status).toBe("failed");
  });

  it("非对象输入 → failed", () => {
    expect(validateCycloneDX({ document: null }).status).toBe("failed");
    expect(validateCycloneDX({ document: "string" }).status).toBe("failed");
    expect(validateCycloneDX({ document: [] }).status).toBe("failed");
  });

  it("自定义 allowedVersions", () => {
    const result = validateCycloneDX({
      document: {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        metadata: {},
        components: [],
        dependencies: [{ ref: "pkg:npm/a@1.0" }],
      },
      allowedVersions: ["1.5", "1.6"],
    });
    expect(result.status).toBe("passed");
  });

  it("components 带 SPDX license", () => {
    const result = validateCycloneDX({
      document: {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        metadata: {},
        components: [
          {
            name: "foo",
            licenses: [{ license: { id: "MIT" } }],
          },
        ],
        dependencies: [{ ref: "pkg:npm/foo@1.0" }],
      },
    });
    expect(result.status).toBe("passed");
    expect(result.allLicensesSpdx).toBe(true);
  });

  // ─── §8.3: JSON Schema 验证 ──────────────────────────────
  it("useJsonSchema=true + 有效文档 → passed + schemaValid=true", () => {
    const result = validateCycloneDX({
      document: {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        metadata: {},
        components: [],
        dependencies: [{ ref: "pkg:npm/a@1.0" }],
      },
      useJsonSchema: true,
    });
    expect(result.status).toBe("passed");
    expect(result.schemaValid).toBe(true);
  });

  it("useJsonSchema=true + 缺 bomFormat/specVersion/metadata → failed + schemaValid=false", () => {
    const result = validateCycloneDX({
      document: {
        components: [],
      },
      useJsonSchema: true,
    });
    expect(result.status).toBe("failed");
    expect(result.schemaValid).toBe(false);
  });

  it("useJsonSchema=false → schemaValid undefined（不执行 Schema 验证）", () => {
    const result = validateCycloneDX({
      document: {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        metadata: {},
        components: [],
        dependencies: [{ ref: "pkg:npm/a@1.0" }],
      },
      useJsonSchema: false,
    });
    expect(result.status).toBe("passed");
    expect(result.schemaValid).toBeUndefined();
  });
});
