import { Temporal } from "@js-temporal/polyfill";
export type CalendarView = "day" | "workweek" | "week" | "month";
export type WorkDay = { day: number; start: string; end: string };
export const fallbackDays: WorkDay[] = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: "09:00",
  end: "17:00",
}));
export function calendarDate(instant: string, zone: string) {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(zone)
    .toPlainDate()
    .toString();
}
export function dayInstant(day: string, zone: string) {
  return Temporal.PlainDate.from(day)
    .toZonedDateTime(zone)
    .toInstant()
    .toString();
}
export function addDays(day: string, count: number) {
  return Temporal.PlainDate.from(day).add({ days: count }).toString();
}
export function calendarDays(
  date: string,
  view: CalendarView,
  workDays?: number[],
) {
  const d = Temporal.PlainDate.from(date);
  const first =
    view === "day"
      ? d
      : view === "month"
        ? d
            .with({ day: 1 })
            .subtract({ days: d.with({ day: 1 }).dayOfWeek - 1 })
        : d.subtract({ days: d.dayOfWeek - 1 });
  const weekdays = workDays?.length
    ? [...new Set(workDays)].sort()
    : [1, 2, 3, 4, 5];
  return Array.from(
    {
      length: view === "day" ? 1 : view === "month" ? 42 : 7,
    },
    (_, i) => first.add({ days: i }).toString(),
  ).filter(
    (day) =>
      view !== "workweek" ||
      weekdays.includes(Temporal.PlainDate.from(day).dayOfWeek),
  );
}
export function calendarRange(
  date: string,
  view: CalendarView,
  zone: string,
  workDays?: number[],
) {
  const days = calendarDays(date, view, workDays);
  return {
    from: dayInstant(days[0], zone),
    to: dayInstant(addDays(days.at(-1)!, 1), zone),
  };
}
export function localMinute(instant: string, zone: string) {
  const z = Temporal.Instant.from(instant).toZonedDateTimeISO(zone);
  return z.hour * 60 + z.minute + z.second / 60;
}
const minute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
// Include the previous day's overnight shift. Intervals are local civil-time minutes.
export function workingIntervals(day: string, days: WorkDay[]) {
  const weekday = Temporal.PlainDate.from(day).dayOfWeek;
  return days.flatMap((d) => {
    const start = minute(d.start),
      end = minute(d.end);
    if (d.day === weekday) return [{ start, end: end <= start ? 1440 : end }];
    if (d.day === (weekday === 1 ? 7 : weekday - 1) && end <= start)
      return [{ start: 0, end }];
    return [];
  });
}
export function withinWorkingHours(
  start: string,
  end: string,
  zone: string,
  days: WorkDay[],
) {
  const lo = Date.parse(start),
    hi = Date.parse(end);
  if (hi <= lo) return false;
  let day = Temporal.Instant.from(start).toZonedDateTimeISO(zone).toPlainDate();
  const last = Temporal.Instant.from(end)
      .toZonedDateTimeISO(zone)
      .toPlainDate(),
    intervals: { start: number; end: number }[] = [];
  for (
    let n = 0;
    n < 368 && Temporal.PlainDate.compare(day, last) <= 0;
    n++, day = day.add({ days: 1 })
  ) {
    const key = day.toString(),
      origin = Date.parse(dayInstant(key, zone));
    intervals.push(
      ...calendarWorkingPositions(key, zone, days).map((w) => ({
        start: origin + w.start * 60000,
        end: origin + w.end * 60000,
      })),
    );
  }
  let covered = lo;
  for (const interval of intervals.sort((a, b) => a.start - b.start)) {
    if (interval.end <= covered) continue;
    if (interval.start > covered) return false;
    covered = Math.max(covered, interval.end);
    if (covered >= hi) return true;
  }
  return false;
}

export function layoutEvents<
  T extends { id: string; starts_at: string; ends_at: string },
>(events: T[]) {
  const sorted = [...events].sort(
    (a, b) =>
      Date.parse(a.starts_at) - Date.parse(b.starts_at) ||
      a.id.localeCompare(b.id),
  );
  const result: { event: T; column: number; columns: number }[] = [];
  let cluster: typeof result = [],
    until = 0;
  function flush() {
    const count = Math.max(1, ...cluster.map((x) => x.column + 1));
    cluster.forEach((x) => {
      x.columns = count;
      result.push(x);
    });
    cluster = [];
  }
  for (const event of sorted) {
    const start = Date.parse(event.starts_at);
    if (start >= until) flush();
    const used = new Set(
      cluster
        .filter((x) => Date.parse(x.event.ends_at) > start)
        .map((x) => x.column),
    );
    let column = 0;
    while (used.has(column)) column++;
    cluster.push({ event, column, columns: 1 });
    until =
      cluster.length === 1
        ? Date.parse(event.ends_at)
        : Math.max(until, Date.parse(event.ends_at));
  }
  flush();
  return result;
}

// An offset timeline keeps repeated fall-back hours distinct and omits nonexistent spring hours.
export function calendarDayTimeline(day: string, zone: string) {
  const start = Temporal.PlainDate.from(day).toZonedDateTime(zone),
    end = Temporal.PlainDate.from(day).add({ days: 1 }).toZonedDateTime(zone),
    minutes = Number(end.epochNanoseconds - start.epochNanoseconds) / 60e9;
  return {
    minutes,
    slots: Array.from({ length: Math.ceil(minutes / 60) }, (_, hour) => {
      const time = start.add({ minutes: hour * 60 });
      return {
        minute: hour * 60,
        local: time.toPlainDateTime().toString({ smallestUnit: "minute" }),
        label: `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`,
        offset: time.offset,
      };
    }),
  };
}
export function calendarEventPosition(
  day: string,
  zone: string,
  start: string,
  end: string,
) {
  const origin = Date.parse(dayInstant(day, zone)),
    limit = Date.parse(dayInstant(addDays(day, 1), zone));
  const top = Math.max(0, (Date.parse(start) - origin) / 60000),
    bottom = (Math.min(Date.parse(end), limit) - origin) / 60000;
  return { top, height: Math.max(26, bottom - top) };
}
export function calendarWorkingPositions(
  day: string,
  zone: string,
  days: WorkDay[],
) {
  const origin = Date.parse(dayInstant(day, zone));
  const at = (minute: number, end = false) => {
    const d = Temporal.PlainDate.from(day)
      .toPlainDateTime()
      .add({ minutes: minute });
    return Number(
      d.toZonedDateTime(zone, { disambiguation: end ? "later" : "compatible" })
        .epochMilliseconds,
    );
  };
  return workingIntervals(day, days).map((w) => ({
    start: (at(w.start) - origin) / 60000,
    end: (at(w.end, true) - origin) / 60000,
  }));
}
