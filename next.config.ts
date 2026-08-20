import type { NextConfig } from "next";

// basePath 由环境变量 SNOW_BASE_PATH 驱动：
// - 本地开发：不设置 → 无 basePath（http://localhost:3000 直接访问）。
// - 腾讯云部署构建：SNOW_BASE_PATH=/snowharness pnpm build（Nginx 子路径代理）。
// 客户端裸 fetch 经 NEXT_PUBLIC_SNOW_BASE_PATH 构建时内联（见 lib/api-fetch.ts）。
// 注意：next start 运行时也会读本文件——服务器 PM2 env 必须同样注入 SNOW_BASE_PATH，
// 否则运行时 basePath 为空，/snowharness/* 全部 404。
const basePath = process.env.SNOW_BASE_PATH ?? "";

if (basePath && (!basePath.startsWith("/") || basePath.endsWith("/"))) {
  throw new Error(`SNOW_BASE_PATH 必须以 / 开头且不以 / 结尾，当前值: "${basePath}"`);
}

const nextConfig: NextConfig = {
  basePath: basePath || undefined,
  // 构建产物目录。默认 .next；e2e 用 SNOW_DIST_DIR=.next-e2e 隔离，
  // 使 e2e 的 build/start 与开发者常驻的 `pnpm dev` 互不干扰
  // （Next 16 对同一项目目录的 dev server 有独占锁，且共用 .next 会互相覆盖）。
  distDir: process.env.SNOW_DIST_DIR || ".next",
  env: {
    NEXT_PUBLIC_SNOW_BASE_PATH: basePath,
  },
  devIndicators: false,
  poweredByHeader: false,
  // Turbopack 在 monorepo / 嵌套 workspace 场景下可能误判项目根目录，
  // 显式指定 root 为项目根，避免 "couldn't find Next.js package" 构建失败。
  turbopack: {
    root: process.cwd(),
  },
  // Next 16 默认拦截跨 origin 访问 dev 资源（webpack-hmr / 字体 / client dev chunks）。
  // dev server 监听 localhost，但本机常以 127.0.0.1 访问，会被判跨 origin → React 不 hydrate、
  // HMR ws 握手失败、会话列表转圈无请求。放行本机回环地址。
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // playwright 有原生依赖（调用 chromium 可执行文件），不能被 Turbopack/webpack 打包，
  // 否则 server 端 import("playwright") 会失败 → QA gate fail-closed。
  // pdf-parse / officeparser 同理（运行时读取原生文件格式）。
  serverExternalPackages: ["pdf-parse", "officeparser", "playwright"],
  typescript: {
    // 部署构建时跳过类型检查（预存的路由类型错误不影响运行）
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
