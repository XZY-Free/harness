import { redirect } from "next/navigation";

// 专题01 §33.7：Web 产品入口为 /chat（新建空态）与 /chat/{threadId}，
// 不存在假 new 路由 /chat/new。根路径重定向到 /chat 新建空态。
export default function HomePage() {
  redirect("/chat");
}
