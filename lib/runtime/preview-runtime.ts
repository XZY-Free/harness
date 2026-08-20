import { randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";
import { extname, resolve as resolvePath } from "node:path";
import { runtimeConfig } from "@/lib/config";
import { readWorkspaceFile, safeJoin, workspaceRoot } from "@/lib/workspace";
import { execDetached } from "./container/docker-cli";
import { startContainer, stopContainerById } from "./container/manager";
import { prepareContainerStartOptions } from "./container/start-options";
import { probePreviewUrl } from "./preview-probe";
import type { SecretEnvMap } from "./secret-mount";
import type {
  NetworkPolicy,
  PreviewHandle,
  PreviewRuntime,
  PreviewStatus,
  ResourceQuota,
} from "./types";

/**
 * StaticPreviewRuntime——`PreviewRuntime` 的静态文件实现。
 *
 * 从 `lib/preview/manager.ts` 迁入进程内静态文件 server 逻辑（零行为变更）：
 * 每个 thread 一个 `http.Server`，`127.0.0.1:0` 随机端口，服务 `workspaces/{threadId}`。
 * 全局 `previews` Map 单例保留（preview-gate 与 api/preview 共用同一实例）。
 *
 * 仍返回 `http://localhost:{port}/`（相对化在 Stage D）。
 * DevServerPreviewRuntime（容器内 dev server）在 提供第二实现。
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

type PreviewEntry = { server: Server; port: number; token: string };

const globalForPreview = globalThis as unknown as {
  __snowPreviews?: Map<string, PreviewEntry>;
  __snowPreviewCleanup?: boolean;
};
const previews = globalForPreview.__snowPreviews ?? new Map<string, PreviewEntry>();
globalForPreview.__snowPreviews = previews;

/** V9 阶段 5：从 Cookie 头解析 preview-token（内置浏览器首次带 ?token= 加载后，子资源走 cookie 鉴权）。 */
function parsePreviewTokenCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(/(?:^|;\s*)preview-token=([^;]+)/);
  return match?.[1];
}

function createStaticServer(threadId: string, token: string): Server {
  return createServer(async (req, res) => {
    // 鉴权——?token= / X-Preview-Token 头 / preview-token cookie 任一匹配即可。
    // V9 阶段 5：新增 cookie 支持——内置浏览器首次以 ?token= 加载 HTML 后，Set-Cookie 让
    // 后续 CSS/JS/图片子资源请求自动带 cookie 鉴权，否则每个子资源都会 403。
    const url = new URL(req.url ?? "/", "http://localhost");
    const queryToken = url.searchParams.get("token");
    const headerToken = req.headers["x-preview-token"] as string | undefined;
    const cookieToken = parsePreviewTokenCookie(req.headers.cookie);
    const reqToken = queryToken ?? headerToken ?? cookieToken;
    if (reqToken !== token) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    // token 经 query 传入且 cookie 未设置时 Set-Cookie（供子资源复用）
    if (queryToken && queryToken === token && !cookieToken) {
      res.setHeader("Set-Cookie", `preview-token=${token}; Path=/; HttpOnly; SameSite=Lax`);
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) {
      pathname += "index.html";
    }
    // 复用 workspace.safeJoin（lstat+realpath symlink 防护）替代自做词法检查 +
    // readFile（原 readFile 跟随 symlink，可越界读 workspace 外文件）。safeJoin 抛错 → 403。
    let target: string;
    try {
      target = safeJoin(threadId, `.${pathname}`);
    } catch {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    try {
      // readWorkspaceFile 内部也走 safeJoin + symlink 防护，双重保险
      const content = await readWorkspaceFile(threadId, `.${pathname}`);
      if (content === null) throw new Error("not found");
      res.setHeader(
        "Content-Type",
        MIME[extname(/*turbopackIgnore: true*/ target).toLowerCase()] ?? "application/octet-stream",
      );
      // V6-M1-5: CSP 头限制可加载资源，配合 iframe sandbox（G4）
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self';",
      );
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<h1>404</h1><p>该路径暂无文件。请先在「生成代码」阶段让 AI 写入项目文件。</p>");
    }
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolvePort(addr.port);
      } else {
        reject(new Error("无法分配预览端口"));
      }
    });
  });
}

