# Phase 5 Stage B：用户项目 runtime 镜像（容器隔离用）。
#
# 与 snow_harness 自身部署 Dockerfile（项目根）分开——本镜像不跑平台进程，
# 而是给每个 thread 拉起的隔离容器：node:22-alpine + git + 常用构建工具
# （python3 / make / g++，适配 node-gyp 原生模块编译）。
#
# 构建：pnpm build:runtime（见 package.json）

FROM node:22-alpine

# git + 原生模块构建工具链；tini 作 init 接管信号（容器内进程树干净）
RUN apk add --no-cache git python3 make g++ tini

WORKDIR /workspace

# sleep infinity 保持容器常驻，命令经 `docker exec` 进容器执行
CMD ["sleep", "infinity"]
