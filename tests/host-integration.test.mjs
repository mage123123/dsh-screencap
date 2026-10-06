/**
 * Integration test for the host half.
 *
 * This imports the REAL `index.js` — `@deepseek-ai/dsh-home-paths` and
 * `@deepseek-ai/dsh-tools` come from a staged `node_modules` (see
 * `extract-deps.mjs`), and the cordis `ctx` is a hand-rolled stub that records
 * what the plugin registers.
 *
 * What it pins down:
 *   - the module loads and exports the cordis contract (`apply`/`inject`/`name`/`Config`);
 *   - the schema defaults are exactly the documented ones;
 *   - `Config` validates and coerces through schemastery;
 *   - the three tools register with the expected names;
 *   - `screencap_latest` reports "none" honestly on an empty directory;
 *   - `shotTime`/`listShots` order by the encoded file name, and `pruneShots`
 *     deletes only what is actually past the cutoff.
 *
 * Skipped (with a clear message) when the staged dependencies are absent, so a
 * plain `node --test` in a fresh checkout does not fail spuriously.
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * Where the staged runtime packages live. `extract-deps.mjs` writes them to
 * `plugin-src/node_modules` (one level above this package) so Node's normal
 * parent-directory resolution finds them without touching the real profile.
 * Override with `DSH_SCREENCAP_DEPS` to point at another staging directory.
 */
const STAGE = process.env.DSH_SCREENCAP_DEPS ?? resolve(import.meta.dirname, "../..");
const haveDeps = existsSync(join(STAGE, "node_modules", "@deepseek-ai", "dsh-tools"));
const SKIP = haveDeps ? false : `staged runtime deps missing (looked in ${join(STAGE, "node_modules")}; run tests/extract-deps.mjs)`;

/**
 * Stub cordis context capturing registrations and effects.
 *
 * `inject` mirrors cordis: the callback receives a scope that sees the same
 * `logger`/`effect`/`get` surface. Routes register through it, so the stub also
 * collects them in `_routes` for assertions.
 */
function makeCtx(services = {}) {
  const tools = [];
  const effects = [];
  const listeners = [];
  const logs = [];
  const routes = [];
  const record = (level) => (...args) => logs.push({ level, text: args.join(" ") });
  const logger = { info: record("info"), warn: record("warn"), error: record("error"), debug: record("debug") };
  const ctx = {
    tools: { register: (tool) => { tools.push(tool); return () => {}; } },
    logger,
    // cordis runs an effect body immediately and keeps its returned disposer.
    effect: (fn, label) => { const dispose = fn(); effects.push({ label, dispose }); return dispose ?? (() => {}); },
    on: (event, handler) => { listeners.push({ event, handler }); return () => {}; },
    get: (name) => services[name],
    inject: (names, cb) => {
      const scope = {
        logger,
        get: (name) => services[name],
        effect: (fn, label) => { const dispose = fn(); effects.push({ label, dispose }); return dispose ?? (() => {}); },
        webServer: {
          register: (route) => { routes.push(route); return () => {}; },
        },
      };
      cb(scope);
      return () => {};
    },
    // exposed for assertions
    _tools: tools,
    _effects: effects,
    _listeners: listeners,
    _logs: logs,
    _routes: routes,
  };
  return ctx;
}

/**
 * Minimal request/response pair for driving a registered route.
 *
 * @param method - HTTP method.
 * @param url - path (with query) as node:http would report it.
 * @param body - optional JSON body.
 */
function makeReqRes(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = {
    method,
    url,
    headers: { host: "127.0.0.1:19387", "sec-fetch-site": "same-origin" },
    on(event, handler) {
      if (event === "data") for (const c of chunks) handler(c);
      if (event === "end") handler();
      if (event === "error") { /* nothing to report */ }
      return this;
    },
    destroy() {},
  };
  const res = {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); return this; },
    end(text) { if (text !== undefined && text !== null) this.body += String(text); },
  };
  return { req, res };
}

/** Find a registered route by exact path. */
function routeFor(ctx, path) {
  // The real webserver matches on pathname, so a query string is not part of
  // the route identity — strip it here to mirror that.
  const pathname = path.split("?")[0];
  const found = ctx._routes.find((r) => r.path === pathname);
  assert.ok(found !== undefined, `route ${pathname} must be registered`);
  return found;
}

/**
 * Invoke a route and return its status, headers, raw body and — when the body
 * really is JSON — the decoded value.
 */
