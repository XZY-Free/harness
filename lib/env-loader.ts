/**
 * 环境文件加载器 —— 仅供 instrumentation.ts 在运行时调用。
 *
 * 为什么独立成文件（而非放 lib/config.ts）：
 * 本模块含 readFileSync / process.cwd() 等文件系统操作。若放在被页面 / route 间接 import 的
 * config.ts 里，Turbopack 的 NFT（Node File Tracing）静态分析会因「动态 cwd + 读文件」把整个
 * 项目纳入追踪并告警。隔离到只被 instrumentation 引用的模块即可避免，也让 config.ts 保持纯粹。
 *
 * 优先级（高 → 低）：
 * 1. 平台注入（K8s / docker -e）/ 命令行 / Shell export —— 进程启动前即存在
 * 2. .env.{APP_ENV}.local —— 开发者个人密钥与覆盖（**始终生效，可覆盖平台注入**）
 * 3. .env.{APP_ENV} —— 该环境的非敏感默认（仅填补空缺，不覆盖已有值）
 * （.env / .env.{NODE_ENV} 由 Next.js 自行加载，优先级最低）
 *
 * 文件值【跳过空值行】——空占位不应设值，也不应破坏注入值。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnvFile(filename: string, overwrite: boolean): void {
 const filePath = join(/*turbopackIgnore: true*/ process.cwd(), filename);
 if (!existsSync(/*turbopackIgnore: true*/ filePath)) return;

 for (const rawLine of readFileSync(/*turbopackIgnore: true*/ filePath, "utf8").split(/\r?\n/)) {
 const line = rawLine.trim();
 if (!line || line.startsWith("#")) continue;

 const eqIdx = line.indexOf("=");
 if (eqIdx <= 0) continue;

 const key = line.slice(0, eqIdx).trim();
 const value = line.slice(eqIdx + 1).trim();

 if (!value) continue; // 跳过空值行
 if (!overwrite && process.env[key]) continue; // 非覆盖模式：已有值不覆盖

 process.env[key] = value;
 }
}

/**
 * 加载 .env.{appEnv}.local 与 .env.{appEnv}。
 *
 * : 生产环境(APP_ENV=production)禁止 .local 覆盖平台注入——能写入应用 cwd 的攻击者
 * 可用 .env.production.local 静默替换 K8s/docker 注入的 secret(LLM_API_KEY/SECRET_MASTER_KEY
 * 等),优先级反直觉高于平台注入。生产改为 overwrite=false(仅填补空缺),与 .env.{appEnv} 同级。
 * dev/test 保留 overwrite=true,供开发者个人密钥覆盖。
 */
export function loadAppEnvFiles(appEnv: string): void {
 const allowLocalOverwrite = appEnv !== "production";
 if (allowLocalOverwrite) {
 loadEnvFile(`.env.${appEnv}.local`, /* overwrite */ true);
 }
 loadEnvFile(`.env.${appEnv}`, /* overwrite */ false);
}
