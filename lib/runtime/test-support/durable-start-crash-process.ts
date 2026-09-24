/** START-03/05: run the real Start and recovery Worker in separate platform processes. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY_FLAG = "--durable-start-crash-entry";

type StartConfig = {
  mode: "start";
  tenantId: string;
  invocationId: string;
  attemptId: string;
  runtimeEndpoint: string;
};

type WorkerConfig = { mode: "worker"; dueAtMs: number };
type Config = StartConfig | WorkerConfig;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runEntry(config: Config): Promise<void> {
  if (config.mode === "worker") {
    const { createRuntimeDispatchRetryWorker } = await import(
      "@/lib/runtime/retry/runtime-dispatch-retry-worker"
    );
    const worker = createRuntimeDispatchRetryWorker({
      clock: () => new Date(config.dueAtMs),
    });
    emit({ event: "done", result: await worker.tick() });
    return;
  }
  const { getInvocationById } = await import("@/lib/executions/persistence/invocation-store");
  const { getExecutionBindingByInvocation } = await import(
    "@/lib/executions/persistence/execution-binding-queries"
  );
  const { getAttemptById } = await import("@/lib/executions/persistence/attempt-store");
  const { attemptPreparationClaimForTest } = await import(
    "@/lib/executions/test-support/preparation-fixtures"
  );
  const { startRuntimeInvocation } = await import("@/lib/runtime/application/runtime-start");
  const { createHttpRuntimeClient } = await import("@/lib/runtime/runtime-client");
  const { buildGatewayEndpoints } = await import("@/lib/runtime/gateway-endpoints");
  const [invocation, binding, attempt] = await Promise.all([
    getInvocationById(config.tenantId, config.invocationId),
    getExecutionBindingByInvocation(config.tenantId, config.invocationId),
    getAttemptById(config.attemptId),
  ]);
  if (!invocation || !binding || !attempt) throw new Error("持久 Start 夹具缺少执行图");
  const preparationClaim = await attemptPreparationClaimForTest(attempt.id);
  await startRuntimeInvocation({
    tenantId: config.tenantId,
    invocation,
    binding,
    attempt,
    sourceOperationKey: `invocation:${invocation.id}`,
    preparationClaim,
    runtimeClient: createHttpRuntimeClient(),
    runtimeEndpoint: config.runtimeEndpoint,
    auth: { mode: "none" },
    callbackEndpoints: buildGatewayEndpoints({ external: true, invocationId: invocation.id }),
  });
  emit({ event: "done" });
}

if (process.argv[2] === ENTRY_FLAG) {
  const raw = process.argv[3];
  if (!raw) throw new Error("缺少持久 Start 子进程配置");
  void runEntry(JSON.parse(raw) as Config).then(
    () => {
      setTimeout(() => process.exit(0), 100);
    },
    (error: unknown) => {
      emit({ event: "error", message: error instanceof Error ? error.message : String(error) });
      setTimeout(() => process.exit(1), 100);
    },
  );
}

export function spawnDurableStartCrashProcess(config: Config) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ENTRY_FLAG, JSON.stringify(config)],
    { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (child.pid === undefined) throw new Error("持久 Start 子进程未返回 PID");
  let stderr = "";
  let stdout = "";
  let doneResolve!: (value: Record<string, unknown>) => void;
  let doneReject!: (error: Error) => void;
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });
  void done.catch(() => undefined);
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      let event: { event?: string; message?: string; result?: Record<string, unknown> };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (event.event === "done") doneResolve(event.result ?? {});
      if (event.event === "error") doneReject(new Error(event.message ?? "子进程失败"));
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      if (code !== 0 && signal === null) doneReject(new Error(`子进程退出 ${code}: ${stderr}`));
      resolve({ code, signal });
    });
  });
  return {
    pid: child.pid,
    done,
    exited,
    kill: () => child.kill("SIGKILL"),
    stderr: () => stderr,
  };
}
