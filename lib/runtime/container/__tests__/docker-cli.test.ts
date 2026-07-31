import {
  type RunContainerOpts,
  execDetachedWithPid,
  runContainer,
} from "@/lib/runtime/container/docker-cli";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 04-G2：docker-cli runContainer 参数透传测试。
 *
 * 验证 runContainer 复用 rlimit.dockerResourceArgs 生成 `--pids-limit` / `--ulimit nofile`
 * 参数（消除双轨：手写参数组装 vs 封装函数）。mock execa 捕获实际传给 docker 的 args 数组，
 * 断言 pidsLimit/openFilesLimit 透传行为等价。
 */

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: execaMock,
}));

// 取 execaMock 第 N 次调用的第二个参数（docker args 数组）；守卫替代非空断言。
function dockerArgs(callIdx = 0): readonly string[] {
  const call = execaMock.mock.calls[callIdx];
  if (!call) throw new Error(`execa 未被调用（期望第 ${callIdx} 次调用）`);
  const args = call[1];
  if (!Array.isArray(args)) throw new Error("execa 第二参数非数组");
  return args as readonly string[];
}

function baseOpts(over: Partial<RunContainerOpts> = {}): RunContainerOpts {
  return {
    name: "snow-thread-test",
    image: "snow-harness-runtime:node22",
    threadId: "tid-docker-cli",
    hostPath: "/tmp/ws",
    port: 41000,
    memory: "1g",
    cpus: "1.0",
    env: ["PORT=41000"],
    ...over,
  };
}

beforeEach(() => {
  execaMock.mockReset();
  // 默认 docker run 成功（exitCode 0 + stdout containerId）
  execaMock.mockResolvedValue({ exitCode: 0, stdout: "container-id-abc\n", stderr: "" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runContainer 透传 dockerResourceArgs（04-G2 双轨消除）", () => {
  it("pidsLimit + openFilesLimit → 透传 --pids-limit 与 --ulimit nofile=soft:hard", async () => {
    await runContainer(baseOpts({ pidsLimit: 256, openFilesLimit: 1024 }));

    expect(execaMock).toHaveBeenCalledTimes(1);
    const args = dockerArgs();
    expect(args).toContain("--pids-limit");
    expect(args).toContain("256");
    expect(args).toContain("--ulimit");
    expect(args).toContain("nofile=1024:1024");
  });

  it("仅 pidsLimit → 只透传 --pids-limit，无 --ulimit", async () => {
    await runContainer(baseOpts({ pidsLimit: 128 }));

    const args = dockerArgs();
    expect(args).toContain("--pids-limit");
    expect(args).toContain("128");
    expect(args.some((a: string) => typeof a === "string" && a.startsWith("nofile="))).toBe(false);
    // 不应出现 --ulimit（nofile 是唯一 ulimit 项）
    const ulimitIdx = args.indexOf("--ulimit");
    expect(ulimitIdx).toBe(-1);
  });

  it("无限额 → 不透传 --pids-limit / --ulimit", async () => {
    await runContainer(baseOpts());

    const args = dockerArgs();
    expect(args).not.toContain("--pids-limit");
    expect(args).not.toContain("--ulimit");
  });

  it("限额=0 → 视为无限额（不透传，与 dockerResourceArgs 行为等价）", async () => {
    await runContainer(baseOpts({ pidsLimit: 0, openFilesLimit: 0 }));

    const args = dockerArgs();
    expect(args).not.toContain("--pids-limit");
    expect(args).not.toContain("--ulimit");
  });

  it("diskQuotaBytes 仍透传 --storage-opt size=（与资源限额解耦，04-G2 不影响）", async () => {
    await runContainer(baseOpts({ diskQuotaBytes: 512 * 1024 * 1024 }));

    const args = dockerArgs();
    expect(args).toContain("--storage-opt");
    expect(args).toContain("size=536870912");
  });

  it("docker run 失败 → 抛错含 exit code 与 stderr", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "name already in use" });
    await expect(runContainer(baseOpts({ pidsLimit: 8 }))).rejects.toThrow(/docker run 失败/);
  });
});

