import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalRendererServer } from "./local-renderer-server";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createRendererFiles(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "snow-renderer-"));
  await writeFile(join(directory, "index.html"), "<main>本地桌面页面</main>");
  await writeFile(join(directory, "app.js"), "console.log('renderer')");
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startUpstream(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("upstream 未监听 TCP 端口");
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${address.port}/snowharness`;
}

describe("startLocalRendererServer", () => {
  it("为 Desktop 路由返回本地打包页面", async () => {
    const server = await startLocalRendererServer({
      rendererDir: await createRendererFiles(),
      serverOrigin: "https://api.example.com/snowharness",
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.origin}/desktop/chat/thread-1`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("本地桌面页面");
  });

  it("提供本地打包的静态资源", async () => {
    const server = await startLocalRendererServer({
      rendererDir: await createRendererFiles(),
      serverOrigin: "https://api.example.com/snowharness",
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.origin}/app.js`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("renderer");
  });

  it("只把 API 请求转发到远端 basePath", async () => {
    const upstreamOrigin = await startUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ method: request.method, url: request.url }));
    });
    const server = await startLocalRendererServer({
      rendererDir: await createRendererFiles(),
      serverOrigin: upstreamOrigin,
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.origin}/api/v1/threads?limit=20`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      method: "GET",
      url: "/snowharness/api/v1/threads?limit=20",
    });
  });

  it("不将任意本地路径作为远端代理", async () => {
    const server = await startLocalRendererServer({
      rendererDir: await createRendererFiles(),
      serverOrigin: "https://api.example.com/snowharness",
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.origin}/internal/admin`);

    expect(response.status).toBe(404);
  });
});
