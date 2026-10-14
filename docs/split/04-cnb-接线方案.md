# 04 — CNB 企业部署接线方案（阶段④ · 方案 §5.3）

> 状态：**材料就绪，切换待执行**（2026-10-14）。现实约束：本机当前不可达 CNB 平台
> （`cnb.crb.cn` CONNECT 502）——框架仓/业务仓的 CNB 侧改动与流水线触发需在内网环境执行。
> 原则（方案 §5.3）：**旧链路保持至切换日**，本阶段只备料不改线上。

## 1. 现状（旧链路）

| 项 | 现值 |
|---|---|
| 部署源 | CNB `crb/aigc/ai-team/python-service` 仓的 `snow_harness/` 子目录（拆分前快照；企业版代码经 `enterprise/private-hr-integration` 分支同步——同步机制属企业线子方案，本轮不动） |
| 流水线 | 业务仓 `.cnb.yml` + **框架仓 `CRB/devops/cnb-pipeline`（feature 分支）**；通用阶段：down_k8s_manifests → down_cnb_pipeline → print_params → java_compile → build_image → nacos_contract_check → deploy_yaml |
| 镜像/模板/values 来源 | **框架仓独有**：`config/Python/aigc/python-service/config.yaml`、`deploy/dsu/Dockerfile/Python/aigc/python-service/snowharness-web\|snowharness-worker/`、`deploy/dsu/Deployment/Python/aigc/python-service/{templates/deployment.yaml,<服务名>/values.yaml}`；业务仓 `snow_harness/deployment/helm/**` 已退化为说明载体（不再被流水线调用） |
| 集群资源（创建服务时前置，流水线只滚动 Deployment 镜像） | 5 Deployment：`snowharness-hosted-provisioning`（web）+ 4 role worker；Service/Ingress `snowharness` @ `ai-uat.crb.cn` path `/snowharness`（TLS `crb-cn`）；ConfigMap `snowharness-runtime-config`；Secret `cnb-harbor-secret`/`crb-cn` |
| Nacos | namespace `9d99594f-e156-4c22-ad62-b8740dbfd822`；dataId `snow_harness.yaml`；地址 `nacos-headless.app-system.svc.cluster.local:8848` |
| 镜像仓库 | CNB Harbor（`cnb-harbor-secret`） |

## 2. 目标形态（切换后）

| 产物 | 形态 | 来源 |
|---|---|---|
| nexharness API | 镜像（web/api + 4 workers 同代码多入口；拆分后 = 纯 API 服务：Next.js route handlers，无页层） | `nexharness` 仓（Dockerfile 已就绪） |
| auth-center | 镜像（Hono API + 同源门户/管理台 SPA 单容器） | `auth-center` 仓（Dockerfile 本阶段新增） |
| client Web | 静态产物镜像（nginx 子路径 `/nexharness/`，SPA fallback） | `nexharness-client` 仓（deploy/Dockerfile + nginx.conf 本阶段新增） |
| client Desktop | 桌面分发包（dmg/zip，非集群物） | 桌面打包链（已冒烟） |

## 3. 更名映射表（snow → nex，切换日全量替换）

| 面 | 现值 | 目标值 |
|---|---|---|
| Deployment（web） | `snowharness-hosted-provisioning`（或 `snowharness-web`） | `nexharness-*` |
| Deployment（workers ×4） | `snowharness-<role>` | `nexharness-<role>` |
| Service / Ingress | `snowharness` | `nexharness` |
| Ingress path | `/snowharness` | `/nexharness` |
| ConfigMap | `snowharness-runtime-config` | `nexharness-runtime-config` |
| Nacos dataId | `snow_harness.yaml` | `nexharness.yaml` |
| Nacos 键前缀 | `SNOW_*` | `NEX_*`（代码侧已改名；配置值需同步） |
| 镜像路径 | `…/snowharness-web`、`…/snowharness-worker` | `…/nexharness-web`、`…/nexharness-worker`（+`auth-center`、`nexharness-client`） |
| `.cnb.yml` 构建服务选项 | 「SnowHarness 全套」 | 「NexHarness 全套」（含三产物条目） |

## 4. 切换日清单（按序执行）

