import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 冻结不变量：scripts/build-desktop.mjs 生成 desktop/package-app 时，node_modules
 * 必须只包含 better-sqlite3@13.0.3 真实需要的 runtime 文件——包括清掉升级前遗留
 * 的历史死依赖（bindings / file-uri-to-path）。生成后的 better-sqlite3 必须能被
 * Node 真实 open/query/close。
 *
 * 真实行为测试：测试自行在 package-app/node_modules 种入旧残留，直接以子进程运行
 * 真实生成器（不改源码），再对生成产物断言。不得在断言前手工删除种入的残留——
 * 清理必须由生成器自己完成，不能依赖外部手工干预。不是对 build-desktop.mjs 源码
 * 做字符串匹配——那无法代表打包行为。
 *
 * better-sqlite3@13.0.3 的运行时产物是自包含的 prebuilds/darwin-*.node（N-API，
 * lib/binding.js 直接 require），其生产依赖 node-addon-api 仅用于编译期、运行时
 * 不需要；旧版本通过 bindings/file-uri-to-path 定位 .node 文件的机制在 13 已移除。
 */
const ROOT = process.cwd();
const GENERATOR = "scripts/build-desktop.mjs";
const PACKAGE_APP = join(ROOT, "desktop", "package-app");
const APP_NODE_MODULES = join(PACKAGE_APP, "node_modules");
const SQLITE_DIR = join(APP_NODE_MODULES, "better-sqlite3");
const CURRENT_PLATFORM_PREBUILD = `${process.platform}-${process.arch}.node`;

describe("build-desktop 生成器冻结不变量", () => {
  it(
    "生成器清掉种入的旧残留，只留 better-sqlite3 真实 runtime，且 Node 可真实加载",
    { timeout: 120_000 },
    async () => {
      // 种入升级前遗留的死依赖，模拟旧构建残留；不得在断言前手工删除。
      await mkdir(join(APP_NODE_MODULES, "bindings"), { recursive: true });
      await writeFile(join(APP_NODE_MODULES, "bindings", "index.js"), "// stale legacy residue\n");
      await mkdir(join(APP_NODE_MODULES, "file-uri-to-path"), { recursive: true });
      await writeFile(
        join(APP_NODE_MODULES, "file-uri-to-path", "index.js"),
        "// stale legacy residue\n",
      );

      const result = spawnSync(process.execPath, [GENERATOR], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, CI: "1" },
      });
      expect(
        result.status,
        `build-desktop 生成失败（status=${result.status}）\n---stdout---\n${result.stdout}\n---stderr---\n${result.stderr}`,
      ).toBe(0);

      // 生成器必须整体重建 node_modules，清掉种入的旧残留（即使生成器 exit 0，
      // 若残留仍在则此断言失败——这正是历史缺陷）。
      expect(existsSync(join(APP_NODE_MODULES, "bindings"))).toBe(false);
      expect(existsSync(join(APP_NODE_MODULES, "file-uri-to-path"))).toBe(false);

      // better-sqlite3 整包被复制，且含当前平台 N-API prebuild（运行时加载源）。
      expect(existsSync(join(SQLITE_DIR, "package.json"))).toBe(true);
      expect(existsSync(join(SQLITE_DIR, "prebuilds", CURRENT_PLATFORM_PREBUILD))).toBe(true);

      // 生成后的 better-sqlite3 必须能被 Node 真实 open/query/close。
      const require = createRequire(import.meta.url);
      const Database = require(SQLITE_DIR);
      const db = new Database(":memory:");
      db.exec("create table t (a)");
      db.prepare("insert into t (a) values (?)").run(42);
      expect(db.prepare("select a from t").get()).toEqual({ a: 42 });
      db.close();
    },
  );
});
