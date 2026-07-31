import { redirect } from "next/navigation";

/**
 * 智能体档案已合并到「资源」页。保留路由作向后兼容重定向。
 */
export default function AgentsPage() {
  redirect("/studio/resources?tab=agents");
}
