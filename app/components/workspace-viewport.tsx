"use client";
import { useEffect } from "react";
// Resize the authenticated shell for an on-screen keyboard without treating
// pinch zoom as a smaller application viewport. Media keeps its existing owner.
export function WorkspaceViewport() {
  useEffect(() => {
    const viewport = window.visualViewport,
      shell = document.querySelector<HTMLElement>(".application");
    if (!viewport || !shell) return;
    let frame = 0;
    const sync = () => {
      if (!shell.isConnected) return;
      const element = document.activeElement as HTMLElement | null;
      const editing = element?.matches(
        'input,textarea,[contenteditable="true"]',
      );
      if (
        editing &&
        Math.abs(viewport.scale - 1) < 0.01 &&
        viewport.height < window.innerHeight - 40
      ) {
        shell.dataset.keyboardOpen = "true";
        shell.style.setProperty(
          "--workspace-app-height",
          `${Math.floor(viewport.height)}px`,
        );
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (element?.isConnected && document.activeElement === element)
            element.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
      } else {
        delete shell.dataset.keyboardOpen;
        shell.style.removeProperty("--workspace-app-height");
      }
    };
    const focused = () => queueMicrotask(sync);
    viewport.addEventListener("resize", sync);
    document.addEventListener("focusin", focused);
    document.addEventListener("focusout", focused);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      delete shell.dataset.keyboardOpen;
      viewport.removeEventListener("resize", sync);
      document.removeEventListener("focusin", focused);
      document.removeEventListener("focusout", focused);
      shell.style.removeProperty("--workspace-app-height");
    };
  }, []);
  return null;
}
