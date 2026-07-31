#!/usr/bin/env node
/**
 * 阶段十一：依赖许可证扫描脚本。
 *
 * 扫描 node_modules 中所有包的 license 字段，发现禁用许可证时退出码 1。
 *
 * 禁用许可证（copyleft / 网络 copyleft）：
 * - GPL-1.0, GPL-2.0, GPL-3.0
 * - AGPL-1.0, AGPL-3.0
 * - SSPL-1.0
 * - LGPL（仅作为直接依赖时禁用，作为传递依赖允许——LGPL 动态链接例外）
 *   → 本脚本统一禁用 LGPL，由人工审查白名单
 * - CPAL-1.0
 * - EUPL-1.0, EUPL-1.1, EUPL-1.2
 * - JSCL（JSON License — 不算真正开源，有使用限制）
 *
 * 许可：MIT, ISC, Apache-2.0, BSD-*, 0BSD, Unlicense, CC0-1.0, MPL-2.0 均通过。
 *
 * 用法：node scripts/check-licenses.mjs
 * 选项：
 *   --json   输出 JSON 格式（供 CI 解析）
 *   --path   自定义 node_modules 路径（默认 ./node_modules）
 *   --whitelist  自定义白名单文件路径（默认 ./.license-whitelist.json）
 *
 * 白名单文件格式（JSON）：
 * [{ "name": "@img/sharp-libvips-darwin-arm64", "license": "LGPL-3.0-or-later", "reason": "libvips 作为动态链接库使用，LGPL 动态链接例外适用" }]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ─── 禁用许可证模式 ───────────────────────────────────────────────

const FORBIDDEN_LICENSE_PATTERNS = [
  /^GPL-/i,
  /^GPL\b/i,
  /^AGPL-/i,
  /^AGPL\b/i,
  /^SSPL-/i,
  /^LGPL-/i,
  /^LGPL\b/i,
  /^CPAL-/i,
  /^EUPL-/i,
  /^JSON/i,
  /"JSON License"/i,
];

// ─── 许可证字段解析 ───────────────────────────────────────────────

/**
 * 从 package.json 提取许可证信息。license 字段可能是字符串或对象。
 */
function extractLicense(pkg) {
  if (!pkg) return "UNKNOWN";
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && typeof pkg.license.type === "string") {
    return pkg.license.type;
  }
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const types = pkg.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    return types.length > 0 ? types.join(", ") : "UNKNOWN";
  }
  return "UNKNOWN";
}

function isForbidden(license) {
  if (!license || license === "UNKNOWN") return false;
  // licenses 数组字段会被 join 成 "MIT, GPL-3.0"；逐段检查更精确
  // （含 SPDX 表达式如 "(MIT OR GPL-3.0)" 也按子串命中）
  const parts = license
    .split(/[,()]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.some((part) => FORBIDDEN_LICENSE_PATTERNS.some((p) => p.test(part)));
}

// ─── node_modules 扫描 ────────────────────────────────────────────

function scanNodeModules(rootDir) {
  const results = [];
  const seen = new Set();

  function scanPackageDir(fullPath, entry) {
    const pkgJsonPath = join(fullPath, "package.json");
    try {
      const raw = readFileSync(pkgJsonPath, "utf-8");
      const pkg = JSON.parse(raw);
      const name = pkg.name || entry;
      const versionKey = `${name}@${pkg.version || "?"}`;
      if (seen.has(versionKey)) return;
      seen.add(versionKey);
      const license = extractLicense(pkg);
      results.push({ name, version: pkg.version || "?", license });
    } catch {
      // package.json 不存在或解析失败，跳过
    }
  }

  function scanDir(dir, isScoped = false) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      // 跳过 .package-lock.json 等隐藏文件，但保留 .pnpm（pnpm 虚拟存储）
      if (entry.startsWith(".") && entry !== ".pnpm") continue;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === ".pnpm") {
          // pnpm 虚拟存储：每个子目录形如 pkg@ver_peer@ver/node_modules/<pkg>/package.json
          scanPnpmStore(fullPath);
        } else if (entry.startsWith("@") && !isScoped) {
          // scoped 包目录（@scope/pkg）
          scanDir(fullPath, true);
        } else {
          // 普通包目录
          scanPackageDir(fullPath, entry);
          // 递归扫描嵌套 node_modules
          const nestedModules = join(fullPath, "node_modules");
          try {
            if (statSync(nestedModules).isDirectory()) {
              scanDir(nestedModules);
            }
          } catch {
            // 无嵌套 node_modules
          }
        }
      }
    }
  }

  /**
   * 扫描 pnpm .pnpm 虚拟存储。
   * 结构：.pnpm/<pkg>@<ver>/node_modules/<pkg>/package.json
   * 也可能含 scoped：.pnpm/@scope+pkg@ver/node_modules/@scope/pkg/package.json
   */
  function scanPnpmStore(pnpmDir) {
    let entries;
    try {
      entries = readdirSync(pnpmDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const storeEntry = join(pnpmDir, entry, "node_modules");
      try {
        if (!statSync(storeEntry).isDirectory()) continue;
      } catch {
        continue;
      }
      // 扫描 node_modules 下的所有包（含 @scope 目录）
      scanDir(storeEntry, false);
    }
  }

  scanDir(rootDir);
  return results;
}

