/**
 * Smoke test for the browser half.
 *
 * `client.js` is a hand-written ModuleLoader bundle: it calls
 * `window.__ModuleLoader__.load({ id, factory })` at import time and pulls
 * `react` through the loader's `require`. This test provides both, then drives
 * the registered `settings.section` contribution far enough to prove the
 * section renders and that its validation logic agrees with the host.
 *
 * It also cross-checks `validActiveHours` against the host's `parseActiveHours`
 * so the two halves cannot drift: the UI must accept exactly the windows the
 * host will honour.
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const STAGE = process.env.DSH_SCREENCAP_DEPS ?? resolve(import.meta.dirname, "../..");
// The client half itself only needs a React stub (supplied below), but the
// cross-check tests import the host half, which needs the staged runtime deps.
// `react` is bundled into the web frontend rather than exposed as a package, so
// its absence is expected and is not the gate.
const haveDeps = existsSync(join(STAGE, "node_modules", "@deepseek-ai", "schemastery"));
const SKIP = haveDeps ? false : `staged runtime deps missing (looked in ${join(STAGE, "node_modules")}; run tests/extract-deps.mjs)`;

/** Minimal React stub: enough for createElement trees, not for rendering. */
function makeReactStub() {
  const hooks = { states: [], cursor: 0 };
  return {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (init) => {
      const i = hooks.cursor++;
      if (hooks.states[i] === undefined) hooks.states[i] = typeof init === "function" ? init() : init;
      return [hooks.states[i], (next) => { hooks.states[i] = typeof next === "function" ? next(hooks.states[i]) : next; }];
    },
    useEffect: () => {},
    useRef: (init) => ({ current: init }),
    __hooks: hooks,
  };
}

/**
 * Expand an element tree into plain JSON.
 *
 * The slot contribution is a wrapper component, so the tree has to be rendered
 * one level before the section body appears. Function components are invoked
 * (with hooks reset per component) until only host elements remain.
 */
function renderToJson(node, react, depth = 0) {
  if (node === null || node === undefined || typeof node !== "object") return node;
  // React flattens an array passed as children (the usual `items.map(...)`
  // shape), so the stub must too — otherwise a list rendered from a dynamically
  // built array would silently vanish and the test would pass vacuously.
  if (Array.isArray(node)) return node.map((child) => renderToJson(child, react, depth));
  if (typeof node.type === "function") {
    if (depth > 12) throw new Error("render depth exceeded — possible component loop");
    const savedCursor = react.__hooks.cursor;
    react.__hooks.cursor = 0;
    let out;
    try {
      out = renderToJson(node.type(node.props ?? {}), react, depth + 1);
    } finally {
      react.__hooks.cursor = savedCursor;
    }
    return out;
  }
  const children = (node.props?.children ?? []).map((child) => renderToJson(child, react, depth + 1));
  return { type: String(node.type), props: { ...(node.props ?? {}), children } };
}

/**
 * Load `client.js` with a stub loader and return what it registered.
 *
 * @param opts.locale - locale service stub.
 * @param opts.configForms - configForms service stub.
 * @param opts.snapshot - the settings snapshot the bound scope reports.
 */
