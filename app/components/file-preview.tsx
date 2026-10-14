"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/contracts";
import { filePreviewSchema, type FilePreview } from "@/lib/file-preview";
import { Modal } from "./primitives";

export function FilePreviewDialog({ stream, file, onClose }: {
  stream: string;
  file: { id: string; name: string };
  onClose: () => void;
}) {
  const [data, setData] = useState<FilePreview | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true, pending = false;
    let controller: AbortController | undefined;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8000);
      try {
        const response = filePreviewSchema.parse(await api(`/channels/${stream}/files/${file.id}/preview`, "GET", undefined, controller.signal));
        if (active && !document.hidden) { setData(response); setError(""); }
      } catch (e) {
        if (active) {
          setData(null);
          setError(e instanceof Error && e.name !== "AbortError" ? e.message : "Preview request interrupted. Retry when connected.");
        }
      } finally { clearTimeout(timeout); pending = false; }
    };
    const visibility = () => {
      if (document.hidden) { controller?.abort(); setData(null); }
      else void refresh();
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    document.addEventListener("visibilitychange", visibility);
    return () => { active = false; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [stream, file.id, attempt]);
  return <Modal title={`Preview: ${file.name}`} onClose={onClose}>
    <div className="modal-body">
      <p>Source text only. Formatting, links and formulas are not executed.</p>
      {error ? <div role="alert"><p>{error}</p><button className="secondary" onClick={() => { setError(""); setAttempt(n => n + 1); }}>Retry preview</button></div>
        : !data ? <p role="status">Loading preview…</p>
        : <>
          {data.truncated && <p role="status">Preview truncated to {data.limit.toLocaleString()} text units. Download the file for its complete contents.</p>}
          {data.text ? <pre className="file-preview" tabIndex={0} aria-label="File source text">{data.text}</pre> : <p>This file is empty.</p>}
        </>}
    </div>
  </Modal>;
}
