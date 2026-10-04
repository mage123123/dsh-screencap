/**
 * dsh-screencap — pure scheduling helpers.
 *
 * Kept in a separate module (no host imports) so both `index.js` and the unit
 * tests can use it, and so the time-window logic is testable without a running
 * DSH host.
 *
 * @module dsh-screencap/schedule
 */

/** Minutes in one day. */
const DAY = 24 * 60;

/**
 * Parse one `HH:MM` clock value into minutes since midnight.
 *
 * @param text - the raw clock string.
 * @returns minutes since midnight, or `null` when the value is not a clock.
 */
function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (m === null) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * Parse an `HH:MM-HH:MM` active-hours window.
 *
 * Accepted forms:
 *   - `""` (or whitespace)  → `{ mode: "always" }` — no time restriction.
 *   - `"08:00-23:00"`       → `{ mode: "window", start: 480, end: 1380, crossDay: false }`
 *   - `"22:00-06:00"`       → `{ mode: "window", start: 1320, end: 360, crossDay: true }`
 *   - `"08:00-08:00"`       → `{ mode: "always" }` — identical ends mean all day.
 *
 * Anything else returns `null`; callers treat that as "misconfigured" and fall
 * back to unrestricted capture rather than silently never capturing.
 *
 * @param text - the raw `activeHours` setting.
 * @returns the parsed window, or `null` when the text is not a valid window.
 */
export function parseActiveHours(text) {
  if (text === undefined || text === null) return { mode: "always" };
  const raw = String(text).trim();
  if (raw === "") return { mode: "always" };

  // Split on a single dash. Both clocks contain no dash, so the first split
  // point is unambiguous; reject anything with extra parts.
  const parts = raw.split("-");
  if (parts.length !== 2) return null;

  const start = parseClock(parts[0]);
  const end = parseClock(parts[1]);
  if (start === null || end === null) return null;
  if (start === end) return { mode: "always" };

  return {
    mode: "window",
    start,
    end,
    // A window whose end is not after its start wraps past midnight, e.g.
    // 22:00-06:00 (1320 → 360).
    crossDay: end < start,
  };
}

/**
 * Whether a local clock time falls inside an active-hours window.
 *
 * Cross-midnight handling: when the window wraps (`crossDay`), the day is
 * split into two segments — `[start, 24:00)` and `[00:00, end)` — and the time
 * is inside when it matches EITHER. There is no single `start <= t <= end`
 * comparison that can express a wrap, which is why the two cases are split.
 *
 * The window is half-open at the end (`end` itself is outside) so two abutting
 * windows such as `08:00-12:00` and `12:00-18:00` never both claim 12:00.
 *
 * @param window - a value from {@link parseActiveHours}.
 * @param minutes - minutes since local midnight.
 * @returns whether capture is allowed at that time.
 */
export function isWithinWindow(window, minutes) {
  if (window === null || window === undefined) return true;
  if (window.mode === "always") return true;
  if (window.crossDay) return minutes >= window.start || minutes < window.end;
  return minutes >= window.start && minutes < window.end;
}

/**
 * Minutes since local midnight for a date.
 *
 * @param date - the instant to read (local time).
 * @returns minutes since local midnight, 0–1439.
 */
export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Whether capture is allowed right now under the active-hours setting.
 *
 * A misconfigured `activeHours` (see {@link parseActiveHours}) does NOT block
 * capture: the plugin keeps working with no time restriction and the host logs
 * one warning. Never capturing because of a typo would be the worse failure.
 *
 * @param activeHours - the raw setting text.
 * @param date - the instant to test.
 * @returns whether the time window allows a capture now.
 */
export function allowsCaptureNow(activeHours, date = new Date()) {
  return isWithinWindow(parseActiveHours(activeHours), minutesOfDay(date));
}

/**
 * Milliseconds until the next occurrence of a local clock time.
 *
 * Used to schedule the periodic tick at a window edge instead of polling, and
 * always returns a strictly positive delay (at least one second) so a timer can
 * never spin.
 *
 * @param minutes - target minutes since local midnight.
 * @param date - the instant to measure from.
 * @returns delay in milliseconds, at least 1000.
 */
export function msUntilClock(minutes, date = new Date()) {
  const now = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  const target = minutes * 60;
  let delta = target - now;
  if (delta <= 0) delta += DAY * 60;
  return Math.max(1000, delta * 1000);
}

/** Default retention/interval floors used by both halves. */
export const LIMITS = {
  /** Interval minutes are clamped into this range. */
  minIntervalMinutes: 1,
  maxIntervalMinutes: 24 * 60,
  /** Keep-days is clamped into this range; 0 disables pruning. */
  minKeepDays: 0,
  maxKeepDays: 3650,
  /** Max width is clamped into this range; 0 disables downscaling. */
  maxWidthMax: 16384,
  /** JPEG quality is clamped into this range. */
  minQuality: 1,
  maxQuality: 100,
};
