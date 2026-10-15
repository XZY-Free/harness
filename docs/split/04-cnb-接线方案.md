# 04 — CNB 企业部署接线方案（阶段④ · 方案 §5.3）

> 状态：**材料就绪，切换待执行**（2026-10-15 复核：CNB 已从本机可达，权限边界见 §7；企业侧缺口见 §9）。
> 原则（方案 §5.3）：**旧链路保持至切换日**，本阶段只备料不改线上。

## 1. 现状（旧链路）

| 项 | 现值 |
|---|---|
| 部署源 | CNB `crb/aigc/ai-team/python-service` 仓的 `snow_harness/` 子目录（拆分前快照；企业版代码经 `enterprise/private-hr-integration` 分支同步——同步机制属企业线子方案，本轮不动） |
| 流水线 | 业务仓 `.cnb.yml` + **框架仓 `CRB/devops/cnb-pipeline`（feature 分支）**；通用阶段：down_k8s_manifests → down_cnb_pipeline → print_params → java_compile → build_image → nacos_contract_check → deploy_yaml |
| 镜像/模板/values 来源 | **框架仓独有**：`config/Python/aigc/python-service/config.yaml`、`deploy/dsu/Dockerfile/Python/aigc/python-service/snowharness-web\|snowharness-worker/`、`deploy/dsu/Deployment/Python/aigc/python-service/{templates/deployment.yaml,<服务名>/values.yaml}`；业务仓 `snow_harness/deployment/helm/**` 已退化为说明载体（不再被流水线调用） |
| 集群资源（创建服务时前置，流水线只滚动 Deployment 镜像） | 5 Deployment：`snowharness-web`（web）+ 4 worker（`snowharness-hosted-provisioning` / `-control-plane-outbox` / `-runtime-dispatch-retry` / `-tool-execution`）；Service/Ingress `snowharness` @ `ai-uat.crb.cn` path `/snowharness`（TLS `crb-cn`）；ConfigMap `snowharness-runtime-config`；Secret `cnb-harbor-secret`/`crb-cn` |
| Nacos | namespace `9d99594f-e156-4c22-ad62-b8740dbfd822`；dataId `snow_harness.yaml`；地址 `nacos-headless.app-system.svc.cluster.local:8848` |
| 镜像仓库 | CNB Harbor（`cnb-harbor-secret`） |

## 2. 目标形态（切换后）

| 产物 | 形态 | 来源 |
|---|---|---|
| nexharness API | 镜像（web/api + workers 同代码多入口；拆分后 = 纯 API 服务：Next.js route handlers，无页层；**新拓扑 durable worker = 5（旧 4 + `job-worker`）**，另有 workspace-host / environment-lease-cleanup 条目——见 §9） | `nexharness` 仓（Dockerfile 已就绪） |
| auth-center | 镜像（Hono API + 同源门户/管理台 SPA 单容器） | `auth-center` 仓（Dockerfile 本阶段新增） |
| client Web | 静态产物镜像（nginx 子路径 `/nexharness/`，SPA fallback） | `nexharness-client` 仓（deploy/Dockerfile + nginx.conf 本阶段新增） |
| client Desktop | 桌面分发包（dmg/zip，非集群物） | 桌面打包链（已冒烟） |

## 3. 更名映射表（snow → nex，切换日全量替换）

| 面 | 现值 | 目标值 |
|---|---|---|
| Deployment（web） | `snowharness-web` | `nexharness-web` |
| Deployment（workers，旧 4 → 新拓扑 5） | `snowharness-<role>` | `nexharness-<role>`（新增 `job-worker` 条目；workspace-host 等见 §9） |
| Service / Ingress | `snowharness` | `nexharness` |
| Ingress path | `/snowharness` | `/nexharness` |
| ConfigMap | `snowharness-runtime-config` | `nexharness-runtime-config` |
| Nacos dataId | `snow_harness.yaml` | `nexharness.yaml` |
| Nacos 键前缀 | `SNOW_*` | `NEX_*`（代码侧已改名；配置值需同步） |
| 镜像路径 | `…/snowharness-web`、`…/snowharness-worker` | `…/nexharness-web`、`…/nexharness-worker`（+`auth-center`、`nexharness-client`） |
| `.cnb.yml` 构建服务选项 | 「SnowHarness 全套」 | 「NexHarness 全套」（含三产物条目） |

## 4. 切换日清单（按序执行）

> 执行边界（2026-10-15 复核）：第 1 步需 devops 协同（本机框架仓只读 403）；第 2 步本机可执行（业务仓有写权限）；第 3/4 步需集群凭据；第 5 步构建源方案待拍板（§6）。

1. **框架仓**（feature 分支）：新增 `nexharness-web|worker` Dockerfile/Deployment/values + `auth-center`、`nexharness-client` 条目（以 snowharness 条目为模板改名/改路径）。
2. **业务仓** `.cnb.yml` + `.web_trigger.yml`：新增「NexHarness 全套」选项（多服务并行构建）。
3. **Nacos**：新建 `nexharness.yaml`（自 `snow_harness.yaml` 复制，键前缀 SNOW_→NEX_，补 auth-center 连接配置）。
4. **集群前置资源**：创建 nexharness / auth-center / nexharness-client 的 Service/Ingress/ConfigMap（镜像滚动由流水线负责）。
5. **构建源就位**：三仓代码进入 CNB 构建源（方案见 §6）。
6. **触发 UAT 流水线** → Deployment 就绪 → 冒烟（登录/会话/工作室 API/门户/管理台）。
7. **路径上线**：`/nexharness` 可用；旧 `/snowharness` 并行保留一个观察期。
8. **回滚**：旧 Deployment 不动；异常时 Ingress 指回 `/snowharness`（旧链路全程保留至切换验收）。