async function callRoute(ctx, path, method = "GET", body) {
  const { req, res } = makeReqRes(method, path, body);
  await routeFor(ctx, path).handler(req, res);
  let json = null;
  const contentType = res.headers["Content-Type"] || res.headers["content-type"] || "";
  if (res.body !== "" && String(contentType).includes("json")) {
    json = JSON.parse(res.body);
  }
  return { status: res.statusCode, headers: res.headers, json, raw: res.body };
}

/** Invoke a registered tool. */
async function callTool(tool, args) {
  return tool.execute(args, {});
}

test("host half loads and exposes the cordis contract", { skip: SKIP }, async () => {
  const mod = await import("../index.js");
  assert.equal(mod.name, "screencap");
  assert.equal(mod.NS, "screencap");
  assert.deepEqual(mod.inject, ["tools"]);
  assert.equal(typeof mod.apply, "function");
  assert.equal(typeof mod.Config, "function");
});

test("schema defaults match the documented values", { skip: SKIP }, async () => {
  const { Config } = await import("../index.js");
  // `.volatile()` wraps the schema in a `{ get() }` accessor rather than
  // returning a plain object, which is exactly why the host half reads settings
  // through `config.get()`. Assert against the accessor, not the wrapper.
  const resolved = Config({}).get();
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.intervalMinutes, 30);
  assert.equal(resolved.maxWidth, 1600);
  assert.equal(resolved.quality, 80);
  assert.equal(resolved.keepDays, 3);
  assert.equal(resolved.activeHours, "");
  assert.equal(resolved.skipWhenIdle, false);
  assert.equal(resolved.idleSeconds, 60);
});

test("a volatile Config exposes get() and preserves overrides", { skip: SKIP }, async () => {
  const { Config } = await import("../index.js");
  const parsed = Config({ enabled: false, intervalMinutes: 7, activeHours: "22:00-06:00" });
  assert.equal(typeof parsed.get, "function", "volatile configs must be read via get()");
  const live = parsed.get();
  assert.equal(live.enabled, false);
  assert.equal(live.intervalMinutes, 7);
  assert.equal(live.activeHours, "22:00-06:00");
  // Unset fields still fall back to their defaults.
  assert.equal(live.quality, 80);
});

test("schema rejects a wrong type instead of silently accepting it", { skip: SKIP }, async () => {
  const { Config } = await import("../index.js");
  assert.throws(() => Config({ enabled: "yes" }), /boolean/i);
  assert.throws(() => Config({ intervalMinutes: "soon" }), /number/i);
});

test("normalize clamps out-of-range numbers and ignores junk", { skip: SKIP }, async () => {
  const { normalize } = await import("../index.js");
  const n = normalize({
    enabled: true,
    intervalMinutes: 0, // below the floor
    keepDays: -5, // negative → 0 (pruning off)
    maxWidth: 999999, // above the ceiling
    quality: 500, // above 100
    idleSeconds: Number.NaN, // junk → default
    activeHours: "  08:00-23:00  ",
    skipWhenIdle: 1, // not === true
  });
  assert.equal(n.intervalMinutes, 1);
  assert.equal(n.keepDays, 0);
  assert.equal(n.maxWidth, 16384);
  assert.equal(n.quality, 100);
  assert.equal(n.idleSeconds, 60);
  assert.equal(n.activeHours, "08:00-23:00");
  assert.equal(n.skipWhenIdle, false);
});

test("the default inspect prompt delegates so images stay out of the main Session", { skip: SKIP }, async () => {
  const { DEFAULT_INSPECT_PROMPT, normalize } = await import("../index.js");
  // An image read by the MAIN session is re-uploaded on every later request, so
  // the built-in instruction must route the read through a subagent. These three
  // assertions are the contract; loosening any of them silently reintroduces the
  // traffic problem this default exists to prevent.
  assert.ok(DEFAULT_INSPECT_PROMPT.includes("subagent"), "the default must delegate the read to a subagent");
  assert.ok(DEFAULT_INSPECT_PROMPT.includes("read_image"), "the child must be told how to read the shot");
  assert.ok(/不要直接读图|不要读图|别自己读/.test(DEFAULT_INSPECT_PROMPT), "the default must forbid reading it in this Session");
  assert.ok(DEFAULT_INSPECT_PROMPT.includes("{{path}}"), "the default must carry the path placeholder");
  assert.ok(DEFAULT_INSPECT_PROMPT.includes("{{time}}"), "the default must carry the time placeholder");
  // An empty/blank configured prompt falls back to this default rather than
  // delivering an empty instruction.
  assert.equal(normalize({ inspectPrompt: "   " }).inspectPrompt, DEFAULT_INSPECT_PROMPT);
  assert.equal(normalize({}).inspectPrompt, DEFAULT_INSPECT_PROMPT);
  assert.equal(normalize({ inspectPrompt: "custom" }).inspectPrompt, "custom");
});

