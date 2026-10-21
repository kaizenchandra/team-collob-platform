"use client";
import { useLayoutEffect, useState, type ReactNode } from "react";
export function ComposerFormatting({ children }: { children: ReactNode }) {
  const [compact, setCompact] = useState(false),
    [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const media = matchMedia("(max-width:700px), (max-height:600px)");
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return (
    <details
      className="composer-format-options"
      open={!compact || expanded}
      onToggle={(e) => {
        if (compact) setExpanded(e.currentTarget.open);
      }}
    >
      <summary>Formatting options</summary>
      {children}
    </details>
  );
}
