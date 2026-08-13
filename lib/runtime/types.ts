/**
 * 三层 runtime 稳定 interface（蓝图 ）。
 *
 * 把三层 runtime 职责分散到三个文件，但按 「单一实现不抽」显式拒绝
 * 抽 interface。第二个 runtime 实现（容器）出现，该前提失效，抽象不再空壳——
 * 本文件定义三个稳定 interface，host / container 实现都满足之。
 *
 * 设计取舍（零行为变更）：
 * - 方法签名贴合现有 `lib/workspace` / `lib/preview/manager` / `tools.ts` 的 execa 逻辑，
 * 而非方案 草案签名（read→Buffer / write→{bytes} 等）。零回归优先于签名理想化；
 * 若后续 container 实现需要更丰富语义，再在 interface 上增量演进。
 * - WorkspaceStore / ExecutionRuntime 绑定 threadId（构造注入）；PreviewRuntime 不绑定，
 * 方法接收 threadId（与现有全局 Map 单例语义一致，preview-gate 与 api/preview 共用）。
 */

// ─── WorkspaceStore ──────────────────────────────────────────

/**
 * 工作区存储责任面：路径解析 + 文件读写删 stat list。
 *
 * host 实现：走宿主文件系统（`lib/workspace`）。
 * container 实现（Stage B）：`root()` 仍返回宿主路径（平台进程读写用），
 * `mountTarget()` 返回容器内 bind mount 路径（`/workspace`），读写仍走宿主 + bind mount。
 */
export interface WorkspaceStore {
  /** 工作区根路径（宿主侧绝对路径）。 */
  root(): string;
  /** 安全解析工作区内路径，拒绝 `..` 越界（词法边界）。 */
  safeJoin(relPath: string): string;
  /** 读文件内容；不存在返回 null。symlink / 越界 → throw。 */
  read(relPath: string): Promise<string | null>;
  /** 写文件（自动建父目录），返回相对路径。symlink / 越界 → throw。 */
  write(relPath: string, content: string): Promise<string>;
  /** 删文件；不存在静默返回 false；目录拒绝删除。symlink / 越界 → throw。 */
  delete(relPath: string): Promise<boolean>;
  /** 文件 stat；不存在返回 null。symlink / 越界 → throw。 */
  stat(relPath: string): Promise<{ size: number; mtime: Date; isDirectory: boolean } | null>;
  /** 递归列出工作区内所有文件（相对路径）。 */
  list(): Promise<string[]>;
  /**
   * glob 匹配工作区内文件（相对路径），默认尊重 `.gitignore`。
   * `includeIgnored` 为 true 时额外返回被 gitignore 忽略的文件。
   */
  glob(pattern: string, opts?: { includeIgnored?: boolean }): Promise<string[]>;
  /**
   * grep 搜索文件内容，返回结构化匹配（默认尊重 `.gitignore`）。
   * 输出按 `maxResults` 截断并标记 `truncated`。
   */
  grep(
    pattern: string,
    opts?: {
      glob?: string;
      caseInsensitive?: boolean;
      context?: number;
      maxResults?: number;
    },
  ): Promise<GrepResult>;
  /**
   * bind mount 目标（容器内路径）。host 模式返回 `root()`（宿主即执行地）；
   * container 模式返回 `/workspace`。
   */
  mountTarget(): string;
}

/** 单条 grep 匹配。before/after 为 -C context 产生的上下文行（可选）。 */
export interface GrepMatch {
  path: string;
  line: number;
  text: string;
  before?: Array<{ line: number; text: string }>;
  after?: Array<{ line: number; text: string }>;
}

/** grep 结果：匹配列表 + 是否被 maxResults 截断。 */
export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

// ─── ExecutionRuntime ────────────────────────────────────────

/** 命令执行结果（host / container 共享 shape，对齐现有 runCommand/runTests 返回）。 */
export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command: string;
}

/**
 * 命令执行责任面。
 *
 * host 实现：`execa(command, { shell, cwd: workspaceRoot, timeout, reject:false, maxBuffer })`。
 * container 实现（Stage B）：`docker exec snow-thread-{id} sh -c "cd /workspace && {command}"`。
 *
 * 异常语义：exec 内部 catch spawn 级失败（ENOENT / timeout），返回 `{ ok:false, exitCode:-1 }`，
 * 不向上抛——对齐现有 runCommand/runTests 的 try/catch 兜底契约。
 */
export interface ExecutionRuntime {
  /**
   * 执行命令。
   *
   * 增 `logCapBytes`——per-thread 日志体积配额(只能收紧)。
   * 与既有 MAX_OUTPUT 取 min:logCapBytes < MAX_OUTPUT 时按 logCapBytes 截断,
   * 否则维持 MAX_OUTPUT(不放宽)。
   */
  exec(
    command: string,
    opts?: {
      timeoutMs?: number;
      logCapBytes?: number;
      /** 流式回写回调，逐块接收 stdout/stderr（同时仍返回完整缓冲结果）。 */
      onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
      /** V6-M1-1：AbortSignal，用于取消长时间运行的命令。 */
      signal?: AbortSignal;
    },
  ): Promise<ExecResult>;
}

