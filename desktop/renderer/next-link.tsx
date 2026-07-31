import type { AnchorHTMLAttributes, PropsWithChildren } from "react";
import { navigateDesktop } from "./next-navigation";

export default function DesktopLink({
  href,
  children,
  onClick,
  ...props
}: PropsWithChildren<AnchorHTMLAttributes<HTMLAnchorElement> & { readonly href: string }>) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          props.target === "_blank"
        ) {
          return;
        }
        event.preventDefault();
        navigateDesktop(href);
      }}
    >
      {children}
    </a>
  );
}
