/**
 * Capture-triggered inspection: the pure helpers and the end-to-end wake-up.
 *
 * Three layers are pinned down separately, because each has a different failure
 * mode:
 *
 *   1. `expandInspectPrompt` — placeholder substitution (pure).
 *   2. `pickInspectSession` — target choice and its refusal to guess (pure).
 *   3. The real timer path — a capture must actually hand a `schedule`-sourced
 *      user message to `agent.followup()` and ask the Session to flush, and a
 *      missing target must warn instead of throwing.
 *
 * Skipped (with a clear message) when the staged dependencies are absent.
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const STAGE = process.env.DSH_SCREENCAP_DEPS ?? new URL("../..", import.meta.url).pathname.replace(/^\//, "");
const haveDeps = existsSync(join(STAGE, "node_modules", "@deepseek-ai", "dsh-tools"));
const SKIP = haveDeps ? false : `staged runtime deps missing (${join(STAGE, "node_modules")})`;

test("expandInspectPrompt substitutes path and time, and leaves typos alone", { skip: SKIP }, async () => {
  const { expandInspectPrompt } = await import("../index.js");
  const when = new Date("2026-10-03T02:15:00.000Z");
  const out = expandInspectPrompt("shot={{path}} at {{time}} {{nope}}", "C:\\a\\shot.jpg", when);
  assert.equal(out, "shot=C:\\a\\shot.jpg at 2026-10-03T02:15:00.000Z {{nope}}");
});

test("expandInspectPrompt replaces every occurrence", { skip: SKIP }, async () => {
  const { expandInspectPrompt } = await import("../index.js");
  const out = expandInspectPrompt("{{path}} {{path}}", "/x/y.jpg", new Date(0));
  assert.equal(out, "/x/y.jpg /x/y.jpg");
});

test("pickInspectSession prefers the explicit id over everything else", { skip: SKIP }, async () => {
  const { pickInspectSession } = await import("../index.js");
  const agents = { roots: () => [{ id: "root-1" }] };
  const listed = async () => ["listed-3"];
  assert.equal(await pickInspectSession("explicit-9", "recent-2", agents, listed), "explicit-9");
});

test("pickInspectSession falls back to the most recent human session", { skip: SKIP }, async () => {
  const { pickInspectSession } = await import("../index.js");
  const agents = { roots: () => [{ id: "root-1" }, { id: "root-2" }] };
  assert.equal(await pickInspectSession("", "recent-2", agents, async () => ["listed-3"]), "recent-2");
});

test("pickInspectSession uses the newest listed Session before the lone-root rule", { skip: SKIP }, async () => {
  const { pickInspectSession } = await import("../index.js");
  const agents = { roots: () => [{ id: "a" }, { id: "b" }] };
  assert.equal(await pickInspectSession("", null, agents, async () => ["newest", "older"]), "newest");
});

test("pickInspectSession ignores an empty or failing listing", { skip: SKIP }, async () => {
  const { pickInspectSession } = await import("../index.js");
  const one = { roots: () => [{ id: "only" }] };
  assert.equal(await pickInspectSession("", null, one, async () => []), "only");
  assert.equal(await pickInspectSession("", null, one, async () => [""]), "only");
  assert.equal(await pickInspectSession("", null, one, async () => { throw new Error("nope"); }), "only");
  // A broken listing must not mask a genuinely ambiguous choice.
  assert.equal(await pickInspectSession("", null, { roots: () => [{ id: "a" }, { id: "b" }] }, async () => { throw new Error("nope"); }), null);
});

test("pickInspectSession uses a lone live root only when there is exactly one", { skip: SKIP }, async () => {
  const { pickInspectSession } = await import("../index.js");
  assert.equal(await pickInspectSession("", null, { roots: () => [{ id: "only" }] }), "only");
  // Ambiguous: two roots and no history — refuse rather than guess.
  assert.equal(await pickInspectSession("", null, { roots: () => [{ id: "a" }, { id: "b" }] }), null);
  assert.equal(await pickInspectSession("", null, { roots: () => [] }), null);
  // A host without an `agents` service must not throw.
  assert.equal(await pickInspectSession("", null, undefined), null);
});

/**
 * Start the plugin against a stub host, let the first tick capture, and report
 * what the plugin handed to `agent.followup()`.
 *
 * @param config - plugin config override.
 * @param services - extra services the stub `ctx.get()` should answer.
 * @returns the captured log lines and the delivered messages.
 */