async function loadClient(opts = {}) {
  const registrations = [];
  const slots = {
    inject: (name, register) => { registrations.push({ name, register }); },
    register: (spec, Component) => ({ spec, Component }),
  };
  const dictionaries = [];
  const locale = opts.locale ?? {
    bind: () => (key) => key,
    register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {}; },
  };
  const scope = opts.scope ?? {
    getSnapshot: () => opts.snapshot ?? { status: "ready", value: {}, user: {}, revision: 1 },
    subscribe: () => () => {},
    mutate: async () => {},
    set: async () => {},
    unset: async () => {},
  };
  const configForms = { get: (ns) => { assert.equal(ns, "screencap"); return scope; } };
  const effects = [];
  const ctx = {
    locale,
    slots,
    configForms,
    // Run the effect body immediately, the way a mounted plugin context does.
    effect: (fn, label) => { const dispose = fn(); effects.push({ label, dispose }); return dispose; },
    get: () => undefined,
  };

  const previousWindow = globalThis.window;
  let loaded = null;
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => { loaded = entry; },
    },
  };
  try {
    const react = makeReactStub();
    // Bust the module cache so each call re-evaluates the bundle.
    const url = new URL(`../client.js?t=${Date.now()}${Math.random()}`, import.meta.url);
    await import(url.href);
    assert.ok(loaded !== null, "client.js must call window.__ModuleLoader__.load");
    assert.equal(loaded.id, "dsh-screencap");
    const exports = loaded.factory((spec) => {
      assert.equal(spec, "react");
      return react;
    });
    exports.apply(ctx);
    return { exports, registrations, dictionaries, effects, react, ctx };
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

test("client half loads, registers its section and dictionaries", { skip: SKIP }, async () => {
  const { exports, registrations, dictionaries, effects } = await loadClient();

  assert.equal(typeof exports.apply, "function");
  assert.ok(Array.isArray(exports.inject));
  assert.deepEqual([...exports.inject].sort(), ["configForms", "locale", "slots"]);

  // One dictionary registration and one settings.section injection.
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].ns, "screencapUi");
  assert.ok(dictionaries[0].dicts.zh && dictionaries[0].dicts.en, "both locales must be present");

  const sections = registrations.filter((r) => r.name === "settings.section");
  assert.equal(sections.length, 1);

  // The effect list must include the dictionary registration.
  assert.ok(effects.some((e) => String(e.label).includes("dictionaries")));
});

test("the registered section has the expected slot spec", { skip: SKIP }, async () => {
  const { registrations } = await loadClient();
  const reg = registrations.find((r) => r.name === "settings.section");
  const contribution = reg.register();
  assert.equal(contribution.spec.name, "settings.section");
  assert.equal(contribution.spec.id, "screencap");
  assert.equal(typeof contribution.spec.order, "number");
  assert.equal(typeof contribution.spec.label, "function");
  assert.equal(contribution.spec.locale, "screencapUi");
});

test("the section component builds a tree without throwing", { skip: SKIP }, async () => {
  const { registrations, ctx, react } = await loadClient({
    snapshot: {
      status: "ready",
      revision: 3,
      user: {},
      value: {
        enabled: true,
        intervalMinutes: 30,
        keepDays: 3,
        activeHours: "22:00-06:00",
        skipWhenIdle: false,
        idleSeconds: 60,
        maxWidth: 1600,
        quality: 80,
      },
    },
  });
  const reg = registrations.find((r) => r.name === "settings.section");
  const contribution = reg.register();
  const t = ctx.locale.bind("screencapUi");
  const tree = contribution.Component({ t, scope: ctx.configForms.get("screencap") });
  assert.ok(tree !== null && tree !== undefined, "component must return a tree");

  const rendered = renderToJson(tree, react);
  const text = JSON.stringify(rendered);
  // The tree must contain the field labels the settings page promises.
  for (const key of ["intervalLabel", "keepDaysLabel", "activeHoursLabel", "maxWidthLabel", "qualityLabel", "idleLabel", "switchLabel"]) {
    assert.ok(text.includes(key), `section must render ${key}`);
  }
  // And the staged values must reach the inputs, not the defaults.
  assert.ok(text.includes("22:00-06:00"), "the stored activeHours value must be shown");
  assert.ok(text.includes("\"type\":\"checkbox\""), "the enable switch must render as a checkbox");
});

test("the Session picker is a dropdown whose first option is \"follow automatically\"", { skip: SKIP }, async () => {
  const { registrations, ctx, react } = await loadClient({
    snapshot: { status: "ready", revision: 1, user: {}, value: { inspectSessionId: "" } },
  });
  const contribution = registrations.find((r) => r.name === "settings.section").register();
  const tree = contribution.Component({
    t: ctx.locale.bind("screencapUi"),
    scope: ctx.configForms.get("screencap"),
  });
  const rendered = renderToJson(tree, react);
  const text = JSON.stringify(rendered);

  // A raw id box is exactly what a non-technical reader cannot fill in, so the
  // field must be a select. The empty value is the host's auto tier.
  assert.ok(text.includes("\"type\":\"select\""), "inspectSessionId must render as a select");
  assert.ok(text.includes("inspectSessionAuto"), "the auto option must be offered");
  // With an empty stored value there is nothing to preserve, so no manual box.
  assert.ok(!text.includes("session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"), "no manual id box when the list is enough");
});

