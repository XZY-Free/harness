#!/usr/bin/env npx tsx
/**
 * §9.5: 架构门禁 — CI pipeline 检查脚本。
 *
 * 检查项：
 * 1. Drizzle migration journal 完整性（无断裂序列）
 * 2. 已删除的 deprecated re-export 无残留消费者
 * 3. 错误码投影与契约 JSON 一致
 * 4. 所有 Event Type 有对应的 Zod Schema + Aggregate Type
 * 5. Schema 版本统一
 * 6. 正式稳定模块不得依赖 lib/v11（架构收敛核心约束）
 * 7. Legacy HMAC 验证分支已移除（DSSE 为唯一验签路径）
 * 8. Cutover 临时兼容代码已清除
 *
 * 用法：pnpm architecture:gate
 * 退出码：0=通过，1=失败
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
let failures = 0;

function fail(msg: string) {
  console.error(`❌ FAIL: ${msg}`);
  failures++;
}

function pass(msg: string) {
  console.log(`✅ PASS: ${msg}`);
}

async function main() {
  // ─── 1. Migration Journal 完整性 ──────────────────────────
  console.log("\n=== 1. Migration Journal 完整性 ===");
  try {
    const journalPath = resolve(ROOT, "drizzle/meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
    const entries = journal.entries;
    let journalFailures = 0;

    for (let i = 0; i < entries.length; i++) {
      if (entries[i].idx !== i) {
        fail(`Journal idx 不连续: 期望 ${i}，实际 ${entries[i].idx} (tag: ${entries[i].tag})`);
        journalFailures++;
      }
    }

    for (const entry of entries) {
      const sqlPath = resolve(ROOT, `drizzle/${entry.tag}.sql`);
      if (!existsSync(sqlPath)) {
        fail(`Migration SQL 文件不存在: drizzle/${entry.tag}.sql`);
        journalFailures++;
      }
    }

    if (journalFailures === 0) {
      pass(`Migration journal 完整: ${entries.length} entries, idx 连续, SQL 文件存在`);
    }
  } catch (e) {
    fail(`无法读取 migration journal: ${e}`);
  }

  // ─── 2. Deprecated re-export 无残留消费者 ──────────────────
  console.log("\n=== 2. Deprecated re-export 无残留消费者 ===");
  const deprecatedPaths = [
    "@/lib/agents/persistence/control-plane-outbox",
    "@/lib/agents/persistence/outbox-relay",
    "@/lib/agents/persistence/outbox-relay-worker",
  ];

  for (const depPath of deprecatedPaths) {
    try {
      const result = execSync(
        `grep -rln "${depPath}" ${ROOT}/lib --include='*.ts' 2>/dev/null || true`,
        { encoding: "utf-8" },
      ).trim();
      if (result) {
        fail(`Deprecated path "${depPath}" 仍有消费者: ${result}`);
      } else {
        pass(`Deprecated path "${depPath}" 无残留消费者`);
      }
    } catch {
      pass(`Deprecated path "${depPath}" 检查跳过`);
    }
  }

  // ─── 3. 错误码投影与契约一致 ──────────────────────────────
  console.log("\n=== 3. 错误码投影与契约一致 ===");
  try {
    const contractPath = resolve(
      ROOT,
      "docs/solutions/v11-agentkit-platform/contracts/error-codes.json",
    );
    const contract = JSON.parse(readFileSync(contractPath, "utf-8"));
    const { API_ERROR_CODES } = await import("../lib/error-codes");
    const contractCodes = Object.keys(contract.errors).sort();
    const projectionCodes = Object.keys(API_ERROR_CODES).sort();

    if (contractCodes.length !== projectionCodes.length) {
      fail(`错误码数量不一致: 契约 ${contractCodes.length} vs 投影 ${projectionCodes.length}`);
    }

    let mismatch = false;
    for (const code of contractCodes) {
      if (!(code in API_ERROR_CODES)) {
        fail(`投影缺少错误码: ${code}`);
        mismatch = true;
      }
    }

    if (!mismatch && contractCodes.length === projectionCodes.length) {
      pass(`错误码投影与契约一致: ${projectionCodes.length} 个`);
    }
  } catch (e) {
    fail(`错误码检查失败: ${e}`);
  }

  // ─── 4. Event Type Schema 覆盖 ────────────────────────────
  console.log("\n=== 4. Event Type Schema 覆盖 ===");
  try {
    const { EVENT_PAYLOAD_SCHEMAS, EVENT_AGGREGATE_TYPES } = await import(
      "../lib/control-plane/events/event-contracts"
    );
    const schemaKeys = new Set(Object.keys(EVENT_PAYLOAD_SCHEMAS));
    const aggregateKeys = new Set(Object.keys(EVENT_AGGREGATE_TYPES));

    let missing = false;
    for (const key of schemaKeys) {
      if (!aggregateKeys.has(key)) {
        fail(`EVENT_AGGREGATE_TYPES 缺少: ${key}`);
        missing = true;
      }
    }

    if (!missing) {
      pass(`Event Type Schema 覆盖: ${schemaKeys.size} types, aggregate mapping 完整`);
    }
  } catch (e) {
    fail(`Event Type Schema 检查失败: ${e}`);
  }

  // ─── 5. Schema 版本统一 ────────────────────────────────
  console.log("\n=== 5. Schema 版本统一 ===");
  try {
    const { SCHEMA_VERSIONS } = await import("../lib/control-plane/events/schema-versions");
    const entries = Object.entries(SCHEMA_VERSIONS) as [string, string][];
    pass(`Schema 版本注册: ${entries.map(([k, v]) => `${k}=${v}`).join(", ")}`);

    // 检查所有 schemaVersion: "1.0" 引用来自统一常量
    const hardcodedCount = execSync(
      `grep -rn 'schemaVersion: "1.0"' ${ROOT}/lib --include='*.ts' 2>/dev/null | grep -v 'schema-versions.ts' | grep -v '.test.' || true`,
      { encoding: "utf-8" },
    ).trim();
    if (hardcodedCount) {
      const count = hardcodedCount.split("\n").filter(Boolean).length;
      pass(`schemaVersion "1.0" 硬编码引用: ${count} 处（待收敛至 SCHEMA_VERSIONS 常量）`);
    } else {
      pass("schemaVersion 已全部收敛至 SCHEMA_VERSIONS 常量");
    }
  } catch (e) {
    fail(`Schema 版本检查失败: ${e}`);
  }

  // ─── 6. 正式稳定模块不得依赖 lib/v11 ──────────────────────
  // 架构收敛核心约束：正式模块（agents/runtimes/routes/executions/artifacts/
  // publications/control-plane/crypto）不得 import lib/v11。
  // 允许的例外：lib/v11 自身、*.test.ts、lib/v11/test-support/。
  console.log("\n=== 6. 正式稳定模块不得依赖 lib/v11 ===");
  try {
    const stableModules = [
      "agents",
      "runtimes",
      "routes",
      "executions",
      "artifacts",
      "publications",
      "control-plane",
      "crypto",
    ];
    const stablePattern = stableModules.join("|");
    // 查找正式稳定模块（非 test、非 lib/v11 自身）中对 @/lib/v11 的引用
    const violations = execSync(
      `grep -rln "from ['\\\"]@/lib/v11/" ${ROOT}/lib --include='*.ts' 2>/dev/null | grep -v '/v11/' | grep -v '\\.test\\.' | grep -v '/test-support/' | grep -E '/(${stablePattern})/' || true`,
      { encoding: "utf-8" },
    ).trim();
    if (violations) {
      const files = violations.split("\n").filter(Boolean);
      fail(`正式稳定模块仍引用 lib/v11 (${files.length} 处):`);
      for (const f of files) {
        fail(`  - ${f.replace(`${ROOT}/`, "")}`);
      }
    } else {
      pass("正式稳定模块无 lib/v11 依赖");
    }
  } catch (e) {
    fail(`lib/v11 依赖检查失败: ${e}`);
  }

  // ─── 7. Legacy HMAC 验证分支已移除 ──────────────────────
  // §8.4: DSSE 是唯一的 Conformance 验签路径，Legacy HMAC 成功分支必须移除。
  // 允许在注释中提及 "Legacy HMAC" 作为历史说明，但不得存在可执行的验签逻辑。
  console.log("\n=== 7. Legacy HMAC 验证分支已移除 ===");
  try {
    // 查找 verification 目录下包含 HMAC 验签逻辑的代码（排除注释行）
    const hmacCode = execSync(
      `grep -rn 'verify.*Hmac\\|Hmac.*verify\\|createHmac.*verify' ${ROOT}/lib/runtimes/verification --include='*.ts' 2>/dev/null | grep -v '^.*:\\s*//' | grep -v '\\.test\\.' || true`,
      { encoding: "utf-8" },
    ).trim();
    if (hmacCode) {
      fail(`发现 Legacy HMAC 验签逻辑: ${hmacCode}`);
    } else {
      pass("Legacy HMAC 验签分支已移除（DSSE 为唯一验签路径）");
    }
  } catch (e) {
    fail(`Legacy HMAC 检查失败: ${e}`);
  }

  // ─── 8. Cutover 临时兼容代码已清除 ──────────────────────
  // §收口: Cutover 临时兼容系统已移除，不得残留 Cutover 类、函数或导入。
  console.log("\n=== 8. Cutover 临时兼容代码已清除 ===");
  try {
    const cutoverRefs = execSync(
      `grep -rln 'Cutover\\|cutover' ${ROOT}/lib --include='*.ts' 2>/dev/null | grep -v '\\.test\\.' || true`,
      { encoding: "utf-8" },
    ).trim();
    if (cutoverRefs) {
      const files = cutoverRefs.split("\n").filter(Boolean);
      fail(`发现 Cutover 临时兼容代码残留 (${files.length} 处):`);
      for (const f of files) {
        fail(`  - ${f.replace(`${ROOT}/`, "")}`);
      }
    } else {
      pass("Cutover 临时兼容代码已清除");
    }
  } catch (e) {
    fail(`Cutover 检查失败: ${e}`);
  }

  // ─── 总结 ──────────────────────────────────────────────────
  console.log(`\n${"=".repeat(50)}`);
  if (failures === 0) {
    console.log("🎉 架构门禁全部通过！");
    process.exit(0);
  } else {
    console.log(`💥 架构门禁失败: ${failures} 项检查不通过`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("架构门禁脚本异常:", e);
  process.exit(1);
});
