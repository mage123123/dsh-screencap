/**
 * Unit tests for the pure scheduling helpers.
 *
 * Run with: node --test tests/schedule.test.mjs
 *
 * The cross-midnight window is the part worth pinning down: `"22:00-06:00"` is
 * the case a naive `start <= t && t <= end` comparison silently gets wrong (it
 * would never match), so every boundary is asserted here.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  allowsCaptureNow,
  isWithinWindow,
  minutesOfDay,
  msUntilClock,
  parseActiveHours,
} from "../schedule.js";

/** Local date at a given `HH:MM` — the helpers read local time. */
const at = (hh, mm) => new Date(2026, 9, 1, hh, mm, 0, 0);

test("empty / missing activeHours means all day", () => {
  assert.deepEqual(parseActiveHours(""), { mode: "always" });
  assert.deepEqual(parseActiveHours("   "), { mode: "always" });
  assert.deepEqual(parseActiveHours(undefined), { mode: "always" });
  assert.deepEqual(parseActiveHours(null), { mode: "always" });
  for (const h of [0, 6, 12, 23]) {
    assert.equal(allowsCaptureNow("", at(h, 30)), true);
  }
});

test("same start and end means all day, not never", () => {
  assert.deepEqual(parseActiveHours("08:00-08:00"), { mode: "always" });
  assert.equal(allowsCaptureNow("08:00-08:00", at(3, 0)), true);
  assert.equal(allowsCaptureNow("08:00-08:00", at(20, 0)), true);
});

test("a same-day window is half-open at the end", () => {
  const w = parseActiveHours("08:00-23:00");
  assert.deepEqual(w, { mode: "window", start: 480, end: 1380, crossDay: false });
  assert.equal(isWithinWindow(w, 479), false); // 07:59
  assert.equal(isWithinWindow(w, 480), true); // 08:00 inclusive
  assert.equal(isWithinWindow(w, 1379), true); // 22:59
  assert.equal(isWithinWindow(w, 1380), false); // 23:00 exclusive
});

test("abutting windows never both claim the shared edge", () => {
  const morning = parseActiveHours("08:00-12:00");
  const afternoon = parseActiveHours("12:00-18:00");
  assert.equal(isWithinWindow(morning, 720), false);
  assert.equal(isWithinWindow(afternoon, 720), true);
});

test("a cross-midnight window wraps past 00:00", () => {
  const w = parseActiveHours("22:00-06:00");
  assert.deepEqual(w, { mode: "window", start: 1320, end: 360, crossDay: true });

  // Inside: the evening tail.
  assert.equal(isWithinWindow(w, 1320), true); // 22:00 inclusive
  assert.equal(isWithinWindow(w, 1400), true); // 23:20
  assert.equal(isWithinWindow(w, 1439), true); // 23:59
  // Inside: the morning head (this is the half a naive compare misses).
  assert.equal(isWithinWindow(w, 0), true); // 00:00
  assert.equal(isWithinWindow(w, 200), true); // 03:20
  assert.equal(isWithinWindow(w, 359), true); // 05:59
  // Outside: the end is exclusive, and the whole middle of the day.
  assert.equal(isWithinWindow(w, 360), false); // 06:00
  assert.equal(isWithinWindow(w, 720), false); // 12:00
  assert.equal(isWithinWindow(w, 1319), false); // 21:59
});

test("allowsCaptureNow reads local wall-clock time", () => {
  assert.equal(allowsCaptureNow("22:00-06:00", at(23, 30)), true);
  assert.equal(allowsCaptureNow("22:00-06:00", at(5, 30)), true);
  assert.equal(allowsCaptureNow("22:00-06:00", at(12, 0)), false);
  assert.equal(allowsCaptureNow("08:00-23:00", at(9, 0)), true);
  assert.equal(allowsCaptureNow("08:00-23:00", at(7, 0)), false);
});

test("minutesOfDay and msUntilClock agree on the clock", () => {
  assert.equal(minutesOfDay(at(0, 0)), 0);
  assert.equal(minutesOfDay(at(23, 59)), 1439);
  // 06:00 is 3h05m away from 02:55 → 11100s.
  assert.equal(msUntilClock(360, at(2, 55)), 11_100_000);
  // A target already past rolls over to tomorrow, and never returns 0.
  assert.equal(msUntilClock(0, at(0, 0)), 86_400_000);
  assert.ok(msUntilClock(0, at(12, 0)) > 0);
});

test("malformed windows are reported as null so callers fall back", () => {
  for (const bad of ["8:00", "08:00", "08:00-", "-08:00", "08:00-23:00-01:00", "24:00-25:00", "aa:bb-cc:dd", "08:60-09:00"]) {
    assert.equal(parseActiveHours(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  // A null window must not block capture — a typo should not silently kill
  // the feature.
  assert.equal(isWithinWindow(null, 600), true);
  assert.equal(allowsCaptureNow("nonsense", at(12, 0)), true);
});

test("single-digit hours and surrounding spaces are tolerated", () => {
  assert.deepEqual(parseActiveHours("8:00-23:00"), { mode: "window", start: 480, end: 1380, crossDay: false });
  // Each side is trimmed, so padding around a clock is harmless.
  assert.deepEqual(parseActiveHours(" 22:00 - 06:00 "), { mode: "window", start: 1320, end: 360, crossDay: true });
  assert.deepEqual(parseActiveHours("22:00-6:00"), { mode: "window", start: 1320, end: 360, crossDay: true });
});
