/** R2/R3 崩溃窗口夹具：真实初次 dispatcher 在已提交边界等待，由父测试 SIGKILL。 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY_FLAG = "--initial-dispatch-crash-entry";

export type InitialDispatchCrashStage =
  | "after_claim"
  | "after_lease_prepared"
  | "before_owner"
  | "before_writer"
  | "before_writer_commit"
  | "before_request_freeze"
  | "after_request_freeze";

export interface InitialDispatchCrashConfig {
  tenantId: string;
  turnId: string;
  ownerId: string;
  stage: InitialDispatchCrashStage;
}

export interface InitialDispatchCrashHandle {
  pid: number;
  barrier: Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
  stderr(): string;
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runEntry(config: InitialDispatchCrashConfig): Promise<void> {
  const { dispatchInvocationForTurn } = await import("@/lib/runtime/dispatcher");
  const { createDefaultEnvironmentProvisioner } = await import(
    "@/lib/environment/environment-provisioner"
  );
  const { buildGatewayEndpoints } = await import("@/lib/runtime/gateway-endpoints");
  const provisioner = createDefaultEnvironmentProvisioner({ runtimeType: "container" });
  const blockedProvisioner = {
    ...provisioner,
    async provision(input: Parameters<typeof provisioner.provision>[0]) {
      await provisioner.provision(input);
      emit({ event: "barrier", stage: "after_lease_prepared" });
      return new Promise<never>(() => undefined);
    },
  };
  // 这些模式只控制末端解析或在 DB 触发器前等待；初次执行图、准备 claim、
  // Environment 和 Attempt 的写入仍由 dispatchInvocationForTurn / startRuntimeInvocation 完成。
  const runtimeClient = (config.stage === "after_request_freeze"
    ? {
        async startInvocation() {
          emit({ event: "barrier", stage: "after_request_freeze" });
          return new Promise<never>(() => undefined);
        },
      }
    : {}) as unknown as Parameters<typeof dispatchInvocationForTurn>[0]["runtimeClient"];
  await dispatchInvocationForTurn({
    tenantId: config.tenantId,
    turnId: config.turnId,
    executionSubject: {
      tenantId: config.tenantId,
      subjectType: "user",
      subjectId: config.ownerId,
    },
    ...(config.stage === "after_lease_prepared"
      ? { environmentProvisioner: blockedProvisioner }
      : { runtimeClient }),
    ...(config.stage === "after_claim" ||
    config.stage === "before_owner" ||
    config.stage === "before_writer" ||
    config.stage === "before_writer_commit" ||
    config.stage === "before_request_freeze" ||
    config.stage === "after_request_freeze"
      ? {
          runtimeEndpointResolver: async (binding) => {
            if (config.stage === "after_claim") {
              emit({ event: "barrier", stage: "after_claim" });
              return new Promise<never>(() => undefined);
            }
            return {
              runtimeEndpoint: "in-process://hosted",
              auth: { mode: "workload_token" as const, token: "in-process-runtime" },
              callbackEndpoints: buildGatewayEndpoints({
                external: false,
                invocationId: binding.invocationId,
              }),
            };
          },
        }
      : {}),
  });
  emit({ event: "done" });
}

/** 只在显式子进程标记下进入生产 dispatcher。 */
if (process.argv[2] === ENTRY_FLAG) {
  const raw = process.argv[3];
  if (!raw) throw new Error("缺少初次调度崩溃配置");
  void runEntry(JSON.parse(raw) as InitialDispatchCrashConfig).catch((error: unknown) => {
    emit({ event: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}

/** 子进程仅共享真实 MySQL/部署配置，父进程以进程信号终止，不触发 catch/finally。 */
export function spawnInitialDispatchCrashProcess(
  config: InitialDispatchCrashConfig,
): InitialDispatchCrashHandle {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ENTRY_FLAG, JSON.stringify(config)],
    { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (child.pid === undefined) throw new Error("初次调度子进程未返回 PID");
  let stderr = "";
  let stdout = "";
  let settled = false;
  let barrierResolve!: () => void;
  let barrierReject!: (error: Error) => void;
  const barrier = new Promise<void>((resolve, reject) => {
    barrierResolve = resolve;
    barrierReject = reject;
  });
  void barrier.catch(() => undefined);
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      let event: { event?: string; stage?: string; message?: string };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (event.event === "barrier" && event.stage === config.stage && !settled) {
        settled = true;
        barrierResolve();
      }
      if (event.event === "error" && !settled) {
        settled = true;
        barrierReject(new Error(`子进程调度失败：${event.message ?? "未知错误"}`));
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        barrierReject(new Error(`子进程在目标屏障前退出：code=${code} signal=${signal}`));
      }
      resolve({ code, signal });
    });
  });
  return {
    pid: child.pid,
    barrier,
    exited,
    kill: () => child.kill("SIGKILL"),
    stderr: () => stderr,
  };
}
