/**
 * S13-W08 运维手册生成器。
 *
 * 职责：
 * - 组装运维手册：仅描述当前可运行 V11 的运维操作。
 * - 门禁校验：不包含旧路径关键词、不包含未来设想关键词。
 * - 格式化手册为 Markdown 全文。
 *
 * 事实源：13-migration-cutover-and-release.md §S13-W08
 *         （运维手册只描述当前可运行 V11，不把已删除旧路径或未来设想混入正式手册）。
 */
import {
  type OperationsRunbook,
  RUNBOOK_FORBIDDEN_KEYWORDS,
  RunbookGateError,
  type RunbookSection,
  V11_SCHEME_VERSION,
} from "@/lib/v11/release/release-contract";

// ─── 标准运维手册章节 ──────────────────────────────────────

/** 标准运维手册章节标题（仅 V11 当前可运行内容）。 */
export const STANDARD_RUNBOOK_SECTIONS = [
  "系统概览",
  "部署架构",
  "启动与停止",
  "健康检查",
  "监控与告警",
  "日志与诊断",
  "备份与恢复",
  "扩容与缩容",
  "事故响应",
  "安全运维",
] as const;

// ─── 运维手册构建器 ────────────────────────────────────────

/** 手册构建器输入。 */
export interface RunbookBuilderInput {
  /** 自定义章节（覆盖或补充标准章节）。 */
  readonly sections: readonly RunbookSection[];
  /** 适用范围（默认 "V11 当前可运行版本"）。 */
  readonly scope?: string;
}

/** 构建运维手册。 */
export function buildOperationsRunbook(input: RunbookBuilderInput): OperationsRunbook {
  const sections = [...input.sections].sort((a, b) => a.order - b.order);
  const markdown = renderRunbookMarkdown(sections, input.scope ?? "V11 当前可运行版本");

  return {
    version: V11_SCHEME_VERSION,
    generatedAt: new Date().toISOString(),
    scope: input.scope ?? "V11 当前可运行版本",
    sections,
    markdown,
  };
}

/** 渲染手册 Markdown 全文。 */
function renderRunbookMarkdown(sections: readonly RunbookSection[], scope: string): string {
  const lines: string[] = [];
  lines.push("# V11 运维手册");
  lines.push("");
  lines.push(`- 版本：${V11_SCHEME_VERSION}`);
  lines.push(`- 适用范围：${scope}`);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push("");

  for (const section of sections) {
    lines.push(`## ${section.order}. ${section.title}`);
    lines.push("");
    lines.push(section.content);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── 门禁校验 ─────────────────────────────────────────────

/**
 * 校验运维手册门禁：不包含旧路径/未来设想关键词。
 *
 * 违规关键词来自 RUNBOOK_FORBIDDEN_KEYWORDS。
 */
export function validateRunbook(runbook: OperationsRunbook): {
  passed: boolean;
  violations: readonly string[];
} {
  const violations: string[] = [];
  const fullText = runbook.markdown;

  for (const keyword of RUNBOOK_FORBIDDEN_KEYWORDS) {
    if (fullText.includes(keyword)) {
      violations.push(`包含禁止关键词：${keyword}`);
    }
  }

  // 校验适用范围必须包含 V11
  if (!runbook.scope.includes("V11")) {
    violations.push("适用范围未包含 V11");
  }

  // 校验至少有一个章节
  if (runbook.sections.length === 0) {
    violations.push("手册无章节");
  }

  return { passed: violations.length === 0, violations };
}

/** 门禁断言：包含禁止关键词时抛 RunbookGateError。 */
export function assertRunbookGate(runbook: OperationsRunbook): void {
  const result = validateRunbook(runbook);
  if (!result.passed) {
    throw new RunbookGateError(
      `运维手册门禁失败：${result.violations.join("; ")}`,
      result.violations,
      runbook,
    );
  }
}

// ─── 格式化 ───────────────────────────────────────────────

/** 格式化手册摘要（用于报告，非全文）。 */
export function formatRunbookSummary(runbook: OperationsRunbook): string {
  const lines: string[] = [];
  lines.push("=== V11 运维手册摘要 ===");
  lines.push(`版本：${runbook.version}`);
  lines.push(`适用范围：${runbook.scope}`);
  lines.push(`生成时间：${runbook.generatedAt}`);
  lines.push(`章节数：${runbook.sections.length}`);
  lines.push("");
  lines.push("章节列表：");
  for (const section of runbook.sections) {
    lines.push(`  ${section.order}. ${section.title}`);
  }
  return lines.join("\n");
}
