import { resolve } from "node:path";
import { runtimeConfig } from "@/lib/config";
import { buildImage, imageExists } from "./docker-cli";

/**
 * Phase 5 Stage B：用户项目 runtime 镜像校验/构建。
 *
 * 首次使用 container 模式前 `ensureRuntimeImage()`：`docker images` 查询，缺失则
 * `docker build`（Dockerfile 在 `docker/runtime/`）。build 失败 fail fast（提示
 * `pnpm build:runtime`）——此时 docker 可用但镜像 build 失败，属配置/环境问题，
 * 不降级（降级仅针对 docker daemon 不可用，见 availability.ts）。
 *
 * 镜像 CI 预构建可跳过运行时 build（plan §5 风险表）。
 */

/** Dockerfile 所在目录（相对 cwd，snow_harness 根）。 */
const DOCKERFILE_DIR = resolve(process.cwd(), "docker/runtime");

let ensuring: Promise<void> | null = null;

/** 确保镜像存在（并发安全：首次调用 build，后续并发复用同一 promise）。 */
export function ensureRuntimeImage(): Promise<void> {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const image = runtimeConfig.runtimeImage;
    if (await imageExists(image)) return;
    await buildImage(image, DOCKERFILE_DIR);
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}
