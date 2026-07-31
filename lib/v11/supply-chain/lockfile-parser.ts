/**
 * V11 依赖锁定文件解析器（S12-W04）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §4
 *         （npm、Python、Electron 和基础镜像依赖纳入锁定、漏洞扫描和升级流程）。
 *
 * 职责：
 * - 解析 package-lock.json v3 / pnpm-lock.yaml 提取依赖清单。
 * - 输出标准化 DependencyEntry[]（name + version + licenses + vulnerabilities）。
 * - 不执行网络请求（漏洞/许可证数据由调用方注入）。
 *
 * 关键约束：
 * - 纯逻辑：不读文件系统、不访问网络。
 * - 调用方传入 lockfile 文本内容，解析器返回结构化数据。
 * - 解析失败抛 LockfileParseError（不返回空数组冒充成功）。
 */

/** 标准化依赖条目。 */
export interface DependencyEntry {
  /** 包名（如 "react"、"@scope/pkg"）。 */
  name: string;
  /** 版本（semver，如 "18.2.0"）。 */
  version: string;
  /** 许可证列表（SPDX 标识符；未知时为空数组）。 */
  licenses: string[];
  /** 漏洞列表（由调用方注入，解析器不填充）。 */
  vulnerabilities: Array<{
    id: string;
    severity: "critical" | "high" | "medium" | "low";
  }>;
  /** 来源（npm / pnpm / python / electron）。 */
  source: "npm" | "pnpm" | "python" | "electron";
}

/** 锁定文件解析错误。 */
export class LockfileParseError extends Error {
  constructor(
    public readonly format: string,
    message: string,
  ) {
    super(message);
    this.name = "LockfileParseError";
  }
}

// ─── package-lock.json v3 解析 ─────────────────────────────

/** package-lock.json v3 顶层结构（最小化字段）。 */
interface PackageLockV3 {
  lockfileVersion: number;
  packages?: Record<
    string,
    {
      version: string;
      license?: string | string[];
      resolved?: string;
    }
  >;
  dependencies?: Record<string, { version: string; license?: string | string[] }>;
}

/**
 * 解析 package-lock.json v2/v3 文本，提取依赖清单。
 *
 * v3 使用 `packages` 字段（key 为 node_modules 路径）。
 * v2 使用 `dependencies` 字段（key 为包名）。
 * 根项目（key=""）跳过。
 */
export function parsePackageLockJson(content: string): DependencyEntry[] {
  let parsed: PackageLockV3;
  try {
    parsed = JSON.parse(content) as PackageLockV3;
  } catch (e) {
    throw new LockfileParseError("npm", `JSON 解析失败: ${(e as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new LockfileParseError("npm", "非有效 JSON 对象");
  }

  const entries: DependencyEntry[] = [];

  // v3: packages 字段
  if (parsed.packages && typeof parsed.packages === "object") {
    for (const [key, pkg] of Object.entries(parsed.packages)) {
      // 跳过根项目（key=""）和 node_modules 内嵌（key 含 node_modules/）
      if (key === "" || key.startsWith("node_modules/")) {
        // 提取包名：node_modules/@scope/pkg → @scope/pkg
        const name = key === "" ? null : key.replace(/^node_modules\//, "");
        if (!name || !pkg.version) continue;
        entries.push({
          name,
          version: pkg.version,
          licenses: normalizeLicenses(pkg.license),
          vulnerabilities: [],
          source: "npm",
        });
      }
    }
  }

  // v2: dependencies 字段（fallback）
  if (entries.length === 0 && parsed.dependencies && typeof parsed.dependencies === "object") {
    for (const [name, dep] of Object.entries(parsed.dependencies)) {
      if (!dep.version) continue;
      entries.push({
        name,
        version: dep.version,
        licenses: normalizeLicenses(dep.license),
        vulnerabilities: [],
        source: "npm",
      });
    }
  }

  return entries;
}

// ─── pnpm-lock.yaml 解析（最小化） ──────────────────────────

/**
 * 解析 pnpm-lock.yaml 文本，提取依赖清单。
 *
 * 支持 lockfileVersion 6.0+ 的 `packages:` 段（key 为路径@version 格式）。
 * 不解析 peerDependencies / optionalDependencies。
 */
export function parsePnpmLockYaml(content: string): DependencyEntry[] {
  const entries: DependencyEntry[] = [];
  const lines = content.split("\n");
  let inPackagesSection = false;
  let inDependenciesSection = false;

  for (const line of lines) {
    // 检测 packages 段开始
    if (/^packages:\s*$/.test(line)) {
      inPackagesSection = true;
      inDependenciesSection = false;
      continue;
    }
    // 检测 dependencies 段开始
    if (/^dependencies:\s*$/.test(line)) {
      inDependenciesSection = true;
      inPackagesSection = false;
      continue;
    }
    // 检测新顶层段（非空且不缩进）
    if (/^\S/.test(line) && line.trim() !== "" && !line.startsWith(" ")) {
      inPackagesSection = false;
      inDependenciesSection = false;
      continue;
    }

    if (inPackagesSection) {
      // packages 段格式：  /@scope/pkg@1.2.3:
      const match = line.match(/^\s+\/(.+)@([^@]+):\s*$/);
      if (match?.[1] && match[2]) {
        entries.push({
          name: match[1],
          version: match[2],
          licenses: [],
          vulnerabilities: [],
          source: "pnpm",
        });
      }
    } else if (inDependenciesSection) {
      // dependencies 段格式：  pkg: 1.2.3
      const match = line.match(/^\s{2}([^@\s]+):\s*([^\s]+)\s*$/);
      if (match?.[1] && match[2]) {
        entries.push({
          name: match[1],
          version: match[2],
          licenses: [],
          vulnerabilities: [],
          source: "pnpm",
        });
      }
    }
  }

  return entries;
}

// ─── 辅助函数 ──────────────────────────────────────────────

/** 规范化许可证字段为 string[]。 */
function normalizeLicenses(license: string | string[] | undefined): string[] {
  if (!license) return [];
  if (Array.isArray(license)) return license.filter((l): l is string => typeof l === "string");
  if (typeof license === "string") {
    // 可能是 "MIT OR Apache-2.0" 格式，拆分为列表
    return license.split(/\s+(?:OR|AND)\s+/).filter((l) => l.length > 0);
  }
  return [];
}

// ─── 统一解析入口 ──────────────────────────────────────────

/** 锁定文件格式。 */
export type LockfileFormat = "npm" | "pnpm";

/** 根据格式解析锁定文件文本。 */
export function parseLockfile(content: string, format: LockfileFormat): DependencyEntry[] {
  switch (format) {
    case "npm":
      return parsePackageLockJson(content);
    case "pnpm":
      return parsePnpmLockYaml(content);
    default:
      throw new LockfileParseError(format, `不支持的格式: ${format}`);
  }
}
