"use client";
import Markdown from "react-markdown";
import { useState, type RefObject } from "react";

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

export function MessageContent({body, format, mentions = []}: {body: string; format: "plain" | "markdown-v1"; mentions?: {id: string; name: string}[]}) {
  if (format === "plain") return <p className="plain-message">{body}</p>;
  return <div className="formatted-message"><Markdown
    urlTransform={(value) => {
      const id = value.startsWith("concord-mention:") ? value.slice("concord-mention:".length).toLowerCase() : "";
      return mentions.some(m => m.id === id) ? `concord-mention:${id}` : safeUrl(value);
    }}
    components={{
      a: ({href, children}) => {
        const mention = mentions.find(m => href === `concord-mention:${m.id}`);
        return mention ? <span className="mention">@{mention.name}</span> : href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
      },
      img: ({alt}) => <span>[Image omitted{alt ? `: ${alt}` : ""}]</span>,
      h1: ({children}) => <p><strong>{children}</strong></p>,
      h2: ({children}) => <p><strong>{children}</strong></p>,
      h3: ({children}) => <p><strong>{children}</strong></p>,
      h4: ({children}) => <p><strong>{children}</strong></p>,
      h5: ({children}) => <p><strong>{children}</strong></p>,
      h6: ({children}) => <p><strong>{children}</strong></p>,
    }}
  >{body}</Markdown></div>;
}

export function FormattingTools({value, change, input, disabled = false}: {
  value: string; change: (body: string) => void;
  input: RefObject<HTMLTextAreaElement | null>; disabled?: boolean;
}) {
  const [preview, setPreview] = useState(false), [error, setError] = useState("");
  function insert(before: string, after: string, fallback: string) {
    const field = input.current;
    if (!field || disabled) return;
    const start = field.selectionStart, end = field.selectionEnd;
    const selected = value.slice(start, end) || fallback;
    const updated = value.slice(0, start) + before + selected + after + value.slice(end);
    if (updated.length > 10000) { setError("Formatting would exceed the 10,000 character message limit."); return; }
    setError(""); change(updated);
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + before.length, start + before.length + selected.length); });
  }
  return <div className="formatting-tools">
    <div role="group" aria-label="Message formatting">
      <button type="button" disabled={disabled} onClick={()=>insert("**", "**", "bold text")}>Bold</button>
      <button type="button" disabled={disabled} onClick={()=>insert("*", "*", "italic text")}>Italic</button>
      <button type="button" disabled={disabled} onClick={()=>insert("`", "`", "code")}>Code</button>
      <button type="button" disabled={disabled} onClick={()=>insert("[", "](https://example.com)", "link text")}>Link</button>
      <button type="button" disabled={disabled} onClick={()=>insert("\n- ", "\n", "list item")}>Bullet list</button>
      <button type="button" disabled={disabled} aria-pressed={preview} onClick={()=>setPreview(!preview)}>Preview formatting</button>
    </div>
    <small>Markdown supported. Links use http(s); images and HTML are not embedded.</small>
    {error && <p role="alert">{error}</p>}
    {preview && <section className="message-preview" aria-label="Message preview"><MessageContent body={value || "Nothing to preview yet."} format="markdown-v1" /></section>}
  </div>;
}