async function runInspect(config, services = {}) {
  const { apply } = await import("../index.js");
  const logs = [];
  const delivered = [];
  const flushed = [];
  const listeners = [];
  const disposers = [];
  const session = { id: "session-target" };
  const agent = {
    id: "session-target",
    session,
    followup: (message) => { delivered.push(message); },
  };
  const merged = {
    sessionController: { resolveAgent: async () => ({ agent }) },
    agents: { get: () => agent, roots: () => [agent] },
    sessions: { flush: async (s) => { flushed.push(s); return true; } },
    ...services,
  };
  const ctx = {
    tools: { register: () => () => {} },
    logger: {
      info: (...a) => logs.push(`info ${a.join(" ")}`),
      warn: (...a) => logs.push(`warn ${a.join(" ")}`),
      error: (...a) => logs.push(`error ${a.join(" ")}`),
      debug: () => {},
    },
    // Collect every disposer. The plugin's timer re-arms itself forever, and
    // `shotsDir()` resolves DSH_HOME at call time — so a timer left armed past
    // the end of this function would write shots into the REAL
    // `~/.dsh/screencap/shots` once the environment is restored. Disposal is
    // what makes the temp home the only place a test can write.
    effect: (fn, label) => {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      else disposers.push(() => {});
      return dispose ?? (() => {});
    },
    on: (event, handler) => { listeners.push({ event, handler }); return () => {}; },
    get: (name) => merged[name],
  };
  const home = await mkdtemp(join(tmpdir(), "dsh-sc-inspect-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let closed = false;
  /** Stop the timer, then restore the environment and remove the temp home. */
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch {
        /* a disposer failure must not mask the test result */
      }
    }
    // A capture already in flight may still be finishing; give it a beat so it
    // cannot land after the env is restored.
    await new Promise((r) => setTimeout(r, 1500));
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  };
  try {
    apply(ctx, config);
    // Let the effect body (and its `arm(MIN_TICK_MS)`) run before the caller
    // fires any synthetic events.
    await new Promise((r) => setTimeout(r, 50));
    return {
      logs,
      delivered,
      flushed,
      listeners,
      close,
      /**
       * Poll until `predicate()` holds, or fail after `timeoutMs`.
       *
       * The first tick is armed at MIN_TICK_MS (5s), and the capture itself
       * spawns PowerShell, so a fixed sleep is both slow and flaky.
       */
      async waitFor(predicate, timeoutMs = 30_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (predicate()) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Fire every listener registered for one event name. */
function emit(listeners, event, ...args) {
  const hits = listeners.filter((l) => l.event === event);
  for (const hit of hits) hit.handler(...args);
  return hits.length;
}

test("a capture wakes the agent with a schedule-sourced message and flushes", { skip: SKIP, timeout: 90_000 }, async () => {
  const run = await runInspect({
    enabled: true,
    intervalMinutes: 1,
    maxWidth: 400,
    quality: 40,
    keepDays: 3,
    activeHours: "",
    skipWhenIdle: false,
    inspectEnabled: true,
    inspectPrompt: "look at {{path}}",
    inspectSessionId: "session-target",
  });

  const woke = await run.waitFor(() => run.delivered.length > 0);
  const { logs, delivered, flushed } = run;
  try {
    assert.ok(woke, `a follow-up is expected; got:\n${logs.join("\n")}`);
    assert.equal(delivered.length, 1, `exactly one follow-up is expected; got:\n${logs.join("\n")}`);
    const [message] = delivered;
    assert.equal(message.role, "user");
    assert.equal(message.source.kind, "schedule");
    assert.ok(typeof message.id === "string" && message.id.length > 0, "the message needs a stable id");
    assert.equal(message.content.length, 1);
    assert.equal(message.content[0].type, "text");
    assert.ok(message.content[0].text.startsWith("look at "), `the prompt must be expanded: ${message.content[0].text}`);
    assert.ok(/shot_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.jpg$/.test(message.content[0].text), `the path must be the shot: ${message.content[0].text}`);
    assert.deepEqual(flushed.map((s) => s.id), ["session-target"], "the Session must be asked to flush");
  } finally {
    await run.close();
  }
});

test("inspect off means no follow-up at all", { skip: SKIP, timeout: 90_000 }, async () => {
  const run = await runInspect({
    enabled: true,
    intervalMinutes: 1,
    maxWidth: 400,
    quality: 40,
    keepDays: 3,
    activeHours: "",
    skipWhenIdle: false,
    inspectEnabled: false,
  });
  try {
    const captured = await run.waitFor(() => run.logs.some((l) => l.includes("captured")));
    assert.ok(captured, `a capture is still expected; got:\n${run.logs.join("\n")}`);
    // Give a would-be (wrong) notification time to show up before asserting none.
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(run.delivered, [], "nothing may be delivered while inspect is off");
  } finally {
    await run.close();
  }
});

test("an ambiguous target warns and does not throw", { skip: SKIP, timeout: 90_000 }, async () => {
  const run = await runInspect({
    enabled: true,
    intervalMinutes: 1,
    maxWidth: 400,
    quality: 40,
    keepDays: 3,
    activeHours: "",
    skipWhenIdle: false,
    inspectEnabled: true,
    inspectSessionId: "",
  }, {
    // Two live roots and no remembered human session: the plugin must refuse.
    agents: { get: () => undefined, roots: () => [{ id: "a" }, { id: "b" }] },
    sessionController: undefined,
  });
  try {
    const warned = await run.waitFor(() => run.logs.some((l) => l.startsWith("warn") && l.includes("no target Session")));
    assert.ok(warned, `a warning is expected; got:\n${run.logs.join("\n")}`);
    assert.deepEqual(run.delivered, [], "an ambiguous target must deliver nothing");
    // The capture itself must still have happened.
    assert.ok(run.logs.some((l) => l.includes("captured")), "the shot must still be taken");
  } finally {
    await run.close();
  }
});

test("a failing resume is logged, not thrown, and the shot survives", { skip: SKIP, timeout: 90_000 }, async () => {
  const run = await runInspect({
    enabled: true,
    intervalMinutes: 1,
    maxWidth: 400,
    quality: 40,
    keepDays: 3,
    activeHours: "",
    skipWhenIdle: false,
    inspectEnabled: true,
    inspectSessionId: "session-target",
  }, {
    sessionController: { resolveAgent: async () => ({ error: new Error("writer-held") }) },
    agents: { get: () => undefined, roots: () => [] },
  });
  try {
    const warned = await run.waitFor(() => run.logs.some((l) => l.startsWith("warn") && l.includes("writer-held")));
    assert.ok(warned, `the resume failure must be reported; got:\n${run.logs.join("\n")}`);
    assert.deepEqual(run.delivered, [], "nothing may be delivered when the resume failed");
    assert.ok(run.logs.some((l) => l.includes("captured")), "the shot must still be taken");
  } finally {
    await run.close();
  }
});

test("api-session/activity retargets the wake-up to the newest human Session", { skip: SKIP, timeout: 90_000 }, async () => {
  const { pickInspectSession } = await import("../index.js");
  // Two live roots make the automatic choice ambiguous...
  const run = await runInspect({
    enabled: true,
    intervalMinutes: 1,
    maxWidth: 400,
    quality: 40,
    keepDays: 3,
    activeHours: "",
    skipWhenIdle: false,
    inspectEnabled: true,
    inspectPrompt: "peek",
    inspectSessionId: "",
  }, {
    agents: { get: () => undefined, roots: () => [{ id: "a" }, { id: "b" }] },
    sessionController: undefined,
  });

  try {
    // ...until the controller reports human activity in one of them.
    const listeners = emit(run.listeners, "api-session/activity", "session-human");
    assert.equal(listeners, 1, "the plugin must listen for human session activity");
    assert.equal(await pickInspectSession("", "session-human", undefined), "session-human");
    // With no agent reachable for that Session, the plugin must warn about the
    // *resolved* id rather than about being unable to choose one.
    const settled = await run.waitFor(() => run.logs.some((l) => l.startsWith("warn") && l.includes("session-human")));
    assert.ok(settled, `a warning naming the chosen Session is expected; got:\n${run.logs.join("\n")}`);
    assert.deepEqual(run.delivered, [], "no agent was reachable, so nothing may be delivered");
  } finally {
    await run.close();
  }
});
