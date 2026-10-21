"use client";
/* eslint-disable react-hooks/set-state-in-effect -- Withdraw stale profile data when the identity changes. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import { createPortal } from "react-dom";
import type { OrganizationProfile } from "@/lib/organization";
import { Avatar } from "./primitives";
import { useOwnPresence, presenceStates } from "./presence-provider";
import { api, type Person, type Session } from "@/lib/contracts";

const Popovers = createContext<{
  active: string | null;
  setActive: (id: string | null, expected?: string) => void;
  routeKey: string;
}>({ active: null, setActive: () => {}, routeKey: "" });
const Directory = createContext<{
  org: string;
  organization: (id: string) => void;
  people: Person[];
  userId: string;
  message: (id: string) => Promise<void>;
  call: (mode: "audio" | "video", id: string) => Promise<void>;
}>({
  org: "",
  organization: () => {},
  people: [],
  userId: "",
  message: async () => {},
  call: async () => {},
});
export function ProfilePopovers({
  children,
  org,
  organization,
  people,
  userId,
  routeKey,
  message,
  call,
}: {
  children: ReactNode;
  org: string;
  organization: (id: string) => void;
  people: Person[];
  userId: string;
  routeKey: string;
  message: (id: string) => Promise<void>;
  call: (mode: "audio" | "video", id: string) => Promise<void>;
}) {
  const scope = `${org}:${userId}`;
  const [selection, setSelection] = useState<{
    scope: string;
    id: string | null;
  }>({ scope, id: null });
  const active = selection.scope === scope ? selection.id : null;
  const currentScope = useRef(scope);
  useEffect(() => {
    currentScope.current = scope;
  }, [scope]);
  const setActive = useCallback(
    (id: string | null, expected?: string) => {
      if (currentScope.current !== scope) return;
      setSelection((previous) =>
        expected && previous.id !== expected ? previous : { scope, id },
      );
    },
    [scope],
  );
  // Withdraw old-scope cards synchronously; changing directory context must not
  // remount settings forms or recreate the application's media owner.
  useEffect(() => setActive(null), [routeKey, setActive]);
  return (
    <Popovers.Provider value={{ active, setActive, routeKey }}>
      <Directory.Provider
        value={{ org, organization, people, userId, message, call }}
      >
        {children}
      </Directory.Provider>
    </Popovers.Provider>
  );
}
export function HoverPopover({
  label,
  trigger,
  children,
  focusOpens = true,
  triggerClassName,
  description,
}: {
  label: string;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  focusOpens?: boolean;
  triggerClassName?: string;
  description?: string;
}) {
  const { active, setActive, routeKey } = useContext(Popovers),
    id = useId(),
    open = active === id;
  const button = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null),
    opening = useRef<ReturnType<typeof setTimeout> | null>(null),
    closing = useRef<ReturnType<typeof setTimeout> | null>(null),
    pinned = useRef(false),
    keyboard = useRef(false),
    restoring = useRef(false);
  const [position, setPosition] = useState({ top: 0, left: 0, ready: false });
  function clear() {
    if (opening.current) clearTimeout(opening.current);
    if (closing.current) clearTimeout(closing.current);
  }
  function close(restore = false) {
    clear();
    setActive(null, id);
    pinned.current = false;
    if (restore) {
      restoring.current = true;
      button.current?.focus();
      queueMicrotask(() => {
        restoring.current = false;
      });
    }
  }
  useEffect(() => {
    clear();
    pinned.current = false;
  }, [routeKey]);
  function enter() {
    clear();
    if (!open)
      opening.current = setTimeout(() => {
        pinned.current = false;
        keyboard.current = false;
        setActive(id);
      }, 200);
  }
  function leave() {
    clear();
    if (!pinned.current)
      closing.current = setTimeout(() => {
        if (
          !panel.current?.contains(document.activeElement) &&
          document.activeElement !== button.current
        )
          setActive(null, id);
      }, 180);
  }
  useEffect(
    () => () => {
      if (opening.current) clearTimeout(opening.current);
      if (closing.current) clearTimeout(closing.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = button.current,
        box = panel.current;
      if (!anchor?.isConnected || !anchor.getClientRects().length) {
        setActive(null, id);
        return;
      }
      if (!box) return;
      const a = anchor.getBoundingClientRect(),
        width = document.documentElement.clientWidth,
        height = window.innerHeight;
      // Reserve the visible meeting toolbar even on short/mobile screens.
      const toolbar = Array.from(
        document.querySelectorAll<HTMLElement>(".call-toolbar"),
      ).find((element) => element.getClientRects().length > 0);
      const bottom = Math.min(
        height,
        toolbar?.getBoundingClientRect().top ?? height,
      );
      box.style.setProperty(
        "--popover-available-height",
        `${Math.max(40, bottom - 16)}px`,
      );
      const b = box.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(a.left, width - b.width - 8)),
        top: Math.max(
          8,
          Math.min(
            a.bottom + 8 + b.height > bottom - 8
              ? a.top - b.height - 8
              : a.bottom + 8,
            bottom - b.height - 8,
          ),
        ),
        ready: true,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const focusFirst = () => {
      if (!keyboard.current) return;
      const box = panel.current;
      if (
        !box ||
        (document.activeElement !== button.current &&
          document.activeElement !== box)
      )
        return;
      if (box.querySelector('[aria-busy="true"]'))
        box.focus({ preventScroll: true });
      else
        box
          .querySelector<HTMLElement>(
            "button:not(:disabled),select:not(:disabled),a[href]",
          )
          ?.focus({ preventScroll: true });
    };
    const mutations = new MutationObserver(() => {
      if (!button.current?.isConnected) setActive(null, id);
      else focusFirst();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    focusFirst();
    const dismiss = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !button.current?.contains(event.target as Node)
      )
        close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(
          keyboard.current ||
            pinned.current ||
            !!panel.current?.contains(document.activeElement),
        );
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
    // Callbacks deliberately read current DOM refs; lifetime follows the active popover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id, setActive]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={triggerClassName ?? "profile-details-trigger"}
        aria-label={label}
        aria-describedby={description ? `${id}-description` : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onPointerEnter={(e) => {
          if (e.pointerType !== "touch") enter();
        }}
        onPointerLeave={leave}
        onFocus={() => {
          if (focusOpens && !restoring.current) enter();
        }}
        onBlur={(e) => {
          if (!panel.current?.contains(e.relatedTarget)) leave();
        }}
        onClick={(e) => {
          e.stopPropagation();
          clear();
          if (open && pinned.current) {
            close();
            return;
          }
          pinned.current = true;
          keyboard.current = e.detail === 0;
          setActive(id);
          if (open && keyboard.current)
            panel.current
              ?.querySelector<HTMLButtonElement>("button,select,a[href]")
              ?.focus();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            clear();
            keyboard.current = true;
            pinned.current = true;
            setActive(id);
          }
        }}
      >
        {trigger}
      </button>
      {description && (
        <span
          id={`${id}-description`}
          className="sr-only"
          aria-live="polite"
          aria-atomic="true"
        >
          {description}
        </span>
      )}
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            tabIndex={-1}
            aria-label={label}
            className="profile-popover"
            style={{
              top: position.top,
              left: position.left,
              visibility: position.ready ? "visible" : "hidden",
            }}
            onPointerEnter={clear}
            onPointerLeave={leave}
            onBlur={(e) => {
              if (
                !e.currentTarget.contains(e.relatedTarget) &&
                e.relatedTarget !== button.current
              )
                close();
            }}
          >
            {children(() => setActive(null, id))}
          </div>,
          document.body,
        )}
    </>
  );
}
export function ProfileTrigger({
  userId,
  name,
  children,
}: {
  userId: string;
  name: string;
  children?: ReactNode;
}) {
  const context = useContext(Directory);
  if (!context.userId) return <>{children ?? name}</>;
  return (
    <HoverPopover
      label={`Profile details for ${name}`}
      trigger={children ?? name}
    >
      {(close) => (
        <ProfileCard key={userId} userId={userId} name={name} close={close} />
      )}
    </HoverPopover>
  );
}
export function useProfileActions() {
  return useContext(Directory);
}
function ProfileCard({
  userId,
  name,
  close,
}: {
  userId: string;
  name: string;
  close: () => void;
}) {
  const {
      org,
      organization,
      userId: ownId,
      message,
      call,
    } = useContext(Directory),
    [profile, setProfile] = useState<OrganizationProfile | null>(null),
    [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setProfile(null);
    setLoading(true);
    setError("");
    void api<OrganizationProfile>(
      `/organizations/${org}/organization/people/${userId}/profile`,
      "GET",
      undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    )
      .then((data) => {
        if (!controller.signal.aborted) setProfile(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Profile unavailable");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [org, userId, attempt]);
  const person = profile?.person;
  async function act(fn: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await fn();
      close();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Action unavailable. Please retry.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <div className="profile-card-identity">
        <Avatar name={person?.name ?? name} />
        <div>
          <h2>{person?.name ?? name}</h2>
          {person?.title && <p>{person.title}</p>}
        </div>
      </div>
      {person ? (
        <>
          <p>
            {presenceStates[person.presence as keyof typeof presenceStates] ??
              person.presence}
          </p>
          <a href={`mailto:${person.email}`}>{person.email}</a>
          {person.department && <p>{person.department}</p>}
          {person.organizationalUnit && <p>{person.organizationalUnit}</p>}
          {person.workLocation && <p>{person.workLocation}</p>}
          {profile?.manager && <p>Reports to {profile.manager.name}</p>}
          {profile?.managerState === "unavailable" && (
            <p>Manager details unavailable.</p>
          )}
          <small>
            {person.directReportCount} visible direct{" "}
            {person.directReportCount === 1 ? "report" : "reports"}
          </small>
          {expanded && (
            <dl>
              <dt>Workspace role</dt>
              <dd>{person.role}</dd>
              {person.title && (
                <>
                  <dt>Job title</dt>
                  <dd>{person.title}</dd>
                </>
              )}
            </dl>
          )}
          <div className="profile-card-actions">
            {userId !== ownId && (
              <>
                <button
                  className="secondary"
                  disabled={pending}
                  onClick={() => void act(() => message(userId))}
                >
                  Message
                </button>
                <button
                  className="secondary"
                  disabled={pending}
                  onClick={() => void act(() => call("audio", userId))}
                >
                  Audio call
                </button>
                <button
                  className="secondary"
                  disabled={pending}
                  onClick={() => void act(() => call("video", userId))}
                >
                  Video call
                </button>
              </>
            )}
            <button
              className="secondary"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Hide profile details" : "View profile"}
            </button>
          </div>
          <button
            className="secondary"
            onClick={() => {
              close();
              organization(userId);
            }}
          >
            View organization
          </button>
        </>
      ) : (
        <div>
          {loading ? (
            <p role="status" aria-busy="true">
              Loading authorized profile details…
            </p>
          ) : (
            <>
              <p>Further profile details are unavailable in this workspace.</p>
              <button
                className="secondary"
                onClick={() => setAttempt((x) => x + 1)}
              >
                Retry profile
              </button>
            </>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <button className="profile-card-close" onClick={close}>
        Close profile card
      </button>
    </>
  );
}
export function AccountDropdown({
  session,
  onSettings,
  onOrganization,
  onSave,
  onLogout,
}: {
  session: Session;
  onSettings: () => void;
  onOrganization: () => void;
  onSave: () => Promise<void>;
  onLogout: () => void;
}) {
  const presence = useOwnPresence(),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  async function theme(value: string) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await api("/profile", "PATCH", {
        name: session.user.name,
        title: session.user.title,
        timezone: session.user.timezone,
        status: session.user.status,
        preferences: { ...session.user.preferences, theme: value },
      });
      await onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Theme could not be saved.");
    } finally {
      setPending(false);
    }
  }
  return (
    <HoverPopover
      label="Account menu"
      description={
        presence.current
          ? presenceStates[presence.current.state]
          : presence.error
            ? "Presence unavailable"
            : "Checking presence…"
      }
      focusOpens={false}
      trigger={
        <span className="account-trigger">
          <span className="profile-avatar">
            <Avatar name={session.user.name} small />
            <span
              className="presence-dot"
              data-state={presence.current?.state ?? "unknown"}
              aria-hidden="true"
            />
          </span>
          <span>
            {presence.current
              ? presenceStates[presence.current.state]
              : presence.error
                ? "Presence unavailable"
                : "Checking presence…"}
          </span>
        </span>
      }
    >
      {(close) => (
        <>
          <div className="profile-card-identity">
            <Avatar name={session.user.name} />
            <div>
              <h2>{session.user.name}</h2>
              <p>{session.user.email}</p>
            </div>
          </div>
          <button
            className="secondary"
            onClick={() => {
              close();
              onSettings();
            }}
          >
            Profile & account settings
          </button>
          <button
            className="secondary"
            onClick={() => {
              close();
              onOrganization();
            }}
          >
            My organization
          </button>
          <label>
            Availability
            <select
              aria-label="Account availability"
              disabled={presence.busy || presence.loading}
              value={presence.current?.state ?? ""}
              onChange={(e) =>
                void presence.setPresence(
                  e.target.value as keyof typeof presenceStates,
                  60,
                )
              }
            >
              <option value="" disabled>
                Loading…
              </option>
              {Object.entries(presenceStates).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Theme
            <select
              aria-label="Theme"
              disabled={pending}
              value={
                session.user.preferences.theme === "dark" ? "dark" : "light"
              }
              onChange={(e) => void theme(e.target.value)}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          {(error || presence.error) && (
            <p role="alert">{error || presence.error}</p>
          )}
          <button
            className="secondary"
            onClick={() => {
              close();
              onLogout();
            }}
          >
            Sign out
          </button>
        </>
      )}
    </HoverPopover>
  );
}

const chatPeople = z.object({
  id: z.uuid(),
  participants: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export function ChatProfiles({
  channelId,
  userId,
}: {
  channelId: string;
  userId: string;
}) {
  const [data, setData] = useState<z.infer<typeof chatPeople> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api(`/channels/${channelId}/chat`, "GET", undefined, controller.signal)
      .then((value) => {
        const result = chatPeople.parse(value);
        if (!controller.signal.aborted && result.id === channelId)
          setData(result);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [channelId]);
  return (
    <div className="chat-profile-links" aria-label="Conversation participants">
      {data?.id === channelId &&
        data.participants
          .filter((p) => p.id !== userId)
          .map((p) => (
            <ProfileTrigger key={p.id} userId={p.id} name={p.name} />
          ))}
    </div>
  );
}