// ─── 白名单加载 ───────────────────────────────────────────────────

/**
 * 加载白名单文件。格式：[{ name, license, reason }]。
 * 文件不存在时返回空数组（非错误——白名单可选）。
 */
function loadWhitelist(whitelistPath) {
  if (!existsSync(whitelistPath)) return [];
  try {
    const raw = readFileSync(whitelistPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("白名单文件必须是 JSON 数组");
    }
    // 校验每条记录
    for (const entry of parsed) {
      if (typeof entry.name !== "string" || typeof entry.license !== "string") {
        throw new Error("白名单每条记录需含 name 与 license 字段");
      }
    }
    return parsed;
  } catch (err) {
    console.error(`❌ 白名单文件解析失败（${whitelistPath}）: ${err.message}`);
    process.exit(2);
  }
}

/**
 * 判断包是否在白名单中。匹配规则：name 相同且 license 子串匹配（容忍版本后缀差异）。
 */
function isWhitelisted(pkg, whitelist) {
  return whitelist.some((w) => w.name === pkg.name && pkg.license.includes(w.license));
}

// ─── 主逻辑 ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const pathIdx = args.indexOf("--path");
  const nodeModulesPath =
    pathIdx >= 0 && args[pathIdx + 1]
      ? resolve(args[pathIdx + 1])
      : resolve(process.cwd(), "node_modules");
  const whitelistIdx = args.indexOf("--whitelist");
  const whitelistPath =
    whitelistIdx >= 0 && args[whitelistIdx + 1]
      ? resolve(args[whitelistIdx + 1])
      : resolve(process.cwd(), ".license-whitelist.json");

  const whitelist = loadWhitelist(whitelistPath);
  const results = scanNodeModules(nodeModulesPath);
  const forbiddenAll = results.filter((r) => isForbidden(r.license));
  // 白名单过滤：已审查的包不视为违规
  const forbidden = forbiddenAll.filter((r) => !isWhitelisted(r, whitelist));
  const whitelistedHits = forbiddenAll.filter((r) => isWhitelisted(r, whitelist));
  const unknown = results.filter((r) => r.license === "UNKNOWN");

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          total: results.length,
          forbidden: forbidden.length,
          whitelisted: whitelistedHits.length,
          unknown: unknown.length,
          forbiddenPackages: forbidden,
          whitelistedPackages: whitelistedHits,
          unknownPackages: unknown,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\n📋 许可证扫描报告`);
    console.log(`   扫描路径:   ${nodeModulesPath}`);
    console.log(`   白名单文件: ${whitelistPath}`);
    console.log(`   总包数:     ${results.length}`);
    console.log(`   禁用许可证: ${forbidden.length}`);
    console.log(`   白名单命中: ${whitelistedHits.length}`);
    console.log(`   未知许可证: ${unknown.length}`);

    if (whitelistedHits.length > 0) {
      console.log(`\n✅ 白名单覆盖（已审查）:`);
      for (const pkg of whitelistedHits) {
        const w = whitelist.find((x) => x.name === pkg.name);
        console.log(`   ${pkg.name}@${pkg.version} → ${pkg.license}`);
        if (w?.reason) console.log(`      原因: ${w.reason}`);
      }
    }

    if (forbidden.length > 0) {
      console.log(`\n❌ 发现禁用许可证:`);
      for (const pkg of forbidden) {
        console.log(`   ${pkg.name}@${pkg.version} → ${pkg.license}`);
      }
    }

    if (unknown.length > 0 && !jsonOutput) {
      console.log(`\n⚠️  未知许可证（需人工审查）:`);
      for (const pkg of unknown.slice(0, 20)) {
        console.log(`   ${pkg.name}@${pkg.version}`);
      }
      if (unknown.length > 20) {
        console.log(`   ...还有 ${unknown.length - 20} 个`);
      }
    }

    if (forbidden.length === 0) {
      console.log(`\n✅ 无禁用许可证（白名单已过滤已审查包）`);
    }
  }

  process.exit(forbidden.length > 0 ? 1 : 0);
}

main();
