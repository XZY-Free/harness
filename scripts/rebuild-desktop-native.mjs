import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const electronVersion = require("electron/package.json").version;
const rebuildCli = resolve(dirname(require.resolve("@electron/rebuild")), "cli.js");
const packageDir = resolve("desktop/package-app");

function verifyElectronAbi() {
  return (
    spawnSync(
      electronExecutable,
      [
        "-e",
        `const Database=require(${JSON.stringify(
          resolve(packageDir, "node_modules/better-sqlite3"),
        )}); new Database(\":memory:\").close()`,
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "ignore",
      },
    ).status === 0
  );
}

if (!verifyElectronAbi()) {
  const result = spawnSync(
    process.execPath,
    [
      rebuildCli,
      "--version",
      electronVersion,
      "--module-dir",
      packageDir,
      "--force",
      "--which-module",
      "better-sqlite3",
      "--sequential",
    ],
    {
      env: { ...process.env, PYTHON: "/usr/bin/python3" },
      stdio: "inherit",
    },
  );
  if (result.status !== 0 || !verifyElectronAbi()) {
    throw new Error("better-sqlite3 Electron ABI 重编译失败");
  }
}