1. **框架仓**（feature 分支）：新增 `nexharness-web|worker` Dockerfile/Deployment/values + `auth-center`、`nexharness-client` 条目（以 snowharness 条目为模板改名/改路径）。
2. **业务仓** `.cnb.yml` + `.web_trigger.yml`：新增「NexHarness 全套」选项（多服务并行构建）。
3. **Nacos**：新建 `nexharness.yaml`（自 `snow_harness.yaml` 复制，键前缀 SNOW_→NEX_，补 auth-center 连接配置）。
4. **集群前置资源**：创建 nexharness / auth-center / nexharness-client 的 Service/Ingress/ConfigMap（镜像滚动由流水线负责）。
5. **构建源就位**：三仓代码进入 CNB 构建源（方案见 §6）。
6. **触发 UAT 流水线** → Deployment 就绪 → 冒烟（登录/会话/工作室 API/门户/管理台）。
7. **路径上线**：`/nexharness` 可用；旧 `/snowharness` 并行保留一个观察期。
8. **回滚**：旧 Deployment 不动；异常时 Ingress 指回 `/snowharness`（旧链路全程保留至切换验收）。

## 5. 验证

**本地镜像冒烟（2026-10-14，已完成两件）**：

| 镜像 | 构建 | 运行冒烟 |
|---|---|---|
| auth-center（384MB） | ✓（本地 node:24-alpine 缓存） | ✓ `/health` ok；门户 SPA 静态；`/login` fallback 200；**带库登录请求 → 规范 401**（容器 → MySQL 连接链通） |
| nexharness-client（28.9MB） | ✓（alpine+apk nginx 形态） | ✓ `/healthz` ok；`/nexharness/` SPA（NEX_BASE_PATH 前缀生效）；`/login` fallback 200；资产 200；301 跳转 |
| nexharness（API） | ✓（9m11s，next build 全链） | ✓ `Ready in 176ms`；bridge :3002 启动；无体 POST → 400；假票据 → `IDENTITY_SERVICE_UNAVAILABLE` 503（**fail-closed 正确**）；docker 探测 fail-fast（容器内无 socket 时拒绝启动——生产应挂 docker socket 或设降级开关） |

**切换日**：CNB UAT 手动入口 → 目标 Deployment 全就绪 + 登录/会话冒烟（方案 §六 验证矩阵第 ④ 行）。

**镜像形态备注**：client 运行时用 `alpine + apk nginx`（非 docker.io/library/nginx）——依赖单一 alpine 主源，受限网络/内网镜像源下更稳；本地网络受限时仍可构建。

## 6. 构建源与同步机制（待协同拍板）

现 `python-service/snow_harness` 子目录由企业线维护。切换后三仓代码进入 CNB 构建源，两种方案：

- **A（推荐，成本低）**：沿用子目录模式——`python-service/` 下新增子目录（`snow_harness` 原位更名或新增 `nexharness`/`auth-center`/`nexharness-client-web`），复用现有流水线模式；同步脚本从三 Git 仓推送代码。
- **B**：新建 CNB 仓（如 `crb/aigc/ai-team/nexharness`）——需 CNB 平台建仓权限与框架仓匹配配置。

## 7. 现实约束（2026-10-14 记录）

- 本机不可达 CNB（`CONNECT tunnel failed 502`）——CNB 侧操作需内网环境。
- 框架仓为 devops 共享仓，改动需按 devops 评审流程协同。
- K8s/Nacos 写操作需集群凭据（本机未见过 kubectl 配置，待切换环境确认）。
- 企业线同步机制（私有分支 → 子目录）不在本方案范围（企业分支对齐策略单独出子方案）。

## 8. 本阶段已备材料（本地）

| 仓 | 材料 |
|---|---|
| auth-center | `Dockerfile`（4 阶段：deps → web build → prod-deps → runner；tsx 直跑 server）+ `.dockerignore` |
| nexharness-client | `deploy/Dockerfile`（deps → vite build（NEX_BASE_PATH 注入）→ nginx）+ `deploy/nginx.conf`（子路径 SPA + 资产缓存 + 探活 + API 反代注释模板）+ `.dockerignore` |
| nexharness | 根 `Dockerfile`（web 镜像，注释更新双形态 context 说明）；`docker/worker/Dockerfile`、`docker/runtime/Dockerfile` 既有保留 |