// ─── PreviewRuntime ──────────────────────────────────────────

export type PreviewKind = "static" | "dev-server";

export interface PreviewHandle {
  url: string;
  port: number;
  kind: PreviewKind;
  /** 静态预览鉴权 token（内部探活/反代转发时带回）。 */
  token?: string;
}

export type PreviewState = "idle" | "starting" | "ready" | "failed";

export interface PreviewStatus {
  state: PreviewState;
  port?: number;
  kind?: PreviewKind;
  /** 静态预览鉴权 token（反代转发时带回，防 host 内进程直读 workspace）。 */
  token?: string;
}

/**
 * 预览运行时责任面。
 *
 * - `StaticPreviewRuntime`（host 默认）：进程内静态文件 server，迁入自 `lib/preview/manager`。
 * - `DevServerPreviewRuntime`（Stage C）：容器内 spawn `npm run dev` + ready 探测。
 *
 * 零行为变更：`start` 仍返回 `http://localhost:{port}/`（相对化在 Stage D）。
 */
export interface PreviewRuntime {
  start(threadId: string): Promise<PreviewHandle>;
  stop(threadId: string): Promise<void>;
  status(threadId: string): PreviewStatus | null;
}

// ─── 组合句柄 ────────────────────────────────────────────────

/** 按 thread 解析出的三层 runtime 组合（工厂产物）。 */
export interface RuntimeHandle {
  workspace: WorkspaceStore;
  execution: ExecutionRuntime;
  preview: PreviewRuntime;
  /** runtime 能力上报（审计 + UI 可见 + 部署决策依据）。 */
  capability: RuntimeCapability;
}

// ─── : Runtime Capability / Network Policy / Resource Quota ──

/**
 * per-thread 网络策略模式。
 *
 * S1 修复（02-P0-2，方案 B）：删除 `allowlist` 模式。原 allowlist 模式与 disabled 等价
 * （都 `--network none`），却仍向 UI/审计上报"白名单模式"，契约不兑现。不可绕过的容器
 * egress 隔离需 iptables/网络插件改造（未实现），在此之前只保留语义诚实的两态：
 * - `disabled`：完全断网（container `--network none`）
 * - `open`：不限制（container 默认 bridge）
 *
 * 域名级放行由 host 侧平台工具（webFetch/webSearch/searchDocs）各自的 `domainAllowlist`
 * fail-closed 治理负责，与容器网络模式正交。
 */
export type NetworkPolicyMode = "disabled" | "open";

/** 解析后的网络策略。 */
export interface NetworkPolicy {
  mode: NetworkPolicyMode;
}

/** per-thread 资源配额。container 模式硬配额(docker --memory/--cpus/--pids-limit);host soft + 诚实标注。 */
export interface ResourceQuota {
  /** CPU 上限,如 "1.0"/"0.5"。 */
  cpu?: string;
  /** 内存上限,如 "1g"/"512m"。 */
  memory?: string;
  /** 命令超时(ms)。 */
  timeoutMs?: number;
  /** 日志体积上限(bytes)。 */
  logCapBytes?: number;
  /**
   * S1 修复（04-G2 长期方案）：进程数上限。
   * container 模式 → docker `--pids-limit` 硬限；host 模式（Linux）→ `prlimit --nproc` 软限。
   */
  pidsLimit?: number;
  /**
   * S1 修复（04-G2 长期方案）：文件描述符上限。
   * container 模式 → docker `--ulimit nofile` 硬限；host 模式（Linux）→ `prlimit --nofile` 软限。
   */
  openFilesLimit?: number;
  /**
   * 容器 rootfs 磁盘配额（bytes）。
   * container 模式 → docker `--storage-opt size=`（需 overlay2/devicemapper 配额支持）。
   * 0/undefined=不限。注意：bind-mount 的 workspace 不受此限（需 host FS projquota），仅限容器内部写入。
   */
  diskQuotaBytes?: number;
}

/**
 * Runtime 能力上报(蓝图 §10 / §1)。
 *
 * - runtimeType: host / container(不含 k8s)。
 * - imageVersion: container 模式的镜像版本(host 无)。
 * - networkPolicy / networkPolicyEnforced: 当前网络策略 + 是否实际强制执行。
 * host=false(平台进程无法硬隔离 egress);container=true(docker network 治理)。
 * - quotas / quotaEnforced: 资源配额 + 是否硬配额。host=false(soft);container=true(cgroup)。
 * - secretMount: 是否支持 secret 挂载注入(启用)。
 * - available: runtime 是否可用(container 模式 docker 不可用时 false)。
 */
export interface RuntimeCapability {
  runtimeType: "host" | "container";
  imageVersion?: string;
  networkPolicy: NetworkPolicyMode;
  networkPolicyEnforced: boolean;
  quotas: ResourceQuota;
  quotaEnforced: boolean;
  secretMount: boolean;
  available: boolean;
  /** 当前运行时是降级产物时，记录原始请求的 runtime 类型。 */
  degradedFrom?: "host" | "container";
  /** 运行时降级原因（如 docker unavailable）。 */
  degradedReason?: string;
}