## 5. 验证

**本地镜像冒烟（2026-10-14，三件全部完成）**：

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

## 7. 现实约束与权限边界（2026-10-15 本机复核）

| 项 | 复核结果 | 对切换日的影响 |
|---|---|---|
| 平台连通 | `cnb.crb.cn` 可达（HTTP 200）；业务仓 / 框架仓 / k8s-manifests 的 `git ls-remote` 均通 | CNB 读操作本机可执行 |
| 业务仓写权限 | `python-service` 可推送（push --dry-run 通过；凭据已在 keychain） | §4 第 2 步本机可执行 |
| 框架仓写权限 | `cnb-pipeline` **403 无写权限**（读可用） | §4 第 1 步需 devops 协同 |
| 集群凭据 | 本机 kubeconfig 为空；CNB 上 `kube-config.yaml` 需登录态（401） | §4 第 3/4 步需凭据/内网执行 |
| 镜像仓库 | `docker.cnb.crb.cn` 可达（401 为未认证常规响应） | 构建推送链路通 |
| 旧链路健康 | `ai-uat.crb.cn/snowharness` 307 → `/chat` → 登录跳转，正常 | 观察期与回滚基线成立 |
| Docker Hub | `docker.io` 仍不可达（本地缓存 node:24-alpine / alpine:3.19 可用） | 本地镜像构建受限于缓存基座 |

- 框架仓（devops 共享仓）改动建议以 **patch/清单** 形式（文件级 diff + 说明）走 devops 评审合并。
- 企业线同步机制（私有分支 → 子目录）不在本方案范围——对齐进度与缺口见 §9。

## 8. 本阶段已备材料（本地）

| 仓 | 材料 |
|---|---|
| auth-center | `Dockerfile`（4 阶段：deps → web build → prod-deps → runner；tsx 直跑 server）+ `.dockerignore` |
| nexharness-client | `deploy/Dockerfile`（deps → vite build（NEX_BASE_PATH 注入）→ nginx）+ `deploy/nginx.conf`（子路径 SPA + 资产缓存 + 探活 + API 反代注释模板）+ `.dockerignore` |
| nexharness | 根 `Dockerfile`（web 镜像，注释更新双形态 context 说明）；`docker/worker/Dockerfile`、`docker/runtime/Dockerfile` 既有保留 |

## 9. 企业侧缺口分析（2026-10-15 复核发现 · 切换日硬前置）

复核「企业私有分支（`enterprise/private-hr-integration`）→ 拆分后三仓」的能力对齐，确认以下缺口必须在切换日之前解决，否则企业版能力上线即缺失：

| # | 缺口 | 现状 | 影响 |
|---|---|---|---|
| G1 | **Nacos 运行时加载** | 企业分支有 `lib/nacos/runtime-config.ts`（SNOW_* 键清单 + fail-fast）+ `scripts/verify-nacos-config.ts`；**nexharness main 无 `lib/nacos`**（main 仅按 APP_ENV 读 `.env` 文件） | UAT 集群「最小 Secret 引导 Nacos」链断裂——不补则 nexharness 镜像在 UAT 无法获得运行配置 |
| G2 | **企业 SSO 提供者** | 企业分支有 `lib/deployment/enterprise-sso-provider.ts`（376 行）与 `identity-extension.ts` 企业装配；auth-center main 的 `lib/deployment/identity-extension.ts` 是**开源静态组合根**（仅 local provider，注释明确「私有发行版在构建时替换此模块」） | 企业登录（SSO/HR 目录）不可用——需为企业版建立 `identity-extension` 私有替换物 |
| G3 | **COS 文件存储扩展** | 企业分支 `file-storage-extension.ts` 接 COS；nexharness main 为开源默认（workspaceFileStorageProvider） | 企业文件存储链路缺失（契约位已留，需私有实现） |
| G4 | **worker 角色集扩容** | main 拓扑 = 5 worker（含 `job-worker`，2026-09-17 引入）+ workspace-host + environment-lease-cleanup（compose 为准）；企业分支仍为旧 4 worker | 框架 snowharness-worker 条目需按新拓扑增补 Deployment/values |
| G5 | **企业专用 env/业务键** | 企业分支键集（SNOW_ENTERPRISE_*、SNOW_LOCAL_HR_A2A_TOKEN、SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET、SNOW_COS_* 等 28 键）；main 键集为 NEX_ 前缀的通用面 | Nacos `nexharness.yaml` 键映射需**逐键核对归属**（哪些进 auth-center、哪些留 nexharness、哪些被消费方模型裁掉） |

**方向性结论**（待与用户确认后落子方案）：
- G1/G3 属「企业私有发行版替换组合根」模式（main 已按此设计留位：`lib/deployment/*` 注释「私有发行版在构建时替换本模块」）——建议以私有分支方式补回，不改 main 结构。
- G2 应落 **auth-center 私有分支**（认证提供者归 auth-center 权威），而非 nexharness。
- G4/G5 属切换日清单内的量变项（新增条目/键映射），不是新机制。
- 数据库侧：企业库 `ctp_rbac` 的表口径需按拆分后 19（auth-center）+ 116（nexharness）重新核对（现 `snowharness-init.sql` 为拆分前 134 表快照）。
