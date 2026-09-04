#!/usr/bin/env node
// 保留直接调用兼容；阶段列表只从 Topic 01 机器验证计划读取。
process.argv.push("--profile", "verify");
await import("./topic-01-acceptance.mjs");
