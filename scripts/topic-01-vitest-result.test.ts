import { describe, expect, it } from "vitest";
import { collectSkippedTests } from "./topic-01-vitest-result.mjs";

describe("Topic01 skipped test evidence", () => {
  it("把 Vitest pending case 映射为带原因与验收影响的证据", () => {
    const metadata = {
      file: "lib/example.test.ts",
      testName: "suite > case",
      reason: "需要外部运行条件",
      acceptanceImpact: "由独立验收覆盖",
    };
    expect(
      collectSkippedTests(
        {
          testResults: [
            {
              name: "/repo/lib/example.test.ts",
              assertionResults: [{ ancestorTitles: ["suite"], title: "case", status: "pending" }],
            },
          ],
        },
        { tests: [metadata] },
        "/repo",
      ),
    ).toEqual([metadata]);
  });

  it("拒绝没有 reason/impact 登记的 skipped test", () => {
    expect(() =>
      collectSkippedTests(
        {
          testResults: [
            {
              name: "/repo/lib/example.test.ts",
              assertionResults: [{ ancestorTitles: ["suite"], title: "case", status: "pending" }],
            },
          ],
        },
        { tests: [] },
        "/repo",
      ),
    ).toThrow("未登记的 skipped test");
  });
});
