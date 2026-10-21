"use client";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import type { Message } from "@/lib/contracts";
type Position = {
  top: number;
  following: boolean;
  last: string;
  unseen: string[];
};
export type TimelineMemory = Map<string, Position>;
export function ConversationTimeline({
  scope,
  memory,
  messages,
  userId,
  children,
}: {
  scope: string;
  memory: TimelineMemory;
  messages: Message[];
  userId: string;
  children: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null),
    previous = useRef<{
      first: string;
      offset: number;
      last: string;
      following: boolean;
    } | null>(null),
    unseen = useRef(new Set<string>());
  const [away, setAway] = useState(false),
    [count, setCount] = useState(0);
  function save() {
    const node = list.current;
    if (!node) return;
    const following =
      node.scrollHeight - node.clientHeight - node.scrollTop < 64;
    if (following) {
      unseen.current.clear();
      setCount(0);
    }
    setAway(!following);
    const first = node.querySelector<HTMLElement>(".message");
    previous.current = {
      first: first?.id ?? "",
      offset: first?.offsetTop ?? 0,
      last: messages.at(-1)?.seq ?? "0",
      following,
    };
    memory.delete(scope);
    memory.set(scope, {
      top: node.scrollTop,
      following,
      last: messages.at(-1)?.seq ?? "0",
      unseen: [...unseen.current],
    });
    if (memory.size > 24) memory.delete(memory.keys().next().value!);
  }
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    const old = previous.current,
      saved = memory.get(scope),
      last = messages.at(-1)?.seq ?? "0";
    if (!old) {
      unseen.current = new Set(saved?.unseen ?? []);
      if (saved?.last)
        for (const m of messages)
          if (BigInt(m.seq) > BigInt(saved.last) && m.user_id !== userId)
            unseen.current.add(m.id);
      node.scrollTop =
        !saved || saved.following || saved.last === "0"
          ? node.scrollHeight
          : saved.top;
    } else {
      const first = node.querySelector<HTMLElement>(".message");
      if (old.following) node.scrollTop = node.scrollHeight;
      else {
        for (const m of messages)
          if (BigInt(m.seq) > BigInt(old.last) && m.user_id !== userId)
            unseen.current.add(m.id);
        if (first && first.id !== old.first) {
          const anchor = node.querySelector<HTMLElement>(`[id="${old.first}"]`);
          if (anchor) node.scrollTop += anchor.offsetTop - old.offset;
        }
      }
    }
    setCount(unseen.current.size);
    save();
    // Preserve the latest viewport when a section/tab unmounts this timeline.
    return () => {
      if (node)
        memory.set(scope, {
          top: node.scrollTop,
          following: previous.current?.following ?? true,
          last,
          unseen: [...unseen.current],
        });
    };
    // save reads the current commit's messages and DOM; it does not own media or API state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, memory, scope, userId]);
  function latest() {
    const node = list.current;
    if (node) {
      node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
      unseen.current.clear();
      setCount(0);
      save();
      node.focus({ preventScroll: true });
    }
  }
  return (
    <div className="conversation-timeline">
      <div
        ref={list}
        className="message-list"
        role="region"
        aria-label="Messages"
        tabIndex={0}
        onScroll={save}
      >
        {children}
      </div>
      <span className="sr-only" role="status">
        {count
          ? `${count} new ${count === 1 ? "message" : "messages"} while you read history`
          : ""}
      </span>
      {away && (
        <button type="button" className="timeline-latest" onClick={latest}>
          <ArrowDown size={15} aria-hidden="true" />
          {count
            ? `${count} new ${count === 1 ? "message" : "messages"}`
            : "Jump to latest"}
        </button>
      )}
    </div>
  );
}
