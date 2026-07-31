// S01-W01：V11 机器契约项目级校验入口。
//
// 把 OpenAPI 生成检查、合同校验、JSON Schema 校验和 conformance 校验组合为
// 单一命令。校验只读取仓库文件，不访问生产服务，不依赖真实 Token。
//
// 生成文件（v11.openapi.json）只能由生成器更新；--check 模式检测手工修改时失败。
// 输出固定包含 HTTP 操作数、Event 数、错误码数和一致性用例数，便于打卡留证。
//
// 用法：
//   node scripts/v11-contracts.mjs          # 校验（CI 用）
//   node scripts/v11-contracts.mjs --write  # 重新生成 OpenAPI 后再校验

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS_DIR = resolve(ROOT, "docs/solutions/v11-agentkit-platform/scripts");
const VALIDATOR = resolve(SCRIPTS_DIR, "validate_contracts.py");
const GENERATOR = resolve(SCRIPTS_DIR, "generate_openapi.py");

const wantWrite = process.argv.includes("--write");

function runPy(file, extraArgs = []) {
  const result = spawnSync("python3", [file, ...extraArgs], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// 1. 生成器 --check（或 --write）：确保 OpenAPI 与规范文档同步，禁止手改生成文件。
runPy(GENERATOR, [wantWrite ? "--write" : "--check"]);

// 2. 全量契约校验：manifest、OpenAPI、Event Catalog、错误码、conformance、跨文档规则。
//    校验器输出固定格式：“V11 contracts valid: N operations, N events, N errors, N conformance cases”
runPy(VALIDATOR);