test("apply registers the three tools", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx();
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  const names = ctx._tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["screencap_capture", "screencap_latest", "screencap_list"]);
  for (const tool of ctx._tools) {
    assert.equal(typeof tool.execute, "function", `${tool.name} needs execute`);
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
  }
  // The timer effect must be registered, plus one effect per widget route.
  assert.ok(ctx._effects.some((e) => e.label === "dsh-screencap: capture timer"));
  assert.equal(
    ctx._effects.length,
    1 + ctx._routes.length,
    "each route must own exactly one effect",
  );
  // Both listeners: the settings re-arm and the boot injection row.
  assert.ok(ctx._listeners.some((l) => l.event === "settings/document-updated"));
  assert.ok(ctx._listeners.some((l) => l.event === "webserver/index-inject"));
});

test("the boot injection row is an inline script that swallows its own load error", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx();
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });

  const listener = ctx._listeners.find((l) => l.event === "webserver/index-inject");
  const table = [];
  listener.handler(table);

  assert.equal(table.length, 1, "exactly one row must be pushed");
  const row = table[0];
  // MUST be `script` (inline), never `script-src`: a failing `script-src` row
  // rejects __DSH_BOOT_READY__ and takes the whole desktop app down.
  assert.equal(row.kind, "script");
  assert.equal(row.placement, "body");
  assert.equal(typeof row.text, "string");
  assert.ok(row.text.includes("/dsh-screencap/widget.js"), "the row must point at our bundle");
  assert.ok(row.text.includes("onerror"), "the row must swallow its own load error");

  // A second emit must not duplicate the row.
  const again = [];
  listener.handler(again);
  assert.equal(again.length, 1);
  listener.handler(again);
  assert.equal(again.length, 1, "the row must be idempotent across emits");

  // And an existing equivalent row from another emitter is respected.
  const preset = [{ kind: "script", placement: "body", text: 'var s="/dsh-screencap/widget.js"' }];
  listener.handler(preset);
  assert.equal(preset.length, 1, "must not duplicate a row already present");
});

test("the widget routes are registered under the plugin prefix", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx();
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  const paths = ctx._routes.map((r) => r.path).sort();
  assert.deepEqual(paths, [
    "/dsh-screencap/latest.jpg",
    "/dsh-screencap/open-folder.json",
    "/dsh-screencap/sessions.json",
    "/dsh-screencap/settings.json",
    "/dsh-screencap/shoot.json",
    "/dsh-screencap/status.json",
    "/dsh-screencap/widget.js",
  ]);
  for (const r of ctx._routes) {
    assert.equal(r.kind, "exact", `${r.path} must be an exact route`);
    assert.equal(typeof r.handler, "function");
  }
});

test("a profile without a webserver still loads the plugin", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx();
  // Simulate the service being absent by making `inject` never call back —
  // exactly what cordis does while a service is missing.
  ctx.inject = () => () => {};
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  assert.equal(ctx._tools.length, 3, "tools must still register");
  assert.ok(ctx._listeners.some((l) => l.event === "webserver/index-inject"));
});

test("sessions.json feeds the picker: titles, no subagents, no blanks", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx({
    sessionController: {
      list: async () => ({
        items: [
          { sessionId: "session-aaa", updatedAt: 300, running: true, blank: false, projections: { values: { title: "英语单词课" } } },
          // A subagent conversation must never be offered as a target.
          { sessionId: "child-bbb", updatedAt: 900, running: false, blank: false, parentSessionId: "session-aaa" },
          // A blank session has no conversation to show yet.
          { sessionId: "session-ccc", updatedAt: 800, running: false, blank: true },
          { sessionId: "session-ddd", updatedAt: 100, running: false, blank: false },
        ],
      }),
    },
  });
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  const out = await callRoute(ctx, "/dsh-screencap/sessions.json");

  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.deepEqual(out.json.sessions.map((s) => s.id), ["session-aaa", "session-ddd"]);
  assert.equal(out.json.sessions[0].title, "英语单词课");
  assert.equal(out.json.sessions[0].running, true);
  // A missing title stays empty rather than inventing an id-shaped label: the
  // browser half decides how to shorten it.
  assert.equal(out.json.sessions[1].title, "");
});

