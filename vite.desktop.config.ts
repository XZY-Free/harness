import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "desktop/renderer"),
  base: "/",
  // Desktop 页面先到本机 loopback server；它再为 /api、/preview 补远端 Nginx basePath。
  // 因此不能继承 Web 部署构建注入的 /snowharness，否则会跳过本机 API proxy。
  define: {
    "process.env.NEXT_PUBLIC_SNOW_BASE_PATH": JSON.stringify(""),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname),
      "next/link": resolve(__dirname, "desktop/renderer/next-link.tsx"),
      "next/navigation": resolve(__dirname, "desktop/renderer/next-navigation.ts"),
    },
  },
  esbuild: { jsx: "automatic" },
  build: {
    outDir: resolve(__dirname, "desktop/renderer-dist"),
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE" || warning.code === "SOURCEMAP_ERROR") return;
        warn(warning);
      },
    },
  },
});
