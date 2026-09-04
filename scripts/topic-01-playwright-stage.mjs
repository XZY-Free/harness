#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
    "sleep 2",
    `xvfb-run -a pnpm exec playwright test ${files.map((file) => JSON.stringify(file)).join(" ")}`,
  ].join("; ");
  args = ["--", "bash", "-c", command];
}
const run = spawnSync(executable, args, { stdio: "inherit", env: process.env });
process.exit(run.status ?? 1);
