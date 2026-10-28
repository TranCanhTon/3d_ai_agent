"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { IconButton } from "../ui.tsx";

/** A centred dialog over a dim backdrop; Esc (AppShell) and a backdrop click close it. */
export function Modal({ title, children, footer, width = 520 }: { title: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const close = () => useWorldStore.getState().setDialog(null);

  useEffect(() => {
    // Focus the first field so typing can start at once.
    box.current?.querySelector<HTMLElement>("input, textarea, select, button[data-autofocus]")?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-950/70 p-6 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div ref={box} role="dialog" aria-modal="true" aria-label={title} className="surface card-in flex max-h-full w-full flex-col rounded-2xl" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between border-b border-mist-500/10 px-5 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <IconButton label="Close" onClick={close}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        {footer !== undefined && <div className="border-t border-mist-500/10 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
