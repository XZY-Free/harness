import { redirect } from "next/navigation";

/**
 * 产物页已移除:产物列表项本就跳转到会话详情,与「会话」页冗余;
 * 跨会话最近产物改在「总览」页「最近产物」模块展示。保留路由作向后兼容重定向。
 */
export default function ArtifactsPage() {
  redirect("/studio");
}
