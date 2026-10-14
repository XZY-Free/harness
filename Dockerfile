# nexharness 容器镜像（单 Next.js app）
#
# 本地构建（context = 本目录）：
#   docker build -t nexharness:dev nexharness/
#
# 指定部署环境构建：
#   docker build --build-arg APP_ENV=test -t nexharness:test nexharness/
#
# ⚠️ CNB 接线的 build context 随部署形态而定（见 docs/split/04-cnb-接线方案.md）：
#    - 沿用 python-service 仓子目录模式（context = 仓库根 python-service/）时，
#      将下面所有 COPY 源路径统一加 `<子目录>/` 前缀；
#    - 独立构建源（context = 仓根）时，保持现状即可。
#    本文件先保证本地/独立 context 可构建、可验证。

# 部署环境标识：development | test | production（默认 production）
ARG APP_ENV=production

# ---------- Stage 1: 依赖 ----------
FROM node:24-alpine AS deps
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- Stage 2: 构建 ----------
FROM node:24-alpine AS builder
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# next build 不读 .env、不校验配置（读文件 + 校验都在 instrumentation.ts 的 register() 运行时执行）。
# 构建阶段仅需 APP_ENV 决定环境语义；DATABASE_URL / LLM_API_KEY 等真实值运行时由部署平台注入。
ENV APP_ENV=production

RUN pnpm build:workspace-lock && pnpm build

# ---------- Stage 3: 运行时 ----------
FROM node:24-alpine AS runner
# git：lib/git/deliver.ts 的 simple-git 运行时要调 git CLI；tini 做 PID 1 收割子进程
# chromium 依赖：QA gate 用 Playwright 跑确定性浏览器检查（console error / 白屏 / 404），
# 需要 chromium 可执行文件。Alpine 用 system chromium（比 playwright 自带更小），
# 通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指向。
RUN apk add --no-cache git tini chromium nss freetype harfbuzz attr acl docker-cli

WORKDIR /app

# 运行时环境变量——APP_ENV 由构建参数注入，其余由 K8s / docker -e 覆盖
ARG APP_ENV=production
ENV NODE_ENV=production
ENV APP_ENV=${APP_ENV}
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Playwright 使用系统 chromium（Alpine apk 安装），不下载自带浏览器
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Next 非 standalone：运行时需要 .next / node_modules / package.json / next.config
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/native ./native

# DATABASE_URL / LLM_API_KEY / LLM_BASE_URL 等由运行环境（K8s / docker -e）注入，不写死
# 启动时 instrumentation.ts 会校验必填变量，缺失则 fail fast
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
