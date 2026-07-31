import { redirect } from "next/navigation";

/**
 * 工作区列表已合并到「会话」页(会话与工作区同源 thread,原两套列表冗余)。
 * 保留路由作向后兼容重定向。
 */
export default function WorkspacesPage() {
  redirect("/studio/threads");
}
