/**
 * Runtime gating test: the timer must NOT capture outside the active window,
 * and must capture once the window opens.
 *
 * This drives the plugin's real timer with a window that is deliberately
 * closed right now, then with one that is open, and asserts on the log lines —
 * i.e. on what the scheduler actually decided, not on a helper's return value.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const STAGE = process.env.DSH_SCREENCAP_DEPS ?? new URL("../..", import.meta.url).pathname.replace(/^\//, "");
const { existsSync } = await import("node:fs");
const haveDeps = existsSync(join(STAGE, "node_modules", "@deepseek-ai", "dsh-tools"));
const SKIP = haveDeps ? false : `staged runtime deps missing (${join(STAGE, "node_modules")})`;

/** Two-digit pad. */
const p = (n) => String(n).padStart(2, "0");
/** `HH:MM` for a date offset by minutes from now. */
function clockIn(offsetMinutes) {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Find an `HH:MM-HH:MM` window that really wraps past midnight AND contains now.
 *
 * Hand-rolled offsets are time-of-day flaky: `now+600 / now+60` only reads as a
 * wrap before 14:00, so the test failed every afternoon. Searching a small
 * candidate set (anchored to the current clock, plus the two canonical
 * night windows) is time-independent and keeps the assertion honest — the test
 * verifies whatever window it actually found, and fails loudly if none exists.
 *
 * @param parse - `parseActiveHours` from the plugin.
 * @param allows - `allowsCaptureNow` from the plugin.
 * @returns the first valid wrapping window, or `null`.
 */
function findWrappingWindow(parse, allows) {
  const candidates = [];
  // A window that ENDS an hour earlier than it STARTS is a wrap, and putting the
  // start a few hours in the past guarantees "now" is in the `[start, 24:00)`
  // half. Several offsets in case one straddles midnight awkwardly.
  for (const back of [30, 120, 300, 600, 900]) {
    candidates.push(`${clockIn(-back)}-${clockIn(-back - 60)}`);
  }
  // Canonical night windows, in case one of them happens to contain now.
  candidates.push("22:00-06:00", "23:00-07:00", "20:00-08:00");
  for (const window of candidates) {
    const parsed = parse(window);
    if (parsed !== null && parsed.mode === "window" && parsed.crossDay === true && allows(window)) return window;
  }
  return null;
}

/**
 * Start the plugin and collect its log lines for `ms` milliseconds.
 *
 * The plugin's timer re-arms itself forever and `shotsDir()` resolves
 * `DSH_HOME` at call time, so the effect MUST be disposed before the
 * environment is restored — otherwise a still-armed timer writes shots into the
 * user's real `~/.dsh/screencap/shots`.
 */
async function runFor(config, ms) {
  const { apply } = await import("../index.js");
  const logs = [];
  const disposers = [];
  const ctx = {
    tools: { register: () => () => {} },
    logger: {
      info: (...a) => logs.push(`info ${a.join(" ")}`),
      warn: (...a) => logs.push(`warn ${a.join(" ")}`),
      error: (...a) => logs.push(`error ${a.join(" ")}`),
      debug: () => {},
    },
    effect: (fn) => {
      const dispose = fn();
      disposers.push(typeof dispose === "function" ? dispose : () => {});
      return dispose ?? (() => {});
    },
    on: () => () => {},
    get: () => undefined,
  };
  const home = await mkdtemp(join(tmpdir(), "dsh-sc-gate-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    apply(ctx, config);
    await new Promise((r) => setTimeout(r, ms));
    return logs;
  } finally {
    // Stop the timer FIRST, then let any in-flight capture finish, then put the
    // environment back — in that order, or a late shot lands in the real home.
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch {
        /* a disposer failure must not mask the assertions */
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test("a closed active window suppresses the capture", { skip: SKIP, timeout: 60_000 }, async () => {
  // A one-minute window that both starts and ends in the past today, so "now"
  // is unambiguously outside it (the helpers treat equal ends as all-day, so
  // the ends must differ).
  const start = clockIn(-180);
  let end = clockIn(-179);
  if (start === end) end = clockIn(-178);
  const logs = await runFor(
    { enabled: true, intervalMinutes: 1, maxWidth: 400, quality: 40, keepDays: 3, activeHours: `${start}-${end}`, skipWhenIdle: false },
    8000,
  );
  const captured = logs.filter((l) => l.includes("captured"));
  assert.deepEqual(captured, [], `nothing should be captured outside the window; got:\n${logs.join("\n")}`);
  // The scheduler must have re-armed toward the next opening, not spun.
  assert.ok(logs.some((l) => l.includes("ready")), "the plugin should log its startup line");
});

test("an open active window allows the capture", { skip: SKIP, timeout: 60_000 }, async () => {
  const start = clockIn(-60);
  let end = clockIn(60);
  if (start === end) end = clockIn(61);
  const logs = await runFor(
    { enabled: true, intervalMinutes: 1, maxWidth: 400, quality: 40, keepDays: 3, activeHours: `${start}-${end}`, skipWhenIdle: false },
    8000,
  );
  assert.ok(
    logs.some((l) => l.includes("captured")),
    `a capture is expected inside the window; got:\n${logs.join("\n")}`,
  );
});

test("a cross-midnight window that wraps over now allows the capture", { skip: SKIP, timeout: 60_000 }, async () => {
  // Build a window whose START is later in the day than its END, so it can only
  // be read as wrapping past midnight — and arrange it to contain "now". The
  // naive `start <= t <= end` comparison would call this outside and never
  // capture, so a capture here proves the wrap branch is the one running.
  const { parseActiveHours, allowsCaptureNow } = await import("../schedule.js");
  const window = findWrappingWindow(parseActiveHours, allowsCaptureNow);
  assert.ok(window !== null, "could not construct a wrapping window that contains now");
  // Re-check the window really is a wrap and really does contain now.
  const parsed = parseActiveHours(window);
  assert.equal(parsed.crossDay, true, `expected ${window} to wrap; got ${JSON.stringify(parsed)}`);
  assert.equal(allowsCaptureNow(window), true, `${window} should contain now`);

  const logs = await runFor(
    { enabled: true, intervalMinutes: 1, maxWidth: 400, quality: 40, keepDays: 3, activeHours: window, skipWhenIdle: false },
    8000,
  );
  assert.ok(
    logs.some((l) => l.includes("captured")),
    `the wrapped window ${window} must allow capture; got:\n${logs.join("\n")}`,
  );
});

test("a cross-midnight window that does NOT wrap over now suppresses the capture", { skip: SKIP, timeout: 60_000 }, async () => {
  // Same wrap direction, but shifted so "now" lands in the daytime gap.
  // start = now + 6h, end = now - 6h → inside means t >= start or t < end,
  // neither of which holds for now.
  const start = clockIn(360);
  let end = clockIn(-360);
  if (start === end) end = clockIn(-361);
  const window = `${start}-${end}`;
  const { parseActiveHours, allowsCaptureNow } = await import("../schedule.js");
  const parsed = parseActiveHours(window);
  assert.equal(parsed.crossDay, true, `expected ${window} to wrap; got ${JSON.stringify(parsed)}`);
  assert.equal(allowsCaptureNow(window), false, `${window} should exclude now`);

  const logs = await runFor(
    { enabled: true, intervalMinutes: 1, maxWidth: 400, quality: 40, keepDays: 3, activeHours: window, skipWhenIdle: false },
    8000,
  );
  assert.deepEqual(
    logs.filter((l) => l.includes("captured")),
    [],
    `the wrapped window must block capture; got:\n${logs.join("\n")}`,
  );
});

test("a malformed window warns once and still captures", { skip: SKIP, timeout: 60_000 }, async () => {
  const logs = await runFor(
    { enabled: true, intervalMinutes: 1, maxWidth: 400, quality: 40, keepDays: 3, activeHours: "8am-11pm", skipWhenIdle: false },
    8000,
  );
  const warnings = logs.filter((l) => l.startsWith("warn") && l.includes("activeHours"));
  assert.equal(warnings.length, 1, `the typo must warn exactly once, got:\n${logs.join("\n")}`);
  assert.ok(logs.some((l) => l.includes("captured")), "a typo must not stop capture");
});

test("a disabled plugin never captures", { skip: SKIP, timeout: 60_000 }, async () => {
  const logs = await runFor(
    { enabled: false, intervalMinutes: 1, maxWidth: 400, quality: 40, keepDays: 3, activeHours: "", skipWhenIdle: false },
    8000,
  );
  assert.deepEqual(logs.filter((l) => l.includes("captured")), [], "a disabled plugin must stay quiet");
});
