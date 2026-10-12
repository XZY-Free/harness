"use strict";

/**
 * workspace-lock 原生模块加载器（A07 决策一）。
 *
 * 暴露内核锁与 descriptor-relative 受管文件 IO，且**没有 fallback**：
 *
 *   openAndTryLock(stablePath) -> { state: "held", handle } | { state: "busy" }
 *   unlockAndClose(handle)     -> { state: "released" | "already_released" }
 *   lockFileIdentity(path)     -> { device, inode, exists }
 *   secureWriteFile(root, relativePath, content)
 *   secureDeleteFile(root, relativePath)
 *
 * 二进制缺失时**抛出**，绝不安静降级成"总是成功"的纯 JS 实现 —— 那会让
 * "内核排他锁"退化成 `mkdir` 时代同样的竞态，而且测试会假绿。
 */

const fs = require("node:fs");
const path = require("node:path");

const CANDIDATE_PATHS = [
  path.join(__dirname, "build", "Release", "workspace_lock.node"),
  path.join(__dirname, "build", "Debug", "workspace_lock.node"),
];

function loadBinding() {
  for (const candidate of CANDIDATE_PATHS) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error(
    `workspace-lock 原生模块尚未构建或安装：未找到 ${CANDIDATE_PATHS.join(" 或 ")}。请运行 \`pnpm build:workspace-lock\`（需要 C/C++ 工具链与 Node 头文件）。`,
  );
}

module.exports = loadBinding();
module.exports.BINARY_PATHS = CANDIDATE_PATHS;
