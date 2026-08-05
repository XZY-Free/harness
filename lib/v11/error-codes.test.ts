import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { V11_ERROR_CODES, errorDefinition } from "@/lib/v11/error-codes";

// 契约 normative 事实源。tsconfig exclude docs，但测试（vitest）可读文件。
const CONTRACT_PATH = resolve(
  process.cwd(),
  "docs/solutions/v11-agentkit-platform/contracts/error-codes.json",
);
const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, "utf-8")) as {
  contract_version: string;
  errors: Record<string, { http: number; retryable: boolean }>;
};

describe("V11 error-codes projection", () => {
  it("投影与契约事实源完全一致（code/http/retryable）", () => {
    const contractCodes = Object.keys(CONTRACT.errors).sort();
    const projectionCodes = Object.keys(V11_ERROR_CODES).sort();
    expect(projectionCodes).toEqual(contractCodes);

    for (const code of contractCodes) {
      const expected = CONTRACT.errors[code];
      const actual = V11_ERROR_CODES[code as keyof typeof V11_ERROR_CODES];
      expect(actual).toEqual(expected);
    }
  });

  it("contract_version 为 11.0.0", () => {
    expect(CONTRACT.contract_version).toBe("11.0.0");
  });

  it("错误码 76 个（+§7.1 CUTOVER_ITEM_NOT_READY）", () => {
    expect(Object.keys(V11_ERROR_CODES)).toHaveLength(77);
  });

  it("errorDefinition 对未知码 fail-closed", () => {
    expect(() => errorDefinition("NOT_A_REAL_CODE")).toThrow(/unknown V11 error code/);
  });
});