test("sessions.json degrades to an empty list when the profile has no controller", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx();
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  const out = await callRoute(ctx, "/dsh-screencap/sessions.json");

  // 200 with an empty list, never a 5xx: the browser half falls back to a text box.
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.deepEqual(out.json.sessions, []);
});

test("sessions.json survives a controller failure without breaking the section", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx({
    sessionController: { list: async () => { throw new Error("persistence offline"); } },
  });
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  const out = await callRoute(ctx, "/dsh-screencap/sessions.json");

  assert.equal(out.status, 200);
  assert.equal(out.json.ok, false);
  assert.deepEqual(out.json.sessions, []);
  assert.ok(ctx._logs.some((l) => l.level === "warn" && l.text.includes("sessions.json failed")));
});

test("status.json reports settings, counts and the newest shot", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const home = await mkdtemp(join(tmpdir(), "dsh-sc-status-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const dir = join(home, "screencap", "shots");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "shot_2026-01-01_00-00-00.jpg"), "aa");
    await writeFile(join(dir, "shot_2026-09-09_09-09-09.jpg"), "bbb");

    const ctx = makeCtx();
    apply(ctx, { enabled: true, intervalMinutes: 15, keepDays: 3, activeHours: "" });
    const out = await callRoute(ctx, "/dsh-screencap/status.json");

    assert.equal(out.status, 200);
    assert.equal(out.json.enabled, true);
    assert.equal(out.json.intervalMinutes, 15);
    assert.equal(out.json.count, 2);
    assert.equal(out.json.bytes, 5);
    assert.equal(out.json.latest.file, "shot_2026-09-09_09-09-09.jpg");
    assert.equal(out.json.latest.bytes, 3);
    assert.ok(out.json.dir.endsWith(join("screencap", "shots")));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("latest.jpg serves the newest shot and refuses an unknown file name", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const home = await mkdtemp(join(tmpdir(), "dsh-sc-latest-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const dir = join(home, "screencap", "shots");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "shot_2026-01-01_00-00-00.jpg"), "old");
    await writeFile(join(dir, "shot_2026-09-09_09-09-09.jpg"), "newer");

    const ctx = makeCtx();
    apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });

    const newest = await callRoute(ctx, "/dsh-screencap/latest.jpg");
    assert.equal(newest.status, 200);
    assert.equal(newest.headers["Content-Type"], "image/jpeg");
    assert.equal(newest.raw, "newer");

    // An explicit, known file is honoured...
    const named = await callRoute(ctx, "/dsh-screencap/latest.jpg?file=shot_2026-01-01_00-00-00.jpg");
    assert.equal(named.status, 200);
    assert.equal(named.raw, "old");

    // ...but a traversal attempt is not a path, it is just an unknown name.
    const evil = await callRoute(ctx, "/dsh-screencap/latest.jpg?file=../../../../Windows/win.ini");
    assert.equal(evil.status, 404, "an unknown file name must never be opened");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("settings.json writes only the two fields the panel owns", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const updates = [];
  const ctx = makeCtx({
    settings: {
      describe: () => [{ ns: "screencap", revision: 4 }],
      update: async (ns, patch, revision) => { updates.push({ ns, patch, revision }); },
    },
  });
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });

  // A body carrying extra fields must have them dropped, and the interval
  // must be clamped to the schema's own range.
  const out = await callRoute(ctx, "/dsh-screencap/settings.json", "POST", {
    enabled: false,
    intervalMinutes: 99999,
    keepDays: 0,
    quality: 1,
    activeHours: "00:00-00:01",
  });
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].patch, { enabled: false, intervalMinutes: 1440 });
  assert.equal(updates[0].ns, "screencap");
  assert.equal(updates[0].revision, 4, "the revision must come from describe()");

  // GET is refused, and an empty patch is refused.
  const wrongMethod = await callRoute(ctx, "/dsh-screencap/settings.json", "GET");
  assert.equal(wrongMethod.status, 405);
  const empty = await callRoute(ctx, "/dsh-screencap/settings.json", "POST", { keepDays: 9 });
  assert.equal(empty.status, 400);
  assert.equal(updates.length, 1, "nothing may be written for an empty patch");
});

