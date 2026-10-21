"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  ScreenShare,
  ScreenShareOff,
  Hand,
  Users,
  MessageSquare,
  Settings2,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
  PhoneOff,
  Pin,
  PinOff,
  X,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { Track, type Room, type Participant } from "livekit-client";
import { ProfileTrigger } from "./profile-popovers";
import { CallCollaboration } from "./call-collaboration";
import { api } from "@/lib/contracts";
import { galleryCell, meetingGrid } from "@/lib/meeting-layout";
import type { MediaGrant, MediaState } from "@/lib/media-contracts";

type Panel = "chat" | "participants" | "settings" | "options";
function Control({
  label,
  icon: Icon,
  onClick,
  disabled,
  pressed,
  danger = false,
  secondary = false,
}: {
  secondary?: boolean;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      className={`call-control ${secondary ? "secondary-control" : ""} ${danger ? "call-control-danger" : ""}`}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={20} aria-hidden="true" />
      <span>{label}</span>
      <span className="call-tooltip" role="tooltip">
        {label}
      </span>
    </button>
  );
}
export function CallMeetingSurface({
  detailsPanel,
  onSettingsVisibility,
  unmutePrompt,
  room,
  connection,
  error,
  notice,
  busy,
  grant,
  base,
  state,
  userId,
  visible,
  moderation,
  settings,
  diagnostics,
  deviceControls,
  onRefresh,
  onLeave,
  onEnd,
  run,
  onMicrophone,
  onCamera,
  onShare,
  onPlayback,
  renderTrack,
}: {
  detailsPanel: React.ReactNode;
  onSettingsVisibility: (shown: boolean) => void;
  unmutePrompt: React.ReactNode;
  room: Room | null;
  connection: string;
  error: string;
  notice: string;
  busy: boolean;
  grant: MediaGrant;
  base: string;
  state: MediaState | null;
  userId: string;
  visible: boolean;
  moderation: React.ReactNode;
  settings: React.ReactNode;
  diagnostics: React.ReactNode;
  deviceControls: React.ReactNode;
  onRefresh: () => Promise<void>;
  onLeave: () => void;
  onEnd: () => Promise<void>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  onMicrophone: () => Promise<void>;
  onCamera: () => Promise<void>;
  onShare: () => Promise<void>;
  onPlayback: () => Promise<void>;
  renderTrack: (track: Track, local: boolean, index: number) => React.ReactNode;
}) {
  const [panel, setPanel] = useState<Panel | null>(null),
    [unread, setUnread] = useState(0),
    [layout, setLayout] = useState<"grid" | "speaker">("grid"),
    [pinned, setPinned] = useState(""),
    [confirmEnd, setConfirmEnd] = useState(false),
    [pageAnchor, setPageAnchor] = useState(""),
    [bounds, setBounds] = useState({ width: 800, height: 400 });
  useEffect(() => {
    onSettingsVisibility(panel === "settings" && visible);
  }, [panel, visible, onSettingsVisibility]);
  const stage = useRef<HTMLDivElement | null>(null),
    gallery = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = gallery.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0)
        setBounds((previous) =>
          previous.width === entry.contentRect.width &&
          previous.height === entry.contentRect.height
            ? previous
            : {
                width: entry.contentRect.width,
                height: entry.contentRect.height,
              },
        );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const moreTrigger = useRef<HTMLButtonElement | null>(null);
  const panelTitle = useRef<HTMLHeadingElement | null>(null),
    trigger = useRef<HTMLButtonElement | null>(null),
    endButton = useRef<HTMLButtonElement | null>(null),
    confirmButton = useRef<HTMLButtonElement | null>(null),
    id = useId();
  const participants: Participant[] = room
      ? [...room.remoteParticipants.values(), room.localParticipant]
      : [],
    local = room?.localParticipant;
  const focused = participants.some((p) => p.identity === pinned)
    ? pinned
    : (participants.find((p) => p !== local && p.isSpeaking)?.identity ??
      participants.find((p) => p !== local)?.identity ??
      local?.identity);
  const sharing = participants.find((p) => p.isScreenShareEnabled),
    share = sharing?.getTrackPublication(Track.Source.ScreenShare)?.track;
  const roster =
      state?.participants.filter((p) => p.room_id === grant.roomId) ?? [],
    raised = roster
      .filter((p) => p.hand_raised_at)
      .sort((a, b) =>
        BigInt(a.hand_order ?? "0") < BigInt(b.hand_order ?? "0") ? -1 : 1,
      ),
    ownRaised = !!roster.find((p) => p.id === grant.grantId)?.hand_raised_at,
    host = state?.call.hostUserId === userId;
  const connected = connection === "connected",
    disabled = !room || busy || !connected;
  const presenting = !!sharing,
    audioOnly =
      participants.length > 0 &&
      participants.every((p) => !p.isCameraEnabled) &&
      !sharing;
  const spotlight =
    !presenting &&
    (layout === "speaker" || (participants.length === 2 && !audioOnly));
  const featured = spotlight
    ? (participants.find((p) => p.identity === focused) ?? participants[0])
    : undefined;
  const wideSpotlight = bounds.width >= 520;
  const thumbnailSlots = spotlight
    ? wideSpotlight
      ? Math.min(3, Math.floor(bounds.height / 132))
      : bounds.height >= 250
        ? Math.min(2, Math.floor(bounds.width / 160))
        : 0
    : 0;
  const candidates = featured
    ? participants.filter((p) => p !== featured)
    : participants;
  const grid = meetingGrid(bounds.width, bounds.height, candidates.length);
  const capacity = spotlight
    ? thumbnailSlots
    : presenting
      ? Math.max(1, Math.floor(bounds.width / 160))
      : grid.capacity;
  const pages = capacity
    ? Math.max(1, Math.ceil(candidates.length / capacity))
    : Math.max(1, participants.length);
  const page = capacity
    ? Math.min(
        pages - 1,
        Math.floor(
          Math.max(
            0,
            candidates.findIndex((p) => p.identity === pageAnchor),
          ) / capacity,
        ),
      )
    : Math.max(
        0,
        participants.findIndex((p) => p === featured),
      );
  const shown = capacity
    ? candidates.slice(page * capacity, (page + 1) * capacity)
    : [];
  const visibleIds = new Set(
    [...shown, ...(featured ? [featured] : [])].map((p) => p.identity),
  );
  const arrangement = meetingGrid(bounds.width, bounds.height, shown.length);
  function changePage(next: number) {
    if (next < 0 || next >= pages) return;
    if (!capacity) {
      setPinned(participants[next].identity);
      setLayout("speaker");
    } else setPageAnchor(candidates[next * capacity].identity);
  }

  useEffect(() => {
    if (stage.current) stage.current.scrollTop = 0;
  }, [presenting]);
  useEffect(() => {
    if (panel) panelTitle.current?.focus();
  }, [panel]);
  useEffect(() => {
    if (confirmEnd) confirmButton.current?.focus();
  }, [confirmEnd]);
  function toggle(value: Panel, event: React.MouseEvent<HTMLButtonElement>) {
    trigger.current = event.currentTarget.closest(".call-options")
      ? moreTrigger.current
      : event.currentTarget;
    if (panel === value) {
      setPanel(null);
      event.currentTarget.focus();
    } else setPanel(value);
  }
  function closePanel() {
    setPanel(null);
    trigger.current?.focus();
  }
  function closeEnd() {
    setConfirmEnd(false);
    endButton.current?.focus();
  }
  const panelButton = (
    value: Panel,
    label: string,
    Icon: LucideIcon,
    secondary = false,
  ) => (
    <button
      ref={value === "options" ? moreTrigger : undefined}
      className={`call-control ${secondary ? "secondary-control" : ""}`}
      aria-label={label}
      aria-expanded={panel === value}
      aria-controls={`${id}-panel`}
      onClick={(e) => toggle(value, e)}
    >
      <Icon size={20} aria-hidden="true" />
      <span>{label}</span>
      <span className="call-tooltip" role="tooltip">
        {label}
      </span>
    </button>
  );
  return (
    <section
      aria-label="Live call"
      className={`media-session meeting-surface bounded-meeting ${audioOnly ? "audio-only" : ""}`}
    >
      <div className="call-connection" role="status" aria-live="polite">
        <span
          className={`connection-dot ${connected ? "connected" : ""}`}
          aria-hidden="true"
        />
        Connection: {connection}
        {participants.length > 0 && (
          <span>
            {" "}
            · {participants.length}{" "}
            {participants.length === 1 ? "participant" : "participants"}
          </span>
        )}
        {busy && <span> · Updating…</span>}
      </div>
      {error && (
        <p className="call-feedback" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="call-feedback" role="status">
          {notice}
        </p>
      )}
      {room && connected && !room.canPlaybackAudio && (
        <p role="alert" className="call-feedback">
          Your browser blocked audio.{" "}
          <button onClick={() => void run(onPlayback)}>
            <Volume2 size={18} />
            Enable audio playback
          </button>
        </p>
      )}
      {unmutePrompt}
      <div className={`call-body ${panel ? "panel-open" : ""}`}>
        <div
          ref={stage}
          className={`call-stage ${presenting ? "is-presenting" : ""}`}
          aria-label="Meeting stage"
        >
          <div className="call-view-options">
            <label>
              <span className="sr-only">Meeting layout</span>
              <select
                aria-label="Meeting layout"
                value={layout}
                onChange={(e) => {
                  setLayout(e.target.value as "grid" | "speaker");
                  setPinned("");
                  setPageAnchor("");
                }}
              >
                <option value="grid">Gallery</option>
                <option value="speaker">Active speaker</option>
              </select>
            </label>
            <span>
              {pinned
                ? "Pinned for you"
                : presenting
                  ? "Shared content"
                  : audioOnly
                    ? "Audio meeting"
                    : "Meeting gallery"}
            </span>
          </div>
          <div
            className={`call-visuals ${presenting ? "with-presentation" : ""}`}
          >
            {sharing && (
              <section
                className="call-presentation"
                aria-label={`${sharing.name ?? "Participant"} is presenting`}
              >
                <h3>
                  <ScreenShare size={18} />
                  {sharing.name ?? "Participant"} is presenting
                </h3>
                {share ? (
                  renderTrack(share, sharing === local, 0)
                ) : (
                  <p role="status">Connecting shared content…</p>
                )}
              </section>
            )}
            <div ref={gallery} className="call-gallery-viewport">
              <div
                className={`media-grid call-gallery fitted-gallery ${spotlight ? "spotlight-gallery" : ""} ${wideSpotlight ? "spotlight-wide" : "spotlight-stacked"} ${presenting ? "sharing-gallery" : ""}`}
                style={{
                  gridTemplateColumns: spotlight
                    ? wideSpotlight && thumbnailSlots
                      ? "minmax(0,1fr) minmax(100px,24%)"
                      : `repeat(${Math.max(1, shown.length)},minmax(0,1fr))`
                    : `repeat(${presenting ? Math.max(1, shown.length) : arrangement.columns * 2},minmax(0,1fr))`,
                  gridTemplateRows: spotlight
                    ? wideSpotlight
                      ? `repeat(${Math.max(1, shown.length)},minmax(0,1fr))`
                      : thumbnailSlots
                        ? "minmax(0,1fr) 100px"
                        : "minmax(0,1fr)"
                    : `repeat(${presenting ? 1 : arrangement.rows},minmax(0,1fr))`,
                }}
              >
                {!participants.length && (
                  <p className="call-waiting" role="status">
                    {connected
                      ? "Waiting for participants…"
                      : "Connecting to the meeting…"}
                  </p>
                )}
                {participants.map((p, index) => {
                  const isLocal = p === local,
                    camera = p.getTrackPublication(Track.Source.Camera),
                    track = !camera?.isMuted ? camera?.track : undefined,
                    cell = galleryCell(
                      shown.indexOf(p),
                      shown.length,
                      arrangement.columns,
                    );
                  return (
                    <article
                      hidden={!visibleIds.has(p.identity)}
                      style={
                        spotlight
                          ? p !== featured
                            ? {
                                gridColumn: wideSpotlight
                                  ? 2
                                  : shown.indexOf(p) + 1,
                                gridRow: wideSpotlight
                                  ? shown.indexOf(p) + 1
                                  : 2,
                              }
                            : {
                                gridColumn: wideSpotlight ? "1" : "1 / -1",
                                gridRow: wideSpotlight ? "1 / -1" : 1,
                              }
                          : !presenting
                            ? {
                                gridColumn: `${cell.column} / span 2`,
                                gridRow: cell.row,
                              }
                            : undefined
                      }
                      className={`media-tile ${p === featured ? "featured-tile" : ""} ${spotlight && p !== featured ? "thumbnail-tile" : ""} ${pinned === p.identity ? "is-pinned" : ""} ${isLocal ? "local-tile" : ""} ${p.identity === focused ? "focused-tile" : ""} ${p.isSpeaking ? "is-speaking" : ""}`}
                      key={p.identity}
                      aria-label={`${isLocal ? "You" : (p.name ?? "Participant")} media`}
                    >
                      <div className="call-tile-media">
                        {track ? (
                          renderTrack(track, isLocal, index)
                        ) : (
                          <div className="call-avatar-wrap">
                            <span className="meeting-avatar" aria-hidden="true">
                              {(p.name ?? "?")
                                .split(" ")
                                .map((n) => n[0])
                                .slice(0, 2)
                                .join("")}
                            </span>
                            {p.isCameraEnabled && <p>Video connecting…</p>}
                          </div>
                        )}
                      </div>
                      <div className="call-tile-caption">
                        <div>
                          <h3 title={p.name}>
                            <ProfileTrigger
                              userId={
                                roster.find((g) => g.id === p.identity)
                                  ?.user_id ?? ""
                              }
                              name={p.name ?? "Participant"}
                            />
                            {isLocal ? " (you)" : ""}
                          </h3>
                          <p className="tile-status">
                            <span className="sr-only">
                              {p.isSpeaking ? "Speaking · " : ""}
                              {p.isMicrophoneEnabled
                                ? "Microphone on"
                                : "Microphone muted"}{" "}
                              · {p.isCameraEnabled ? "Camera on" : "Camera off"}
                              {p.connectionQuality === "lost"
                                ? " · Connection interrupted"
                                : ""}
                            </span>
                            {!p.isMicrophoneEnabled && (
                              <MicOff size={14} aria-label="Microphone muted" />
                            )}
                            {!p.isCameraEnabled && (
                              <VideoOff size={14} aria-label="Camera off" />
                            )}
                            {p.isSpeaking && (
                              <span className="speaking-label">Speaking</span>
                            )}
                            {p.connectionQuality === "lost" && (
                              <span>Reconnecting</span>
                            )}
                          </p>
                          {raised.some((g) => g.id === p.identity) && (
                            <span className="hand-badge" title="Hand raised">
                              <Hand size={14} />
                              <span className="sr-only">Hand raised</span>
                            </span>
                          )}
                        </div>
                        <button
                          className="call-pin"
                          title={`${pinned === p.identity ? "Unpin" : "Pin"} ${p.name} (only for you)`}
                          aria-label={`${pinned === p.identity ? "Unpin" : "Pin"} ${p.name}`}
                          aria-pressed={pinned === p.identity}
                          onClick={() => {
                            setPinned(pinned === p.identity ? "" : p.identity);
                            setLayout("speaker");
                          }}
                        >
                          {pinned === p.identity ? (
                            <PinOff size={18} />
                          ) : (
                            <Pin size={18} />
                          )}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
          <nav className="call-pagination" aria-label="Participant pages">
            <button
              className="icon-button"
              aria-label="Previous participant page"
              disabled={page === 0}
              onClick={() => changePage(page - 1)}
            >
              <ChevronLeft size={18} />
            </button>
            <span role="status">
              Page {page + 1} of {pages} · {participants.length}{" "}
              {participants.length === 1 ? "participant" : "participants"}
            </span>
            <button
              className="icon-button"
              aria-label="Next participant page"
              disabled={page >= pages - 1}
              onClick={() => changePage(page + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </nav>
        </div>
        <aside
          id={`${id}-panel`}
          className="call-panel"
          hidden={!panel}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              closePanel();
            }
          }}
        >
          <header>
            <h3 ref={panelTitle} tabIndex={-1}>
              {panel === "chat"
                ? "Call chat"
                : panel === "participants"
                  ? "Participants"
                  : panel === "options"
                    ? "More options"
                    : "Device settings"}
            </h3>
            <button
              className="icon-button"
              aria-label="Close call panel"
              title="Close call panel"
              onClick={closePanel}
            >
              <X size={20} />
            </button>
          </header>
          <div hidden={panel !== "chat"}>
            <CallCollaboration
              key={`${grant.grantId}:${grant.roomId}`}
              userId={userId}
              base={base}
              grant={grant}
              state={state}
              onRefresh={onRefresh}
              embedded
              open={panel === "chat"}
              visible={visible && panel === "chat"}
              onUnreadChange={setUnread}
            />
          </div>
          <section hidden={panel !== "participants"} aria-label="Participants">
            <section aria-label="Raised hands">
              <h3>Raised hands</h3>
              {raised.length ? (
                <ol>
                  {raised.map((p) => (
                    <li key={p.id}>{p.name} · Hand raised</li>
                  ))}
                </ol>
              ) : (
                <p>No hands raised</p>
              )}
            </section>
            <ul className="call-roster">
              {roster.map((g) => {
                const p = participants.find((p) => p.identity === g.id);
                return (
                  <li key={g.id}>
                    <ProfileTrigger userId={g.user_id} name={g.name}>
                      <strong>{g.name}</strong>
                    </ProfileTrigger>
                    <span>
                      {g.user_id === state?.call.hostUserId
                        ? "Host"
                        : "Participant"}{" "}
                      ·{" "}
                      {g.disconnected_at
                        ? "Reconnecting"
                        : p
                          ? "Connected"
                          : "Connecting"}
                    </span>
                    <span>
                      {!p
                        ? "Media status unavailable"
                        : p.isMicrophoneEnabled
                          ? "Microphone on"
                          : "Microphone muted"}{" "}
                      ·{" "}
                      {!p
                        ? "Video status unavailable"
                        : p.isCameraEnabled
                          ? "Camera on"
                          : "Camera off"}
                      {g.hand_raised_at ? " · Hand raised" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
            {moderation}
          </section>
          <section
            hidden={panel !== "options"}
            className="call-options"
            aria-label="More meeting options"
          >
            <button
              className="secondary"
              onClick={(e) => toggle("settings", e)}
            >
              <Settings2 size={18} />
              Device settings & effects
            </button>
            <button
              className="secondary"
              aria-pressed={ownRaised}
              disabled={disabled || !state}
              onClick={() =>
                void run(async () => {
                  await api(
                    `${base}/connections/${grant.grantId}/hand`,
                    "POST",
                    { raised: !ownRaised },
                  );
                  await onRefresh();
                })
              }
            >
              <Hand size={18} />
              {ownRaised ? "Lower hand" : "Raise hand"}
            </button>
            <button
              className="secondary"
              onClick={(e) => toggle("participants", e)}
            >
              <Users size={18} />
              Participants
            </button>
            <button className="secondary" onClick={(e) => toggle("chat", e)}>
              <MessageSquare size={18} />
              Call chat{unread ? ` (${unread} unread)` : ""}
            </button>
            {host && (
              <button
                className="secondary compact-end"
                disabled={busy}
                onClick={(e) => {
                  endButton.current = e.currentTarget;
                  setConfirmEnd(true);
                }}
              >
                End call for everyone
              </button>
            )}
            <p>
              Pin a participant to change only your own view. Unpin to follow
              the active speaker.
            </p>
            {typeof navigator.mediaDevices?.getDisplayMedia !== "function" && (
              <p>Screen sharing is unavailable in this browser.</p>
            )}
            {detailsPanel}
          </section>
          <section hidden={panel !== "settings"} aria-label="Call settings">
            {deviceControls}
            {settings}
            {diagnostics}
            <button
              className="secondary"
              disabled={!room}
              onClick={() => void run(onPlayback)}
            >
              Enable audio playback
            </button>
          </section>
        </aside>
      </div>
      <div
        className="call-toolbar"
        role="toolbar"
        aria-label="Call controls"
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
            return;
          const buttons = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            ),
            index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
          if (index < 0) return;
          e.preventDefault();
          buttons[
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (index + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) %
                  buttons.length
          ]?.focus();
        }}
      >
        <Control
          label={
            local?.isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"
          }
          icon={local?.isMicrophoneEnabled ? Mic : MicOff}
          pressed={!!local?.isMicrophoneEnabled}
          disabled={disabled}
          onClick={() => void run(onMicrophone)}
        />
        <Control
          label={local?.isCameraEnabled ? "Turn camera off" : "Turn camera on"}
          icon={local?.isCameraEnabled ? Video : VideoOff}
          pressed={!!local?.isCameraEnabled}
          disabled={disabled}
          onClick={() => void run(onCamera)}
        />
        <Control
          label={
            local?.isScreenShareEnabled ? "Stop screen sharing" : "Share screen"
          }
          icon={local?.isScreenShareEnabled ? ScreenShareOff : ScreenShare}
          pressed={!!local?.isScreenShareEnabled}
          disabled={
            disabled ||
            typeof navigator.mediaDevices?.getDisplayMedia !== "function"
          }
          onClick={() => void run(onShare)}
        />
        <Control
          secondary
          label={ownRaised ? "Lower hand" : "Raise hand"}
          icon={Hand}
          pressed={ownRaised}
          disabled={disabled || !state}
          onClick={() =>
            void run(async () => {
              await api(`${base}/connections/${grant.grantId}/hand`, "POST", {
                raised: !ownRaised,
              });
              await onRefresh();
            })
          }
        />
        {panelButton("participants", "Participants", Users, true)}
        {panelButton(
          "chat",
          `Call chat${unread ? ` (${unread} unread)` : ""}`,
          MessageSquare,
          true,
        )}
        {panelButton("settings", "Device settings", Settings2, true)}
        {panelButton("options", "More options", MoreHorizontal)}
        <div className="call-destructive">
          <Control
            label="Leave call"
            icon={PhoneOff}
            danger
            onClick={onLeave}
          />
          {host && (
            <button
              className="call-control call-end secondary-control"
              title="End this meeting for all participants"
              disabled={busy}
              onClick={(e) => {
                endButton.current = e.currentTarget;
                setConfirmEnd(true);
              }}
            >
              End call for everyone
            </button>
          )}
        </div>
      </div>
      <div className="call-audio-sinks" aria-hidden="true">
        {participants.map((p, index) => (
          <span key={p.identity}>
            {[...p.audioTrackPublications.values()]
              .filter((pub) => !!pub.track && !pub.isMuted)
              .map((pub) => (
                <span key={pub.trackSid}>
                  {renderTrack(pub.track!, p === local, index)}
                </span>
              ))}
          </span>
        ))}
      </div>
      {confirmEnd && host && (
        <div className="call-end-backdrop">
          <section
            role="alertdialog"
            aria-modal="true"
            aria-label="End meeting confirmation"
            className="call-end-confirm"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeEnd();
              }
              if (e.key === "Tab") {
                e.preventDefault();
                (document.activeElement === confirmButton.current
                  ? e.currentTarget.querySelector<HTMLButtonElement>(
                      ".keep-meeting",
                    )
                  : confirmButton.current
                )?.focus();
              }
            }}
          >
            <h3>End this meeting for everyone?</h3>
            <p>
              All participants will be disconnected. You can leave independently
              instead.
            </p>
            <button
              ref={confirmButton}
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await onEnd();
                  setConfirmEnd(false);
                })
              }
            >
              Confirm end meeting
            </button>
            <button
              className="secondary keep-meeting"
              disabled={busy}
              onClick={closeEnd}
            >
              Keep meeting open
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