/** 关闭单个 thread 的预览 server（同步 close，供过渡薄转发复用）。 */
function closePreview(threadId: string): void {
  const entry = previews.get(threadId);
  if (entry) {
    entry.server.close();
    previews.delete(threadId);
  }
}

/** 进程退出时关闭所有预览 server，杜绝端口泄漏。 */
function closeAllPreviews(): void {
  for (const { server } of previews.values()) {
    server.close();
  }
  previews.clear();
}

if (!globalForPreview.__snowPreviewCleanup) {
  globalForPreview.__snowPreviewCleanup = true;
  process.once("SIGTERM", closeAllPreviews);
  process.once("SIGINT", closeAllPreviews);
  process.once("beforeExit", closeAllPreviews);
}

export class StaticPreviewRuntime implements PreviewRuntime {
  async start(threadId: string): Promise<PreviewHandle> {
    const existing = previews.get(threadId);
    if (existing) {
      return {
        url: `http://localhost:${existing.port}/`,
        port: existing.port,
        kind: "static",
        token: existing.token,
      };
    }
    const token = randomUUID();
    const server = createStaticServer(threadId, token);
    const port = await listen(server);
    previews.set(threadId, { server, port, token });
    return { url: `http://localhost:${port}/`, port, kind: "static", token };
  }

  async stop(threadId: string): Promise<void> {
    closePreview(threadId);
  }

  status(threadId: string): PreviewStatus | null {
    const entry = previews.get(threadId);
    if (!entry) return null;
    return { state: "ready", port: entry.port, kind: "static", token: entry.token };
  }
}

/** 进程内单例（preview-gate / api/preview / 过渡薄转发共用）。 */
export const staticPreviewRuntime = new StaticPreviewRuntime();

/** 暴露 closeAllPreviews 供进程退出 / 测试清理复用。 */
export { closeAllPreviews, closePreview };

// ─── DevServerPreviewRuntime（）─────────────────────────

type DevServerEntry = {
  port: number;
  containerName: string;
  state: "starting" | "ready" | "failed";
  lastActivityAt: number;
  token: string; // V6-M1-5: per-dev-server token for preview auth
};

const devServers = new Map<string, DevServerEntry>();

/** 读 /workspace/package.json，判断是否有 dev script。 */
async function hasDevScript(threadId: string): Promise<boolean> {
  const pkg = await readWorkspaceFile(threadId, "package.json");
  if (!pkg) return false;
  try {
    const json = JSON.parse(pkg) as { scripts?: Record<string, unknown> };
    return typeof json?.scripts?.dev === "string";
  } catch {
    return false;
  }
}

