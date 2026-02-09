"use client";

import React from "react";

type Props = {
  title?: string;
  subtitle?: string;
  rightSlot?: React.ReactNode; // e.g., small status label or action button
  children: React.ReactNode;

  /** If true, body scrolls; otherwise body is just a flex container */
  scrollBody?: boolean;

  /** Tailwind class overrides */
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  footer?: React.ReactNode;
  footerClassName?: string;

  /** Surface tokens */
  surfaceClassName?: string; // defaults to canonical rail surface
  borderClassName?: string; // defaults to canonical rail border
};

export default function RailPanelFrame({
  title,
  subtitle,
  rightSlot,
  children,
  scrollBody = true,
  className = "",
  headerClassName = "",
  bodyClassName = "",
  footer,
  footerClassName = "",
  surfaceClassName = "bg-neutral-950",
  borderClassName = "border border-neutral-800",
}: Props) {
  return (
    <section
      className={[
        "h-full min-h-0 flex flex-col rounded-lg",
        borderClassName,
        surfaceClassName,
        className,
      ].join(" ")}
    >
      {(title || subtitle || rightSlot) ? (
        <header
          className={[
            "shrink-0 flex items-start justify-between gap-3 px-3 py-2",
            headerClassName,
          ].join(" ")}
        >
          <div className="min-w-0">
            {title ? (
              <div className="text-xs font-medium text-neutral-100">{title}</div>
            ) : null}
            {subtitle ? (
              <div className="text-[11px] text-neutral-400">{subtitle}</div>
            ) : null}
          </div>
          {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
        </header>
      ) : null}

      <div
        className={[
          "min-h-0 flex-1 px-3 pb-3",
          scrollBody ? "overflow-auto" : "",
          bodyClassName,
        ].join(" ")}
      >
        {children}
      </div>

      {footer ? (
        <footer
          className={[
            "shrink-0 px-3 py-2 border-t border-neutral-800",
            footerClassName,
          ].join(" ")}
        >
          {footer}
        </footer>
      ) : null}
    </section>
  );
}