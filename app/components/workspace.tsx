"use client";
import {clearMeetingPending} from '@/lib/pending-call-chat';
import {MediaWorkspace,type MediaCallIntent} from "./media-workspace";
import {MessageReaders} from "./message-readers";
import {MessageReadStatus,useReadReceipts} from "./read-status";
import {sequenceBefore} from "@/lib/message-sequence";
import {ActivityFeed} from "./activity-feed";
import {PresenceProvider,ProfilePresence} from "./presence-provider";
import {ConversationVisibility,HiddenConversations} from "./conversation-visibility";
import {SavedMessages} from "./saved-messages";
import {readFileLink,type FileLinkTarget} from "@/lib/file-link";
import {LinkedFile} from "./linked-file";
import {LinkedMessage} from "./linked-message";
import {messageLink,readMessageLink,type MessageLinkTarget} from "@/lib/message-link";
import {WorkspaceSearch} from "./workspace-search";
import {FileRetention} from "./file-retention";
import {MessageRetention} from "./message-retention";
import {ChannelPreservation} from "./channel-preservation";
import {AuditSearch} from "./audit-search";
import {ChatManagement} from "./chat-management";
import {UsageReport} from "./usage-report";
import {MessageReportDialog,ModerationPanel} from "./moderation";
import {ChannelAccess} from "./channel-access";
import {ChannelSettings} from "./channel-settings";
import {PostingPolicy} from "./posting-policy";
import {MeetingReminders} from "./meeting-reminders";
import { InvitationInbox, InvitationNotice } from "./invitation-inbox";
import { BrowserMentionAlerts } from "./notifications";
import {ReplyDraft,useReplyDraft} from "./reply-draft";
import {acknowledgeDraftReply,retainReplyIdentity,setDraftReply} from "@/lib/draft-replies";
import {AttachmentDraft,useAttachmentDraft} from "./attachment-draft";
import {acknowledgeDraftAttachments,retainAttachmentIdentity} from "@/lib/draft-attachments";
import { AttachmentPicker, MessageAttachments } from "./attachments";
import { MentionPicker } from "./mention-picker";
import { MessageContent, FormattingTools } from "./message-content";
/* Remote snapshots and live subscriptions intentionally reset state on resource changes.
   This prevents showing the previous resource while asynchronous requests are pending. */
