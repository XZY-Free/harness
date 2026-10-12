#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Node 版本前置条件——**必须 fail-fast**。
 *
 * 事实源：`package.json` 的 `engines.node`（CI `.github/workflows/ci.yml` 同样固定 node 24）。
 *
 * 为什么不能靠"跑起来再说"：Playwright 1.62 在 Node 22 上走 `module.registerHooks`
 * 同步 hooks 分支，**不**安装 CJS hooks（`playwright/lib/common/index.js` 的
 * `registerESMLoader` 与 `esmLoader.js` 的 `installCJSHooks` 只在 async loader 分支执行）。
 * 后果是 tsconfig `paths` 只对 spec 文件里**直接书写**的 `@/…` 生效，被加载的应用模块内部的
 * 嵌套 `@/…` 解析失败，报出的是 `Cannot find module '@/lib/config'`
 * （Require stack: `lib/db/client.ts`）——看起来像别名配置缺陷，实际是运行器版本不符，
 * 排查代价极高。这里把它变成一句话结论。
 */
const enginesNode = JSON.parse(readFileSync("package.json", "utf8")).engines?.node ?? "";
const requiredNode = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(enginesNode);
if (requiredNode) {
  const actual = process.versions.node.split(".").map(Number);
  const wanted = requiredNode.slice(1).map(Number);
  const isOlder =
    actual[0] < wanted[0] ||
    (actual[0] === wanted[0] &&
      (actual[1] < wanted[1] || (actual[1] === wanted[1] && actual[2] < wanted[2])));
  if (isOlder) {
    throw new Error(
      `Playwright 阶段要求 Node ${enginesNode}（package.json engines），当前 ${process.version}。请用工程 engines 指定的 Node 运行本阶段；Node 22 会让应用模块内的 @/ 别名解析失败。`,
    );
  }
}

const group = process.argv[2];
const allowed = new Set(["e2e-web", "e2e-desktop", "e2e-cross-client"]);
if (!allowed.has(group)) throw new Error(`未知 Playwright 分组：${group ?? "<empty>"}`);
const audit = JSON.parse(readFileSync("docs/topic-01/evidence/test-collection.json", "utf8"));
const files = audit.tests.filter((test) => test.group === group).map((test) => test.file);
if (files.length === 0) throw new Error(`${group} 没有测试文件`);

let executable = "pnpm";
let args = ["exec", "playwright", "test", ...files];
if (process.platform === "linux" && group !== "e2e-web") {
  executable = "dbus-run-session";
  const command = [
    'echo "" | gnome-keyring-daemon --unlock --replace --components=secrets >/dev/null 2>&1 &',
    "sleep 2;",
    `xvfb-run -a pnpm exec playwright test ${files.map((file) => JSON.stringify(file)).join(" ")}`,
  ].join(" ");
  args = ["--", "bash", "-c", command];
}
const run = spawnSync(executable, args, { stdio: "inherit", env: process.env });
process.exit(run.status ?? 1);