test("settings.json retries once on a revision conflict and reports failure", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  let calls = 0;
  const ctx = makeCtx({
    settings: {
      describe: () => [{ ns: "screencap", revision: calls }],
      update: async () => { calls += 1; if (calls === 1) throw new Error("conflict"); },
    },
  });
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });

  const ok = await callRoute(ctx, "/dsh-screencap/settings.json", "POST", { enabled: true });
  assert.equal(ok.status, 200);
  assert.equal(calls, 2, "one retry must follow the conflict");

  const failing = makeCtx({
    settings: {
      describe: () => [{ ns: "screencap", revision: 1 }],
      update: async () => { throw new Error("always conflicts"); },
    },
  });
  apply(failing, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  const bad = await callRoute(failing, "/dsh-screencap/settings.json", "POST", { enabled: true });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.ok, false);
});

test("settings.json reports 503 when the settings service is absent", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx();
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  const out = await callRoute(ctx, "/dsh-screencap/settings.json", "POST", { enabled: true });
  assert.equal(out.status, 503);
  assert.equal(out.json.ok, false);
});

test("a cross-site request is refused before any route logic runs", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx();
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });

  const { req, res } = makeReqRes("GET", "/dsh-screencap/status.json");
  req.headers["sec-fetch-site"] = "cross-site";
  await routeFor(ctx, "/dsh-screencap/status.json").handler(req, res);
  assert.equal(res.statusCode, 403);

  // A mismatched Origin is refused too.
  const second = makeReqRes("GET", "/dsh-screencap/status.json");
  second.req.headers.origin = "http://evil.example";
  await routeFor(ctx, "/dsh-screencap/status.json").handler(second.req, second.res);
  assert.equal(second.res.statusCode, 403);
});

