#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const status = execFileSync("git", ["status", "--short"], { encoding: "utf8" }).trim();
if (status) throw new Error(`验收要求 clean worktree，当前存在改动：\n${status}`);
console.log("Worktree cleanliness OK");
