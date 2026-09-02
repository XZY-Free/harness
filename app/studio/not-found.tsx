import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowLeft, FileQuestion } from "lucide-react";
import Link from "next/link";

export default function StudioNotFound() {
  return (
    <section
      aria-labelledby="studio-not-found-title"
      className="mx-auto flex min-h-96 w-full max-w-xl items-center justify-center py-10"
    >
      <div className="w-full rounded-2xl border border-border bg-card px-6 py-10 text-center shadow-sm sm:px-10">
        <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <FileQuestion className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-5 text-sm font-medium text-muted-foreground">404</p>
        <h1
          id="studio-not-found-title"
          className="mt-1 text-2xl font-semibold tracking-tight text-foreground"
        >
          没有找到这个页面
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          页面可能已移动或不再可用。返回后台首页后，可以从左侧菜单重新进入。
        </p>
        <Link href="/studio" className={cn(buttonVariants({ variant: "outline" }), "mt-6")}>
          <ArrowLeft aria-hidden="true" />
          返回后台首页
        </Link>
      </div>
    </section>
  );
}
