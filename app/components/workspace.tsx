"use client";
import {AuditSearch} from "./audit-search";
import {UsageReport} from "./usage-report";
import {MessageReportDialog,ModerationPanel} from "./moderation";
import {PostingPolicy} from "./posting-policy";
import {MeetingReminders} from "./meeting-reminders";
import { InvitationInbox, InvitationNotice } from "./invitation-inbox";
import { BrowserMentionAlerts } from "./notifications";
import { AttachmentPicker, MessageAttachments } from "./attachments";
import { MentionPicker } from "./mention-picker";
import { MessageContent, FormattingTools } from "./message-content";
/* Remote snapshots and live subscriptions intentionally reset state on resource changes.
   This prevents showing the previous resource while asynchronous requests are pending. */
/* eslint-disable react-hooks/set-state-in-effect */
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type FormEvent,
} from "react";
import {
  MessageSquare,
  Users,
  CalendarDays,
  Phone,
  FolderOpen,
  Bell,
  Settings,
  Search,
  Plus,
  Hash,
  Lock,
  ChevronDown,
  ChevronRight,
  Send,
  Paperclip,
  Smile,
  AtSign,
  Video,
  PanelRight,
  ExternalLink,
  Check,
  CheckCheck,
  Reply,
  Trash2,
  Pencil,
  Bookmark,
  Pin,
  VolumeX,
  LogOut,
  HelpCircle,
  RefreshCw,
  Shield,
  Menu,
  X,
  Link as LinkIcon,
} from "lucide-react";
import {
  API,
  api,
  ApiError,
  sessionSchema,
  historySchema,
  type Session,
  type Bootstrap,
  type Channel,
  type Message,
} from "@/lib/contracts";
import {
  pendingFor,
  savePending,
  removePending,
  retainIdentity,
  clearPending,
  type PendingMessage,
} from "@/lib/pending-messages";
import { Avatar, Empty, Modal, Unavailable } from "./primitives";
import {
  WorkPanel,
  CalendarPanel,
  SettingsPanel,
  FilesPanel,
  MigrationPanel,
} from "./panels";
import { TeamsPanel, MembershipPanel } from "./membership-panels";

type View =
  | "Chat"
  | "Teams"
  | "Activity"
  | "Calendar"
  | "Calls"
  | "Files"
  | "Invitations"
  | "Settings"
  | "Help"
  | "Admin";
