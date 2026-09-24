/** JOB-08: consume a persisted JobCommand in an independent platform process. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY_FLAG = "--job-consumer-crash-entry";

if (process.argv[2] === ENTRY_FLAG) {
  const tenantId = process.argv[3];
  const commandId = process.argv[4];
  if (!tenantId || !commandId) throw new Error("缺少 JobCommand 子进程参数");
  void import("@/lib/job/job-command-consumer")
    .then(({ consumeJobCommand }) => consumeJobCommand({ tenantId, commandId }))
    .then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(String(error));
        process.exit(1);
      },
    );
}

export function spawnJobConsumerCrashProcess(tenantId: string, commandId: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ENTRY_FLAG, tenantId, commandId],
    { cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "pipe"] },
  );
  if (child.pid === undefined) throw new Error("JobCommand 子进程未启动");
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { kill: () => child.kill("SIGKILL"), exited, stderr: () => stderr };
}
