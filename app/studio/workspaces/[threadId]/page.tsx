import { redirect } from "next/navigation";

/**
 * 单 thread 工作区文件管理已合并到「会话详情」页「文件」tab。
 * 保留路由作向后兼容重定向。
 */
export default async function WorkspaceDetailPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  redirect(`/studio/threads/${threadId}?tab=files`);
}