const nav = [
  ["Activity", Bell],
  ["Chat", MessageSquare],
  ["Teams", Users],
  ["Calendar", CalendarDays],
  ["Calls", Phone],
  ["Files", FolderOpen],
] as const;
export default function Workspace() {
  const [session, setSession] = useState<Session | null>(null),
    [checking, setChecking] = useState(true),
    [error, setError] = useState(""),
    [org, setOrg] = useState(""),
    [boot, setBoot] = useState<Bootstrap | null>(null),
    [stream, setStream] = useState(""),
    [view, setView] = useState<View>("Chat"),
    [tab, setTab] = useState("Posts"),
    [messages, setMessages] = useState<Message[]>([]),
    [hasMore, setHasMore] = useState(false),
    [draft, setDraft] = useState(""),
    [draftReady, setDraftReady] = useState(false),
    [reply, setReply] = useState<Message | null>(null),
    [connection, setConnection] = useState("Connecting"),
    [sending, setSending] = useState(false),
    [failed, setFailed] = useState<PendingMessage | null>(null),
    [typing, setTyping] = useState<string[]>([]),
    [receipts, setReceipts] = useState<
      { user_id: string; name: string; seq: string }[]
    >([]),
    [filter, setFilter] = useState(""),
    [search, setSearch] = useState(""),
    [results, setResults] = useState<
      | {
          id: string;
          body: string;
          channel_id: string;
          channel_name: string;
          author: string;
        }[]
      | null
    >(null),
    [modal, setModal] = useState(""),
    [details, setDetails] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [activityFilter, setActivityFilter] = useState<"unread" | "mentions" | "replies">("unread"),
    [activity, setActivity] = useState<
      {
        id: string;
        body: string;
        channel_id: string;
        channel_name: string;
        author: string;
        format: "plain" | "markdown-v1";
        mentions: {id:string;name:string}[];
        mentioned: boolean;
        replied: boolean;
      }[]
    >([]);
  const identityRef = useRef("");
  const streamRef = useRef(stream);
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);
  const orgRef = useRef(org);
  useEffect(() => {
    orgRef.current = org;
  }, [org]);
  const draftLoaded = useRef(false);
  const latestDraft = useRef(draft);
  useEffect(() => {
    latestDraft.current = draft;
  }, [draft]);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const typingAt = useRef(0);
  const listEnd = useRef<HTMLDivElement>(null);
  const [reporting,setReporting]=useState<{channel:string;id:string;deleted:boolean}|null>(null);
  useEffect(()=>setReporting(null),[org,stream]);
  const channel = boot?.channels.find((c) => c.id === stream);
  const postingBlocked=!!channel?.posting_restricted&&!["owner","admin"].includes(boot?.role??"");
  const resetSession = useCallback(() => {
    identityRef.current = "";
    orgRef.current = "";
    streamRef.current = "";
    draftLoaded.current = false;
    latestDraft.current = "";
    setSession(null);
    setBoot(null);
    setOrg("");
    setStream("");
    setMessages([]);
    setDraft("");
    setDraftReady(false);
    setFailed(null);
    setResults(null);
    setActivity([]);
    setReceipts([]);
    setTyping([]);
    setReply(null);
  }, []);
  const report = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        resetSession();
      }
      setError(
        e instanceof Error
          ? e.message
          : "Connection failed. Check your connection and try again.",
      );
    },
    [resetSession],
  );
  const refreshSession = useCallback(async () => {
    try {
      const s = sessionSchema.parse(await api("/session"));
      try {
        retainIdentity(window.sessionStorage, s.user.id);
      } catch (e) {
        report(e);
      }
      identityRef.current = s.user.id;
      setSession(s);
      setOrg(
        (o) =>
          o ||
          s.organizations.find(
            (item) =>
              item.id ===
              new URLSearchParams(window.location.search).get("org"),
          )?.id ||
          s.organizations[0]?.id ||
          "",
      );
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) report(e);
    } finally {
      setChecking(false);
    }
  }, [report]);
  const refresh = useCallback(async () => {
    if (!org) return;
    const b = await api<Bootstrap>(`/organizations/${org}/bootstrap`);
    if (orgRef.current !== org) return;
    setBoot(b);
    setStream((s) =>
      b.channels.some((c) => c.id === s) ? s : (b.channels[0]?.id ?? ""),
    );
  }, [org]);
  const history = useCallback(async () => {
    if (!stream) return;
    const data = historySchema.parse(await api(`/channels/${stream}/messages`));
    if (streamRef.current !== stream) return;
    setMessages((previous) => {
      const fresh = new Map(data.messages.map((m) => [m.id, m]));
      return [
        ...previous.filter(
          (m) => Number(m.seq) < Number(data.messages[0]?.seq ?? 0),
        ),
        ...fresh.values(),
      ];
    });
    setHasMore(data.hasMore);
    const r = await api<{ receipts: typeof receipts }>(
      `/channels/${stream}/receipts`,
    );
    if (streamRef.current === stream) setReceipts(r.receipts);
  }, [stream]);
  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);
  useEffect(() => {
    if (!session) return;
    document.documentElement.dataset.theme =
      session.user.preferences.theme === "dark" ? "dark" : "light";
  }, [session]);
  useEffect(() => {
    if (session && org) void refresh().catch(report);
  }, [session, org, refresh, report]);
  useEffect(() => {
    if (!session || !org) return;
    const tick = () => {
      void api(`/organizations/${org}/presence`, "POST", {}).catch(() => {});
      void refresh().catch(report);
    };
    const timer = setInterval(tick, 20000);
    tick();
    return () => clearInterval(timer);
  }, [session, org, refresh, report]);
  useEffect(() => {
    if (!stream || !session) return;
    draftLoaded.current = false;
    setDraftReady(false);
    setDraft("");
    setMessages([]);
    setReply(null);
    setReceipts([]);
    setFailed(null);
    try {
      setFailed(
        pendingFor(window.sessionStorage, session.user.id, org, stream),
      );
    } catch (e) {
      report(e);
    }
    void history().catch(report);
    void api<{ body: string }>(`/channels/${stream}/draft`)
      .then((d) => {
        if (streamRef.current === stream) {
          setDraft(d.body);
          draftLoaded.current = true;
          setDraftReady(true);
        }
      })
      .catch(report);
    setConnection("Connecting");
    let source: EventSource;
    let cursor = "0";
    let hydrateTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      source?.close();
    };
    const connect = () => {
      if (stopped || !navigator.onLine) return;
      clearTimeout(reconnectTimer);
      source?.close();
      source = new EventSource(
        `${API}/v1/channels/${stream}/events?after=${cursor}`,
        { withCredentials: true },
      );
      const active = source;
      source.onopen = () => {
        if (stopped || source !== active) return;
        attempts = 0;
        setConnection("Live");
        if (draftLoaded.current)
          void api(`/channels/${stream}/draft`, "PUT", {
            body: latestDraft.current,
          }).catch(report);
      };
      source.onmessage = (event) => {
        if (stopped || source !== active) return;
        cursor = event.lastEventId || cursor;
        if (hydrateTimer) return;
        hydrateTimer = setTimeout(() => {
          hydrateTimer = undefined;
          void history().catch(report);
          void refresh().catch(report);
        }, 50);
      };
      source.onerror = () => {
        if (stopped || source !== active) return;
        source.close();
        setConnection(navigator.onLine ? "Reconnecting" : "Offline");
        clearTimeout(reconnectTimer);
        if (navigator.onLine) {
          // Some failed HTTP handshakes permanently close EventSource. Own the
          // retry loop, retaining the replay cursor and current draft.
          const delay = Math.min(10000, 500 * 2 ** Math.min(attempts++, 4) + Math.random() * 500);
          reconnectTimer = setTimeout(connect, delay);
        }
      };
      source.addEventListener("session-ended", () => {
        if (stopped || source !== active) return;
        stop();
        try {
          clearPending(window.sessionStorage);
        } catch {
          /* storage may be disabled */
        }
        const event = new BroadcastChannel("concord-session");
        event.postMessage("logout");
        event.close();
        report(new ApiError("Your session ended. Sign in again.", 401));
      });
      source.addEventListener("revoked", () => {
        if (stopped || source !== active) return;
        stop();
        setMessages([]);
        setDraft("");
        try {
          const pending = pendingFor(
            window.sessionStorage,
            session.user.id,
            org,
            stream,
          );
          if (pending) removePending(window.sessionStorage, pending.id);
        } catch (e) {
          report(e);
        }
        setFailed(null);
        setConnection("Access changed");
        void refresh().catch(report);
      });
    };
    const offline = () => {
      clearTimeout(reconnectTimer);
      source?.close();
      setConnection("Offline");
    };
    const online = () => {
      setConnection("Reconnecting");
      connect();
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    connect();
    const timer = setInterval(() => {
      void api<{ people: string[] }>(`/channels/${stream}/typing`)
        .then((x) => {
          if (streamRef.current === stream) setTyping(x.people);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      stop();
      clearTimeout(hydrateTimer);
      clearInterval(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [stream, org, session, history, refresh, report]);
  useEffect(() => {
    if (!draftLoaded.current || !stream) return;
    const timer = setTimeout(() => {
      void api(`/channels/${stream}/draft`, "PUT", { body: draft }).catch(() =>
        setConnection("Draft not synced — keep this window open"),
      );
    }, 600);
    return () => clearTimeout(timer);
  }, [draft, stream]);
  useEffect(() => {
    if (view !== "Activity" || !org) return;
    let active = true, pending = false;
    setActivity([]);
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await api<{items: typeof activity}>(`/organizations/${org}/activity?filter=${activityFilter}`);
        if (active && orgRef.current === org) setActivity(response.items);
      } catch (error) { if (active) { setActivity([]); report(error); } }
      finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => { void load(); },5000);
    return () => { active = false; clearInterval(timer); };
  },[view,org,activityFilter,report]);
  useEffect(() => {
    const event = new BroadcastChannel("concord-session");
    event.onmessage = (e) => {
      if (e.data === "logout") {
        try {
          clearPending(window.sessionStorage);
        } catch {
          /* storage may be disabled */
        }
        resetSession();
      }
    };
    return () => event.close();
  }, [resetSession]);
  async function logout() {
    try {
      await api("/session", "DELETE");
      try {
        clearPending(window.sessionStorage);
      } catch (e) {
        report(e);
      }
      resetSession();
      const event = new BroadcastChannel("concord-session");
      event.postMessage("logout");
      event.close();
    } catch (e) {
      report(e);
    }
  }
  async function send(retry = false, attachmentIds: string[] = []) {
    if (!session || !stream || !org || sending || !draftReady || (postingBlocked&&!retry)) return;
    const destination = stream;
    const tenant = org;
    let item: PendingMessage;
    try {
      const pending = pendingFor(
        window.sessionStorage,
        session.user.id,
        tenant,
        destination,
      );
      if (retry && !pending) {
        setFailed(null);
        return;
      }
      if (pending && !retry) {
        setFailed(pending);
        report(
          new Error("Resolve the unconfirmed message before sending another."),
        );
        return;
      }
      item = pending ?? {
        id: crypto.randomUUID(),
        userId: session.user.id,
        orgId: tenant,
        channelId: destination,
        body: draft.trim() || (attachmentIds.length ? "Shared a file." : ""),
        attachmentIds,
        format: "markdown-v1",
        parentId: reply?.id ?? null,
      };
      if (!item.body) return;
      savePending(window.sessionStorage, item);
    } catch (e) {
      report(e);
      return;
    }
    setSending(true);
    const current = () =>
      streamRef.current === destination &&
      orgRef.current === tenant &&
      identityRef.current === item.userId;
    try {
      await api(`/channels/${destination}/messages`, "POST", {
        clientId: item.id,
        body: item.body,
        format: item.format ?? "plain",
        parentId: item.parentId,
        attachmentIds: item.attachmentIds ?? [],
      });
    } catch (e) {
      if (current()) {
        setFailed(item);
        report(e);
      }
      setSending(false);
      return;
    }
    // Accepted/persisted is final even if draft saving or rendering later fails.
    try {
      removePending(window.sessionStorage, item.id);
      if (current()) {
        setFailed(null);
        setError("");
        if (latestDraft.current.trim() === item.body || (!latestDraft.current.trim() && item.attachmentIds?.length && item.body === "Shared a file.")) {
          latestDraft.current = "";
          setDraft("");
          setReply(null);
          await api(`/channels/${destination}/draft`, "PUT", { body: "" });
        }
        await history();
        await refresh();
        setTimeout(
          () => listEnd.current?.scrollIntoView({ behavior: "smooth" }),
          50,
        );
      }
    } catch (e) {
      if (current()) report(e);
    } finally {
      setSending(false);
    }
  }
  function discardPending() {
    if (!failed) return;
    try {
      removePending(window.sessionStorage, failed.id);
      setFailed(null);
    } catch (e) {
      report(e);
    }
  }
  async function perform(fn: () => Promise<unknown>) {
    try {
      await fn();
      await history();
      await refresh();
    } catch (e) {
      report(e);
    }
  }
  async function select(c: string) {
    if (stream && c !== stream && draftLoaded.current) {
      try {
        await api(`/channels/${stream}/draft`, "PUT", { body: draft });
      } catch (e) {
        report(e);
        return;
      }
    }
    streamRef.current = c;
    setStream(c);
    setView("Chat");
    setTab("Posts");
    setResults(null);
    setMobileNav(false);
    window.history.replaceState(null, "", `/?org=${org}&channel=${c}`);
  }
  useEffect(() => {
    if (boot) {
      const deep = new URLSearchParams(window.location.search).get("channel");
      if (deep && boot.channels.some((c) => c.id === deep)) {
        setStream(deep);
      }
    }
  }, [boot]);
  async function searchAll(e: FormEvent) {
    e.preventDefault();
    if (!search.trim()) return;
    try {
      const data = await api<{ results: NonNullable<typeof results> }>(
        `/organizations/${org}/search?q=${encodeURIComponent(search)}`,
      );
      if (orgRef.current === org) setResults(data.results);
    } catch (e) {
      report(e);
    }
  }
  if (checking)
    return (
      <main className="loading-page">
        <div className="brand-icon">c</div>
        <p>Opening your workspace…</p>
      </main>
    );
  if (!session)
    return <Login onSuccess={refreshSession} error={error} onError={report} />;
  const orgName =
    session.organizations.find((o) => o.id === org)?.name ?? "Workspace";
  const visible =
    boot?.channels.filter(
      (c) => !c.hidden && c.name.toLowerCase().includes(filter.toLowerCase()),
    ) ?? [];
  return (
    <div className="application">
      {org && <BrowserMentionAlerts key={`${session.user.id}:${org}`} org={org} userId={session.user.id} />}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">c</span>concord
          <span className="brand-dot">.</span>
        </div>
        <form className="global-search" onSubmit={searchAll}>
          <Search size={18} />
          <input
            aria-label="Search this workspace"
            placeholder="Search messages in your workspace"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>↵</kbd>
        </form>
        <div className="top-actions">
          <span className="environment">LOCAL DEVELOPMENT</span>
          <button
            className="icon-button"
            aria-label="Help and service status"
            onClick={() => setView("Help")}
          >
            <HelpCircle size={20} />
          </button>
          <button
            className="profile-button"
            aria-label="Open profile settings"
            onClick={() => setView("Settings")}
          >
            <Avatar name={session.user.name} small />
            <span className="presence-dot" />
          </button>
        </div>
      </header>
      <nav className="rail" aria-label="Main navigation">
        {nav.map(([label, Icon]) => (
          <button
            key={label}
            className={view === label ? "active" : ""}
            onClick={() => {
              setView(label);
              setResults(null);
            }}
          >
            <Icon size={22} />
            <span>{label}</span>
            {label === "Activity" &&
              !!boot?.channels.some((c) => c.unread > 0) && <i />}
          </button>
        ))}
        <div className="rail-bottom">
          {["owner", "admin"].includes(boot?.role ?? "") && (
            <button
              onClick={() => setView("Admin")}
              className={view === "Admin" ? "active" : ""}
            >
              <Shield size={21} />
              <span>Admin</span>
            </button>
          )}
          <button
            onClick={() => setView("Settings")}
            className={view === "Settings" ? "active" : ""}
          >
            <Settings size={21} />
            <span>Settings</span>
          </button>
          <button onClick={logout}>
            <LogOut size={21} />
            <span>Sign out</span>
          </button>
        </div>
      </nav>
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <div className="workspace-switch">
          <label htmlFor="workspace">WORKSPACE</label>
          <div>
            <select
              id="workspace"
              value={org}
              onChange={async (e) => {
                const destination = e.target.value;
                if (stream && draftLoaded.current) {
                  try {
                    await api(`/channels/${stream}/draft`, "PUT", {
                      body: draft,
                    });
                  } catch (e) {
                    report(e);
                    return;
                  }
                }
                orgRef.current = destination;
                streamRef.current = "";
                setOrg(destination);
                setBoot(null);
                setStream("");
                setMessages([]);
                setDraft("");
                setResults(null);
                setActivity([]);
              }}
            >
              {session.organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
        </div>
        <div className="sidebar-heading">
          <h1>Conversations</h1>
          <button
            className="icon-button"
            aria-label="New conversation"
            onClick={() => setModal("conversation")}
          >
            <Pencil size={18} />
          </button>
        </div>
        <div className="filter">
          <Search size={15} />
          <input
            aria-label="Filter conversations"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter conversations"
          />
        </div>
        <button className="sidebar-link" onClick={() => setView("Activity")}>
          <Bell size={16} />
          Unread activity
          <span>{boot?.channels.reduce((n, c) => n + c.unread, 0) || ""}</span>
        </button>
        {!!visible.some((c) => c.pinned) && (
          <>
            <div className="section-label">PINNED</div>
            {visible
              .filter((c) => c.pinned)
              .map((c) => (
                <ChannelButton
                  key={c.id}
                  channel={c}
                  active={stream === c.id}
                  onClick={() => select(c.id)}
                />
              ))}
          </>
        )}
        <div className="section-label">
          YOUR TEAMS
          <button aria-label="Create team" onClick={() => setModal("team")}>
            <Plus size={15} />
          </button>
        </div>
        {boot?.teams.map((team) => (
          <div key={team.id} className="team-group">
            <div className="team-title">
              <ChevronDown size={14} />
              <span className="team-icon">{team.name[0]}</span>
              <span>{team.name}</span>
            </div>
            {visible
              .filter((c) => c.team_id === team.id)
              .map((c) => (
                <ChannelButton
                  key={c.id}
                  channel={c}
                  active={stream === c.id && view === "Chat"}
                  onClick={() => select(c.id)}
                />
              ))}
          </div>
        ))}
        <button className="add-channel" onClick={() => setModal("channel")}>
          <Plus size={15} />
          Add a channel
        </button>
        <div className="section-label">
          DIRECT MESSAGES
          <button
            aria-label="Start direct message"
            onClick={() => setModal("conversation")}
          >
            <Plus size={15} />
          </button>
        </div>
        {visible
          .filter((c) => !c.team_id)
          .map((c) => (
            <ChannelButton
              key={c.id}
              channel={c}
              active={stream === c.id}
              onClick={() => select(c.id)}
            />
          ))}
        {!visible.some((c) => !c.team_id) && (
          <p className="sidebar-hint">Good work starts with a conversation.</p>
        )}
        <div className="sidebar-footer">
          <div className="workspace-art">
            <span>✦</span>
            <span>✧</span>
            <span>✦</span>
          </div>
          <strong>A little more connected.</strong>
          <p>One place for your people and ideas.</p>
          <button onClick={() => setView("Help")}>
            Explore your workspace <ChevronRight size={14} />
          </button>
        </div>
      </aside>
      <main id="main" className="main">
        <MeetingReminders key={org} org={org}/>
        <div className="mobile-toolbar">
          <button
            onClick={() => setMobileNav(!mobileNav)}
            aria-label="Toggle conversations"
          >
            <Menu size={20} />
          </button>
          <span>{orgName}</span>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        <InvitationNotice key={session.user.id} onReview={()=>{setResults(null);setView("Invitations");}} />
        {results !== null ? (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">{orgName}</span>
                <h1>Search results</h1>
                <p>Messages you have permission to view.</p>
              </div>
              <button className="secondary" onClick={() => setResults(null)}>
                Back to conversation
              </button>
            </div>
            <div className="content-pad">
              {results.length ? (
                results.map((r) => (
                  <button
                    className="result-card"
                    key={r.id}
                    onClick={() => select(r.channel_id)}
                  >
                    <strong>
                      #{r.channel_name} <small>{r.author}</small>
                    </strong>
                    <p>{r.body}</p>
                  </button>
                ))
              ) : (
                <Empty title="No matching messages">
                  Try a different word or phrase.
                </Empty>
              )}
            </div>
          </>
        ) : view === "Teams" ? (
          <TeamsPanel
            key={org}
            org={org}
            role={boot?.role ?? "member"}
            refresh={refresh}
            report={report}
          />
        ) : view === "Chat" ? (
          channel ? (
            <>
              <header className="conversation-header">
                <div className="channel-emblem">
                  {channel.kind === "private" ? (
                    <Lock size={23} />
                  ) : (
                    <Hash size={25} />
                  )}
                </div>
                <div className="conversation-title">
                  <h1>
                    {channel.name}
                    <span className="type-badge">{channel.kind}</span>
                  </h1>
                  <p>
                    {channel.description ||
                      "A space to keep the conversation going."}
                  </p>
                </div>
                <div className="conversation-actions">
                  <button
                    className="secondary"
                    onClick={() => setModal("meeting")}
                  >
                    <Video size={17} />
                    Meet
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Open conversation in separate window"
                    onClick={() =>
                      window.open(
                        `/?org=${org}&channel=${stream}`,
                        "_blank",
                        "noopener,width=1100,height=800",
                      )
                    }
                  >
                    <ExternalLink size={18} />
                  </button>
                  <button
                    className={`icon-button ${details ? "selected" : ""}`}
                    aria-label="Conversation details"
                    onClick={() => setDetails(!details)}
                  >
                    <PanelRight size={19} />
                  </button>
                </div>
              </header>
              <div className="tabs">
                {[
                  "Posts",
                  "Files",
                  ...(channel.kind === "private" ? ["Tasks", "Forms"] : []),
                ].map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={tab === t ? "active" : ""}
                  >
                    {t}
                  </button>
                ))}
                <span
                  className={`connection ${connection === "Live" ? "live" : ""}`}
                >
                  <i />
                  {connection}
                </span>
              </div>
              <div className="conversation-layout">
                <div className="conversation-body">
                  {tab === "Posts" ? (
                    <>
                      <div className="message-list" aria-label="Messages">
                        <div className="channel-welcome">
                          <div className="welcome-art">
                            <MessageSquare size={29} />
                            <span>✦</span>
                          </div>
                          <h2>Welcome to {channel.name}</h2>
                          <p>
                            {channel.description ||
                              "Share an update, ask a question, or say hello."}
                          </p>
                          <span className="encryption-note">
                            <Shield size={12} />
                            Server-processable messages · E2EE unavailable
                          </span>
                        </div>
                        {hasMore && (
                          <button
                            className="load-more"
                            onClick={() =>
                              (async () => {
                                const d = historySchema.parse(
                                  await api(
                                    `/channels/${stream}/messages?before=${messages[0]?.seq}`,
                                  ),
                                );
                                setMessages((m) => [...d.messages, ...m]);
                                setHasMore(d.hasMore);
                              })().catch(report)
                            }
                          >
                            Load earlier messages
                          </button>
                        )}
                        <div className="date-divider">
                          <span>Conversation history</span>
                        </div>
                        {messages.map((m) => (
                          <article
                            className={`message ${m.user_id === session.user.id ? "own" : ""}`}
                            key={m.id}
                            id={`message-${m.id}`}
                          >
                            <Avatar name={m.name} />
                            <div className="message-content">
                              <div className="message-meta">
                                <strong>{m.name}</strong>
                                <time dateTime={m.created_at}>
                                  {new Date(m.created_at).toLocaleTimeString(
                                    [],
                                    { hour: "2-digit", minute: "2-digit" },
                                  )}
                                </time>
                                {m.edited_at && <small>edited</small>}
                                {m.saved && <Bookmark size={12} />}
                              </div>
                              {m.parent_id && (
                                <div className="reply-reference">
                                  <Reply size={12} />
                                  Reply to{" "}
                                  {messages.find((p) => p.id === m.parent_id)
                                    ?.name ?? "earlier message"}
                                </div>
                              )}
                              {m.deleted ? <><p className="deleted">This message was deleted.</p>{["standard","private","shared"].includes(channel.kind)&&<button aria-label="View report status" onClick={()=>setReporting({channel:stream,id:m.id,deleted:true})}>View report status</button>}</> : <><MessageContent body={m.body} format={m.format} mentions={m.mentions} /><MessageAttachments channelId={stream} attachments={m.attachments} /></>}
                              {!m.deleted && (
                                <div className="message-bottom">
                                  {[
                                    ...new Set(m.reactions.map((r) => r.emoji)),
                                  ].map((emoji) => (
                                    <button
                                      key={emoji}
                                      className="reaction"
                                      aria-label={`React ${emoji}`}
                                      onClick={() =>
                                        perform(() =>
                                          api(
                                            `/channels/${stream}/messages/${m.id}/reactions`,
                                            "POST",
                                            {
                                              emoji,
                                              active: !m.reactions.some(
                                                (r) =>
                                                  r.emoji === emoji &&
                                                  r.userId === session.user.id,
                                              ),
                                            },
                                          ),
                                        )
                                      }
                                    >
                                      {emoji}{" "}
                                      {
                                        m.reactions.filter(
                                          (r) => r.emoji === emoji,
                                        ).length
                                      }
                                    </button>
                                  ))}
                                  {m.user_id === session.user.id && (
                                    <span
                                      className="receipt"
                                      title={
                                        receipts
                                          .filter(
                                            (r) =>
                                              Number(r.seq) >= Number(m.seq) &&
                                              r.user_id !== m.user_id,
                                          )
                                          .map((r) => r.name)
                                          .join(", ") || "Persisted on server"
                                      }
                                    >
                                      {receipts.some(
                                        (r) =>
                                          Number(r.seq) >= Number(m.seq) &&
                                          r.user_id !== m.user_id,
                                      ) ? (
                                        <CheckCheck size={14} />
                                      ) : (
                                        <Check size={14} />
                                      )}
                                      Sent
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                            {!m.deleted && (
                              <div className="message-tools">
                                {["standard","private","shared"].includes(channel.kind)&&<button aria-label="Report message" onClick={()=>setReporting({channel:stream,id:m.id,deleted:m.deleted})}>Report</button>}
                                <button
                                  title="Like message"
                                  aria-label={`Like message by ${m.name}`}
                                  onClick={() =>
                                    perform(() =>
                                      api(
                                        `/channels/${stream}/messages/${m.id}/reactions`,
                                        "POST",
                                        {
                                          emoji: "👍",
                                          active: !m.reactions.some(
                                            (r) =>
                                              r.emoji === "👍" &&
                                              r.userId === session.user.id,
                                          ),
                                        },
                                      ),
                                    )
                                  }
                                >
                                  👍
                                </button>
                                <button
                                  aria-label="Reply to message"
                                  disabled={postingBlocked}
                                  onClick={() => setReply(m)}
                                >
                                  <Reply size={15} />
                                </button>
                                <button
                                  aria-label={
                                    m.saved ? "Unsave message" : "Save message"
                                  }
                                  onClick={() =>
                                    perform(() =>
                                      api(
                                        `/channels/${stream}/messages/${m.id}/save`,
                                        "POST",
                                        { saved: !m.saved },
                                      ),
                                    )
                                  }
                                >
                                  <Bookmark size={15} />
                                </button>
                                <button
                                  aria-label="Copy message link"
                                  onClick={() =>
                                    void navigator.clipboard
                                      .writeText(
                                        `${location.origin}/?org=${org}&channel=${stream}#message-${m.id}`,
                                      )
                                      .catch(report)
                                  }
                                >
                                  <LinkIcon size={15} />
                                </button>
                                {m.user_id === session.user.id && (
                                  <>
                                    <button
                                      aria-label="Edit message"
                                      disabled={postingBlocked}
                                      onClick={() => setModal(`edit:${m.id}`)}
                                    >
                                      <Pencil size={15} />
                                    </button>
                                    <button
                                      aria-label="Delete message"
                                      onClick={() =>
                                        perform(() =>
                                          api(
                                            `/channels/${stream}/messages/${m.id}`,
                                            "DELETE",
                                          ),
                                        )
                                      }
                                    >
                                      <Trash2 size={15} />
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </article>
                        ))}
                        <div ref={listEnd} />
                      </div>
                      <div className="composer-wrap">
                        {postingBlocked&&<p role="status">Only workspace owners and admins can post, reply or edit here. You can keep editing your saved draft.</p>}
                        {messages.length > 0 && (
                          <button
                            className="mark-read"
                            onClick={() =>
                              perform(() =>
                                api(`/channels/${stream}/read`, "POST", {
                                  seq: Number(messages.at(-1)?.seq ?? 0),
                                }),
                              )
                            }
                          >
                            <CheckCheck size={13} />
                            Mark as read
                          </button>
                        )}
                        {reply && (
                          <div className="replying">
                            <Reply size={14} />
                            <span>
                              Replying to {reply.name}:{" "}
                              {reply.body.slice(0, 65)}
                            </span>
                            <button
                              aria-label="Cancel reply"
                              onClick={() => setReply(null)}
                            >
                              <X size={15} />
                            </button>
                          </div>
                        )}
                        {failed && (
                          <div className="failed" role="status">
                            Message not confirmed: {failed.body.slice(0, 80)}.
                            Retrying uses the original message.{" "}
                            <button
                              disabled={sending || !draftReady}
                              onClick={() => send(true)}
                            >
                              Retry safely
                            </button>
                            <button disabled={sending} onClick={discardPending}>
                              Discard retry
                            </button>
                            <span>
                              Discarding does not delete a message already
                              accepted by the server.
                            </span>
                          </div>
                        )}
                        <form
                          className="composer"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void send();
                          }}
                        >
                          <FormattingTools key={stream} value={draft} change={setDraft} input={composerInput} disabled={!draftReady} />
                          <textarea
                            ref={composerInput}
                            aria-label="Message"
                            disabled={!draftReady}
                            placeholder={`Message ${channel.name}…`}
                            value={draft}
                            maxLength={10000}
                            onChange={(e) => {
                              setDraft(e.target.value);
                              if (Date.now() - typingAt.current > 2500) {
                                typingAt.current = Date.now();
                                void api(
                                  `/channels/${stream}/typing`,
                                  "POST",
                                  {},
                                ).catch(() => {});
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void send();
                              }
                            }}
                          />
                          <div className="composer-tools">
                            <button
                              type="button"
                              aria-label="Attach file"
                              disabled={!draftReady || sending || !!failed || postingBlocked}
                              onClick={() => setModal("attachment")}
                            >
                              <Paperclip size={18} />
                            </button>
                            <button
                              type="button"
                              aria-label="Add emoji"
                              onClick={() => setDraft((d) => d + " 👋")}
                            >
                              <Smile size={18} />
                            </button>
                            <button
                              type="button"
                              aria-label="Mention a person"
                              onClick={() => setModal("mention")}
                            >
                              <AtSign size={18} />
                            </button>
                            <span>Shift + Enter for a new line</span>
                            <button
                              className="send-button"
                              aria-label="Send message"
                              type="submit"
                              disabled={
                                postingBlocked ||
                                !draftReady ||
                                !draft.trim() ||
                                sending ||
                                !!failed
                              }
                            >
                              {sending ? (
                                <RefreshCw size={17} />
                              ) : (
                                <Send size={17} />
                              )}
                            </button>
                          </div>
                        </form>
                        <div className="typing" role="status">
                          {typing.length
                            ? `${typing.join(", ")} typing…`
                            : draft
                              ? "Draft saved to server after a short pause."
                              : "Keep the conversation moving."}
                        </div>
                      </div>
                    </>
                  ) : tab === "Files" ? (
                    <FilesPanel key={stream} userId={session.user.id} stream={stream} report={report} />
                  ) : (
                    <WorkPanel
                      key={stream + tab}
                      stream={stream}
                      tab={tab}
                      people={boot?.people ?? []}
                      userId={session.user.id}
                      report={report}
                    />
                  )}
                </div>
                {details && (
                  <aside className="details">
                    <h3>About this space</h3>
                    <p>{channel.description}</p>
                    <div className="detail-label">VISIBILITY</div>
                    <p>{channel.kind} channel</p>
                    <button
                      className="secondary"
                      onClick={() =>
                        perform(() =>
                          api(`/channels/${stream}/preferences`, "PATCH", {
                            pinned: !channel.pinned,
                            muted: channel.muted,
                            hidden: channel.hidden,
                          }),
                        )
                      }
                    >
                      <Pin size={15} />
                      {channel.pinned ? "Unpin" : "Pin"} conversation
                    </button>
                    <button
                      className="secondary"
                      onClick={() =>
                        perform(() =>
                          api(`/channels/${stream}/preferences`, "PATCH", {
                            pinned: channel.pinned,
                            muted: !channel.muted,
                            hidden: channel.hidden,
                          }),
                        )
                      }
                    >
                      <VolumeX size={15} />
                      {channel.muted ? "Unmute" : "Mute"}
                    </button>
                    <h3>Workspace directory</h3>
                    {boot?.people.map((p) => (
                      <div className="person" key={p.id}>
                        <Avatar name={p.name} small />
                        <div>
                          <strong>{p.name}</strong>
                          <small>
                            {p.presence} · {p.role}
                          </small>
                        </div>
                      </div>
                    ))}
                    {["admin", "owner"].includes(boot?.role ?? "") && (
                      <>
                        {["standard","private","shared"].includes(channel.kind)&&<PostingPolicy channel={channel} onSaved={refresh}/>}
                        <button
                          className="secondary"
                          onClick={() => setModal("migration")}
                        >
                          Convert or move channel
                        </button>
                        <button
                          className="secondary"
                          onClick={() => setView("Admin")}
                        >
                          Audit history
                        </button>
                      </>
                    )}
                    <h3>Read receipts</h3>
                    {receipts.map((r) => (
                      <p key={r.user_id}>
                        {r.name} · through message {r.seq}
                      </p>
                    ))}
                  </aside>
                )}
              </div>
            </>
          ) : (
            <Empty title="Your next conversation starts here">
              Create a team or start a direct message.
            </Empty>
          )
        ) : view === "Calendar" ? (
          <CalendarPanel
            key={org}
            org={org}
            people={boot?.people ?? []}
            userId={session.user.id}
            report={report}
          />
        ) : view === "Invitations" ? (
          <><div className="page-heading"><h1>Your invitations</h1></div><div className="content-pad"><InvitationInbox onSave={refreshSession} /></div></>
        ) : view === "Settings" ? (
          <SettingsPanel
            session={session}
            onSave={refreshSession}
            report={report}
          />
        ) : view === "Files" ? (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">YOUR WORKSPACE</span>
                <h1>Files</h1>
                <p>Files are secured by their conversation’s permissions.</p>
              </div>
            </div>
            {stream ? (
              <FilesPanel key={stream} userId={session.user.id} stream={stream} report={report} />
            ) : (
              <Empty title="Choose a channel">
                Open a conversation to manage its files.
              </Empty>
            )}
          </>
        ) : view === "Activity" ? (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">STAY IN THE LOOP</span>
                <h1>Your activity</h1>
                <p>Catch up on unread conversations or messages mentioning you.</p>
                <label>Activity filter<select value={activityFilter} onChange={e=>setActivityFilter(e.target.value as "unread" | "mentions" | "replies")}><option value="unread">Unread messages</option><option value="mentions">Mentions of me</option><option value="replies">Replies to me</option></select></label>
              </div>
              <Bell size={28} />
            </div>
            <div className="content-pad">
              {activity.length ? (
                activity.map((a) => (
                  <div className="result-card" key={a.id}>
                    <strong>
                      {a.author} <small>in #{a.channel_name}</small>
                    </strong>
                    {a.mentioned && <span className="mention">Mentioned you</span>}
                    {a.replied && <span className="mention">Replied to you</span>}
                    <MessageContent body={a.body} format={a.format} mentions={a.mentions} />
                    <button onClick={() => select(a.channel_id)}>Open conversation</button>
                  </div>
                ))
              ) : (
                <Empty title="You’re all caught up">
                  New messages in your conversations will appear here.
                </Empty>
              )}
            </div>
          </>
        ) : view === "Calls" ? (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">BETTER FACE TO FACE</span>
                <h1>Calls</h1>
                <p>Browser calling and meetings</p>
              </div>
            </div>
            <div className="content-pad">
              <Unavailable title="Media service not configured">
                Calling, screen sharing, breakout rooms, recording, advanced
                audio/video, and diagnostics require the LiveKit integration and
                independent-device verification. These capabilities are not
                implemented in this release.
              </Unavailable>
              <Unavailable title="Telephony not configured">
                Queues and PSTN merging require a supported SIP/PSTN provider,
                phone numbers, and billing authorization.
              </Unavailable>
            </div>
          </>
        ) : view === "Admin" ? (
          <>
            <div className="page-heading">
              <h1>Workspace administration</h1>
            </div>
            <div className="content-pad">
              <Unavailable title="Governance controls are incomplete">
                Retention, legal holds, full user/workspace export, closure, general
                policy administration and tamper-resistant audit archival are not available yet.
              </Unavailable>
              <UsageReport key={`usage:${org}`} org={org}/>
              <ModerationPanel key={`reports:${org}`} org={org}/>
              <MembershipPanel
                key={org}
                org={org}
                people={boot?.people ?? []}
                refresh={refresh}
                report={report}
              />
              <AuditSearch key={`audit:${org}`} org={org} people={boot?.people??[]}/>
            </div>
          </>
        ) : (
          <Help
            org={org}
            report={report}
            clearRetries={() => {
              clearPending(window.sessionStorage);
              setFailed(null);
              setError("");
            }}
          />
        )}
      </main>
      {reporting&&<MessageReportDialog key={reporting.id} channel={reporting.channel} id={reporting.id} deleted={reporting.deleted} onClose={()=>setReporting(null)}/>}
      {modal && (
        <Modal
          title={
            modal.startsWith("edit:")
              ? "Edit message"
              : modal === "migration"
                ? "Review channel access"
                : modal === "attachment"
                  ? "Send a file"
                : modal === "mention"
                  ? "Mention someone"
                  : modal === "meeting"
                    ? "Meet in this channel"
                    : modal === "team"
                      ? "Create a team"
                      : modal === "channel"
                        ? "Create a channel"
                        : "Start a conversation"
          }
          onClose={() => setModal("")}
        >
          {modal === "meeting" ? (
            <Unavailable title="Meetings are unavailable">
              A real media provider must be configured and verified before you
              can join. You can schedule local meetings in Calendar.
            </Unavailable>
          ) : modal === "attachment" ? (
            <AttachmentPicker key={stream} channelId={stream} select={(id)=>{setModal("");void send(false,[id]);}} openFiles={()=>{setModal("");setTab("Files");}} />
          ) : modal === "mention" ? (
            <MentionPicker key={stream} channelId={stream} select={(person)=>{
              const label = person.name.replace(/[\\`*_[\]<>]/g, "\\$&");
              const next = draft + `[@${label}](concord-mention:${person.id}) `;
              if (next.length > 10000) { report(new Error("Mention would exceed the message character limit.")); return; }
              setDraft(next); setModal("");
            }} />
          ) : modal === "migration" && channel ? (
            <MigrationPanel
              channel={channel}
              teams={boot?.teams ?? []}
              people={boot?.people ?? []}
              onDone={() => {
                setModal("");
                void refresh();
              }}
              report={report}
            />
          ) : modal.startsWith("edit:") ? (
            <EditMessage
              message={messages.find((m) => m.id === modal.slice(5))!}
              save={(body, format) =>
                perform(async () => {
                  await api(
                    `/channels/${stream}/messages/${modal.slice(5)}`,
                    "PATCH",
                    { body, format },
                  );
                  setModal("");
                })
              }
            />
          ) : (
            <CreateConversation
              mode={modal}
              org={org}
              boot={boot}
              userId={session.user.id}
              onDone={(id) => {
                setModal("");
                void refresh();
                if (id) select(id);
              }}
              report={report}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
function ChannelButton({
  channel: c,
  active,
  onClick,
}: {
  channel: Channel;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`channel-button ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {c.kind === "private" ? (
        <Lock size={15} />
      ) : !c.team_id ? (
        <MessageSquare size={15} />
      ) : (
        <Hash size={17} />
      )}
      <span>{c.name}</span>
      {c.muted && <VolumeX size={12} />}{" "}
      {!!c.unread && <b>{c.unread > 99 ? "99+" : c.unread}</b>}
    </button>
  );
}
function Login({
  onSuccess,
  error,
  onError,
}: {
  onSuccess: () => Promise<void>;
  error: string;
  onError: (e: unknown) => void;
}) {
  const [email, setEmail] = useState("alice@acme.test"),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [dev, setDev] = useState(false);
  useEffect(() => {
    void api<{ developmentAuth: boolean }>("/capabilities")
      .then((c) => setDev(c.developmentAuth))
      .catch(onError);
  }, [onError]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/session", "POST", { email, password });
      await onSuccess();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-story">
        <div className="brand">
          <span className="brand-icon">c</span>concord.
        </div>
        <div>
          <span className="eyebrow">GREAT WORK HAPPENS TOGETHER</span>
          <h1>
            Your people.
            <br />
            Your ideas.
            <br />
            <em>One shared space.</em>
          </h1>
          <p>Make room for conversations that move things forward.</p>
        </div>
        <span>CONVERSATIONS · CONNECTION · COLLABORATION</span>
      </section>
      <section className="login-form">
        <span className="eyebrow">WELCOME TO CONCORD</span>
        <h2>A little more connected.</h2>
        <p>Sign in to your team’s workspace.</p>
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        <form onSubmit={submit}>
          <label>
            Email address
            <input
              autoComplete="username"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="primary" disabled={busy || !dev}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <a className="secondary sso" href={`${API}/v1/auth/login`}>
          <Shield size={17} />
          Enterprise sign-in
        </a>
        {dev && (
          <div className="dev-note">
            <strong>Development environment</strong>
            <p>
              Seed accounts: alice@acme.test, bob@acme.test, eve@northstar.test,
              guest@partner.test
            </p>
            <p>Password: Development123!</p>
            <small>
              Local accounts are development-only. Enterprise recovery and MFA
              are managed by your identity provider.
            </small>
          </div>
        )}
      </section>
    </main>
  );
}
function EditMessage({
  message,
  save,
}: {
  message: Message;
  save: (body: string, format: Message["format"]) => Promise<void>;
}) {
  const [body, setBody] = useState(message.body);
  const [format, setFormat] = useState(message.format);
  const input = useRef<HTMLTextAreaElement>(null);
  return (
    <form
      className="modal-body"
      onSubmit={(e) => {
        e.preventDefault();
        void save(body, format);
      }}
    >
      <label>Message format<select value={format} onChange={(e)=>setFormat(e.target.value as Message["format"])}><option value="plain">Plain text</option><option value="markdown-v1">Markdown formatting</option></select></label>
      {format === "markdown-v1" && <FormattingTools value={body} change={setBody} input={input} />}
      <label>
        Message
        <textarea
          ref={input}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          maxLength={10000}
        />
      </label>
      <button className="primary">Save changes</button>
    </form>
  );
}
function CreateConversation({
  mode,
  org,
  boot,
  userId,
  onDone,
  report,
}: {
  mode: string;
  org: string;
  boot: Bootstrap | null;
  userId: string;
  onDone: (id?: string) => void;
  report: (e: unknown) => void;
}) {
  const [name, setName] = useState(""),
    [kind, setKind] = useState(mode === "conversation" ? "direct" : "standard"),
    [team, setTeam] = useState(boot?.teams[0]?.id ?? ""),
    [members, setMembers] = useState<string[]>([]),
    [description, setDescription] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (mode === "team") {
        await api(`/organizations/${org}/teams`, "POST", { name });
        onDone();
        return;
      }
      const r = await api<{ id: string }>(
        `/organizations/${org}/channels`,
        "POST",
        {
          name,
          description,
          kind,
          teamId: mode === "conversation" ? null : team,
          members,
        },
      );
      onDone(r.id);
    } catch (e) {
      report(e);
    }
  }
  return (
    <form className="modal-body" onSubmit={submit}>
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={160}
        />
      </label>
      {mode !== "team" && (
        <>
          <label>
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {(mode === "conversation"
                ? ["direct", "group"]
                : ["standard", "private", "shared"]
              ).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          {mode === "channel" && (
            <label>
              Team
              <select
                value={team}
                onChange={(e) => setTeam(e.target.value)}
                required
              >
                <option value="">Choose a team</option>
                {boot?.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Description
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {kind !== "standard" && (
            <fieldset>
              <legend>Participants</legend>
              {boot?.people
                .filter((p) => p.id !== userId)
                .map((p) => (
                  <label className="check-label" key={p.id}>
                    <input
                      type="checkbox"
                      checked={members.includes(p.id)}
                      onChange={(e) =>
                        setMembers((m) =>
                          e.target.checked
                            ? [...m, p.id]
                            : m.filter((x) => x !== p.id),
                        )
                      }
                    />
                    {p.name}
                  </label>
                ))}
            </fieldset>
          )}
        </>
      )}
      <button className="primary">
        Create{" "}
        {mode === "team"
          ? "team"
          : mode === "channel"
            ? "channel"
            : "conversation"}
      </button>
    </form>
  );
}
function Help({
  org,
  report,
  clearRetries,
}: {
  org: string;
  report: (e: unknown) => void;
  clearRetries: () => void;
}) {
  const [body, setBody] = useState(""),
    [sent, setSent] = useState("");
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">HERE TO HELP</span>
          <h1>Make yourself at home</h1>
          <p>
            Conversations keep your team connected. Private channels keep
            project work focused.
          </p>
        </div>
      </div>
      <div className="content-pad help-grid">
        <section className="card">
          <h2>Getting started</h2>
          <p>
            Pick a channel to post updates, reply, react, or share a link. Use
            the + buttons to create a team or channel. Private channels have
            task boards and forms.
          </p>
          <p>
            Read receipts update when you choose “Mark as read”. Drafts sync to
            the server. Keep an offline window open until it reconnects.
          </p>
          <h3>Message recovery</h3>
          <p>
            Unconfirmed sends are kept in this tab until acknowledged,
            discarded, or signed out. Reloading preserves the original retry
            identifier. Closing the tab or clearing browser storage can remove
            them. These local records contain unencrypted message text.
          </p>
          <button
            className="secondary"
            onClick={() => {
              try {
                clearRetries();
                setSent(
                  "Local retry records cleared. Server messages are unchanged.",
                );
              } catch (e) {
                report(e);
              }
            }}
          >
            Clear all local pending sends
          </button>
          <h3>Service status</h3>
          <Unavailable title="Limited local development release">
            Messaging and work management use a real database. Enterprise
            providers, encryption, media, governance, and production operations
            are incomplete. No production availability or security certification
            is claimed.
          </Unavailable>
        </section>
        <form
          className="card"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api<{ id: string }>(
                `/organizations/${org}/feedback`,
                "POST",
                { body },
              );
              setSent(r.id);
              setBody("");
            } catch (e) {
              report(e);
            }
          }}
        >
          <h2>Share feedback</h2>
          <label>
            What could be better?
            <textarea
              required
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={4000}
            />
          </label>
          <button className="primary">Send feedback</button>
          {sent && <p role="status">Feedback saved. Reference {sent}</p>}
        </form>
      </div>
    </>
  );
}
