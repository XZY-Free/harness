# 多服务部署的受管资源

`compose.yaml` 启动 Web、五类持久 Worker、Workspace Broker 和 Environment Lease 清理进程。Broker 的 RPC 仅在 Compose 网络内使用，不发布宿主机端口。

启动前提供 `deploy/production/.env.production`、`DATABASE_URL`，并设置以下三个**持久、绝对的宿主机目录**：

| 变量 | 用途 |
|---|---|
| `SNOW_HARNESS_WORKSPACE_ROOT` | Workspace 数据和 Broker 锁、身份记录；容器内外使用同一绝对路径 |
| `SNOW_HARNESS_SNAPSHOT_ROOT` | 内容寻址的正式快照 |
| `SNOW_HARNESS_ENVIRONMENT_CONTROL_ROOT` | 环境实例的 operation 登记和 Secret 临时文件 |

三个目录必须相互独立、在重启后保持原数据和路径。受管容器由宿主 Docker daemon 创建，因此 Web、Worker 与 Broker 都把 Workspace 挂载在宿主机的同一绝对路径；改成仅容器可见的命名卷会让受管容器挂载到错误位置。容器实例 Backend 和清理进程使用宿主 Docker socket，部署主机需提供 `/var/run/docker.sock`，并限制这套服务的主机访问权限。正式 Workspace Binding 的 `locationRef` 必须指向 Broker 可访问的受管目录。

可用 `docker compose -f deploy/production/compose.yaml config --quiet` 核对变量与服务配置；这只验证编排，不代替目标主机的实际部署验证。
