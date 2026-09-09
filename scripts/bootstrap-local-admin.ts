import { readFileSync, statSync } from "node:fs";
import { closeDbPool } from "@/lib/db/client";
import { bootstrapLocalAdmin } from "@/lib/identity/local-authentication";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

async function main(): Promise<void> {
  const email = required("SNOW_BOOTSTRAP_ADMIN_EMAIL");
  const displayName = required("SNOW_BOOTSTRAP_ADMIN_NAME");
  const passwordFile = required("SNOW_BOOTSTRAP_ADMIN_PASSWORD_FILE");
  const mode = statSync(passwordFile).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error("管理员密码文件权限过宽，请设置为仅文件所有者可读写（0600）");
  }
  const password = readFileSync(passwordFile, "utf8").replace(/[\r\n]+$/, "");
  await bootstrapLocalAdmin({ email, displayName, password });
  console.log(`[auth] 管理员账号已初始化：${email.trim().toLowerCase()}`);
}

main()
  .catch((error) => {
    console.error("[auth] 管理员初始化失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
