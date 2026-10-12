import { relative } from "node:path";

function normalizedFile(root, value) {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(`${root.replaceAll("\\", "/")}/`)
    ? relative(root, value).replaceAll("\\", "/")
    : normalized.replace(/^\.\//, "");
}

export function collectSkippedTests(report, registry, root = process.cwd()) {
  const registered = new Map(
    registry.tests.map((item) => [`${item.file}\u0000${item.testName}`, item]),
  );
  const skipped = [];
  for (const suite of report.testResults ?? []) {
    const file = normalizedFile(root, suite.name ?? suite.testFilePath ?? "");
    for (const assertion of suite.assertionResults ?? []) {
      if (!["pending", "skipped", "todo"].includes(assertion.status)) continue;
      const testName = [...(assertion.ancestorTitles ?? []), assertion.title]
        .filter(Boolean)
        .join(" > ");
      const metadata = registered.get(`${file}\u0000${testName}`);
      if (!metadata) throw new Error(`未登记的 skipped test：${file} :: ${testName}`);
      skipped.push(metadata);
    }
  }
  return skipped;
}
