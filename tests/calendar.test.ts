import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarRange,
  calendarDays,
  calendarDate,
  layoutEvents,
  workingIntervals,
  withinWorkingHours,
} from "../lib/calendar.ts";
test("calendar ranges use local midnight across DST and retain date-only month boundaries", () => {
  assert.deepEqual(calendarRange("2026-03-08", "day", "America/New_York"), {
    from: "2026-03-08T05:00:00Z",
    to: "2026-03-09T04:00:00Z",
  });
  assert.deepEqual(calendarRange("2026-11-01", "day", "America/New_York"), {
    from: "2026-11-01T04:00:00Z",
    to: "2026-11-02T05:00:00Z",
  });
  assert.equal(calendarDays("2026-10-21", "workweek")[0], "2026-10-19");
  assert.equal(calendarDays("2026-10-21", "month").length, 42);
  assert.equal(
    calendarDate("2026-10-21T00:30:00Z", "America/Los_Angeles"),
    "2026-10-20",
  );
});
test("overlapping meetings occupy distinct lanes; adjacent meetings reuse the full width", () => {
  const events = [
    {
      id: "a",
      starts_at: "2026-10-21T09:00:00Z",
      ends_at: "2026-10-21T10:00:00Z",
    },
    {
      id: "b",
      starts_at: "2026-10-21T09:30:00Z",
      ends_at: "2026-10-21T11:00:00Z",
    },
    {
      id: "c",
      starts_at: "2026-10-21T11:00:00Z",
      ends_at: "2026-10-21T12:00:00Z",
    },
  ];
  assert.deepEqual(
    layoutEvents(events).map((x) => [x.event.id, x.column, x.columns]),
    [
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 0, 1],
    ],
  );
});
test("per-day overnight working hours include the following civil day and reject nonworking time", () => {
  const days = [{ day: 1, start: "22:00", end: "06:00" }];
  assert.deepEqual(workingIntervals("2026-10-20", days), [
    { start: 0, end: 360 },
  ]);
  assert.equal(
    withinWorkingHours(
      "2026-10-19T23:00:00Z",
      "2026-10-20T05:00:00Z",
      "UTC",
      days,
    ),
    true,
  );
  assert.equal(
    withinWorkingHours(
      "2026-10-20T05:00:00Z",
      "2026-10-20T07:00:00Z",
      "UTC",
      days,
    ),
    false,
  );
});

test("DST grids preserve repeated-hour ordering and real elapsed duration", async () => {
  const {
    calendarDayTimeline,
    calendarEventPosition,
    calendarWorkingPositions,
  } = await import("../lib/calendar.ts");
  const fold = calendarDayTimeline("2026-11-01", "America/New_York");
  assert.equal(fold.minutes, 1500);
  assert.deepEqual(
    fold.slots.slice(1, 3).map((x) => [x.label, x.offset]),
    [
      ["01:00", "-04:00"],
      ["01:00", "-05:00"],
    ],
  );
  assert.equal(
    calendarDayTimeline("2026-03-08", "America/New_York").minutes,
    1380,
  );
  assert.deepEqual(
    calendarEventPosition(
      "2026-11-01",
      "America/New_York",
      "2026-11-01T05:30:00Z",
      "2026-11-01T06:15:00Z",
    ),
    { top: 90, height: 45 },
  );
  assert.deepEqual(
    calendarWorkingPositions("2026-11-01", "America/New_York", [
      { day: 7, start: "00:30", end: "03:30" },
    ]),
    [{ start: 30, end: 270 }],
  );
});

test("work week follows configured weekdays and adjoining shifts form continuous working time", () => {
  assert.deepEqual(calendarDays("2026-10-21", "workweek", [2, 4, 7]), [
    "2026-10-20",
    "2026-10-22",
    "2026-10-25",
  ]);
  assert.equal(
    withinWorkingHours("2026-10-20T05:00:00Z", "2026-10-20T07:00:00Z", "UTC", [
      { day: 1, start: "22:00", end: "06:00" },
      { day: 2, start: "06:00", end: "17:00" },
    ]),
    true,
  );
});
