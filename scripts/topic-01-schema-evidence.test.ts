import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverSchemaDeclarations,
  isProductionSourcePath,
  scanCurrentProductionReferences,
} from "./topic-01-schema-evidence-core.mjs";

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "topic01-schema-evidence-"));
  roots.push(root);
  for (const path of [
    "lib/persistence/schema",
    "lib/domain",
    "lib/test",
    "lib/tests",
    "lib/__tests__",
    "lib/test-support",
    "lib/fixture",
    "lib/fixtures",
    "scripts/workers",
  ]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  writeFileSync(
    join(root, "lib/persistence/schema/example.ts"),
    'export const exampleTable = mysqlTable("Example", {});\n',
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Topic01 schema evidence source scan", () => {
  it("排除所有 test/spec/fixture/mock/generated evidence 路径但保留生产 Worker", () => {
    for (const path of [
      "lib/example.test.ts",
      "lib/example.spec.ts",
      "lib/test/example.ts",
      "lib/tests/example.ts",
      "lib/__tests__/example.ts",
      "lib/test-support/example.ts",
      "lib/fixture/example.ts",
      "lib/fixtures/example.ts",
      "e2e/fake-server.ts",
      "lib/mocks/example.ts",
      "lib/runtime/mock-runtime-adapter.ts",
      "lib/runtime/runtime.fake.ts",
      "lib/generated-evidence/example.ts",
    ]) {
      expect(isProductionSourcePath(path), path).toBe(false);
    }
    expect(isProductionSourcePath("scripts/workers/runtime-dispatch-retry-worker.ts")).toBe(true);
  });

  it("只从当前生产源码重建 writer/reader，不读取历史 inventory", () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, "lib/domain/current.ts"),
      "db.insert(exampleTable); db.select().from(exampleTable); console.log(exampleTable.id);\n",
    );
    writeFileSync(
      join(root, "lib/test/stale.ts"),
      "db.insert(exampleTable); db.select().from(exampleTable);\n",
    );
    writeFileSync(
      join(root, "legacy-inventory.json"),
      JSON.stringify({ productionWriters: ["lib/test/stale.ts"] }),
    );

    const declarations = discoverSchemaDeclarations(root);
    expect(declarations).toEqual([
      {
        file: "lib/persistence/schema/example.ts",
        physicalTableName: "Example",
        symbol: "exampleTable",
      },
    ]);
    expect(scanCurrentProductionReferences(root, declarations[0]!)).toEqual({
      writers: ["lib/domain/current.ts"],
      readers: ["lib/domain/current.ts"],
    });
  });
});
