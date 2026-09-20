import { loadEnvConfig } from "@next/env";

type WorkerEnvironment = Partial<Record<"APP_ENV" | "NODE_ENV", string>>;
type EnvironmentLoader = (directory: string, development?: boolean) => unknown;

/**
 * 让独立 Worker 与 Next.js Web 读取同一套项目配置文件。
 *
 * 本地直接运行 Worker 时默认采用 development；部署环境通过 APP_ENV 或 NODE_ENV
 * 选择 production。配置必须在导入业务模块前加载，避免模块初始化时读到空环境。
 */
export function loadWorkerEnvironment(
  directory = process.cwd(),
  environment: WorkerEnvironment = process.env,
  loader: EnvironmentLoader = loadEnvConfig,
): void {
  const mode = environment.APP_ENV ?? environment.NODE_ENV ?? "development";
  loader(directory, mode !== "production");
}

export async function runConfiguredWorkerProcess(role?: string): Promise<void> {
  loadWorkerEnvironment();
  const { runProductionWorkerProcess } = await import("./production-worker-process");
  await runProductionWorkerProcess(role);
}
