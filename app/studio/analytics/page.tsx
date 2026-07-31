import { redirect } from "next/navigation";

/**
 * 数据分析已合并到「总览」页(运营指标 + 失败分布 + 各技能表现)。
 * 保留路由作向后兼容重定向,scope 透传。
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const sp = await searchParams;
  redirect(sp.scope === "global" ? "/studio?scope=global" : "/studio");
}
