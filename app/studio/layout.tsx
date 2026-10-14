import { StudioShell } from "@/components/studio/studio-shell";

/**
 * Studio 统一布局（客户端外壳）。
 *
 * 门禁与导航已迁移到 StudioShell（拉取 /studio/api/context）：
 * 登录态、studio.access 与 8 大菜单可见性全部由接口驱动（消费方模型 v4）。
 * 子页的数据与写操作各自走 API（服务端 requireStudioAction 兜底）。
 */
export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return <StudioShell>{children}</StudioShell>;
}
