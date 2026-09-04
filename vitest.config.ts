import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import collectionAudit from "./docs/topic-01/evidence/test-collection.json";

const alias = { "@": resolve(__dirname, ".") };
type VitestGroup = "unit" | "db" | "integration" | "contract";

function filesFor(group: VitestGroup): string[] {
  return collectionAudit.tests
    .filter((test) => test.group === group)
    .map((test) => test.file)
    .sort();
}

function project(group: VitestGroup, serial = false) {
  return {
    resolve: { alias },
    test: {
      name: group,
      include: filesFor(group),
      environmentMatchGlobs: [
        ["**/*.test.tsx", "happy-dom"],
        ["**/*.test.ts", "node"],
      ] as Array<[string, "happy-dom" | "node"]>,
      ...(serial
        ? {
            environment: "node" as const,
            pool: "forks" as const,
            poolOptions: { forks: { singleFork: true } },
            hookTimeout: 60_000,
            testTimeout: 60_000,
          }
        : {}),
    },
  };
}

export default defineConfig({
  resolve: { alias },
  test: {
    // DB project 使用真实 MySQL 且串行；其余项目由机器清单逐文件归属，不按业务目录粗分。
    globalSetup: ["./lib/db/test/global-setup.ts"],
    projects: [project("unit"), project("db", true), project("integration"), project("contract")],
  },
});
