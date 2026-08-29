import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 专题一源码长期注释合同。
 *
 * 扫描一组固定白名单正式源码，禁止出现：
 * - 实现批次标签、阶段措辞、方案文档引用和残缺注释前缀。
 * - 各文件专属失真短语（详见 FILE_MATCHERS）。
 *
 * 仅扫描白名单文件，不做全仓扫描；不扫描测试自身。
 * 失败信息逐文件列出命中的模式与行号，便于修复。
 *
 * 文件读取基于 process.cwd()，与现有 contract 测试风格一致。
 */

const FILES = [
  "lib/persistence/schema/conversation.ts",
  "lib/persistence/schema/deployment-route.ts",
  "lib/context/context-handle.ts",
  "lib/control-plane/domain/revision-execution-eligibility.ts",
  "lib/control-plane/persistence/mysql-revision-execution-evidence-reader.ts",
  "lib/executions/domain/execution-binding.ts",
  "lib/executions/application/validate-binding-eligibility.ts",
  "lib/routes/application/activate-route-set.ts",
  "lib/routes/domain/route-resolution-policy.ts",
  "lib/routes/infrastructure/configured-route-resolver.ts",
  "lib/routes/persistence/route-set-activation-store.ts",
  "lib/routes/persistence/route-revision-record.ts",
  "lib/routes/persistence/mysql-route-eligibility-resolution-store.ts",
  "lib/routes/projection/build-route-eligibility.ts",
  "lib/routes/projection/route-eligibility-projection-record.ts",
  "lib/routes/projection/route-eligibility-store.ts",
  "lib/runtime/dispatcher.ts",
  "lib/runtime/employee-turn-dispatcher.ts",
  "lib/runtime/command-dispatcher.ts",
  "lib/runtime/redispatch-queries.ts",
  "lib/runtime/resolve-execution-plan.ts",
  "lib/runtime/infrastructure/mysql-hosted-gateways.ts",
  "lib/runtime/provisioning/provision-hosted-runtime.ts",
  "components/thread/web-thread-shell.tsx",
  "desktop/renderer/src/desktop-renderer-app.tsx",
] as const;

/** 单个匹配器：命中即记为一个违规。 */
type Matcher = { label: string; contains: (lineNorm: string) => boolean };

/** 去除空白与反引号，使排版/反引号差异不影响语义判断。 */
function strip(line: string): string {
  return line.replace(/[\s`]/g, "");
}

const phrase = (label: string, text: string): Matcher => ({
  label,
  // text 与行文本都过同一 strip()，使含空白/反引号模式（如 "/** :"、"// :"、"* /:"）
  // 能正确命中，避免永远无法匹配。
  contains: (lineNorm) => lineNorm.includes(strip(text)),
});

const regex = (label: string, pattern: RegExp): Matcher => ({
  label,
  contains: (lineNorm) => pattern.test(lineNorm),
});

/** 全局禁止：批次标签 / 阶段措辞，适用于全部白名单文件。 */
const GLOBAL_MATCHERS: Matcher[] = [
  regex("禁止章节式批次标签", /§0[0-9]/),
  regex("禁止 Sxx 批次标签", /S[0-9]{2}-[A-Z][0-9]+/),
  regex("禁止英文 Phase 标签", /Phase[0-9]+/),
  phrase("禁止阶段 13", "阶段13"),
  phrase("禁止阶段措辞：后续阶段", "后续阶段"),
  phrase("禁止实现方案引用", "专题01"),
  phrase("禁止阶段性扩展措辞", "扩展："),
  phrase("残缺注释前缀 /** :", "/** :"),
  phrase("残缺注释前缀 // :", "// :"),
  phrase("残缺 JSDoc 前缀 * :", "* :"),
  phrase("残缺注释前缀 * /:", "* /:"),
  phrase("残缺中文括号前缀（:", "（:"),
  phrase("残缺英文括号前缀 (:", "(:"),
];

/** 文件专属失真短语（去除空白与反引号后的语义形式）。 */
const FILE_MATCHERS: Record<string, Matcher[]> = {
  "lib/persistence/schema/conversation.ts": [
    phrase("失真短语：绑定租户、所有者和主 Agent", "绑定租户、所有者和主Agent"),
    phrase(
      "失真短语：旧 Thread/Message/ThreadEvent/ThreadRun 表保持只读兼容",
      "旧Thread/Message/ThreadEvent/ThreadRun表保持只读兼容",
    ),
  ],
  "lib/persistence/schema/deployment-route.ts": [
    phrase("失真短语：同一 Agent + Scope", "同一Agent+Scope"),
    phrase(
      "失真短语：固定一个 AgentRevision + 一个 RuntimeRevision",
      "固定一个AgentRevision+一个RuntimeRevision",
    ),
    phrase(
      "失真短语：UNIQUE(routeSetId, agentRevisionId, runtimeRevisionId)",
      "UNIQUE(routeSetId,agentRevisionId,runtimeRevisionId)",
    ),
  ],
  "lib/runtime/employee-turn-dispatcher.ts": [
    phrase("失真短语：测试过渡用", "测试过渡用"),
    phrase("失真短语：E 阶段移除", "E阶段移除"),
    phrase("失真短语：后续阶段（F）", "后续阶段（F）"),
    phrase("失真短语：后续阶段决定", "后续阶段决定"),
  ],
  "components/thread/web-thread-shell.tsx": [phrase("失真短语：G 阶段移除", "G阶段移除")],
};

/**
 * conversation.ts 仅应用其两条专属失真短语（绑定租户/主 Agent、旧表只读兼容），
 * 不套用 GLOBAL_MATCHERS —— 否则会跨专题误伤 defaultWorkspace、Child Thread 预算、
 * InvocationCommand 等其他专题注释。旧表失真短语自身覆盖了对应的失真说明。
 * 其余文件继续 GLOBAL_MATCHERS + 文件专属匹配器。
 */
const GLOBAL_EXCLUDED_FILES = new Set(["lib/persistence/schema/conversation.ts"]);

function matchersFor(file: string): Matcher[] {
  if (GLOBAL_EXCLUDED_FILES.has(file)) return FILE_MATCHERS[file] ?? [];
  return [...GLOBAL_MATCHERS, ...(FILE_MATCHERS[file] ?? [])];
}

/** 返回 file 中所有命中：{ 行号, 标签 }，按行号升序。 */
function scan(file: string): { line: number; label: string }[] {
  const lines = readFileSync(join(process.cwd(), file), "utf8").split(/\r?\n/);
  const hits: { line: number; label: string }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const norm = strip(lines[i] ?? "");
    for (const m of matchersFor(file)) {
      if (m.contains(norm)) hits.push({ line: i + 1, label: m.label });
    }
  }
  return hits;
}

describe("专题一源码长期注释合同", () => {
  for (const file of FILES) {
    it(`${file} 不得包含批次标签/阶段措辞或失真短语`, () => {
      const hits = scan(file);
      const detail = hits.map((h) => `  第 ${h.line} 行: ${h.label}`).join("\n");
      expect(hits, `文件 ${file} 命中禁止措辞：\n${detail}`).toEqual([]);
    });
  }
});
