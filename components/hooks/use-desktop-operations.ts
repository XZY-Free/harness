/**
 * Desktop 本地任务操作 Hook（S10-W06）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W06：「Desktop 复用共同时间线，在右侧增加文件、页面和内部系统任务操作面板」
 *   「本地 Shell、Git、测试、构建、浏览器和应用操作显示实际执行设备、目录、权限和结果」
 *   「原生系统授权、登录和人工确认进入 UserAction；Desktop Shell 不自行决定业务权限」
 *
 * 职责：
 * - 通过 `getDesktopBridge()` 读取 preload 注入的 DesktopRendererBridge。
 * - SSR 安全：首渲染 bridge=null（hydration 一致），客户端 mount 后 useEffect 触发读取。
 * - 检测各命名空间（shell/file/git/app/build/test）可用性，生成操作能力列表。
 * - 提供 execShell / readFile / writeFile / listDir / gitStatus / gitDiff / gitLog /
 *   openApp / runBuild / runTest 等方法，统一返回 DesktopOperationResult | null。
 * - 非 Desktop 环境或命名空间缺失时返回 null 并设置 lastError（降级为提示）。
 * - IPC 失败时设置 lastError；不抛异常，调用方按 null + lastError 处理。
 * - 高影响操作（file.write / build.run / test.run）由主进程负责触发 UserAction 流程；
 *   本 Hook 只接收 requires_confirmation=true 的结果，不自行决定业务权限。
 *
 * 使用：
 * ```tsx
 * function DesktopOperationRunner({ threadId }: { threadId: string }) {
 *   const ops = useDesktopOperations();
 *   if (!ops.isDesktop) return <Hint>需要 SnowHarness Desktop</Hint>;
 *   return <OpPanel capabilities={ops.capabilities} onRun={(op) => ops.execShell({ ... })} />;
 * }
 * ```
 *
 * 稳定性约束（与项目 memory 一致）：
 * - 返回的所有方法引用必须稳定（useCallback），避免子组件因 props 变化无限重渲染。
 * - bridge 读取使用 useState + useEffect，避免每次渲染都调用 getDesktopBridge。
 */
"use client";

import type { DesktopOperationCapability } from "@/lib/client/types";
import {
  type DesktopAppOpenParams,
  type DesktopBuildRunParams,
  type DesktopFileListParams,
  type DesktopFileReadParams,
  type DesktopFileWriteParams,
  type DesktopGitDiffParams,
  type DesktopGitLogParams,
  type DesktopGitStatusParams,
  type DesktopOperationResult,
  type DesktopOperationsBridge,
  type DesktopRendererBridge,
  type DesktopShellExecParams,
  type DesktopTestRunParams,
  getDesktopBridge,
} from "@/lib/desktop/capabilities";
import { useCallback, useEffect, useState } from "react";

/** Desktop 操作错误码。 */
export type DesktopOperationErrorCode = "NOT_DESKTOP" | "NAMESPACE_UNAVAILABLE" | "IPC_ERROR";

/** Desktop 操作错误（非 Desktop 环境、命名空间缺失、IPC 调用失败）。 */
export interface DesktopOperationError {
  readonly code: DesktopOperationErrorCode;
  readonly message: string;
  readonly operation: string;
}

