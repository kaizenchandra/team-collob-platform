"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect } from "react";
import { api, type Person } from "@/lib/contracts";
import { fallbackDays, type WorkDay } from "@/lib/calendar";
import { resolveMeetingTime } from "@/lib/meeting-time";
import { Modal } from "./primitives";
import type { CalendarSettingsData } from "./calendar-canvas";
const weekdays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
export function CalendarSettings({
  org,
  zone,
  initial,
  onClose,
  onSaved,
}: {
  org: string;
  zone: string;
  initial: CalendarSettingsData | null;
  people: Person[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [timezone, setTimezone] = useState(initial?.settings?.timezone ?? zone),
    [days, setDays] = useState<WorkDay[]>(
      initial?.settings?.days ?? fallbackDays,
    ),
    [calendar, setCalendar] = useState(
      initial?.settings?.holiday_calendar ?? "Company",
    ),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<
      {
        id: string;
        name: string;
        first_day: string | null;
        last_day: string | null;
        starts_at: string | null;
        ends_at: string | null;
      }[]
    >([]);
  const [ownLeave, setOwnLeave] = useState<
      {
        id: string;
        status: string;
        first_day: string | null;
        last_day: string | null;
        starts_at: string | null;
        ends_at: string | null;
      }[]
    >([]),
    [year, setYear] = useState(() => new Date().getFullYear()),
    [holidays, setHolidays] = useState<
      { id: string; day: string; title: string; calendar: string }[]
    >([]);
  const [allDay, setAllDay] = useState(true),
    [first, setFirst] = useState(""),
    [last, setLast] = useState("");
  const [holiday, setHoliday] = useState(""),
    [holidayDay, setHolidayDay] = useState(""),
    [holidayCalendar, setHolidayCalendar] = useState(calendar);
  async function approvals() {
    setOwnLeave(
      (
        await api<{ leave: typeof ownLeave }>(
          `/organizations/${org}/calendar/my-leave`,
        )
      ).leave,
    );
    if (initial?.canManage) {
      setHolidays(
        (
          await api<{ holidays: typeof holidays }>(
            `/organizations/${org}/calendar/holidays?year=${year}`,
          )
        ).holidays,
      );
    }
    if (initial?.canManage)
      setPending(
        (
          await api<{ leave: typeof pending }>(
            `/organizations/${org}/calendar/leave`,
          )
        ).leave,
      );
  }
  useEffect(() => {
    let active = true;
    if (initial?.canManage)
      void api<{ leave: typeof pending }>(
        `/organizations/${org}/calendar/leave`,
      )
        .then((x) => {
          if (active) setPending(x.leave);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [org, initial?.canManage]);
  useEffect(() => {
    const c = new AbortController();
    void api<{ leave: typeof ownLeave }>(
      `/organizations/${org}/calendar/my-leave`,
      "GET",
      undefined,
      c.signal,
    )
      .then((x) => {
        if (!c.signal.aborted) setOwnLeave(x.leave);
      })
      .catch(() => {
        if (!c.signal.aborted)
          setError("Your leave requests could not be loaded.");
      });
    if (initial?.canManage)
      void api<{ holidays: typeof holidays }>(
        `/organizations/${org}/calendar/holidays?year=${year}`,
        "GET",
        undefined,
        c.signal,
      )
        .then((x) => {
          if (!c.signal.aborted) setHolidays(x.holidays);
        })
        .catch(() => {
          if (!c.signal.aborted) setError("Holidays could not be loaded.");
        });
    return () => c.abort();
  }, [org, year, initial?.canManage]);
  async function run(fn: () => Promise<void>, message: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await fn();
      await onSaved();
      await approvals();
      setStatus(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Hours & availability"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-body calendar-settings">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`/organizations/${org}/calendar/settings`, "PUT", {
                timezone,
                days,
                holidayCalendar: calendar,
              });
            }, "Working hours saved.");
          }}
        >
          <h3>Working hours</h3>
          <p>
            One shift per working day. An end time before the start continues
            into the next day. These hours warn about conflicts; they do not
            block scheduling.
          </p>
          <label>
            Working timezone
            <input
              required
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/New_York"
            />
          </label>
          {weekdays.map((name, i) => {
            const d = days.find((x) => x.day === i + 1);
            return (
              <div className="calendar-shift" key={name}>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={Boolean(d)}
                    onChange={(e) =>
                      setDays((old) =>
                        e.target.checked
                          ? [
                              ...old,
                              { day: i + 1, start: "09:00", end: "17:00" },
                            ]
                          : old.filter((x) => x.day !== i + 1),
                      )
                    }
                  />
                  {name}
                </label>
                {d && (
                  <>
                    <input
                      type="time"
                      required
                      aria-label={`${name} work starts`}
                      value={d.start}
                      onChange={(e) =>
                        setDays((old) =>
                          old.map((x) =>
                            x.day === i + 1
                              ? { ...x, start: e.target.value }
                              : x,
                          ),
                        )
                      }
                    />
                    <input
                      type="time"
                      required
                      aria-label={`${name} work ends`}
                      value={d.end}
                      onChange={(e) =>
                        setDays((old) =>
                          old.map((x) =>
                            x.day === i + 1 ? { ...x, end: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </>
                )}
              </div>
            );
          })}
          <label>
            Assigned holiday calendar
            <select
              value={calendar}
              onChange={(e) => setCalendar(e.target.value)}
            >
              {[
                ...new Set([
                  "Company",
                  ...(initial?.calendars ?? []),
                  calendar,
                ]),
              ].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <p>
            No public holidays are assumed. Select the calendar applicable to
            your work location; an administrator maintains its dates.
          </p>
          <button className="primary" disabled={busy}>
            Save working hours
          </button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(
                `/organizations/${org}/calendar/leave`,
                "POST",
                allDay
                  ? { allDay: true, firstDay: first, lastDay: last }
                  : {
                      allDay: false,
                      startsAt: resolveMeetingTime(first, timezone),
                      endsAt: resolveMeetingTime(last, timezone),
                    },
              );
              setFirst("");
              setLast("");
            }, "Leave requested. It remains pending until an administrator approves it.");
          }}
        >
          <h3>Request leave</h3>
          <label className="check-label">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => {
                setAllDay(e.target.checked);
                setFirst("");
                setLast("");
              }}
            />
            Full-day leave
          </label>
          <label>
            Leave starts
            <input
              required
              type={allDay ? "date" : "datetime-local"}
              value={first}
              onChange={(e) => setFirst(e.target.value)}
            />
          </label>
          <label>
            Leave ends (inclusive for full days)
            <input
              required
              type={allDay ? "date" : "datetime-local"}
              value={last}
              onChange={(e) => setLast(e.target.value)}
            />
          </label>
          <button disabled={busy}>Request leave</button>
        </form>
        <section>
          <h3>Your leave requests</h3>
          {ownLeave.length ? (
            ownLeave.map((l) => (
              <div className="calendar-approval" key={l.id}>
                <p>
                  {l.first_day
                    ? `${l.first_day} – ${l.last_day}`
                    : `${l.starts_at} – ${l.ends_at}`}{" "}
                  · {l.status}
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `/organizations/${org}/calendar/leave/${l.id}`,
                        "PATCH",
                        { status: "cancelled" },
                      );
                    }, "Leave cancelled.")
                  }
                >
                  Cancel leave
                </button>
              </div>
            ))
          ) : (
            <p>No active leave requests.</p>
          )}
        </section>
        {initial?.canManage && (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api(`/organizations/${org}/calendar/holidays`, "POST", {
                    title: holiday,
                    day: holidayDay,
                    calendar: holidayCalendar,
                  });
                  setHoliday("");
                }, "Holiday saved.");
              }}
            >
              <h3>Manage holidays</h3>
              <label>
                Holiday calendar / location
                <input
                  required
                  maxLength={100}
                  value={holidayCalendar}
                  onChange={(e) => setHolidayCalendar(e.target.value)}
                />
              </label>
              <label>
                Holiday name
                <input
                  required
                  maxLength={200}
                  value={holiday}
                  onChange={(e) => setHoliday(e.target.value)}
                />
              </label>
              <label>
                Holiday date
                <input
                  type="date"
                  required
                  value={holidayDay}
                  onChange={(e) => setHolidayDay(e.target.value)}
                />
              </label>
              <button disabled={busy}>Add holiday</button>
            </form>
            <section>
              <h3>Saved holidays</h3>
              <label>
                Holiday year
                <input
                  type="number"
                  min="1900"
                  max="9998"
                  value={year}
                  onChange={(e) => {
                    const y = Number(e.target.value);
                    if (y >= 1900 && y <= 9998) setYear(y);
                  }}
                />
              </label>
              {holidays.map((h) => (
                <div className="calendar-approval" key={h.id}>
                  <p>
                    {h.day} · {h.title} · {h.calendar}
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(
                          `/organizations/${org}/calendar/holidays/${h.id}`,
                          "DELETE",
                        );
                      }, "Holiday removed.")
                    }
                  >
                    Remove holiday
                  </button>
                </div>
              ))}
              <h3>Pending leave approvals</h3>
              {pending.length ? (
                pending.map((l) => (
                  <div className="calendar-approval" key={l.id}>
                    <p>
                      {l.name} ·{" "}
                      {l.first_day
                        ? `${l.first_day} – ${l.last_day}`
                        : `${l.starts_at} – ${l.ends_at}`}
                    </p>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(
                            `/organizations/${org}/calendar/leave/${l.id}`,
                            "PATCH",
                            { status: "approved" },
                          );
                        }, "Leave approved.")
                      }
                    >
                      Approve
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(
                            `/organizations/${org}/calendar/leave/${l.id}`,
                            "PATCH",
                            { status: "cancelled" },
                          );
                        }, "Leave cancelled.")
                      }
                    >
                      Cancel request
                    </button>
                  </div>
                ))
              ) : (
                <p>No requests awaiting approval.</p>
              )}
            </section>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        {busy && <p role="status">Saving…</p>}
      </div>
    </Modal>
  );
}
export function SchedulingAvailability({
  org,
  people,
  userIds,
  start,
  end,
  timezone,
  excludeMeeting,
}: {
  org: string;
  people: Person[];
  userIds: string[];
  start: string;
  end: string;
  timezone: string;
  excludeMeeting?: string;
}) {
  const [result, setResult] = useState<
      { userId: string; status: string; reasons: string[] }[] | null
    >(null),
    [error, setError] = useState("");
  const signature = JSON.stringify([...new Set(userIds)].sort());
  useEffect(() => {
    const c = new AbortController();
    setResult(null);
    setError("");
    const timer = setTimeout(() => {
      try {
        const startsAt = resolveMeetingTime(start, timezone),
          endsAt = resolveMeetingTime(end, timezone);
        if (Date.parse(endsAt) <= Date.parse(startsAt))
          throw new Error(
            "Choose a valid start and end time to check availability.",
          );
        void api<{ availability: NonNullable<typeof result> }>(
          `/organizations/${org}/calendar/availability`,
          "POST",
          {
            startsAt,
            endsAt,
            userIds: JSON.parse(signature),
            ...(excludeMeeting ? { excludeMeeting } : {}),
          },
          AbortSignal.any([c.signal, AbortSignal.timeout(8000)]),
        )
          .then((x) => {
            if (!c.signal.aborted) setResult(x.availability);
          })
          .catch(() => {
            if (!c.signal.aborted)
              setError(
                "Availability unavailable. Attendees must confirm their availability.",
              );
          });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Availability unknown");
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [org, signature, start, end, timezone, excludeMeeting]);
  return (
    <section
      className="calendar-availability"
      aria-label="Attendee availability"
    >
      <h3>Availability</h3>
      <p>
        Conflicts warn; they do not block invitations. Unconfigured working
        hours remain unknown.
      </p>
      {error ? (
        <p role="status">{error}</p>
      ) : !result ? (
        <p role="status">Checking availability…</p>
      ) : (
        <ul>
          {result.map((r) => (
            <li key={r.userId}>
              <strong>
                {people.find((p) => p.id === r.userId)?.name ?? "Attendee"}
              </strong>{" "}
              · {r.status === "available" ? "Available" : r.reasons.join(" · ")}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