/** 轮询探活直到 ready 或超时。 */
async function pollReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await probePreviewUrl(url);
    if (r.ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * DevServerPreviewRuntime——容器内 spawn `npm run dev` + ready 探测。
 *
 * 补齐 未达成的「static + dev-server 双实现」。经同一 PreviewRuntime interface 调用。
 *
 * start 流程：
 * 1. 已 ready → 复用返回
 * 2. 无 dev script → 委托 staticPreviewRuntime（本轮不强制 dev server，skill 可声明）
 * 3. 有 dev script → startContainer（惰性复用）→ `docker exec -d ... PORT={port} HOST=0.0.0.0 npm run dev`
 * → 轮询 probePreviewUrl（127.0.0.1:{port}）→ ready / failed（超时 runtimeConfig.readyTimeoutMs）
 *
 * stop：停删容器（stopContainerById）+ 清 entry；委托 static 的则委托 stop。
 * status：按 entry state 返回；委托 static 的则委托 status。
 *
 * Note：dev server 需监听 0.0.0.0 才能经 docker port mapping 可达——注入 HOST=0.0.0.0 env，
 * 框架不支持 HOST 时由 dev script 自带 --host（skill 声明责任）。本轮 url 仍 localhost（相对化 Stage D）。
 */
export class DevServerPreviewRuntime implements PreviewRuntime {
  private secretsCache?: SecretEnvMap;

  constructor(
    private readonly defaults?: {
      quota?: ResourceQuota;
      networkPolicy?: NetworkPolicy;
      secretResolver?: () => Promise<SecretEnvMap>;
    },
  ) {}

  async start(threadId: string): Promise<PreviewHandle> {
    const existing = devServers.get(threadId);
    if (existing?.state === "ready") {
      return {
        url: `http://localhost:${existing.port}/`,
        port: existing.port,
        kind: "dev-server",
        token: existing.token,
      };
    }

    // 无 dev script → 回退 static（plan C4）
    if (!(await hasDevScript(threadId))) {
      return staticPreviewRuntime.start(threadId);
    }

    const prepared = await prepareContainerStartOptions({
      threadId,
      quota: this.defaults?.quota,
      networkPolicy: this.defaults?.networkPolicy,
      secretResolver: this.defaults?.secretResolver,
      existingSecrets: this.secretsCache,
    });
    let entry: Awaited<ReturnType<typeof startContainer>>;
    try {
      this.secretsCache = prepared.secretsCache ?? this.secretsCache;
      entry = await startContainer(threadId, prepared.startOptions);
    } finally {
      await prepared.cleanup();
    }
    const dsEntry: DevServerEntry = {
      port: entry.port,
      containerName: entry.containerName,
      state: "starting",
      lastActivityAt: Date.now(),
      token: randomUUID(),
    };
    devServers.set(threadId, dsEntry);

    // dev server 输出重定向到 bind mount 日志文件，启动失败时可 tail 诊断
    // （原 execDetached 立即返回、stdout/stderr 丢弃，端口冲突/依赖缺失/语法错无法排查）。
    const devLogRel = `${threadId}/devserver.log`;
    const devLogContainer = `/workspace/.snow/runtime/${devLogRel}`;
    await execDetached(
      entry.containerName,
      `mkdir -p /workspace/.snow/runtime/${threadId} && PORT=${entry.port} HOST=0.0.0.0 npm run dev > ${devLogContainer} 2>&1`,
    );

    const ok = await pollReady(`http://127.0.0.1:${entry.port}/`, runtimeConfig.readyTimeoutMs);
    dsEntry.state = ok ? "ready" : "failed";
    dsEntry.lastActivityAt = Date.now();
    if (!ok) {
      // 读 dev server 日志尾部附诊断信息（host 经 bind mount 直读）
      let logTail = "";
      try {
        const { readFile } = await import("node:fs/promises");
        const hostLog = resolvePath(
          workspaceRoot(threadId),
          ".snow/runtime",
          `${threadId}`,
          "devserver.log",
        );
        const full = await readFile(hostLog, "utf8").catch(() => "");
        logTail = full.slice(-800);
      } catch {
        // best-effort
      }
      // P2-12: pollReady 失败回收容器 + 清 devServers entry,防残留 failed entry 占端口/内存
      await stopContainerById(threadId).catch(() => {});
      devServers.delete(threadId);
      throw new Error(
        `dev server 启动超时(${runtimeConfig.readyTimeoutMs}ms 内未就绪)${logTail ? `\n--- dev server 日志尾部 ---\n${logTail}` : ""}`,
      );
    }
    return {
      url: `http://localhost:${entry.port}/`,
      port: entry.port,
      kind: "dev-server",
      token: dsEntry.token,
    };
  }

  async stop(threadId: string): Promise<void> {
    const ds = devServers.get(threadId);
    if (!ds) {
      // 可能委托了 static
      return staticPreviewRuntime.stop(threadId);
    }
    // 只停真实 preview server 与其 container 资源；旧后台任务能力已移除。
    await stopContainerById(threadId);
    devServers.delete(threadId);
  }

  status(threadId: string): PreviewStatus | null {
    const ds = devServers.get(threadId);
    if (!ds) return staticPreviewRuntime.status(threadId);
    return { state: ds.state, port: ds.port, kind: "dev-server", token: ds.token };
  }
}

/**
 * 删除未使用的 `devServerPreviewRuntime` 单例导出。
 *
 * 原单例以空 defaults 构造，registry 实际用 `lazyPreviewRuntime("dev-server", {quota,...})`
 * 自建带配置实例，单例在 prod 从未被引用（仅测试用）。删除死代码；测试改用 `new DevServerPreviewRuntime()`。
 * `devServers` Map 是模块级，多实例共享，故测试用本地实例行为一致。
 */
export function __clearDevServerRegistryForTest(): void {
  devServers.clear();
}