test("a stored Session id absent from the list is kept as its own option", { skip: SKIP }, async () => {
  // Opening the settings page and pressing Save must never silently rewrite a
  // stored id just because this profile's list did not mention it.
  const { registrations, ctx, react } = await loadClient({
    snapshot: { status: "ready", revision: 1, user: {}, value: { inspectSessionId: "session-old-not-listed" } },
  });
  const contribution = registrations.find((r) => r.name === "settings.section").register();
  const tree = contribution.Component({
    t: ctx.locale.bind("screencapUi"),
    scope: ctx.configForms.get("screencap"),
  });
  const text = JSON.stringify(renderToJson(tree, react));

  assert.ok(text.includes("session-old-not-listed"), "the stored id must stay selectable");
  // An unknown id also reveals the manual box so it can be corrected by hand.
  assert.ok(text.includes("session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"), "an unknown id must stay editable");
});

test("an unavailable namespace renders the unavailable notice", { skip: SKIP }, async () => {
  const { registrations, ctx, react } = await loadClient({ snapshot: { status: "unavailable" } });
  const reg = registrations.find((r) => r.name === "settings.section");
  const contribution = reg.register();
  const tree = contribution.Component({ t: ctx.locale.bind("screencapUi"), scope: ctx.configForms.get("screencap") });
  const rendered = renderToJson(tree, react);
  assert.ok(JSON.stringify(rendered).includes("unavailable"));
});

test("client validActiveHours accepts exactly what the host honours", { skip: SKIP }, async () => {
  const { exports } = await loadClient();
  const clientOk = exports.__test.validActiveHours;
  const { parseActiveHours } = await import("../schedule.js");

  const cases = [
    "", "   ", "08:00-23:00", "22:00-06:00", "00:00-23:59", "8:00-9:00",
    "08:00-08:00", "23:59-00:00",
    "8:00", "08:00", "24:00-06:00", "08:60-09:00", "aa:bb-cc:dd",
    "08:00-23:00-01:00", "-", "08:00-", "-06:00",
  ];
  for (const raw of cases) {
    const host = parseActiveHours(raw) !== null;
    const client = clientOk(raw);
    assert.equal(client, host, `disagreement on ${JSON.stringify(raw)}: client=${client} host=${host}`);
  }
});

test("client defaults mirror the host schema defaults", { skip: SKIP }, async () => {
  const { exports } = await loadClient();
  const { Config } = await import("../index.js");
  const host = Config({}).get();
  const client = exports.__test.DEFAULTS;
  for (const key of ["enabled", "intervalMinutes", "keepDays", "activeHours", "skipWhenIdle", "idleSeconds", "maxWidth", "quality"]) {
    assert.equal(client[key], host[key], `default mismatch for ${key}`);
  }
});

test("the client's built-in instruction is byte-identical to the host's", { skip: SKIP }, async () => {
  const { exports } = await loadClient();
  const { DEFAULT_INSPECT_PROMPT } = await import("../index.js");
  // The browser half carries its own copy so the "fill in the built-in
  // instruction" button can seed the box without a round trip. That copy is
  // only correct while it matches the host exactly — a drift would seed the
  // box with text the Host would never have used, and the missing clause would
  // be the one that keeps images out of the main Session.
  assert.equal(exports.__test.DEFAULT_INSPECT_PROMPT, DEFAULT_INSPECT_PROMPT);
});

test("settingsOpsApplied detects a refused write", { skip: SKIP }, async () => {
  const { exports } = await loadClient();
  const { settingsOpsApplied } = exports.__test;

  const applied = settingsOpsApplied(
    { status: "ready", value: { intervalMinutes: 15 }, user: { intervalMinutes: 15 } },
    [{ op: "set", path: ["intervalMinutes"], value: 15 }],
  );
  assert.equal(applied, true);

  // The section still holds the old value → the write did not land.
  const refused = settingsOpsApplied(
    { status: "ready", value: { intervalMinutes: 30 }, user: { intervalMinutes: 30 } },
    [{ op: "set", path: ["intervalMinutes"], value: 15 }],
  );
  assert.equal(refused, false);

  // An unset that leaves the key in the user layer also did not land.
  const unsetRefused = settingsOpsApplied(
    { status: "ready", value: { activeHours: "08:00-09:00" }, user: { activeHours: "08:00-09:00" } },
    [{ op: "unset", path: ["activeHours"] }],
  );
  assert.equal(unsetRefused, false);
});
