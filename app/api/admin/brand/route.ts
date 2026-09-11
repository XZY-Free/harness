import {
  BrandFieldPinnedError,
  BrandValidationError,
  parseBrandPatch,
} from "@/lib/branding/brand-contract";
import { getBrandStore } from "@/lib/branding/brand-store";
import { apiError, getRequestId, jsonOk } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * PUT /api/admin/brand → 管理端写入品牌 partial patch（brand.manage 守卫）。
 *
 * 被 branding.json / env pin 的字段拒绝写入 → 409 BRAND_FIELD_PINNED；
 * 校验失败 → 400 BRAND_VALIDATION_FAILED；成功返回新快照与 etag。
 * 本端点是将来 Studio 品牌设置页的唯一写入口（薄写客户端）。
 */
export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = getRequestId(req);
  const guarded = await requireStudioAction(req, "brand.manage");
  if (!guarded.ok) return guarded.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("BRAND_VALIDATION_FAILED", "请求体必须是 JSON 对象", { requestId });
  }
  try {
    const patch = parseBrandPatch(body);
    const snapshot = await getBrandStore().update(patch, guarded.principal.userIdentityId);
    return jsonOk({ brand: snapshot.contract, pinned: snapshot.pinned, etag: snapshot.etag });
  } catch (error) {
    if (error instanceof BrandFieldPinnedError) {
      return apiError("BRAND_FIELD_PINNED", error.message, { requestId });
    }
    if (error instanceof BrandValidationError) {
      return apiError("BRAND_VALIDATION_FAILED", error.message, { requestId });
    }
    throw error;
  }
}