// S1（02-P2-5）：extraArgs/--add-host 透传专项测试(原代码链路完整但无断言,回归风险)。
describe("runContainer 透传 extraArgs（02-P2-5）", () => {
  it("extraArgs → 透传到 docker args(如 --add-host)", async () => {
    await runContainer(
      baseOpts({ extraArgs: ["--add-host", "host.docker.internal:host-gateway"] }),
    );
    const args = dockerArgs();
    // extraArgs 原样 push,顺序在 image 之前
    const addHostIdx = args.indexOf("--add-host");
    expect(addHostIdx).toBeGreaterThan(-1);
    expect(args[addHostIdx + 1]).toBe("host.docker.internal:host-gateway");
    // image 参数在 extraArgs 之后
    expect(args.indexOf("snow-harness-runtime:node22")).toBeGreaterThan(addHostIdx);
  });

  it("无 extraArgs → docker args 不含 --add-host(默认无额外参数)", async () => {
    await runContainer(baseOpts());
    const args = dockerArgs();
    expect(args).not.toContain("--add-host");
  });

  it("extraArgs 多参数 → 全部透传(如 --gpus --cap-add)", async () => {
    await runContainer(baseOpts({ extraArgs: ["--gpus", "all", "--cap-add", "SYS_PTRACE"] }));
    const args = dockerArgs();
    expect(args).toContain("--gpus");
    expect(args).toContain("all");
    expect(args).toContain("--cap-add");
    expect(args).toContain("SYS_PTRACE");
  });
});

// S1（02-P2-6）：execDetachedWithPid 的 pidFile/logPath/tasksDir 经 shQuote 转义专项测试。
// 原 execution-background.test.ts 把 execDetachedWithPid mock 掉,未验证真实转义输出。
describe("execDetachedWithPid shQuote 转义（02-P2-6）", () => {
  // execDetachedWithPid → execDetached → execa("docker",["exec","-d",name,"sh","-lc","cd /workspace && <wrapped>"])
  // 取 execa 调用的第 5 个参数(index 5)即 shell 命令,验证 wrapped 含转义后的路径。
  function wrappedCmd(callIdx = 0): string {
    const call = execaMock.mock.calls[callIdx];
    if (!call) throw new Error("execa 未被调用");
    const args = call[1];
    if (!Array.isArray(args)) throw new Error("execa 第二参数非数组");
    // ["exec","-d",name,"sh","-lc","cd /workspace && <wrapped>"]
    return String(args[5]);
  }

  it("pidFile/logPath/tasksDir 经 shQuote 单引号转义", async () => {
    await execDetachedWithPid("c1", "task-uuid-123", "node server.js");
    const cmd = wrappedCmd();
    // tasksDir/pidFile/logPath 均被 shQuote 包成 '...'
    expect(cmd).toContain("mkdir -p '/workspace/.snow/runtime/tasks'");
    expect(cmd).toContain("'/workspace/.snow/runtime/tasks/task-uuid-123.pid'");
    expect(cmd).toContain("'/workspace/.snow/runtime/tasks/task-uuid-123.log'");
    // 原始 command 原样拼入(非转义,调用方负责)
    expect(cmd).toContain("exec node server.js");
  });

  it("taskId 含空格 → pidFile/logPath 路径仍被引号包裹(防 shell 断词)", async () => {
    await execDetachedWithPid("c1", "task with space", "sleep 1");
    const cmd = wrappedCmd();
    // shQuote 包成单引号串,空格在引号内安全(不断词)
    expect(cmd).toContain("'/workspace/.snow/runtime/tasks/task with space.pid'");
    expect(cmd).toContain("'/workspace/.snow/runtime/tasks/task with space.log'");
  });

  it("返回 pidFile/logPath 路径(供调用方回收)", async () => {
    const info = await execDetachedWithPid("c1", "t1", "sleep 1");
    expect(info.pidFile).toBe("/workspace/.snow/runtime/tasks/t1.pid");
    expect(info.logPath).toBe("/workspace/.snow/runtime/tasks/t1.log");
  });
});

// V10 Phase 2：runBrowserContainer / RunBrowserContainerOpts / BROWSER_CONTAINER_LABELS
// / listBrowserContainersByLabel 已随 V9 远程浏览器链路删除。
// inspectContainerLabels / isContainerRunning / listContainersByLabelKey 保留，
// 通用容器能力仍需使用（Phase 2 只删浏览器专属扩展）。
