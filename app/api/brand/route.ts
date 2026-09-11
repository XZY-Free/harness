import { getBrandStore } from "@/lib/branding/brand-store";
import { ETAG_HEADER } from "@/lib/http";
import type { NextRequest } from "next/server";

/**
 * GET /api/brand → 当前品牌合同（公开读：登录页与各消费端首屏使用）。
 *
 * ETag = revision:fileGen；If-None-Match 命中返回 304。
 * 本端点只供状态拉取；失效信号由 /api/brand/stream 与 Desktop 控制面推送。
 */
export async function GET(req: NextRequest): Promise<Response> {
  const snapshot = await getBrandStore().get();
  if (req.headers.get("if-none-match") === snapshot.etag) {
    return new Response(null, { status: 304, headers: { [ETAG_HEADER]: snapshot.etag } });
  }
  return new Response(JSON.stringify({ brand: snapshot.contract, pinned: snapshot.pinned }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-cache",
      [ETAG_HEADER]: snapshot.etag,
    },
  });
}
