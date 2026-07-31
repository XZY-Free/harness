import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const bundleDir = "desktop/bundle";
const packageDir = "desktop/package-app";
const rendererDir = "desktop/renderer-dist";

await Promise.all([
  rm(bundleDir, { recursive: true, force: true }),
  rm(`${packageDir}/bundle`, { recursive: true, force: true }),
  rm(`${packageDir}/renderer`, { recursive: true, force: true }),
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

for (const dependency of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
  const source = await realpath(
    dependency === "better-sqlite3"
      ? `node_modules/${dependency}`
      : `node_modules/.pnpm/node_modules/${dependency}`,
  );
  const target = `${packageDir}/node_modules/${dependency}`;
  const sourcePackage = JSON.parse(await readFile(`${source}/package.json`, "utf8"));
  let targetVersion = "";
  try {
    targetVersion = JSON.parse(await readFile(`${target}/package.json`, "utf8")).version;
  } catch {
    // 首次构建没有目标依赖。
  }
  if (targetVersion !== sourcePackage.version) {
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { dereference: true, recursive: true });
  }
}

// electron-builder only needs the runtime dependency graph. better-sqlite3's
// prebuild installer is not used when electron-builder rebuilds the native addon.
const sqlitePackagePath = `${packageDir}/node_modules/better-sqlite3/package.json`;
const sqlitePackage = JSON.parse(await readFile(sqlitePackagePath, "utf8"));
sqlitePackage.dependencies = { bindings: sqlitePackage.dependencies.bindings };
await writeFile(sqlitePackagePath, `${JSON.stringify(sqlitePackage, null, 2)}\n`);
