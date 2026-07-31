import { readFile, stat } from "node:fs/promises";
import { createServer, request as requestHttp } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as requestHttps } from "node:https";
import { extname, resolve } from "node:path";

export interface LocalRendererServer {
  readonly origin: string;
  close(): Promise<void>;
}

export interface StartLocalRendererServerOptions {
  /** Vite 构建输出目录。 */
  readonly rendererDir: string;
  /** 远端后端 origin，可含 Nginx basePath（如 https://host/snowharness）。 */
  readonly serverOrigin: string;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function isApiPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/preview" ||
    pathname.startsWith("/preview/")
  );
}

function isDesktopRoute(pathname: string): boolean {
  return pathname === "/" || pathname === "/desktop" || pathname.startsWith("/desktop/");
}

function withoutHopByHopHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === "connection" || name === "host") continue;
    result[name] = value;
  }
  return result;
}

function proxyResponseHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === "connection" || name === "transfer-encoding") continue;
    result[name] = value;
  }
  return result;
}

function rendererFilePath(rendererRoot: string, pathname: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decodedPath.replace(/^\/+/, "");
  const candidate = resolve(rendererRoot, relative);
  return candidate === rendererRoot || candidate.startsWith(`${rendererRoot}/`) ? candidate : null;
}

async function sendFile(response: ServerResponse, filename: string): Promise<boolean> {
  try {
    const fileStat = await stat(filename);
    if (!fileStat.isFile()) return false;
    const content = await readFile(filename);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(filename)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

function proxyRequest(request: IncomingMessage, response: ServerResponse, upstream: URL): void {
  const incomingUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const basePath = upstream.pathname.replace(/\/$/, "");
  const transport = upstream.protocol === "https:" ? requestHttps : requestHttp;
  const proxied = transport(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: request.method,
      path: `${basePath}${incomingUrl.pathname}${incomingUrl.search}`,
      headers: {
        ...withoutHopByHopHeaders(request.headers),
        host: upstream.host,
      },
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        proxyResponseHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(response);
    },
  );
  proxied.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    response.end(JSON.stringify({ error: "无法连接远端服务" }));
  });
  request.pipe(proxied);
}

/**
 * 启动仅供 Electron renderer 使用的 loopback Web server。
 *
 * 页面和 API 同源：React 继续使用相对 API URL，SSE 也不受跨域与 Cookie 策略影响；
 * 代理范围固定为 /api 与 /preview，不能充当任意 URL 的本机开放代理。
 */
export async function startLocalRendererServer(
  options: StartLocalRendererServerOptions,
): Promise<LocalRendererServer> {
  const rendererRoot = resolve(options.rendererDir);
  const upstream = new URL(options.serverOrigin);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error("SNOW_SERVER_ORIGIN 必须是 http 或 https 地址");
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (isApiPath(url.pathname)) {
      proxyRequest(request, response, upstream);
      return;
    }

    const filename = rendererFilePath(rendererRoot, url.pathname);
    if (filename && extname(filename)) {
      void sendFile(response, filename).then((served) => {
        if (!served && !response.writableEnded) response.writeHead(404).end();
      });
      return;
    }
    if (!isDesktopRoute(url.pathname)) {
      response.writeHead(404).end();
      return;
    }
    void sendFile(response, resolve(rendererRoot, "index.html")).then((served) => {
      if (!served && !response.writableEnded) response.writeHead(500).end();
    });
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
    throw new Error("本地渲染服务器未监听 TCP 端口");
  }

  let closed = false;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}
