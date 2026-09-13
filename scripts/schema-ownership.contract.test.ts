import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as agents from "@/lib/persistence/schema/agents";
import * as executions from "@/lib/persistence/schema/executions";
import * as runtimes from "@/lib/persistence/schema/runtimes";

/**
 * Topic01 物理 Schema 所有权契约（docs/V12/01 §20 / §29 H）。
 *
 * 单一物理权威：agents.ts 拥有 Agent/AgentRevision；runtimes.ts 拥有
 * Runtime/RuntimeRevision；executions.ts 拥有 Invocation/ExecutionBinding/
 * InvocationAttempt/ExecutionOwnership/RuntimeSessionBinding/RuntimeEventIngress。
 * 旧同义来源 agent.ts / runtime.ts 必须消失，生产代码不得再 import 这两个旧路径。
 *
 * 两种互补结论：
 * 1. 静态文本检查（去除空白后语义化）——验证规范模块真实定义表、不复导出旧源、
 *    旧源文件已删除、无生产 import 旧路径。
 * 2. 运行时 import 断言——import 规范模块并校验导出表对象存在且保留预期物理表名
 *    （不连接 DB）。
 */

const SCHEMA_DIR = join(process.cwd(), "lib/persistence/schema");
const OBSOLETE_SOURCES = ["agent.ts", "runtime.ts"] as const;

/** 规范模块 → { 导出符号 → 物理表名 }。语义化表名，不依赖排版/行号。 */
const OWNERSHIP = {
  "agents.ts": {
    agentTable: "Agent",
    agentRevisionTable: "AgentRevision",
  },
  "runtimes.ts": {
    runtimeTable: "Runtime",
    runtimeRevisionTable: "RuntimeRevision",
  },
  "executions.ts": {
    invocationTable: "Invocation",
    executionBindingTable: "ExecutionBinding",
    invocationAttemptTable: "InvocationAttempt",
    executionOwnershipTable: "ExecutionOwnership",
    runtimeSessionBindingTable: "RuntimeSessionBinding",
    runtimeEventIngressTable: "RuntimeEventIngress",
  },
} as const;

const MODULE_NAMESPACES: Record<keyof typeof OWNERSHIP, Record<string, unknown>> = {
  "agents.ts": agents,
  "runtimes.ts": runtimes,
  "executions.ts": executions,
};

/** 去除全部空白，使排版差异不影响语义判断。 */
function normalize(source: string): string {
  return source.replace(/\s+/g, "");
}

function readModule(rel: string): string {
  return readFileSync(join(SCHEMA_DIR, rel), "utf8");
}

function listTsFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (!statSync(root).isFile()) {
    return readdirSync(root).flatMap((entry) => {
      if (["node_modules", ".git", ".next", "build", "dist", "__pycache__"].includes(entry)) {
        return [];
      }
      return listTsFiles(join(root, entry));
    });
  }
  return root.endsWith(".ts") ? [root] : [];
}

describe("Topic01 physical schema ownership contract", () => {
  it("obsolete synonym sources agent.ts and runtime.ts are gone", () => {
    for (const rel of OBSOLETE_SOURCES) {
      expect(existsSync(join(SCHEMA_DIR, rel)), `${rel} 必须物理删除`).toBe(false);
    }
  });

  it("canonical modules physically define tables instead of re-exporting facades", () => {
    for (const file of Object.keys(OWNERSHIP) as (keyof typeof OWNERSHIP)[]) {
      const normalized = normalize(readModule(file));
      for (const physicalName of Object.values(OWNERSHIP[file])) {
        // 规范模块必须包含真实的 mysqlTable("物理表名", ...) 定义。
        expect(
          normalized,
          `${file} 必须物理定义 ${physicalName} 表（mysqlTable），而非重导出`,
        ).toContain(`mysqlTable("${physicalName}",`);
      }
      // 不得从旧同义来源 agent.ts / runtime.ts 复导出。
      expect(normalized, `${file} 不得复导出旧同义来源 agent.ts`).not.toContain(
        'from"@/lib/persistence/schema/agent"',
      );
      expect(normalized, `${file} 不得复导出旧同义来源 runtime.ts`).not.toContain(
        'from"@/lib/persistence/schema/runtime"',
      );
    }
  });

  it("no production import of obsolete schema paths agent / runtime", () => {
    const obsoleteImport = /schema\/agent["']|schema\/runtime["']/;
    const violations = listTsFiles(join(process.cwd(), "lib"))
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const path = relative(process.cwd(), file);
        const source = readFileSync(file, "utf8");
        return obsoleteImport.test(source) ? [path] : [];
      });
    expect(violations, "生产代码不得 import 旧 schema 路径 agent / runtime").toEqual([]);
  });

  it("canonical modules export real table objects with expected physical names", () => {
    for (const file of Object.keys(OWNERSHIP) as (keyof typeof OWNERSHIP)[]) {
      const ns = MODULE_NAMESPACES[file];
      for (const [symbol, physicalName] of Object.entries(OWNERSHIP[file])) {
        const table = ns[symbol];
        expect(table, `${file} 应导出表对象 ${symbol}`).toBeDefined();
        expect(getTableName(table as Parameters<typeof getTableName>[0]), `${file}.${symbol}`).toBe(
          physicalName,
        );
      }
    }
  });
});