/* eslint-disable react-hooks/set-state-in-effect */
import {
  useState,
  useId,
  useEffect,
  useCallback,
  useRef,
  type FormEvent,
  type SetStateAction,
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
  | "Saved"
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
  ["Saved", Bookmark],
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
    [draftLoadError, setDraftLoadError] = useState(""),
    [draftLoadAttempt, setDraftLoadAttempt] = useState(0),
    [connection, setConnection] = useState("Connecting"),
    [sending, setSending] = useState(false),
    [failed, setFailed] = useState<PendingMessage | null>(null),
    [typing, setTyping] = useState<string[]>([]),
    [filter, setFilter] = useState(""),
    [listFilter,setListFilter]=useState<"all"|"unread"|"pinned"|"muted">("all"),
    [search, setSearch] = useState(""),
    [results, setResults] = useState<{query:string;run:number}|null>(null),
    [modal, setModal] = useState(""),
    [details, setDetails] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [activityFilter, setActivityFilter] = useState<"unread" | "mentions" | "replies">("unread");
  const attachmentDraft=useAttachmentDraft(session?.user.id??"",org,stream);
  const replyDraft=useReplyDraft(session?.user.id??"",org,stream);
  useEffect(()=>{setModal(value=>value==="mention"?"":value);},[org,stream,session?.user.id]);
  const [mediaIntent,setMediaIntent]=useState<MediaCallIntent|null>(null);
  const [readerTarget,setReaderTarget]=useState<{key:string;id:string}|null>(null);
  useEffect(()=>setReaderTarget(null),[session?.user.id,org,stream,view,tab]);
  const [linkedMessage,setLinkedMessageTarget]=useState<MessageLinkTarget|null>(null);
  const [sourceTrail,setSourceTrail]=useState<{key:string;items:MessageLinkTarget[]}>({key:'',items:[]});
  const setLinkedMessage=useCallback((value:SetStateAction<MessageLinkTarget|null>)=>{
    setSourceTrail({key:'',items:[]});setLinkedMessageTarget(value);
  },[]);
  const [linkedFile,setLinkedFile]=useState<FileLinkTarget|null>(null);
  const [hiddenOpen,setHiddenOpen]=useState(false);
  const [previewsUnavailable,setPreviewsUnavailable]=useState(false);
  const bootstrapRequest=useRef(0);
  const selectionRequest=useRef(0);
  const cancelActivityNavigation=useCallback(()=>{selectionRequest.current++;},[]);
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
  const draftRead = useRef<AbortController | null>(null);
  const latestDraft = useRef(draft);
  useEffect(() => {
    latestDraft.current = draft;
  }, [draft]);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const emojiLimitId = useId();
  const emojiText = " 👋";
  const emojiFits = draft.length + emojiText.length <= 10000;
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
    setLinkedMessage(null);setLinkedFile(null);setHiddenOpen(false);
    selectionRequest.current++;
    setSession(null);
    setBoot(null);
    setPreviewsUnavailable(false);
    setFilter("");setListFilter("all");
    setOrg("");
    setStream("");
    setMessages([]);
    setDraft("");
    setDraftReady(false);
    setFailed(null);
    setResults(null);
    setActivityFilter("unread");
    setTyping([]);
  }, [setLinkedMessage]);
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
  const readStatus=useReadReceipts(session?.user.id??"",org,stream,view==="Chat"&&(tab==="Posts"||details),report);
  const refreshSession = useCallback(async () => {
    try {
      const s = sessionSchema.parse(await api("/session"));
      try {
        retainIdentity(window.sessionStorage, s.user.id);
        retainAttachmentIdentity(window.sessionStorage,s.user.id);
        retainReplyIdentity(window.sessionStorage,s.user.id);
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
  const refresh = useCallback(async (signal?:AbortSignal) => {
    if (!org) return;
    const user=identityRef.current,request=++bootstrapRequest.current;
    const current=()=>orgRef.current===org&&identityRef.current===user&&bootstrapRequest.current===request;
    try {
      const b = await api<Bootstrap>(`/organizations/${org}/bootstrap`,"GET",undefined,signal??AbortSignal.timeout(8000));
      if (!current()) return;
      setBoot(b);
      setPreviewsUnavailable(false);
      setStream((s) =>
        b.channels.some((c) => c.id === s) ? s : (b.channels[0]?.id ?? ""),
      );
    } catch(e) {
      if (current()) {
        setBoot(previous=>previous?{...previous,channels:previous.channels.map(c=>({...c,preview:null}))}:previous);
        setPreviewsUnavailable(true);
      }
      throw e;
    }
  }, [org]);
  const history = useCallback(async () => {
    if (!stream) return;
    const data = historySchema.parse(await api(`/channels/${stream}/messages`));
    if (streamRef.current !== stream) return;
    setMessages((previous) => {
      const fresh = new Map(data.messages.map((m) => [m.id, m]));
      return [
        ...previous.filter(
          (m) => sequenceBefore(m.seq,data.messages[0]?.seq ?? "0"),
        ),
        ...fresh.values(),
      ];
    });
    setHasMore(data.hasMore);
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
    latestDraft.current = "";
    setDraftReady(false);
    setDraft("");
    setMessages([]);
    setFailed(null);
    try {
      setFailed(
        pendingFor(window.sessionStorage, session.user.id, org, stream),
      );
    } catch (e) {
      report(e);
    }
    void history().catch(report);
    let stopped = false;
    setConnection("Connecting");
    let source: EventSource;
    let cursor = "0";
    let hydrateTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const stop = () => {
      stopped = true;
      draftRead.current?.abort();
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
          clearMeetingPending(window.sessionStorage);
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
    if (!stream || !session || !org) return;
    const controller = new AbortController();
    draftRead.current = controller;
    let active = true;
    const current = () => active && draftRead.current === controller && streamRef.current === stream && orgRef.current === org && identityRef.current === session.user.id;
    draftLoaded.current = false;
    latestDraft.current = "";
    setDraft("");
    setDraftReady(false);
    setDraftLoadError("");
    const deadline = setTimeout(() => controller.abort(new DOMException("Saved draft loading timed out. Retry loading it.", "TimeoutError")), 8000);
    void api<unknown>(`/channels/${stream}/draft`, "GET", undefined, controller.signal)
      .then((result) => {
        if (!current() || controller.signal.aborted) return;
        if (!result || typeof result !== "object" || !("body" in result) || typeof result.body !== "string" || result.body.length > 10000) throw new Error("Saved draft response was invalid. Retry loading it.");
        // A live-open callback may run before React's passive ref update.
        latestDraft.current = result.body;
        setDraft(result.body);
        draftLoaded.current = true;
        setDraftReady(true);
      })
      .catch((e) => {
        if (!current() || (controller.signal.aborted && controller.signal.reason?.name !== "TimeoutError")) return;
        if (e instanceof ApiError && e.status === 401) { report(e); return; }
        setDraftLoadError(controller.signal.reason?.name === "TimeoutError" ? "Saved draft loading timed out. Retry loading it." : "Saved draft could not be loaded. Retry loading it to continue.");
      })
      .finally(() => clearTimeout(deadline));
    return () => { active = false; clearTimeout(deadline); controller.abort(); if (draftRead.current === controller) draftRead.current = null; };
  }, [stream, org, session, report, draftLoadAttempt]);
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
    const event = new BroadcastChannel("concord-session");
    event.onmessage = (e) => {
      if (e.data === "logout") {
        try {
          clearPending(window.sessionStorage);
          clearMeetingPending(window.sessionStorage);
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
          clearMeetingPending(window.sessionStorage);
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
  async function send(retry = false) {
    if (!session || !stream || !org || sending || !draftReady || (!retry&&(!attachmentDraft.ready||!replyDraft.ready)) || (postingBlocked&&!retry) || channel?.archived) return;
    const destination = stream;
    const tenant = org;
    const attachmentIds=attachmentDraft.files.map(file=>file.id);
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
        body: draft.trim() || (attachmentIds.length ? attachmentIds.length===1?"Shared a file.":"Shared files." : ""),
        attachmentIds,
        format: "markdown-v1",
        parentId: replyDraft.id,
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
      let attachmentCleanupError:unknown;
      try{acknowledgeDraftAttachments(window.sessionStorage,{userId:item.userId,orgId:item.orgId,channelId:item.channelId},item.attachmentIds??[]);}
      catch(e){attachmentCleanupError=e;}
      let replyCleanupError:unknown;
      try{acknowledgeDraftReply(window.sessionStorage,{userId:item.userId,orgId:item.orgId,channelId:item.channelId},item.parentId);}
      catch(e){replyCleanupError=e;}
      if (current()) {
        if(replyCleanupError)replyDraft.invalidate(replyCleanupError);else replyDraft.reload();
        if(attachmentCleanupError)attachmentDraft.invalidate(attachmentCleanupError);else attachmentDraft.reload();
        setFailed(null);
        setError("");
        if (latestDraft.current.trim() === item.body || (!latestDraft.current.trim() && item.attachmentIds?.length && ["Shared a file.","Shared files."].includes(item.body))) {
          latestDraft.current = "";
          setDraft("");
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
  async function select(c: string, nextTab: "Posts" | "Files" = "Posts", preparation?:{signal:AbortSignal;commit:()=>void}) {
    const request=++selectionRequest.current,user=session?.user.id;
    if (stream && c !== stream && draftLoaded.current) {
      try {
        await api(`/channels/${stream}/draft`, "PUT", { body: draft },preparation?.signal);
      } catch (e) {
        if(!preparation?.signal.aborted)report(e);
        return false;
      }
    }
    if(selectionRequest.current!==request||orgRef.current!==org||identityRef.current!==user||preparation?.signal.aborted)return false;
    preparation?.commit();
    streamRef.current = c;
    setStream(c);
    setView("Chat");
    setTab(nextTab);
    setResults(null);
    setMobileNav(false);
    window.history.replaceState(null, "", `/?org=${org}&channel=${c}`);
    return true;
  }
  async function replyToSource(target:MessageLinkTarget,signal:AbortSignal){
    const user=session?.user.id,destination=boot?.channels.find(c=>c.id===target.channel);
    if(!user||target.org!==org||identityRef.current!==user||orgRef.current!==org||signal.aborted)return false;
    if(!destination||destination.archived)throw new Error('This conversation is unavailable for replies.');
    if(destination.posting_restricted&&!["owner","admin"].includes(boot?.role??""))throw new Error('Posting is restricted in this conversation.');
    if(sending||failed)throw new Error('Resolve the unconfirmed message before changing reply targets.');
    const commit=()=>{
      if(pendingFor(window.sessionStorage,user,org,target.channel)||stream&&pendingFor(window.sessionStorage,user,org,stream))throw new Error('Resolve the unconfirmed message before changing reply targets.');
      if(target.channel===stream)replyDraft.select(target.id);
      else setDraftReply(window.sessionStorage,{userId:user,orgId:org,channelId:target.channel},target.id);
    };
    return select(target.channel,"Posts",{signal,commit});
  }
  useEffect(() => {
    if (boot) {
      const deep = new URLSearchParams(window.location.search).get("channel");
      if (deep && boot.channels.some((c) => c.id === deep)) {
        setStream(deep);
      }
    }
  }, [boot]);
  useEffect(()=>{
    const sync=(event?:HashChangeEvent)=>{
      const href=event?.newURL??window.location.href;
      if(event){
        const next=new URL(href),current=new URL(window.location.href);
        if(next.origin!==current.origin||next.pathname!==current.pathname||next.search!==current.search)return;
        // Keep Next's canonical URL in step with native hash navigation, including a pending close.
        window.history.replaceState(null,'',href);
      }
      const message=readMessageLink(href),file=readFileLink(href);
      setLinkedMessage(message&&message.org===org?message:null);setLinkedFile(file&&file.org===org?file:null);
    };
    sync();window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);
  },[org,session?.user.id,setLinkedMessage]);
  function closeLinkedFile(target:FileLinkTarget){
    setLinkedFile(current=>current?.org===target.org&&current.channel===target.channel&&current.id===target.id?null:current);
    const link=readFileLink(window.location.href);
    if(link?.org===target.org&&link.channel===target.channel&&link.id===target.id)window.history.replaceState(null,'',window.location.pathname+window.location.search);
  }
  function closeLinkedMessage(target:MessageLinkTarget){
    selectionRequest.current++;
    setLinkedMessage(current=>current?.org===target.org&&current.channel===target.channel&&current.id===target.id?null:current);
    const link=readMessageLink(window.location.href);
    if(link?.org===target.org&&link.channel===target.channel&&link.id===target.id)window.history.replaceState(null,'',window.location.pathname+window.location.search);
  }
  function navigateMessageSource(next:MessageLinkTarget){
    const current=readMessageLink(window.location.href);
    setLinkedMessageTarget(next);
    if(current?.org===next.org&&current.channel===next.channel)window.history.replaceState(null,"",messageLink(window.location.origin,next));
  }
  function visitMessageSource(id:string){
    if(!linkedMessage||linkedMessage.id===id)return;
    const previous=linkedMessage,key=`${identityRef.current}:${orgRef.current}`;
    setSourceTrail(trail=>{
      const items=trail.key===key?trail.items:[],last=items.at(-1);
      return {key,items:last?.org===previous.org&&last.channel===previous.channel&&last.id===previous.id?items:[...items.slice(-31),{org:previous.org,channel:previous.channel,id:previous.id}]};
    });
    navigateMessageSource({...previous,id});
  }
  function previousMessageSource(){
    const previous=sourceTrail.items.at(-1),key=`${identityRef.current}:${orgRef.current}`;
    if(sourceTrail.key!==key||!linkedMessage||!previous||previous.org!==orgRef.current||previous.channel!==linkedMessage.channel)return;
    setSourceTrail({key,items:sourceTrail.items.slice(0,-1)});navigateMessageSource(previous);
  }
  function searchAll(e: FormEvent) {
    e.preventDefault();
    const query=search.trim();if(!query)return;
    setResults(previous=>({query,run:(previous?.run??0)+1}));
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
      (c) => !c.hidden && c.name.toLowerCase().includes(filter.toLowerCase()) &&
        (listFilter==="all"||(listFilter==="unread"?c.unread>0:listFilter==="pinned"?c.pinned:c.muted)),
    ) ?? [];
  return (
    <PresenceProvider org={org} userId={session.user.id}><div className="application">
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
            placeholder="Search messages or filenames"
            maxLength={200}
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
          <ProfilePresence name={session.user.name} onOpen={()=>setView("Settings")}/>
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
      <aside id="conversation-sidebar" className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
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
                selectionRequest.current++;
                setLinkedMessage(null);setLinkedFile(null);setHiddenOpen(false);
                setOrg(destination);
                setBoot(null);
                setPreviewsUnavailable(false);
                setFilter("");setListFilter("all");
                setStream("");
                setMessages([]);
                setDraft("");
                setResults(null);
                setActivityFilter("unread");
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
          <button className="icon-button sidebar-close" aria-label="Close conversations" onClick={()=>setMobileNav(false)}><X size={18}/></button>
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
        <label className="conversation-list-filter">Show conversations
          <select aria-label="Conversation list filter" value={listFilter} onChange={e=>setListFilter(e.target.value as typeof listFilter)}>
            <option value="all">All conversations</option><option value="unread">Unread conversations</option><option value="pinned">Pinned conversations</option><option value="muted">Muted conversations</option>
          </select>
        </label>
        {(filter!==""||listFilter!=="all")&&<>
          {boot&&visible.length===0&&<p className="sidebar-hint" role="status">No matching conversations.</p>}
          <button className="sidebar-link" onClick={()=>{setFilter("");setListFilter("all");}}>Clear conversation filters</button>
        </>}
        <button className="sidebar-link" onClick={()=>void refresh().catch(report)}><RefreshCw size={16}/>Refresh conversations</button>
        {previewsUnavailable&&<p className="sidebar-hint" role="status">Conversation previews unavailable. Refresh conversations to retry.</p>}
        <button className="sidebar-link" onClick={() => setView("Activity")}>
          <Bell size={16} />
          Unread activity
          <span>{boot?.channels.reduce((n, c) => n + c.unread, 0) || ""}</span>
        </button>
        <button className="sidebar-link" onClick={()=>setHiddenOpen(true)}>Hidden conversations <span>{boot?.channels.filter(c=>c.hidden).length||""}</span></button>
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
        {visible.some(c=>c.team_id&&!(boot?.teams??[]).some(t=>t.id===c.team_id))&&<><div className="section-label">OTHER CHANNELS</div>{visible.filter(c=>c.team_id&&!(boot?.teams??[]).some(t=>t.id===c.team_id)).map(c=><ChannelButton key={c.id} channel={c} active={stream===c.id&&view==="Chat"} onClick={()=>select(c.id)}/>)}</>}
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
        {filter===""&&listFilter==="all"&&!visible.some((c) => !c.team_id) && (
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
        <MediaWorkspace key={`${session.user.id}:${org}`} org={org} userId={session.user.id} channels={boot?.channels??[]} people={boot?.people??[]} visible={view==="Calls"} onShow={()=>setView("Calls")} intent={mediaIntent}/>
        <MeetingReminders key={org} org={org}/>
        <div className="mobile-toolbar">
          <button
            onClick={() => setMobileNav(!mobileNav)}
            aria-label="Toggle conversations"
            aria-expanded={mobileNav}
            aria-controls="conversation-sidebar"
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
          <WorkspaceSearch key={`${org}:${results.run}`} org={org} orgName={orgName} query={results.query} channels={boot?.channels??[]} onClose={()=>setResults(null)} onOpen={(id,kind,message)=>{if(kind==='messages'&&message)setLinkedMessage({org,channel:id,id:message});else if(kind==='files'&&message)setLinkedFile({org,channel:id,id:message});else void select(id,kind==='files'?'Files':'Posts');}}/>
        ) : view === "Teams" ? (
          <TeamsPanel
            key={org}
            org={org}
            people={boot?.people??[]}
            userId={session.user.id}
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
                    onClick={() => {setMediaIntent({channelId:stream,key:crypto.randomUUID()});setView("Calls");}}
                  >
                    <Video size={17} />
                    Meet
                  </button>
                  <button className="secondary media-launch" aria-label="Audio call" onClick={()=>{setMediaIntent({channelId:stream,key:crypto.randomUUID(),mode:"audio",start:true});setView("Calls");}}><Phone size={17}/><span>Audio call</span></button>
                  <button className="secondary media-launch" aria-label="Video call" onClick={()=>{setMediaIntent({channelId:stream,key:crypto.randomUUID(),mode:"video",start:true});setView("Calls");}}><Video size={17}/><span>Video call</span></button>
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
                        {readStatus.error&&<section aria-label="Read status"><p role="alert">{readStatus.error}</p><button className="secondary" onClick={readStatus.retry}>Retry read status</button></section>}
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
                                  {!m.deleted&&<button className="reply-source" onClick={()=>{if(m.parent_id){setLinkedFile(null);setLinkedMessage({org,channel:stream,id:m.parent_id});}}}>View replied-to message</button>}
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
                                    <><MessageReadStatus sequence={m.seq} authorId={m.user_id} receipts={readStatus.receipts} error={readStatus.error}/><button className="reply-source" onClick={()=>setReaderTarget({key:`${session.user.id}:${org}:${stream}`,id:m.id})}>View message readers</button></>
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
                                  disabled={postingBlocked || channel.archived || sending || !!failed || !replyDraft.cacheReady}
                                  onClick={() => {try{replyDraft.select(m.id);}catch(e){report(e);}}}
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
                        {channel.archived&&<p role="status">This conversation is archived. Your draft is preserved; restore the channel to send messages.</p>}
                        {postingBlocked&&<p role="status">Only workspace owners and admins can post, reply or edit here. You can keep editing your saved draft.</p>}
                        {messages.length > 0 && (
                          <button
                            className="mark-read"
                            onClick={() =>
                              perform(() =>
                                api(`/channels/${stream}/read`, "POST", {
                                  seq: messages.at(-1)?.seq ?? "0",
                                }),
                              )
                            }
                          >
                            <CheckCheck size={13} />
                            Mark as read
                          </button>
                        )}
                        {!draftReady && <section aria-label="Saved text draft">
                          {draftLoadError ? <div role="alert"><p>{draftLoadError}</p><button type="button" className="secondary" onClick={() => setDraftLoadAttempt(value => value + 1)}>Retry saved draft</button></div> : <p role="status">Loading saved draft…</p>}
                        </section>}
                        <ReplyDraft draft={replyDraft} disabled={sending||!!failed} cancel={()=>{try{replyDraft.select(null);}catch(e){report(e);}}} clear={()=>{try{replyDraft.clear();}catch(e){report(e);}}}/>
                        {failed && (
                          <div className="failed" role="status">
                            Message not confirmed: {failed.body.slice(0, 80)}.
                            Retrying uses the original message.{" "}
                            <button
                              disabled={sending || !draftReady || channel.archived}
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
                        <AttachmentDraft files={attachmentDraft.files} error={attachmentDraft.error} disabled={sending||!!failed} remove={id=>{try{attachmentDraft.remove(id);}catch(e){report(e);}}} clear={()=>{try{attachmentDraft.clear();}catch(e){report(e);}}}/>
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
                              // Enter may confirm an input-method candidate rather than send.
                              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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
                              disabled={!draftReady || !attachmentDraft.ready || attachmentDraft.files.length>=10 || sending || !!failed || postingBlocked || channel.archived}
                              onClick={() => setModal("attachment")}
                            >
                              <Paperclip size={18} />
                            </button>
                            <button
                              type="button"
                              aria-label="Add emoji"
                              aria-describedby={draftReady && !emojiFits ? emojiLimitId : undefined}
                              disabled={!draftReady || !emojiFits}
                              onClick={() => setDraft((value) => value.length + emojiText.length <= 10000 ? value + emojiText : value)}
                            >
                              <Smile size={18} />
                            </button>
                            <button
                              type="button"
                              aria-label="Mention a person"
                              disabled={!draftReady}
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
                                postingBlocked || channel.archived ||
                                !draftReady ||
                                !attachmentDraft.ready || !replyDraft.ready ||
                                (!draft.trim()&&!attachmentDraft.files.length) ||
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
                        {draftReady && !emojiFits && <p id={emojiLimitId} role="status">Not enough room to add this emoji. Shorten your message first.</p>}
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
                            muted: !channel.muted,
                          }),
                        )
                      }
                    >
                      <VolumeX size={15} />
                      {channel.muted ? "Unmute" : "Mute"}
                    </button>
                    <ConversationVisibility key={`${session.user.id}:${stream}`} id={stream} hidden={channel.hidden} onChanged={()=>refresh(AbortSignal.timeout(8000))}/>
                    {["direct","group"].includes(channel.kind)&&<ChatManagement key={stream} id={stream} people={boot?.people??[]} userId={session.user.id} onSaved={refresh} onLeft={async()=>{
                      try{const pending=pendingFor(window.sessionStorage,session.user.id,org,stream);
                        if(pending)removePending(window.sessionStorage,pending.id);
                      }catch(e){report(e);}
                      latestDraft.current="";setDraft("");setFailed(null);setMessages([]);setDetails(false);
                      setBoot(previous=>previous?{...previous,channels:previous.channels.filter(c=>c.id!==stream)}:previous);setStream("");
                      await refresh().catch(report);
                    }}/>}
                    <h3>Workspace directory</h3>
                    {boot?.people.map((p) => (
                      <div className="person" key={p.id}>
                        <Avatar name={p.name} small />
                        <div>
                          <strong>{p.name}</strong>
                          {p.id!==session.user.id&&<><button className="secondary" onClick={()=>void (async()=>{try{const c=await api<{id:string}>(`/organizations/${org}/direct-conversation`,'POST',{userId:p.id});setMediaIntent({channelId:c.id,key:crypto.randomUUID(),mode:'audio',start:true});setView('Calls');}catch(e){report(e);}})()}>Audio call {p.name}</button><button className="secondary" onClick={()=>void (async()=>{try{const c=await api<{id:string}>(`/organizations/${org}/direct-conversation`,'POST',{userId:p.id});setMediaIntent({channelId:c.id,key:crypto.randomUUID(),mode:'video',start:true});setView('Calls');}catch(e){report(e);}})()}>Video call {p.name}</button></>}
                          <small>
                            {p.presence} · {p.role}
                          </small>
                        </div>
                      </div>
                    ))}
                    {["admin", "owner"].includes(boot?.role ?? "") && (
                      <>
                        {boot?.role==="owner"&&["standard","private","shared"].includes(channel.kind)&&<><ChannelPreservation key={stream} id={stream}/><MessageRetention key={`retention-${stream}`} id={stream}/><FileRetention key={`file-retention-${stream}`} id={stream}/></>}
                        {["standard","private","shared"].includes(channel.kind)&&<><ChannelSettings key={stream} id={stream} onSaved={refresh}/><PostingPolicy channel={channel} onSaved={refresh}/></>}
                        {["private","shared"].includes(channel.kind)&&<ChannelAccess key={stream} id={stream} userId={session.user.id} people={boot?.people??[]} onSaved={refresh}/>}
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
                    {readStatus.error?<p>{readStatus.error}</p>:readStatus.receipts===null?<p>Checking shared read positions…</p>:!readStatus.receipts.length&&<p>No shared read positions returned.</p>}
                    {readStatus.error&&tab!=="Posts"&&<button className="secondary" onClick={readStatus.retry}>Retry read status</button>}
                    {readStatus.receipts?.map((r) => (
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
            org={org}
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
        ) : view === "Saved" ? (
          <SavedMessages key={`${session.user.id}:${org}`} org={org} onOpen={(channel,id)=>setLinkedMessage({org,channel,id})}/>
        ) : view === "Activity" ? (
          <ActivityFeed key={`${session.user.id}:${org}`} org={org} filter={activityFilter} onFilter={setActivityFilter} onOpen={(channel,id)=>{setLinkedFile(null);setLinkedMessage({org,channel,id});}} onConversation={channel=>select(channel)} onCancel={cancelActivityNavigation}/>
        ) : view === "Calls" ? (
          <div className="content-pad"><Unavailable title="Telephony not configured">Queues and PSTN merging require a supported SIP/PSTN provider, phone numbers, and billing authorization.</Unavailable></div>
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
          clearMeetingPending(window.sessionStorage);
              setFailed(null);
              setError("");
            }}
          />
        )}
      </main>
      {hiddenOpen&&<HiddenConversations key={`${session.user.id}:${org}`} org={org} onChanged={()=>refresh(AbortSignal.timeout(8000))} onClose={()=>{selectionRequest.current++;setHiddenOpen(false);}} onOpen={async id=>{const opened=await select(id);if(opened)setHiddenOpen(false);return opened;}}/>}
      {linkedFile?.org===org&&<LinkedFile key={`${session.user.id}:${org}:${linkedFile.channel}:${linkedFile.id}`} target={linkedFile} userId={session.user.id} onClose={()=>closeLinkedFile(linkedFile)}/>}
      {view==="Chat"&&tab==="Posts"&&readerTarget?.key===`${session.user.id}:${org}:${stream}`&&<MessageReaders key={`${readerTarget.key}:${readerTarget.id}`} target={{org,channel:stream,id:readerTarget.id}} onClose={()=>setReaderTarget(null)}/>}
      {linkedMessage?.org===org&&<LinkedMessage key={`${session.user.id}:${org}:${linkedMessage.channel}:${linkedMessage.id}`} target={linkedMessage} onClose={()=>closeLinkedMessage(linkedMessage)} onConversation={()=>select(linkedMessage.channel)} onReply={signal=>replyToSource(linkedMessage,signal)} replyDisabled={sending||!!failed} onMarkedUnread={()=>refresh(AbortSignal.timeout(8000))} onOpenSource={visitMessageSource} onBack={sourceTrail.key===`${session.user.id}:${org}`&&sourceTrail.items.at(-1)?.channel===linkedMessage.channel?previousMessageSource:undefined}/>}
      {reporting&&<MessageReportDialog key={reporting.id} channel={reporting.channel} id={reporting.id} deleted={reporting.deleted} onClose={()=>setReporting(null)}/>}
      {modal && (
        <Modal
          title={
            modal.startsWith("edit:")
              ? "Edit message"
              : modal === "migration"
                ? "Review channel access"
                : modal === "attachment"
                  ? "Attach files"
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
            <p>Open Calls to start or join a LiveKit call. Calendar scheduling remains available separately.</p>
          ) : modal === "attachment" ? (
            <AttachmentPicker key={stream} channelId={stream} selectedIds={attachmentDraft.files.map(file=>file.id)} select={file=>{try{attachmentDraft.add(file);setModal("");}catch(e){report(e);}}} openFiles={()=>{setModal("");setTab("Files");}} />
          ) : modal === "mention" ? (
            <MentionPicker key={`${session.user.id}:${org}:${stream}`} channelId={stream} select={(person)=>{
              if(!draftReady||streamRef.current!==stream||orgRef.current!==org||identityRef.current!==session.user.id)return;
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
    </div></PresenceProvider>
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
  const previewId=useId();
  const unread=c.unread>99?"99+":String(c.unread);
  return (
    <button
      aria-label={`${c.name}${c.unread?` ${unread}`:""}`}
      aria-describedby={c.preview?previewId:undefined}
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
      <span className="channel-copy"><span>{c.name}</span>{c.preview&&<small id={previewId} className="channel-preview">{c.preview}</small>}</span>
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
  const typeId=useId();
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
          <label htmlFor={typeId}>Type</label>
            <select id={typeId} value={kind} onChange={(e) => setKind(e.target.value)}>
              {(mode === "conversation"
                ? ["direct", "group"]
                : ["standard", "private", "shared"]
              ).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
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
