import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type StudioPageProps = {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly width?: "default" | "wide";
  readonly className?: string;
};

/** Studio 页面统一的可读内容列与标题区。 */
export function StudioPage({
  title,
  description,
  actions,
  children,
  width = "default",
  className,
}: StudioPageProps) {
  return (
    <div
      data-slot="studio-page"
      className={cn(
        "mx-auto w-full py-5 md:py-10",
        width === "wide" ? "max-w-5xl" : "max-w-3xl",
        className,
      )}
    >
      <header className="mb-10 flex flex-col items-start justify-between gap-5 sm:flex-row sm:gap-6">
        <div className="min-w-0 space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description && (
            <div className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</div>
          )}
        </div>
        {actions && (
          <div
            data-slot="studio-page-actions"
            className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end"
          >
            {actions}
          </div>
        )}
      </header>

      <div className="space-y-10">{children}</div>
    </div>
  );
}