/** Hook 返回值。 */
export interface UseDesktopOperationsResult {
  /** 是否在 Desktop 环境中（preload bridge 已注入）。 */
  readonly isDesktop: boolean;
  /** 当前 Desktop 设备 id（如有）。 */
  readonly deviceId: string | null;
  /** 全部操作能力列表（操作面板渲染依据）。enabled=false 表示当前 Desktop 不支持。 */
  readonly capabilities: readonly DesktopOperationCapability[];
  /** 最近一次操作结果（成功或失败）；null 表示尚未执行或上一次出错。 */
  readonly lastResult: DesktopOperationResult | null;
  /** 最近一次操作错误（仅环境降级或 IPC 失败）；null 表示无错误。 */
  readonly lastError: DesktopOperationError | null;
  /** 是否有操作正在执行。 */
  readonly running: boolean;
  /** 执行 Shell 命令。 */
  readonly execShell: (params: DesktopShellExecParams) => Promise<DesktopOperationResult | null>;
  /** 读取文件。 */
  readonly readFile: (params: DesktopFileReadParams) => Promise<DesktopOperationResult | null>;
  /** 写入文件（高影响，主进程会触发 UserAction）。 */
  readonly writeFile: (params: DesktopFileWriteParams) => Promise<DesktopOperationResult | null>;
  /** 列出目录内容。 */
  readonly listDir: (params: DesktopFileListParams) => Promise<DesktopOperationResult | null>;
  /** Git 状态。 */
  readonly gitStatus: (params: DesktopGitStatusParams) => Promise<DesktopOperationResult | null>;
  /** Git diff。 */
  readonly gitDiff: (params: DesktopGitDiffParams) => Promise<DesktopOperationResult | null>;
  /** Git log。 */
  readonly gitLog: (params: DesktopGitLogParams) => Promise<DesktopOperationResult | null>;
  /** 打开本机应用。 */
  readonly openApp: (params: DesktopAppOpenParams) => Promise<DesktopOperationResult | null>;
  /** 执行构建命令（高影响）。 */
  readonly runBuild: (params: DesktopBuildRunParams) => Promise<DesktopOperationResult | null>;
  /** 执行测试命令。 */
  readonly runTest: (params: DesktopTestRunParams) => Promise<DesktopOperationResult | null>;
  /** 清除最近一次结果和错误。 */
  readonly clear: () => void;
}

/**
 * 静态操作能力描述符。
 *
 * enabled 字段在运行时由 bridge 命名空间存在性决定，这里只声明展示信息。
 */
const CAPABILITY_DESCRIPTORS: ReadonlyArray<Omit<DesktopOperationCapability, "enabled">> = [
  {
    category: "shell",
    operation: "shell.exec",
    display_name: "执行 Shell 命令",
    description: "在 Desktop 设备上执行白名单内的 Shell 命令（受工作目录和环境变量限制）。",
    high_impact: false,
  },
  {
    category: "git",
    operation: "git.status",
    display_name: "查看 Git 状态",
    description: "查看工作区 Git 状态（modified / staged / untracked）。",
    high_impact: false,
  },
  {
    category: "git",
    operation: "git.diff",
    display_name: "查看 Git 差异",
    description: "查看工作区或暂存区与 HEAD 的差异。",
    high_impact: false,
  },
  {
    category: "git",
    operation: "git.log",
    display_name: "查看 Git 历史",
    description: "查看最近 N 条 Git 提交记录。",
    high_impact: false,
  },
  {
    category: "file",
    operation: "file.read",
    display_name: "读取文件",
    description: "读取 Desktop 设备上白名单路径内的文件内容。",
    high_impact: false,
  },
  {
    category: "file",
    operation: "file.list",
    display_name: "列出目录",
    description: "列出 Desktop 设备上白名单路径内的目录内容。",
    high_impact: false,
  },
  {
    category: "file",
    operation: "file.write",
    display_name: "写入文件",
    description: "向 Desktop 设备上白名单路径写入文件（高影响，需要 UserAction 确认）。",
    high_impact: true,
  },
  {
    category: "app",
    operation: "app.open",
    display_name: "打开本机应用",
    description: "打开 Desktop 设备上的本机应用（受 bundleId/appPath 白名单限制）。",
    high_impact: false,
  },
  {
    category: "build",
    operation: "build.run",
    display_name: "执行构建",
    description: "在 Desktop 设备上执行构建命令（make/gradle/npm run build 等，高影响）。",
    high_impact: true,
  },
  {
    category: "test",
    operation: "test.run",
    display_name: "执行测试",
    description: "在 Desktop 设备上执行测试命令（pytest/jest/vitest 等）。",
    high_impact: false,
  },
];

/** 把异常转为错误消息字符串。 */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 构造命名空间缺失或非 Desktop 环境的错误。 */
function makeEnvironmentError(
  operation: string,
  bridge: DesktopRendererBridge | null,
  namespace: keyof DesktopOperationsBridge,
): DesktopOperationError {
  if (!bridge) {
    return {
      code: "NOT_DESKTOP",
      message: "当前不在 Desktop 环境中，无法执行本地操作。",
      operation,
    };
  }
  return {
    code: "NAMESPACE_UNAVAILABLE",
    message: `当前 Desktop 不支持 ${namespace} 操作（preload 未注入该命名空间）。`,
    operation,
  };
}

