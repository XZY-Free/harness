/** 在真实 Backend 已释放资源、Lease 终态尚未写入时停止清理进程。 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY_FLAG = "--environment-cleanup-crash-entry";

type Config = {
  tenantId: string;
  leaseId: string;
  controlRoot: string;
};

async function run(config: Config): Promise<void> {
  const { createContainerEnvironmentBackend } = await import(
    "@/lib/environment/environment-instance-backend"
  );
  const { runEnvironmentLeaseCleanup } = await import("@/lib/environment/environment-provisioner");
  const real = createContainerEnvironmentBackend({ controlRoot: config.controlRoot });
  await runEnvironmentLeaseCleanup({
    tenantId: config.tenantId,
    leaseId: config.leaseId,
    owner: `cleanup-crash:${process.pid}`,
    backend: {
      kind: real.kind,
      create: (input) => real.create(input),
      inspect: (input) => real.inspect(input),
      queryOperation: (operationId) => real.queryOperation(operationId),
      async release(input) {
        const receipt = await real.release(input);
        process.stdout.write(`${JSON.stringify({ event: "released", receipt })}\n`);
        return new Promise<never>(() => undefined);
      },
    },
  });
}

if (process.argv[2] === ENTRY_FLAG) {
  const raw = process.argv[3];
  if (!raw) throw new Error("缺少环境清理子进程配置");
  void run(JSON.parse(raw) as Config).catch((error: unknown) => {
    process.stdout.write(
      `${JSON.stringify({ event: "error", message: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  });
}

export function spawnEnvironmentCleanupCrashProcess(config: Config) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ENTRY_FLAG, JSON.stringify(config)],
    { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (child.pid === undefined) throw new Error("环境清理子进程未返回 PID");
  let stdout = "";
  let stderr = "";
  let resolveReleased!: (value: Record<string, unknown>) => void;
  let rejectReleased!: (error: Error) => void;
  const released = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveReleased = resolve;
    rejectReleased = reject;
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.event === "released") resolveReleased(event);
      if (event.event === "error") rejectReleased(new Error(String(event.message)));
      newline = stdout.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      rejectReleased(new Error(`环境清理子进程提前退出：code=${code} signal=${signal} ${stderr}`));
      resolve({ code, signal });
    });
  });
  return { released, exited, kill: () => child.kill("SIGKILL") };
}
