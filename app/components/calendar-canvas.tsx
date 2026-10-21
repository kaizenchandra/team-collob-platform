"use client";
/* Calendar data is replaced on range/identity changes to avoid showing stale records. */
/* eslint-disable react-hooks/set-state-in-effect */
import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { Temporal } from "@js-temporal/polyfill";
import { ChevronLeft, ChevronRight, Video, Phone, MapPin } from "lucide-react";
import { api, type Meeting, type Person } from "@/lib/contracts";
import {
  calendarDays,
  calendarDate,
  calendarRange,
  addDays,
  layoutEvents,
  calendarDayTimeline,
  calendarEventPosition,
  calendarWorkingPositions,
  fallbackDays,
  type CalendarView,
  type WorkDay,
} from "@/lib/calendar";
import { HoverPopover } from "./profile-popovers";
import { CalendarSettings } from "./calendar-settings";
export type CalendarCall = {
  id: string;
  channelId: string;
  mode: "audio" | "video";
};
type Holiday = { id: string; title: string; day: string; calendar: string };
type Leave = {
  id: string;
  status: string;
  first_day: string | null;
  last_day: string | null;
  starts_at: string | null;
  ends_at: string | null;
};
export type CalendarSettingsData = {
  settings: {
    timezone: string;
    days: WorkDay[];
    holiday_calendar: string;
  } | null;
  calendars: string[];
  canManage: boolean;
};
const format = (
  value: string,
  zone: string,
  options: Intl.DateTimeFormatOptions,
) =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: zone }).format(
    new Date(value),
  );