/** Desktop 本地任务操作 Hook。 */
export function useDesktopOperations(): UseDesktopOperationsResult {
  const [bridge, setBridge] = useState<DesktopRendererBridge | null>(null);
  const [lastResult, setLastResult] = useState<DesktopOperationResult | null>(null);
  const [lastError, setLastError] = useState<DesktopOperationError | null>(null);
  const [running, setRunning] = useState(false);

  // 客户端 mount 后读取 preload 注入的 bridge（SSR 安全）
  useEffect(() => {
    setBridge(getDesktopBridge());
  }, []);

  const isDesktop = bridge !== null;
  const deviceId = bridge?.capabilities.deviceId ?? null;

  const capabilities: readonly DesktopOperationCapability[] = (() => {
    if (!bridge) {
      return CAPABILITY_DESCRIPTORS.map((desc) => ({ ...desc, enabled: false }));
    }
    return CAPABILITY_DESCRIPTORS.map((desc) => ({
      ...desc,
      enabled: bridge[desc.category] !== undefined,
    }));
  })();

  /**
   * 通用执行包装：调用 namespace 上的方法，统一处理 running / lastResult / lastError。
   * 不抛异常；失败时返回 null 并设置 lastError。
   */
  const invoke = useCallback(
    async <TNamespace extends keyof DesktopOperationsBridge>(
      operation: string,
      namespace: TNamespace,
      exec: (ns: NonNullable<DesktopRendererBridge[TNamespace]>) => Promise<DesktopOperationResult>,
    ): Promise<DesktopOperationResult | null> => {
      const ns = bridge?.[namespace];
      if (!ns) {
        setLastError(makeEnvironmentError(operation, bridge, namespace));
        return null;
      }
      setRunning(true);
      try {
        const result = await exec(ns);
        setLastResult(result);
        setLastError(null);
        return result;
      } catch (err) {
        setLastError({
          code: "IPC_ERROR",
          message: toErrorMessage(err),
          operation,
        });
        return null;
      } finally {
        setRunning(false);
      }
    },
    [bridge],
  );

  const execShell = useCallback(
    (params: DesktopShellExecParams): Promise<DesktopOperationResult | null> =>
      invoke("shell.exec", "shell", (ns) => ns.exec(params)),
    [invoke],
  );

  const readFile = useCallback(
    (params: DesktopFileReadParams): Promise<DesktopOperationResult | null> =>
      invoke("file.read", "file", (ns) => ns.read(params)),
    [invoke],
  );

  const writeFile = useCallback(
    (params: DesktopFileWriteParams): Promise<DesktopOperationResult | null> =>
      invoke("file.write", "file", (ns) => ns.write(params)),
    [invoke],
  );

  const listDir = useCallback(
    (params: DesktopFileListParams): Promise<DesktopOperationResult | null> =>
      invoke("file.list", "file", (ns) => ns.list(params)),
    [invoke],
  );

  const gitStatus = useCallback(
    (params: DesktopGitStatusParams): Promise<DesktopOperationResult | null> =>
      invoke("git.status", "git", (ns) => ns.status(params)),
    [invoke],
  );

  const gitDiff = useCallback(
    (params: DesktopGitDiffParams): Promise<DesktopOperationResult | null> =>
      invoke("git.diff", "git", (ns) => ns.diff(params)),
    [invoke],
  );

  const gitLog = useCallback(
    (params: DesktopGitLogParams): Promise<DesktopOperationResult | null> =>
      invoke("git.log", "git", (ns) => ns.log(params)),
    [invoke],
  );

  const openApp = useCallback(
    (params: DesktopAppOpenParams): Promise<DesktopOperationResult | null> =>
      invoke("app.open", "app", (ns) => ns.open(params)),
    [invoke],
  );

  const runBuild = useCallback(
    (params: DesktopBuildRunParams): Promise<DesktopOperationResult | null> =>
      invoke("build.run", "build", (ns) => ns.run(params)),
    [invoke],
  );

  const runTest = useCallback(
    (params: DesktopTestRunParams): Promise<DesktopOperationResult | null> =>
      invoke("test.run", "test", (ns) => ns.run(params)),
    [invoke],
  );

  const clear = useCallback(() => {
    setLastResult(null);
    setLastError(null);
  }, []);

  return {
    isDesktop,
    deviceId,
    capabilities,
    lastResult,
    lastError,
    running,
    execShell,
    readFile,
    writeFile,
    listDir,
    gitStatus,
    gitDiff,
    gitLog,
    openApp,
    runBuild,
    runTest,
    clear,
  };
}
