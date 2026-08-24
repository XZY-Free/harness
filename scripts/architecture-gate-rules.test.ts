import { describe, expect, it } from "vitest";
import {
  type SourceDocument,
  collectDeprecatedArchitectureViolations,
} from "./architecture-gate-rules";

/**
 * 专题：Architecture Gate 的 deprecated/legacy 检查边界（纯规则模块）。
 *
 * 业务不变量：/test-support/ 不因路径整体豁免——只允许 .test.ts/.test.tsx 与
 * 显式精确文件白名单跳过。该模块是抽取自 architecture-gate.ts 的纯规则实现
 * （不得内含 fallback / 内联复制生产算法），以 SourceDocument 数组为输入、
 * 返回违规路径数组，便于单测证明 test-support 被扫描。
 *
 * 规则 API：
 *   type SourceDocument = { path: string; source: string }
 *   collectDeprecatedArchitectureViolations(documents, allowlist?) => string[]
 */

function doc(path: string, source: string): SourceDocument {
  return { path, source };
}

describe("collectDeprecatedArchitectureViolations", () => {
  it("lib/runtime/test-support/fixture.ts 含 @deprecated 时返回违规（test-support 不被整体豁免）", () => {
    const documents = [
      doc("lib/runtime/test-support/fixture.ts", "export const x = 1; // @deprecated 旧实现"),
    ];
    expect(collectDeprecatedArchitectureViolations(documents)).toContain(
      "lib/runtime/test-support/fixture.ts",
    );
  });

  it("lib/runtime/test-support/ 含 legacy 禁词时返回违规", () => {
    const documents = [
      doc("lib/runtime/test-support/seed-verified-runtime-attestation.ts", "const legacy = true;"),
    ];
    expect(collectDeprecatedArchitectureViolations(documents)).toContain(
      "lib/runtime/test-support/seed-verified-runtime-attestation.ts",
    );
  });

  it("lib/runtime/example.test.ts 与 example.test.tsx 可跳过", () => {
    const documents = [
      doc("lib/runtime/example.test.ts", "// @deprecated legacy"),
      doc("lib/runtime/example.test.tsx", "const legacy = true;"),
    ];
    expect(collectDeprecatedArchitectureViolations(documents)).toEqual([]);
  });

  it("精确 allowlist 中的单个文件可跳过，但同目录其他文件不能被连带豁免", () => {
    const allowlist = new Set(["lib/runtime/test-support/fixture.ts"]);
    const documents = [
      doc("lib/runtime/test-support/fixture.ts", "// @deprecated 官方旧夹具"),
      doc("lib/runtime/test-support/sibling.ts", "const legacy = true;"),
    ];
    const violations = collectDeprecatedArchitectureViolations(documents, allowlist);
    expect(violations).not.toContain("lib/runtime/test-support/fixture.ts");
    expect(violations).toContain("lib/runtime/test-support/sibling.ts");
  });

  it("非目标作用域（lib/skill/）不纳入此专题 deprecated 检查", () => {
    const documents = [doc("lib/skill/invocations.ts", "// @deprecated legacy 仅在 lib/skill 下")];
    expect(collectDeprecatedArchitectureViolations(documents)).toEqual([]);
  });

  it("正常的 lib/runtime/test-support helper 不含禁词时无违规", () => {
    const documents = [
      doc(
        "lib/runtime/test-support/build-dsse-conformance-envelope.ts",
        "export function build(): string { return 'clean'; }",
      ),
    ];
    expect(collectDeprecatedArchitectureViolations(documents)).toEqual([]);
  });

  it("精确 allowlist 不接受目录前缀（必须逐文件精确）", () => {
    const allowlist = new Set(["lib/runtime/test-support/"]);
    const documents = [doc("lib/runtime/test-support/fixture.ts", "// @deprecated")];
    expect(
      collectDeprecatedArchitectureViolations(documents, allowlist),
      "目录前缀不得豁免，必须精确到文件",
    ).toContain("lib/runtime/test-support/fixture.ts");
  });
});
