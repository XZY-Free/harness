# SnowHarness durable worker 的统一生产制品。
FROM node:24-alpine AS dependencies
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24-alpine AS worker
RUN apk add --no-cache tini git libstdc++
WORKDIR /app
ENV NODE_ENV=production
ENV WORKER_HEALTH_PORT=8080
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY lib ./lib
COPY scripts ./scripts
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "scripts/workers/worker-entrypoint.ts"]
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
