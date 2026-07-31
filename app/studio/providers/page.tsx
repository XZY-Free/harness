import { redirect } from "next/navigation";

/**
 * 模型提供方档案已合并到「资源」页。保留路由作向后兼容重定向。
 */
export default function ProvidersPage() {
  redirect("/studio/resources?tab=providers");
}
