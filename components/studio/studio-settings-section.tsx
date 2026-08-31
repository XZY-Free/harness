import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

type StudioSettingsSectionProps = {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
};

/** 参考系统设置页的轻量分组：标题在外，相关行收拢到同一容器。 */
export function StudioSettingsSection({
  title,
  description,
  children,
  className,
}: StudioSettingsSectionProps) {
  return (
    <section aria-label={title} className={cn("space-y-3", className)}>
      <div className="space-y-1 px-0.5">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description && <p className="text-xs leading-5 text-muted-foreground">{description}</p>}
      </div>
      <div
        data-slot="studio-settings-group"
        className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-xs"
      >
        {children}
      </div>
    </section>
  );
}

type StudioSettingsRowProps = {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
};

export function StudioSettingsRow({
  title,
  description,
  children,
  className,
}: StudioSettingsRowProps) {
  return (
    <div
      data-slot="studio-settings-row"
      className={cn(
        "grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-6 px-4 py-3.5",
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description && (
          <div className="text-xs leading-5 text-muted-foreground">{description}</div>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>}
    </div>
  );
}

type StudioSettingsLinkRowProps = {
  readonly href: string;
  readonly title: string;
  readonly description?: ReactNode;
  readonly meta?: ReactNode;
  readonly className?: string;
};

export function StudioSettingsLinkRow({
  href,
  title,
  description,
  meta,
  className,
}: StudioSettingsLinkRowProps) {
  return (
    <Link
      href={href}
      data-slot="studio-settings-row"
      className={cn(
        "group grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-6 px-4 py-3.5 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description && (
          <div className="text-xs leading-5 text-muted-foreground">{description}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {meta}
        <ChevronRight
          className="size-4 transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </div>
    </Link>
  );
}
