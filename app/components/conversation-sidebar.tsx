"use client";
import { useEffect, useRef, type ReactNode } from "react";
export function ConversationSidebar({
  open,
  close,
  children,
}: {
  open: boolean;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null),
    callback = useRef(close);
  useEffect(() => {
    callback.current = close;
  }, [close]);
  useEffect(() => {
    if (!open || !matchMedia("(max-width:700px)").matches) return;
    const trigger = document.querySelector<HTMLElement>(
      '[aria-controls="conversation-sidebar"]',
    );
    const escape = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !document.querySelector("dialog[open]") &&
        !document.querySelector(".profile-popover")
      ) {
        e.preventDefault();
        callback.current();
        trigger?.focus({ preventScroll: true });
      }
    };
    const outside = (e: PointerEvent) => {
      if ((e.target as Element).closest?.(".conversation-drawer-backdrop"))
        return;
      if (
        !ref.current?.contains(e.target as Node) &&
        !trigger?.contains(e.target as Node)
      )
        callback.current();
    };
    const resize = () => {
      if (!matchMedia("(max-width:700px)").matches) callback.current();
    };
    const frame = requestAnimationFrame(() =>
      ref.current
        ?.querySelector<HTMLInputElement>(
          'input[aria-label="Filter conversations"]',
        )
        ?.focus({ preventScroll: true }),
    );
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", resize);
    };
  }, [open]);
  function dismiss() {
    close();
    document
      .querySelector<HTMLElement>('[aria-controls="conversation-sidebar"]')
      ?.focus({ preventScroll: true });
  }
  return (
    <>
      {open && (
        <button
          className="conversation-drawer-backdrop"
          aria-label="Dismiss conversations"
          onClick={dismiss}
        />
      )}
      <aside
        ref={ref}
        id="conversation-sidebar"
        aria-label="Conversations"
        className={`sidebar ${open ? "mobile-open" : ""}`}
      >
        {children}
      </aside>
    </>
  );
}
