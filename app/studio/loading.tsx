import { Skeleton } from "@/components/ui/skeleton";

export default function StudioLoading() {
  return (
    <section
      // biome-ignore lint/a11y/useSemanticElements: 加载状态需要容纳页面级块布局并向读屏播报。
      role="status"
      aria-label="后台页面加载中"
      aria-live="polite"
      aria-busy="true"
      className="mx-auto w-full max-w-3xl py-5 md:py-10"
    >
      <span className="sr-only">后台页面加载中</span>

      <header className="mb-10 space-y-3">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </header>

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {[0, 1, 2, 3].map((row) => (
          <div
            key={row}
            className="flex items-center justify-between gap-8 border-b border-border px-4 py-4 last:border-b-0"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-full max-w-sm" />
            </div>
            <Skeleton className="h-8 w-20 shrink-0 rounded-lg" />
          </div>
        ))}
      </div>
    </section>
  );
}
