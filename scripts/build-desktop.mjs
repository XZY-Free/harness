import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const bundleDir = "desktop/bundle";
const packageDir = "desktop/package-app";
const rendererDir = "desktop/renderer-dist";

await Promise.all([
  rm(bundleDir, { recursive: true, force: true }),
  rm(`${packageDir}/bundle`, { recursive: true, force: true }),
  rm(`${packageDir}/renderer`, { recursive: true, force: true }),
  // node_modules 每次整体重建：清掉升级前遗留的历史死依赖，而不写死旧包名。
  rm(`${packageDir}/node_modules`, { recursive: true, force: true }),
]);

await build({
  entryPoints: {
    "main/index": "desktop/main/index.ts",
    "preload/index": "desktop/preload/index.ts",
  },
  outdir: bundleDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron", "better-sqlite3"],
  logLevel: "info",
});

const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const packageJson = {
  name: "snow-harness-desktop",
  version: rootPackage.version,
  description: rootPackage.description,
  author: rootPackage.author,
  private: true,
  main: "bundle/main/index.js",
  dependencies: {
    "better-sqlite3": rootPackage.dependencies["better-sqlite3"],
  },
};

await mkdir(`${packageDir}/node_modules`, { recursive: true });
await Promise.all([
  cp(bundleDir, `${packageDir}/bundle`, { recursive: true }),
  cp(rendererDir, `${packageDir}/renderer`, { recursive: true }),
  writeFile(`${packageDir}/package.json`, `${JSON.stringify(packageJson, null, 2)}\n`),
]);

// better-sqlite3@13 的运行时通过 lib/binding.js 直接 require prebuilds/darwin-*.node，
// 依赖树中已无 bindings/file-uri-to-path（旧版本定位 .node 文件的机制已移除），
// node-addon-api 仅用于 native 编译期，非 JS 运行时加载依赖。node_modules 已在开头
// 整体重建，故直接复制整包，无需版本比较或增量缓存。
const sqliteSource = await realpath("node_modules/better-sqlite3");
await cp(sqliteSource, `${packageDir}/node_modules/better-sqlite3`, {
  dereference: true,
  recursive: true,
});
