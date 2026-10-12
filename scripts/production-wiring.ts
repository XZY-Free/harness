#!/usr/bin/env npx tsx
/**
 * 验收计划 `production-wiring` 阶段的独立入口。
 *
 * 只做一件事：把 `scripts/production-wiring-rules.ts` 的十条接线规则跑在**真实生产
 * 源码**上，逐条打印 PASS/FAIL，任一违规即非零退出。规则本体不在本文件里——阶段与
 * contract 组用例共用同一套实现，避免阶段名与行为漂移。
 *
 * 该阶段**不是** acceptance-matrix 的重复执行：矩阵校验的是 plan/matrix 结构与引用，
 * 本入口校验的是生产入口与 Authority 映射的真实接线事实。
 */
import {
  collectProductionWiringViolations,
  loadProductionWiringDocuments,
} from "./production-wiring-rules";

const documents = loadProductionWiringDocuments(process.cwd());
const results = collectProductionWiringViolations(documents);

let violations = 0;
for (const result of results) {
  if (result.violations.length === 0) {
    console.log(`PASS: [${result.id}] ${result.title}`);
    continue;
  }
  violations += result.violations.length;
  console.error(`FAIL: [${result.id}] ${result.title}`);
  for (const violation of result.violations) console.error(`  - ${violation}`);
}

if (violations > 0) {
  console.error(`\n生产接线校验失败：${violations} 条违规（${results.length} 项检查）`);
  process.exitCode = 1;
} else {
  console.log(
    `Production wiring OK: ${results.length} 项检查全部通过（生产文档 ${documents.length} 个）`,
  );
}
