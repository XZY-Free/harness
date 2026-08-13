/**
 * Stage A：commit message Lore trailer 协议（plan §1 / §5）。
 *
 * `gitCommit` 工具入参为结构化字段，内部经 `composeCommitMessage` 拼成
 * 「主题行 + 空行 + trailer 行」的 commit message，对齐项目既有 commit 规范
 * （见各 Stage Commit 建议：Constraint/Rejected/Confidence/Scope-risk/Tested/Not-tested）。
 *
 * trailer 缺失则省略对应行，不补空。trailer 顺序固定，保证可往返与可审计。
 */

export type CommitFields = {
  subject: string;
  constraint?: string;
  rejected?: string;
  confidence?: string;
  scopeRisk?: string;
  tested?: string;
  notTested?: string;
};

/** trailer 字段 key → commit message 中的标签（顺序即输出顺序）。 */
const TRAILER_KEYS = [
  ["constraint", "Constraint"],
  ["rejected", "Rejected"],
  ["confidence", "Confidence"],
  ["scopeRisk", "Scope-risk"],
  ["tested", "Tested"],
  ["notTested", "Not-tested"],
] as const;

/**
 * commit message 规范校验。
 *
 * 建议 conventional commits 格式（type: description），但不强制——仅 warn 提示。
 * 强制规则：subject 非空 + 不超 72 字符（首行长度规范）。
 * @returns { valid: boolean; warning?: string }
 */
export function validateCommitMessage(subject: string): { valid: boolean; warning?: string } {
  const s = subject.trim();
  if (!s) return { valid: false, warning: "commit 主题行不能为空" };
  if (s.length > 72)
    return { valid: false, warning: `commit 主题行 ${s.length} 字符 > 72（规范建议短主题）` };
  // 建议但不强制 conventional commits 前缀
  const CONV_RE = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\(.+\))?!?: .+/i;
  if (!CONV_RE.test(s)) {
    return { valid: true, warning: "建议用 conventional commits 格式（如 feat: 新增登录页）" };
  }
  return { valid: true };
}

/**
 * 组装 commit message：主题行 + trailer 行（仅含非空字段），行间以 `\n` 连接。
 * subject 为空时不输出主题行（调用方应保证 subject 非空）。
 */
export function composeCommitMessage(fields: CommitFields): string {
  const lines: string[] = [];
  const subject = fields.subject.trim();
  if (subject) lines.push(subject);
  for (const [key, label] of TRAILER_KEYS) {
    const v = fields[key]?.trim();
    if (v) lines.push(`${label}: ${v}`);
  }
  return lines.join("\n");
}

/** 标签 → 字段 key 的反查表（key 显式为 string，便于用运行时字符串查询）。 */
const LABEL_TO_KEY = new Map<string, keyof CommitFields>(
  TRAILER_KEYS.map(([k, label]) => [label, k]),
);

/** trailer 行匹配：`Label: value`，Label 为字母/数字/连字符。 */
const TRAILER_RE = /^([A-Za-z][\w-]*):\s?(.*)$/;

/**
 * 反向解析 commit message 为结构化字段（供审计 / Studio 展示）。
 * 首个非 trailer、非空行作为 subject；其余按 trailer 标签归位。
 * 未知 trailer 标签忽略（向前兼容）。
 */
export function parseCommitMessage(text: string): CommitFields {
  const out: CommitFields = { subject: "" };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const m = TRAILER_RE.exec(line.trim());
    const label = m?.[1];
    const value = m?.[2];
    if (label && value !== undefined && LABEL_TO_KEY.has(label)) {
      const key = LABEL_TO_KEY.get(label);
      if (key) (out as Record<string, unknown>)[key] = value.trim();
    } else if (line.trim() && !out.subject) {
      out.subject = line.trim();
    }
  }
  return out;
}
