"use client";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/contracts";
import { filePreviewSchema, type FilePreview } from "@/lib/file-preview";
import { Modal } from "./primitives";

export function FilePreviewDialog({ stream, file, onClose }: {
  stream: string;
  file: { id: string; name: string };
  onClose: () => void;
}) {
  return <Modal title={`Preview: ${file.name}`} onClose={onClose}><div className="modal-body"><FilePreviewContent stream={stream} file={file}/></div></Modal>;
}

export function FilePreviewContent({stream,file}:{stream:string;file:{id:string}}) {
  return <PreviewContent key={`${stream}:${file.id}`} stream={stream} file={file}/>;
}

function PreviewContent({stream,file}:{stream:string;file:{id:string}}) {
  const [data, setData] = useState<FilePreview | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    const refresh = async () => {
      if (controller || document.hidden) return;
      const current = new AbortController();
      controller = current;
      try {
        const response = filePreviewSchema.parse(await api(`/channels/${stream}/files/${file.id}/preview`, "GET", undefined, AbortSignal.any([current.signal, AbortSignal.timeout(8000)])));
        if (active && controller === current && !current.signal.aborted && !document.hidden) { setData(response); setError(""); }
      } catch (e) {
        if (active && controller === current && !current.signal.aborted && !document.hidden) {
          setData(null);
          setError(e instanceof ApiError ? e.message : "Preview could not be loaded. Retry when connected.");
        }
      } finally { if (controller === current) controller = undefined; }
    };
    const visibility = () => {
      if (document.hidden) { controller?.abort(); controller = undefined; setData(null); setError(""); }
      else void refresh();
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    document.addEventListener("visibilitychange", visibility);
    return () => { active = false; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [stream, file.id, attempt]);
  return <>
      <p>Source text only. Formatting, links and formulas are not executed.</p>
      {error ? <div role="alert"><p>{error}</p><button className="secondary" onClick={() => { setError(""); setAttempt(n => n + 1); }}>Retry preview</button></div>
        : !data ? <p role="status">Loading preview…</p>
        : <>
          {data.truncated && <p role="status">Preview truncated to {data.limit.toLocaleString()} text units. Download the file for its complete contents.</p>}
          {data.text ? <pre className="file-preview" tabIndex={0} aria-label="File source text">{data.text}</pre> : <p>This file is empty.</p>}
        </>}
  </>;
}