test("widget.js is served from the package, or 404s cleanly", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx();
  apply(ctx, { enabled: true, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  const out = await callRoute(ctx, "/dsh-screencap/widget.js");
  // The bundle ships with the package, so it must be present.
  assert.equal(out.status, 200);
  assert.equal(out.headers["Content-Type"], "application/javascript; charset=utf-8");
  assert.ok(out.raw.includes("__dshScreencapWidget"), "the served bundle must be the widget");
  assert.ok(out.raw.includes("dshsc-root"), "the served bundle must define the widget styles");
});

test("shoot.json refuses to capture while the plugin is disabled", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx();
  apply(ctx, { enabled: false, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  const out = await callRoute(ctx, "/dsh-screencap/shoot.json", "POST", {});
  assert.equal(out.status, 200);
  assert.equal(out.json.captured, false);
  assert.equal(out.json.skipped, "disabled");
  const wrongMethod = await callRoute(ctx, "/dsh-screencap/shoot.json", "GET");
  assert.equal(wrongMethod.status, 405);
});

test("shotTime parses the capture.ps1 file name and rejects strangers", { skip: SKIP }, async () => {
  const { shotTime } = await import("../index.js");
  const t = shotTime("shot_2026-10-01_12-34-56.jpg");
  assert.equal(t.getFullYear(), 2026);
  assert.equal(t.getMonth(), 9);
  assert.equal(t.getDate(), 1);
  assert.equal(t.getHours(), 12);
  assert.equal(t.getMinutes(), 34);
  assert.equal(t.getSeconds(), 56);
  for (const bad of ["shot.jpg", "shot_2026-10-01.jpg", "other_2026-10-01_12-34-56.jpg", "shot_2026-10-01_12-34-56.png"]) {
    assert.equal(shotTime(bad), null, `expected null for ${bad}`);
  }
});

test("listShots orders by encoded name, not mtime", { skip: SKIP }, async () => {
  const { listShots } = await import("../index.js");
  const home = await mkdtemp(join(tmpdir(), "dsh-sc-list-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const dir = join(home, "screencap", "shots");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "shot_2026-01-01_00-00-00.jpg"), "old");
    await writeFile(join(dir, "shot_2026-06-15_10-30-00.jpg"), "mid");
    await writeFile(join(dir, "shot_2026-12-31_23-59-59.jpg"), "new");
    await writeFile(join(dir, "not-a-shot.txt"), "ignore me");
    const shots = await listShots();
    assert.equal(shots.length, 3, "the non-shot file must be ignored");
    assert.deepEqual(shots.map((s) => s.file), [
      "shot_2026-12-31_23-59-59.jpg",
      "shot_2026-06-15_10-30-00.jpg",
      "shot_2026-01-01_00-00-00.jpg",
    ]);
    assert.equal(shots[0].bytes, 3);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("pruneShots removes only shots past the cutoff, and 0 disables it", { skip: SKIP }, async () => {
  const { pruneShots } = await import("../index.js");
  const home = await mkdtemp(join(tmpdir(), "dsh-sc-prune-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  try {
    const dir = join(home, "screencap", "shots");
    await mkdir(dir, { recursive: true });
    // Build names relative to "now" so the test does not rot.
    const name = (daysAgo) => {
      const d = new Date(Date.now() - daysAgo * 86_400_000);
      const p = (n) => String(n).padStart(2, "0");
      return `shot_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.jpg`;
    };
    await writeFile(join(dir, name(0)), "today");
    await writeFile(join(dir, name(1)), "yesterday");
    await writeFile(join(dir, name(10)), "ancient");
    await writeFile(join(dir, name(400)), "fossil");

    // keepDays = 0 → pruning is off, nothing is deleted.
    assert.equal(await pruneShots(0, logger), 0);
    assert.equal((await readdir(dir)).length, 4);

    // keepDays = 3 → the 10- and 400-day-old shots go.
    assert.equal(await pruneShots(3, logger), 2);
    const left = (await readdir(dir)).sort();
    assert.equal(left.length, 2);
    assert.ok(left.includes(name(0)) && left.includes(name(1)));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("screencap_latest and screencap_list report an empty directory honestly", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const home = await mkdtemp(join(tmpdir(), "dsh-sc-tools-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const ctx = makeCtx();
    apply(ctx, { enabled: false, intervalMinutes: 30, keepDays: 3, activeHours: "" });
    const latest = ctx._tools.find((t) => t.name === "screencap_latest");
    const list = ctx._tools.find((t) => t.name === "screencap_list");

    const none = await callTool(latest, {});
    assert.equal(none.exists, false);
    assert.equal(none.path, "");
    assert.equal(none.total, 0);
    assert.ok(none.dir.endsWith(join("screencap", "shots")), `unexpected dir ${none.dir}`);

    const empty = await callTool(list, {});
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.shots, []);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("screencap_latest returns the newest shot and honours the list limit", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const home = await mkdtemp(join(tmpdir(), "dsh-sc-newest-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const dir = join(home, "screencap", "shots");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "shot_2026-01-01_00-00-00.jpg"), "a");
    await writeFile(join(dir, "shot_2026-05-05_05-05-05.jpg"), "bb");
    await writeFile(join(dir, "shot_2026-09-09_09-09-09.jpg"), "ccc");

    const ctx = makeCtx();
    apply(ctx, { enabled: false, intervalMinutes: 30, keepDays: 3, activeHours: "" });
    const latest = ctx._tools.find((t) => t.name === "screencap_latest");
    const list = ctx._tools.find((t) => t.name === "screencap_list");

    const one = await callTool(latest, {});
    assert.equal(one.exists, true);
    assert.ok(one.path.endsWith("shot_2026-09-09_09-09-09.jpg"));
    assert.equal(one.bytes, 3);
    assert.equal(one.total, 3);

    const limited = await callTool(list, { limit: 2 });
    assert.equal(limited.count, 2);
    assert.equal(limited.total, 3);
    assert.ok(limited.shots[0].path.endsWith("shot_2026-09-09_09-09-09.jpg"));
    assert.ok(limited.shots[1].path.endsWith("shot_2026-05-05_05-05-05.jpg"));

    // An over-large limit is clamped by the tool body, not rejected.
    const clamped = await callTool(list, { limit: 9999 });
    assert.equal(clamped.count, 3);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("the parameter schema declares limit as an integer", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx();
  apply(ctx, { enabled: false, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  const list = ctx._tools.find((t) => t.name === "screencap_list");
  // `defineTool` normalizes the shorthand into JSON Schema. Declared `integer`,
  // so the harness's own arg validation rejects junk before `execute` runs —
  // which is why the body only has to clamp the high end.
  assert.equal(list.parameters.type, "object");
  assert.equal(list.parameters.properties.limit.type, "integer");
  assert.deepEqual(list.parameters.required ?? [], [], "limit is optional");
});

test("a disabled plugin still refuses screencap_capture", { skip: SKIP }, async () => {
  const { apply } = await import("../index.js");
  const ctx = makeCtx();
  apply(ctx, { enabled: false, intervalMinutes: 30, keepDays: 3, activeHours: "" });
  const capture = ctx._tools.find((t) => t.name === "screencap_capture");
  const out = await callTool(capture, {});
  assert.equal(out.captured, false);
  assert.match(out.skipped, /disabled/);
});