function dateLabel(day: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(undefined, {
    ...options,
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}
export function MeetingDetails({
  org,
  meeting: m,
  zone,
  onJoin,
  actions,
}: {
  org: string;
  meeting: Meeting;
  zone: string;
  onJoin: (call: CalendarCall) => void;
  actions: ReactNode;
}) {
  const [data, setData] = useState<{
      participants: { id: string; name: string; response: string }[];
      call: { ended_at: string | null; started: boolean } | null;
    } | null>(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    setData(null);
    setError("");
    void api<NonNullable<typeof data>>(
      `/organizations/${org}/meetings/${m.id}/details`,
      "GET",
      undefined,
      AbortSignal.any([c.signal, AbortSignal.timeout(8000)]),
    )
      .then((x) => {
        if (!c.signal.aborted) setData(x);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [org, m.id, m.revision, retry]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const ended =
      Boolean(data?.call?.ended_at) ||
      (!data?.call?.started && Date.parse(m.ends_at) <= now),
    early = !data?.call?.started && Date.parse(m.starts_at) > now + 15 * 60000;
  return (
    <div className="calendar-meeting-details">
      <span className="eyebrow">
        {m.team_name ? `Team · ${m.team_name}` : "Personal meeting"}
        {m.series_id ? " · Recurring" : ""}
      </span>
      <h2>{m.title}</h2>
      <p>
        {format(m.starts_at, zone, {
          weekday: "long",
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
        <br />
        {format(m.starts_at, zone, {
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        })}{" "}
        –{" "}
        {format(m.ends_at, zone, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        })}{" "}
        ·{" "}
        {Math.round((Date.parse(m.ends_at) - Date.parse(m.starts_at)) / 60000)}{" "}
        min
      </p>
      <small>{zone}</small>
      <p>
        {m.cancelled
          ? "Cancelled"
          : m.meeting_type === "in_person"
            ? `In person · ${m.location || "Location not specified"}`
            : `Online · Concord calling${m.location ? ` · ${m.location}` : ""}`}
      </p>
      <h3>Agenda</h3>
      <p className="calendar-agenda">
        {m.description || "No agenda provided."}
      </p>
      {data ? (
        <>
          <h3>Organizer</h3>
          <p>
            {data.participants.find((p) => p.id === m.organizer_id)?.name ??
              "Organizer unavailable"}
          </p>
          <details>
            <summary>{data.participants.length} participants</summary>
            <ul>
              {data.participants.map((p) => (
                <li key={p.id}>
                  {p.name} · {p.id === m.organizer_id ? "Organizer · " : ""}
                  {p.response}
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p role="status">
          {error ? "Meeting details unavailable." : "Loading participants…"}
        </p>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button onClick={() => setRetry((x) => x + 1)}>Retry details</button>
        </div>
      )}
      {m.meeting_type !== "in_person" && (
        <>
          <button
            className="primary"
            disabled={busy || m.cancelled || ended || early || !data}
            onClick={async () => {
              if (busy) return;
              setBusy(true);
              setError("");
              try {
                onJoin(
                  await api<CalendarCall>(
                    `/organizations/${org}/meetings/${m.id}/call`,
                    "POST",
                    {},
                  ),
                );
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Could not open meeting",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {m.meeting_type === "audio" ? (
              <Phone size={16} />
            ) : (
              <Video size={16} />
            )}
            {busy ? "Opening meeting…" : "Join meeting"}
          </button>
          <small>
            {m.cancelled
              ? "Cancelled meetings cannot be joined."
              : ended
                ? "This meeting has ended."
                : early
                  ? "Joining opens 15 minutes before the start."
                  : "Opens device setup in the integrated call area."}
          </small>
        </>
      )}
      {actions}
    </div>
  );
}
export function CalendarCanvas({
  org,
  userId,
  userZone,
  meetings,
  loading,
  error,
  onRange,
  onCreate,
  onJoin,
  renderActions,
  people,
  refresh,
  onContext,
}: {
  org: string;
  userId: string;
  userZone: string;
  meetings: Meeting[];
  loading: boolean;
  error: string;
  onRange: (range: { from: string; to: string }) => void;
  onCreate: (
    start: string,
    end: string,
    zone: string,
    choice?: "earlier" | "later",
  ) => void;
  onJoin: (call: CalendarCall) => void;
  renderActions: (meeting: Meeting) => ReactNode;
  people: Person[];
  refresh: () => Promise<void>;
  onContext: (context: { date: string; zone: string }) => void;
}) {
  const [zone, setZone] = useState(userZone || "UTC"),
    [date, setDate] = useState(() =>
      calendarDate(new Date().toISOString(), userZone || "UTC"),
    ),
    [view, setView] = useState<CalendarView>("workweek"),
    [ready, setReady] = useState(false),
    [settings, setSettings] = useState<CalendarSettingsData | null>(null),
    [blocks, setBlocks] = useState<{
      holidays: Holiday[];
      leave: Leave[];
    } | null>(null),
    [blockError, setBlockError] = useState(""),
    [settingsOpen, setSettingsOpen] = useState(false),
    [filter, setFilter] = useState("all"),
    [expandedDay, setExpandedDay] = useState(""),
    [clock, setClock] = useState(() => Date.now());
  const grid = useRef<HTMLDivElement>(null);
  const explicitDate = useRef(false),
    settingsLoaded = useRef(false);
  const storage = `calendar-view:${org}:${userId}`;
  useEffect(() => {
    try {
      const p = JSON.parse(sessionStorage.getItem(storage) || "null");
      if (
        p &&
        ["day", "workweek", "week", "month"].includes(p.view) &&
        /^\d{4}-\d{2}-\d{2}$/.test(p.date)
      ) {
        Temporal.PlainDate.from(p.date);
        explicitDate.current = true;
        setDate(p.date);
        setView(p.view);
      }
    } catch {}
    setReady(true);
  }, [storage]);
  useEffect(() => {
    if (ready)
      try {
        sessionStorage.setItem(storage, JSON.stringify({ date, view }));
      } catch {}
  }, [ready, storage, date, view]);
  const workDays = useMemo(
    () => settings?.settings?.days.map((d) => d.day),
    [settings],
  );
  const days = useMemo(
      () => calendarDays(date, view, workDays),
      [date, view, workDays],
    ),
    range = useMemo(
      () => calendarRange(date, view, zone, workDays),
      [date, view, zone, workDays],
    );
  useEffect(() => {
    if (ready) onContext({ date, zone });
  }, [ready, date, zone, onContext]);
  useEffect(() => {
    if (ready) onRange(range);
  }, [ready, range, onRange]);
  const readSettings = useCallback(async () => {
    const value = await api<CalendarSettingsData>(
      `/organizations/${org}/calendar/settings`,
    );
    setSettings(value);
    if (value.settings) {
      setZone(value.settings.timezone);
      if (!settingsLoaded.current && !explicitDate.current)
        setDate(
          calendarDate(new Date().toISOString(), value.settings.timezone),
        );
    }
    settingsLoaded.current = true;
  }, [org]);
  useEffect(() => {
    void readSettings().catch(() =>
      setBlockError("Working hours unavailable. Availability is unknown."),
    );
  }, [readSettings]);
  useEffect(() => {
    if (grid.current) grid.current.scrollTop = 8 * 60;
  }, [range]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const c = new AbortController();
    let pending = false;
    setBlocks(null);
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const x = await api<NonNullable<typeof blocks>>(
          `/organizations/${org}/calendar/blocks?${new URLSearchParams(range)}`,
          "GET",
          undefined,
          AbortSignal.any([c.signal, AbortSignal.timeout(8000)]),
        );
        if (!c.signal.aborted) {
          setBlocks(x);
          setBlockError("");
        }
      } catch {
        if (!c.signal.aborted) {
          setBlocks(null);
          setBlockError(
            "Leave and holidays unavailable. Availability is unknown; retrying automatically.",
          );
        }
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [org, range, ready, revision]);
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const today = calendarDate(new Date(clock).toISOString(), zone),
    work = settings ? (settings.settings?.days ?? fallbackDays) : [];
  const filtered = meetings.filter(
    (m) =>
      filter === "all" ||
      (filter === "personal" && !m.team_id) ||
      (filter === "team" && m.team_id),
  );
  function move(direction: number) {
    explicitDate.current = true;
    setDate(
      view === "month"
        ? Temporal.PlainDate.from(date).add({ months: direction }).toString()
        : addDays(date, direction * (view === "day" ? 1 : 7)),
    );
    setExpandedDay("");
  }
  function create(day: string, hour = 9) {
    const start = `${day}T${String(hour).padStart(2, "0")}:00`,
      end = Temporal.PlainDateTime.from(start)
        .add({ minutes: 30 })
        .toString({ smallestUnit: "minute" });
    onCreate(start, end, zone);
  }
  function event(m: Meeting) {
    return (
      <HoverPopover
        key={m.id}
        label={`${m.title}, ${format(m.starts_at, zone, { hour: "numeric", minute: "2-digit" })}${m.cancelled ? ", cancelled" : ""}`}
        triggerClassName={`calendar-event${m.cancelled ? " cancelled" : ""}`}
        trigger={
          <>
            <span>
              {m.meeting_type === "in_person" ? (
                <MapPin size={12} />
              ) : m.meeting_type === "audio" ? (
                <Phone size={12} />
              ) : (
                <Video size={12} />
              )}
              <strong>{m.title}</strong>
            </span>
            <small>
              {format(m.starts_at, zone, {
                hour: "numeric",
                minute: "2-digit",
              })}{" "}
              ·{" "}
              {m.cancelled
                ? "Cancelled"
                : m.team_name || m.response || "Meeting"}
            </small>
          </>
        }
      >
        {() => (
          <MeetingDetails
            key={m.id}
            org={org}
            meeting={m}
            zone={zone}
            onJoin={onJoin}
            actions={renderActions(m)}
          />
        )}
      </HoverPopover>
    );
  }
  function allDay(day: string) {
    return (
      <div className="calendar-all-day">
        {blocks?.holidays
          .filter((h) => h.day === day)
          .map((h) => (
            <span className="calendar-holiday" key={h.id} title={h.calendar}>
              ◇ {h.title}
            </span>
          ))}
        {blocks?.leave
          .filter(
            (l) => l.first_day && l.first_day <= day && l.last_day! >= day,
          )
          .map((l) => (
            <span className="calendar-leave" key={l.id}>
              ▧ {l.status === "pending" ? "Pending leave" : "Leave"}
            </span>
          ))}
      </div>
    );
  }
  const timelines = useMemo(
    () => days.map((day) => calendarDayTimeline(day, zone)),
    [days, zone],
  );
  const stageMinutes = Math.max(...timelines.map((t) => t.minutes));
  const title =
    view === "month"
      ? dateLabel(date, { month: "long", year: "numeric" })
      : `${dateLabel(days[0], { month: "short", day: "numeric" })}${days.length > 1 ? ` – ${dateLabel(days.at(-1)!, { month: "short", day: "numeric", year: "numeric" })}` : ` ${date.slice(0, 4)}`}`;
  return (
    <section className="calendar-workspace" aria-label="Calendar">
      <div className="calendar-toolbar">
        <div className="calendar-date-nav">
          <button
            onClick={() => {
              explicitDate.current = true;
              setDate(today);
            }}
          >
            Today
          </button>
          <button
            aria-label="Previous calendar period"
            onClick={() => move(-1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button aria-label="Next calendar period" onClick={() => move(1)}>
            <ChevronRight size={18} />
          </button>
          <h2>{title}</h2>
        </div>
        <div className="calendar-tools">
          <label>
            Date
            <input
              aria-label="Calendar date"
              type="date"
              value={date}
              onChange={(e) => {
                if (e.target.value) {
                  explicitDate.current = true;
                  setDate(e.target.value);
                }
              }}
            />
          </label>
          <label>
            View
            <select
              aria-label="Calendar view"
              value={view}
              onChange={(e) => {
                setView(e.target.value as CalendarView);
                setExpandedDay("");
              }}
            >
              <option value="day">Day</option>
              <option value="workweek">Work week</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </label>
          <label>
            Calendars
            <select
              aria-label="Visible calendars"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All my meetings</option>
              <option value="personal">Personal</option>
              <option value="team">Team</option>
            </select>
          </label>
          <button onClick={() => setSettingsOpen(true)}>
            Hours & availability
          </button>
        </div>
      </div>
      <div className="calendar-legend">
        <span>▣ Meeting</span>
        <span>▧ Leave</span>
        <span>◇ Holiday</span>
        <span>{zone}</span>
        <span>
          {settings?.settings
            ? "Configured working hours"
            : settings
              ? "Working-hours display fallback: Mon–Fri, 9 AM–5 PM"
              : "Working hours unknown"}
        </span>
      </div>
      {blockError && <p role="alert">{blockError}</p>}
      {loading && <p role="status">Loading this date range…</p>}
      {!loading && !error && filtered.length === 0 && (
        <p className="calendar-empty" role="status">
          No meetings in this range. Select a time to schedule one.
        </p>
      )}
      {view === "month" ? (
        <div
          className="calendar-month"
          role="group"
          aria-label="Month calendar"
        >
          {days.map((day) => {
            const events = filtered.filter(
                (m) =>
                  Date.parse(m.ends_at) >
                    Date.parse(calendarRange(day, "day", zone).from) &&
                  Date.parse(m.starts_at) <
                    Date.parse(calendarRange(day, "day", zone).to),
              ),
              visible = expandedDay === day ? events : events.slice(0, 3);
            return (
              <div
                key={day}
                className={`calendar-month-day ${day === today ? "today" : ""} ${day.slice(0, 7) !== date.slice(0, 7) ? "other-month" : ""}`}
              >
                <button
                  className="calendar-day-number"
                  aria-label={`Schedule on ${day}`}
                  onClick={() => create(day)}
                >
                  {dateLabel(day, { weekday: "short", day: "numeric" })}
                </button>
                {allDay(day)}
                {visible.map(event)}
                {events.length > 3 && (
                  <button
                    className="calendar-more"
                    onClick={() =>
                      setExpandedDay(expandedDay === day ? "" : day)
                    }
                  >
                    {expandedDay === day
                      ? "Show less"
                      : `${events.length - 3} more events`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div
            ref={grid}
            className="calendar-time-scroll"
            style={{ "--calendar-days": days.length } as React.CSSProperties}
          >
            <div className="calendar-time-header">
              <span>Time</span>
              {days.map((day) => (
                <div key={day} className={day === today ? "today" : ""}>
                  <button
                    onClick={() => {
                      setDate(day);
                      setView("day");
                    }}
                  >
                    {dateLabel(day, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                  </button>
                  <small className="calendar-work-label">
                    {work
                      .filter(
                        (d) => d.day === Temporal.PlainDate.from(day).dayOfWeek,
                      )
                      .map(
                        (d) =>
                          `${d.start}–${d.end}${d.end <= d.start ? " (+1 day)" : ""}`,
                      )
                      .join(", ") || "Nonworking day"}
                  </small>
                  {allDay(day)}
                </div>
              ))}
            </div>
            <div
              className="calendar-time-body"
              style={{ height: stageMinutes }}
            >
              <div className="calendar-hours">
                {timelines[0].slots.map((slot) => (
                  <span key={slot.minute} style={{ top: slot.minute }}>
                    {slot.label}
                    {timelines[0].minutes !== 1440 ? (
                      <small>{slot.offset}</small>
                    ) : null}
                  </span>
                ))}
              </div>
              {days.map((day, dayIndex) => {
                const timeline = timelines[dayIndex];
                const events = filtered.filter(
                  (m) =>
                    Date.parse(m.ends_at) >
                      Date.parse(calendarRange(day, "day", zone).from) &&
                    Date.parse(m.starts_at) <
                      Date.parse(calendarRange(day, "day", zone).to),
                );
                return (
                  <div
                    className="calendar-time-day"
                    key={day}
                    style={{ height: timeline.minutes }}
                  >
                    {calendarWorkingPositions(day, zone, work).map((w, i) => (
                      <div
                        className="calendar-working"
                        key={i}
                        style={{ top: w.start, height: w.end - w.start }}
                      />
                    ))}
                    {timeline.slots.map((slot) => (
                      <button
                        className="calendar-time-slot"
                        key={slot.minute}
                        style={{
                          top: slot.minute,
                          height: Math.min(60, timeline.minutes - slot.minute),
                        }}
                        aria-label={`Schedule ${slot.local.replace("T", " ")} ${zone}${timeline.minutes !== 1440 ? ` ${slot.offset}` : ""}`}
                        onClick={() => {
                          const local = Temporal.PlainDateTime.from(slot.local),
                            choice =
                              local.toZonedDateTime(zone, {
                                disambiguation: "earlier",
                              }).offset === slot.offset
                                ? "earlier"
                                : "later";
                          onCreate(
                            slot.local,
                            local
                              .add({ minutes: 30 })
                              .toString({ smallestUnit: "minute" }),
                            zone,
                            choice,
                          );
                        }}
                      >
                        {timeline.minutes !== 1440 && (
                          <span>
                            {slot.label} {slot.offset}
                          </span>
                        )}
                      </button>
                    ))}
                    {blocks?.leave
                      .filter(
                        (l) =>
                          l.starts_at &&
                          calendarDate(l.starts_at, zone) <= day &&
                          calendarDate(l.ends_at!, zone) >= day,
                      )
                      .map((l) => {
                        const position = calendarEventPosition(
                          day,
                          zone,
                          l.starts_at!,
                          l.ends_at!,
                        );
                        return (
                          <div
                            key={l.id}
                            className="calendar-leave-time"
                            style={position}
                            title={`Leave · ${l.status}`}
                          >
                            ▧{" "}
                            {l.status === "pending" ? "Pending leave" : "Leave"}
                          </div>
                        );
                      })}
                    {layoutEvents(events).map(
                      ({ event: m, column, columns }) => {
                        const position = calendarEventPosition(
                          day,
                          zone,
                          m.starts_at,
                          m.ends_at,
                        );
                        return (
                          <div
                            className="calendar-event-position"
                            key={m.id}
                            style={{
                              ...position,
                              left: `${(column / columns) * 100}%`,
                              width: `${100 / columns}%`,
                            }}
                          >
                            {event(m)}
                          </div>
                        );
                      },
                    )}
                    {day === today && (
                      <div
                        className="calendar-now"
                        role="img"
                        aria-label={`Current time ${new Intl.DateTimeFormat(undefined,{timeZone:zone,hour:"numeric",minute:"2-digit"}).format(clock)} · ${zone}`}
                        style={{
                          top: calendarEventPosition(
                            day,
                            zone,
                            new Date(clock).toISOString(),
                            new Date(clock).toISOString(),
                          ).top,
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="calendar-mobile-agenda">
            <h3>{title}</h3>
            {days.map((day) => (
              <section key={day}>
                <h4>
                  <button onClick={() => create(day)}>
                    {dateLabel(day, {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    · Schedule
                  </button>
                </h4>
                {allDay(day)}
                {filtered
                  .filter(
                    (m) =>
                      Date.parse(m.ends_at) >
                        Date.parse(calendarRange(day, "day", zone).from) &&
                      Date.parse(m.starts_at) <
                        Date.parse(calendarRange(day, "day", zone).to),
                  )
                  .map(event)}
              </section>
            ))}
          </div>
        </>
      )}
      <details className="calendar-range-agenda">
        <summary>All meetings in this range ({filtered.length})</summary>
        <div>{filtered.map(event)}</div>
      </details>
      {settingsOpen && (
        <CalendarSettings
          org={org}
          zone={zone}
          initial={settings}
          people={people}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            await readSettings();
            setRevision((x) => x + 1);
            await refresh();
          }}
        />
      )}
    </section>
  );
}
