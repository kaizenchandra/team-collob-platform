"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Search } from "lucide-react";
import { api } from "@/lib/contracts";
import { Avatar } from "./primitives";
type Person = { id: string; name: string; email: string; title: string };
type Cursor = { name: string; id: string } | null;
type Page = { people: Person[]; nextCursor: Cursor };
export function AttendeePicker({
  org,
  value,
  onChange,
  people = [],
  excludeIds = [],
  disabled = false,
  refreshKey = "",
  max = 100,
}: {
  org: string;
  value: string[];
  onChange: (ids: string[]) => void;
  people?: Person[];
  excludeIds?: string[];
  disabled?: boolean;
  refreshKey?: string;
  max?: number;
}) {
  const id = useId(),
    root = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [cursor, setCursor] = useState<Cursor>(null),
    [history, setHistory] = useState<Cursor[]>([]),
    [active, setActive] = useState(0),
    [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    page: Page | null;
    error: string;
  }>({ key: "", page: null, error: "" });
  const [resolved, setResolved] = useState<{
    key: string;
    people: Person[];
    unavailableIds: string[];
    error: string;
  }>({ key: "", people: [], unavailableIds: [], error: "" });
  const [announcement, setAnnouncement] = useState("");
  const [known, setKnown] = useState<{ org: string; people: Person[] }>({
    org,
    people: [],
  });
  const selectedKey = JSON.stringify([org, [...value].sort()]),
    key = JSON.stringify([org, query.trim(), cursor, attempt]);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
    target: Element;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!query.trim() || !open) return;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query.trim() });
      if (cursor) {
        params.set("afterName", cursor.name);
        params.set("afterId", cursor.id);
      }
      void api<Page>(
        `/organizations/${org}/attendee-options?${params}`,
        "GET",
        undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      )
        .then((page) => {
          if (!controller.signal.aborted) setSnapshot({ key, page, error: "" });
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setSnapshot({
              key,
              page: null,
              error: e instanceof Error ? e.message : "Search failed",
            });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, open, query, org, cursor]);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api<{
          people: Person[];
          unavailableIds: string[];
        }>(
          `/organizations/${org}/attendee-options/resolve`,
          "POST",
          { ids: JSON.parse(selectedKey)[1] },
          AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        );
        if (!controller.signal.aborted)
          setResolved({ key: selectedKey, ...result, error: "" });
      } catch (e) {
        if (!controller.signal.aborted)
          setResolved({
            key: selectedKey,
            people: [],
            unavailableIds: [],
            error:
              e instanceof Error ? e.message : "Attendee validation failed",
          });
      } finally {
        pending = false;
      }
    };
    if (value.length) void load();
    const timer = setInterval(() => {
      if (value.length && document.visibilityState === "visible") void load();
    }, 15000);
    const focus = () => {
      if (value.length) void load();
    };
    window.addEventListener("focus", focus);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [org, selectedKey, refreshKey, value.length]);
  const page = snapshot.key === key ? snapshot.page : null,
    error = snapshot.key === key ? snapshot.error : "",
    loading = Boolean(query.trim() && !page && !error);
  const results = (page?.people ?? []).filter(
    (p) => !value.includes(p.id) && !excludeIds.includes(p.id),
  );
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = input.current;
      if (!anchor?.isConnected) {
        setOpen(false);
        return;
      }
      const a = anchor.getBoundingClientRect(),
        h = window.visualViewport?.height ?? innerHeight,
        w = document.documentElement.clientWidth;
      const below = h - a.bottom - 12,
        above = a.top - 12,
        space = Math.max(60, Math.min(320, Math.max(below, above))),
        height = Math.min(320, space);
      setPosition({
        left: Math.max(8, Math.min(a.left, w - Math.min(a.width, w - 16) - 8)),
        top:
          below >= Math.min(220, height)
            ? a.bottom + 4
            : Math.max(8, a.top - height - 4),
        width: Math.min(a.width, w - 16),
        maxHeight: height,
        target: anchor.closest("dialog") ?? document.body,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (input.current) observer.observe(input.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    const outside = (e: PointerEvent) => {
      if (
        !root.current?.contains(e.target as Node) &&
        !popup.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  useEffect(() => {
    if (open)
      popup.current
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  function add(p: Person) {
    if (disabled || value.includes(p.id) || value.length >= max) return;
    setKnown((old) => ({
      org,
      people: [
        ...(old.org === org ? old.people : []).filter((x) => x.id !== p.id),
        p,
      ],
    }));
    onChange([...value, p.id]);
    setAnnouncement(`${p.name} added. Invitation not sent yet.`);
    setQuery("");
    setCursor(null);
    setHistory([]);
    setActive(0);
    setOpen(true);
    input.current?.focus();
  }
  function remove(user: string, name: string) {
    onChange(value.filter((id) => id !== user));
    setAnnouncement(`${name} removed from selection.`);
    input.current?.focus();
  }
  const hint = `${id}-hint`,
    list = `${id}-list`;
  return (
    <div ref={root} className="attendee-picker">
      <label htmlFor={id}>Add attendees</label>
      <div className="attendee-search">
        <Search size={17} aria-hidden="true" />
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && !disabled}
          aria-controls={open && !disabled ? list : undefined}
          aria-activedescendant={
            open && !disabled && results[active]
              ? `${id}-option-${results[active].id}`
              : undefined
          }
          aria-describedby={hint}
          placeholder="Search by name or email"
          autoComplete="off"
          maxLength={160}
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onBlur={(e) => {
            if (!popup.current?.contains(e.relatedTarget)) setOpen(false);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(null);
            setHistory([]);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              setActive((i) =>
                Math.max(
                  0,
                  Math.min(
                    results.length - 1,
                    i + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            }
            if (e.key === "Enter") {
              e.preventDefault();
              if (open && results[active]) add(results[active]);
              else setOpen(true);
            }
          }}
        />
      </div>
      <p id={hint} className="attendee-hint">
        Search by name or email. Invitations are sent only when you save or
        create the meeting.
      </p>
      <ul className="attendee-chips" aria-label="Selected attendees">
        {value.map((user) => {
          const fresh = resolved.key === selectedKey,
            unavailable = fresh && resolved.unavailableIds.includes(user),
            p =
              (fresh ? resolved.people : []).find((p) => p.id === user) ??
              (known.org === org ? known.people : []).find(
                (p) => p.id === user,
              ) ??
              people.find((p) => p.id === user),
            name = p?.name ?? `Attendee ${user.slice(0, 8)}`;
          return (
            <li key={user} className={unavailable ? "is-unavailable" : ""}>
              <span>
                {name}
                {!unavailable && p?.email && <small>{p.email}</small>}
                {unavailable && <small>Unavailable — remove to continue</small>}
              </span>
              <button
                type="button"
                className="icon-button"
                disabled={disabled}
                aria-label={`Remove ${name}`}
                onClick={() => remove(user, name)}
              >
                <X size={15} />
              </button>
            </li>
          );
        })}
      </ul>
      {resolved.key === selectedKey && resolved.error && (
        <p role="alert">
          Cannot verify selected attendees. Your selections are preserved.{" "}
          {resolved.error}
        </p>
      )}
      {value.length >= max && (
        <p role="status">
          Maximum {max} attendees selected. Remove someone to add another.
        </p>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {open &&
        !disabled &&
        position &&
        createPortal(
          <div
            ref={popup}
            className="attendee-dropdown"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                input.current?.focus();
                setOpen(false);
              }
            }}
            style={{
              position: "fixed",
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
            onBlur={(e) => {
              if (
                !root.current?.contains(e.relatedTarget) &&
                !e.currentTarget.contains(e.relatedTarget)
              )
                setOpen(false);
            }}
          >
            <div role="status" className="attendee-hint">
              {!query.trim()
                ? "Search by name or email."
                : loading
                  ? "Searching eligible people…"
                  : error
                    ? "Search unavailable."
                    : `${results.length} matching ${results.length === 1 ? "person" : "people"} on this page.`}
            </div>
            <ul role="listbox" aria-label="Eligible attendees" id={list}>
              {results.map((p, index) => (
                <li
                  key={p.id}
                  role="option"
                  id={`${id}-option-${p.id}`}
                  aria-selected={active === index}
                  aria-disabled={value.length >= max}
                  data-index={index}
                  onPointerMove={() => setActive(index)}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => add(p)}
                >
                  <Avatar name={p.name} />
                  <span>
                    <strong>{p.name}</strong>
                    <small>{p.email}</small>
                    {p.title && <small>{p.title}</small>}
                  </span>
                </li>
              ))}
            </ul>
            {query.trim() && !loading && !error && !results.length && (
              <p className="attendee-hint">
                {page?.people.length
                  ? "People on this page are already added."
                  : "No eligible people found."}
              </p>
            )}
            {error && (
              <div role="alert" className="attendee-hint">
                {error}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    input.current?.focus();
                    setAttempt((n) => n + 1);
                  }}
                >
                  Retry search
                </button>
              </div>
            )}
            {(history.length > 0 || page?.nextCursor) && (
              <div className="attendee-pages">
                <button
                  type="button"
                  className="secondary"
                  disabled={!history.length || loading}
                  onClick={() => {
                    input.current?.focus();
                    setCursor(history.at(-1) ?? null);
                    setHistory((h) => h.slice(0, -1));
                    setActive(0);
                  }}
                >
                  Previous results
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!page?.nextCursor || loading}
                  onClick={() => {
                    input.current?.focus();
                    setHistory((h) => [...h, cursor]);
                    setCursor(page!.nextCursor);
                    setActive(0);
                  }}
                >
                  Next results
                </button>
              </div>
            )}
          </div>,
          position.target,
        )}
    </div>
  );
}
