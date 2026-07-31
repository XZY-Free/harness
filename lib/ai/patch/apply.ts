/**
 * V3.1：受约束的 unified diff 子集解析-校验-应用纯函数（蓝图 §12 V3.1）。
 *
 * 设计取舍（§1）：
 * - 不直接 shell `patch`：路径必须经 safeJoin，避免越界；context 严格匹配，不匹配拒绝。
 * - 按「内容块匹配」应用：每个 hunk 的 search 块（context + removed）在文件中精确定位，
 *   替换为 replace 块（context + added）。比行号定位更抗漂移，但要求 search 块唯一出现。
 * - 纯函数：不触文件系统，由调用方（applyPatch 工具）读文件 → 应用 → 写回，便于单测。
 *
 * 不支持（V3.1 边界）：
 * - 新建文件 / 删除文件 via `/dev/null`（用 writeFile / deleteFile 工具）。
 * - 二进制 patch、rename、mode change。
 */

/** patch 解析错误。 */
export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchParseError";
  }
}

/** 单个 hunk：path + search 块 + replace 块（行数组，不含前缀）。 */
export interface PatchHunk {
  path: string;
  oldStart: number;
  search: string[];
  replace: string[];
}

export interface ParsedPatch {
  hunks: PatchHunk[];
}

/** 单个 hunk 应用结果。 */
export interface HunkApplyResult {
  path: string;
  changed: boolean;
  before: string;
  after: string;
  error?: string;
}

export interface ApplyPatchResult {
  results: HunkApplyResult[];
  /** 任一 hunk 出错则整体未应用（原子性由调用方保证：errors 非空时不写回）。 */
  errors: Array<{ path: string; error: string }>;
}

/** 去掉 `a/` `b/` 前缀的路径；`/dev/null` 抛错（V3.1 不支持新建/删除 via patch）。 */
function stripPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "/dev/null") {
    throw new PatchParseError("V3.1 不支持 /dev/null（新建/删除请用 writeFile/deleteFile）");
  }
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}

/** 解析 `@@ -oldStart,oldCount +newStart,newCount @@` 头。 */
function parseHunkHeader(line: string): { oldStart: number } {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
  if (!m) throw new PatchParseError(`无法解析 hunk 头：${line}`);
  return { oldStart: Number(m[1]) };
}

/**
 * 解析 unified diff 子集为 hunk 列表。
 *
 * 接受 `--- a/path` / `+++ b/path` 文件头与 `@@ ... @@` hunk 头；
 * hunk 体行前缀：` `（context）、`-`（removed）、`+`（added）、`\`（no-newline，忽略）。
 * 其他行（`diff --git`、`index ...`）忽略。
 */
export function parsePatch(patch: string): ParsedPatch {
  const lines = patch.split("\n");
  const hunks: PatchHunk[] = [];
  let i = 0;
  let currentPath: string | null = null;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.startsWith("--- ")) {
      const oldPath = stripPath(line.slice(4));
      const plusLine = lines[i + 1] ?? "";
      if (!plusLine.startsWith("+++ ")) {
        throw new PatchParseError("缺少 +++ 行（--- 之后必须紧跟 +++）");
      }
      const newPath = stripPath(plusLine.slice(4));
      // 两侧路径应一致（a/ b/ 前缀剥离后）；不一致时以 +++ 为准并告警式校验
      if (oldPath !== newPath && oldPath !== "/dev/null" && newPath !== "/dev/null") {
        throw new PatchParseError(`--- 与 +++ 路径不一致：${oldPath} vs ${newPath}`);
      }
      currentPath = newPath;
      i += 2;
      continue;
    }

    if (line.startsWith("@@")) {
      const { oldStart } = parseHunkHeader(line);
      const search: string[] = [];
      const replace: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        // 文件头 / 下一个 hunk 头 → 结束当前 hunk（须在判前缀之前，因 --- 以 - 开头）
        if (
          l.startsWith("--- ") ||
          l.startsWith("+++ ") ||
          l.startsWith("@@") ||
          l.startsWith("diff ")
        ) {
          break;
        }
        const prefix = l[0];
        if (prefix === " ") {
          search.push(l.slice(1));
          replace.push(l.slice(1));
        } else if (prefix === "-") {
          search.push(l.slice(1));
        } else if (prefix === "+") {
          replace.push(l.slice(1));
        } else if (prefix === "\\") {
          // `\ No newline at end of file` — 忽略
        } else {
          // 其他（含空行）→ hunk 结束
          break;
        }
        i++;
      }
      hunks.push({ path: currentPath ?? "", oldStart, search, replace });
      continue;
    }

    // 忽略 diff --git / index / 空行等
    i++;
  }

  if (hunks.length === 0) {
    throw new PatchParseError("patch 不含任何 hunk");
  }
  return { hunks };
}

/** 校验 hunk 路径：拒绝绝对路径、拒绝 `..` 越界。 */
export function validatePatchPath(path: string): string | null {
  if (path.length === 0) return "路径为空";
  if (path.startsWith("/")) return `绝对路径不允许：${path}`;
  if (path.split("/").some((seg) => seg === "..")) return `路径含 .. 越界：${path}`;
  return null;
}

/**
 * 应用解析后的 patch 到 files（path→content）。
 *
 * 每个 hunk：在文件内容中精确定位 search 块（行 join `\n`），替换为 replace 块。
 * - search 块为空 → 错误（纯新增 hunk 需 context 行定位）
 * - search 块在文件中未找到 → 错误（context 不匹配，严格拒绝）
 * - search 块多次出现 → 错误（要求唯一定位）
 *
 * 纯函数：不写文件；调用方据 errors 决定是否写回（errors 非空则整体不写，原子性）。
 */
export function applyPatch(patch: string, files: Record<string, string>): ApplyPatchResult {
  const parsed = parsePatch(patch);
  const results: HunkApplyResult[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  // 按 path 累积变更（多 hunk 同文件顺序应用）
  const working = new Map<string, string>();

  for (const hunk of parsed.hunks) {
    const pathErr = validatePatchPath(hunk.path);
    if (pathErr) {
      errors.push({ path: hunk.path, error: pathErr });
      continue;
    }
    const before = working.get(hunk.path) ?? files[hunk.path];
    if (before === undefined) {
      errors.push({ path: hunk.path, error: "文件不存在" });
      continue;
    }
    const searchBlock = hunk.search.join("\n");
    const replaceBlock = hunk.replace.join("\n");

    if (searchBlock.length === 0) {
      errors.push({ path: hunk.path, error: "纯新增 hunk 需 context 行定位" });
      continue;
    }
    const first = before.indexOf(searchBlock);
    if (first === -1) {
      errors.push({ path: hunk.path, error: "context 不匹配，未找到待替换块" });
      continue;
    }
    const second = before.indexOf(searchBlock, first + 1);
    if (second !== -1) {
      errors.push({ path: hunk.path, error: "待替换块非唯一，请补充更多 context" });
      continue;
    }
    const after = before.slice(0, first) + replaceBlock + before.slice(first + searchBlock.length);
    working.set(hunk.path, after);
    results.push({ path: hunk.path, changed: true, before, after });
  }

  return { results, errors };
}
