import { BrandProvider } from "@/components/brand/brand-provider";
import { DEFAULT_BRAND } from "@/lib/branding/brand-contract";
import { toBrandPresentation } from "@/lib/branding/brand-presentation";
import { getBrandStore } from "@/lib/branding/brand-store";

/**
 * 服务端品牌初始值注入（async server component）。
 *
 * 首屏即以权威品牌渲染，避免 rebrand 部署闪烁默认名；客户端活更新由
 * BrandProvider 的 SSE + ETag 拉取接管。品牌源不可用时回退代码默认。
 */
export async function BrandInitial({ children }: { readonly children: React.ReactNode }) {
  const snapshot = await getBrandStore()
    .get()
    .catch(() => null);
  return (
    <BrandProvider initial={toBrandPresentation(snapshot?.contract ?? DEFAULT_BRAND)}>
      {children}
    </BrandProvider>
  );
}
