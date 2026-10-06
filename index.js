/**
 * dsh-screencap — periodic desktop capture for DeepSeek Harness.
 *
 * The plugin owns the `screencap` settings namespace. A background timer fires
 * every `intervalMinutes`, runs `capture.ps1` (System.Windows.Forms +
 * System.Drawing, virtual screen, optional downscale, JPEG quality), and writes
 * the result under `$DSH_HOME/screencap/shots`. Shots older than `keepDays` are
 * pruned on the same tick. Everything is configurable live from the Web UI
 * settings section — no restart, because the timer reads the settings layer on
 * every arm and re-arms on `settings/document-updated`.
 *
 * Two optional restrictions, both off by default:
 *   - `activeHours`  — `"HH:MM-HH:MM"`, cross-midnight windows supported.
 *   - `skipWhenIdle` — skip a shot while the desktop is in active use
 *                      (`GetLastInputInfo`, probed inside capture.ps1).
 *
 * Capture is a child process rather than a native Node implementation: Node has
 * no built-in screen-capture API, and the only native options are heavy
 * (node-ffmpeg / sharp's raw pipeline) or add a per-plugin native build that
 * this profile's pnpm setup cannot link. PowerShell is present on every Windows
 * host and the capture script is a package asset, so there is nothing to
 * install.
 *
 * @module dsh-screencap
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { LIMITS, allowsCaptureNow, msUntilClock, parseActiveHours } from "./schedule.js";

/** Cordis plugin name. */
const name = "screencap";
/** Services this plugin needs injected from the host tree. */
const inject = ["tools"];
/** Settings namespace owned by this plugin (Web UI settings section). */
const NS = "screencap";

/** URL prefix for the widget routes served by the host half. */
const ROUTE_PREFIX = "/dsh-screencap";
/**
 * Inline `<script>` row pushed into the desktop boot injection table.
 *
 * WHY INLINE, NOT `script-src` (this is the whole reason the widget exists at
 * all on the desktop shell — the same trap dsh-whale-widget documents):
 *   - The desktop index.html is read from the packaged static dist, so the
 *     host's `renderIndex`/`tapIndex` never runs for it. The ONLY channel is
 *     the structured row table `webserver/index-inject` emits, which the shell
 *     collects ONCE at host startup and hands to the renderer over IPC.
 *   - The page-side interpreter treats the two script rows asymmetrically:
 *     `script` sets `textContent` on a fresh element and appends it — it cannot
 *     fail to load; `script-src` awaits `loadScript(src)`, and a rejection
 *     there rejects `__DSH_BOOT_READY__`, which takes the WHOLE APP down.
 *   - The table is collected once and cached with no refresh path, so a row
 *     that survives a plugin disable points at a route that no longer exists.
 *     A 404 through `script-src` is therefore a white screen on next restart.
 * So we push an inline row that builds its own `<script src>` and SWALLOWS
 * `onerror`: route present → widget loads; route gone → silent no-op.
 */
const WIDGET_ROW_TEXT =
  "(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;"
  + "if(window.__dshScreencapWidget)return;"
  + 'var s=document.createElement("script");s.src="' + ROUTE_PREFIX + '/widget.js";'
  + "s.onerror=function(){};d.appendChild(s)}catch(e){}})()";

/** Absolute path of the browser-half bundle served at `/dsh-screencap/widget.js`. */
const WIDGET_FILE = fileURLToPath(new URL("./widget.js", import.meta.url));

/**
 * Read and parse a small JSON request body.
 *
 * The body is capped: these routes only ever carry a settings patch, and an
 * unbounded read on a localhost route is an easy way to exhaust memory.
 *
 * @param req - incoming request.
 * @returns the parsed body, or `{}` when it is absent or malformed.
 */
function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve({});
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => resolve({}));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (text === "") { resolve({}); return; }
        const parsed = JSON.parse(text);
        resolve(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * Keep only the fields the floating panel is allowed to write, clamped.
 *
 * The panel is a convenience surface, not a second schema: it may flip the
 * master switch and change the interval, and nothing else. Anything else in
 * the body is dropped rather than trusted.
 *
 * @param patch - the parsed request body.
 * @returns a settings patch safe to hand to `settings.update`.
 */
function pickSettingsPatch(patch) {
  const out = {};
  if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
  if (patch.intervalMinutes !== undefined) {
    const n = Number(patch.intervalMinutes);
    if (Number.isFinite(n)) {
      out.intervalMinutes = clampNumber(n, 30, LIMITS.minIntervalMinutes, LIMITS.maxIntervalMinutes);
    }
  }
  return out;
}

/**
 * Read the widget bundle from disk.
 *
 * Read per request (not cached) so editing the file and refreshing the page is
 * enough to see a change; the file is small and this is a localhost route.
 *
 * @returns the bundle source, or `null` when it is missing.
 */
async function loadWidgetSource() {
  try {
    return await readFile(WIDGET_FILE, "utf8");
  } catch {
    return null;
  }
}

/** JSON response headers for the widget routes. */
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

/**
 * Minimal loopback/same-origin guard for the widget routes.
 *
 * Mirrors what dsh-whale-widget learned the hard way: the Host's own
 * `connection.requestRejection` is the authoritative fence when present, but
 * older hosts lack it, so the plugin keeps a fail-closed fallback. The fallback
 * matters most for the write routes (`settings.json`, `shoot.json`,
 * `open-folder.json`): those must not be reachable from a cross-site page.
 *
 * @param req - incoming request.
 * @param connection - the host `connection` service, when available.
 * @returns `true` when the request must be refused.
 */
function refuseRequest(req, connection) {
  try {
    const headers = (req && req.headers) || {};
    const site = String(headers["sec-fetch-site"] || "").toLowerCase();
    if (site === "cross-site") return true;
    const origin = headers.origin;
    if (typeof origin === "string" && origin !== "" && origin !== "null") {
      let originHost;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        return true;
      }
      const authority = String(headers.host || "").toLowerCase();
      if (authority !== "" && originHost !== authority) return true;
    }
    if (connection !== undefined && connection !== null
      && typeof connection.requestRejection === "function") {
      const code = connection.requestRejection(req);
      // The host fence answers a status code to deny, or a falsy value to allow.
      return code !== undefined && code !== null && code !== false;
    }
    return false;
  } catch {
    return true; // validator itself failed → refuse
  }
}

/** Managed capture directory under the harness home. */
const SHOT_DIR = join("screencap", "shots");
/** File name pattern written by capture.ps1. */
const SHOT_RE = /^shot_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.jpg$/;
/** Hard ceiling for one PowerShell capture run. */
const CAPTURE_TIMEOUT_MS = 60_000;
/** Floor for the re-arm delay, so a bad interval can never spin the loop. */
const MIN_TICK_MS = 5_000;

/**
 * Default instruction delivered after a capture when `inspectEnabled` is on.
 *
 * `{{path}}` and `{{time}}` are replaced per shot.
 *
 * The delegation is the whole point, not a stylistic choice: an image that the
 * MAIN session reads stays in that session's history forever, and every later
 * request re-uploads it. A session that runs this on a 20-minute timer would
 * balloon to hundreds of megabytes a day. A subagent reads the shot in ITS own
 * session and hands back only text, so the picture never enters the main
 * conversation. The wording states the reason explicitly, because an
 * unexplained "do not read it yourself" invites the model to helpfully ignore
 * it.
 */
const DEFAULT_INSPECT_PROMPT = "【截图巡检】刚拍了一张屏幕截图：{{path}}（{{time}}）。\n"
  + "请用 subagent 工具派一个子助手去读这张图（让它用 read_image 读），并要求它只回报文字结论："
  + "两行以内——第一行说用户在做什么，第二行在学习/上课时补一句有用的知识，否则写「无」。\n"
  + "你自己不要直接读图：图片一旦进入本会话就会永久留在历史里，之后每次提问都要重传一遍，很费流量。"
  + "子助手在它自己的会话里读，只把文字带回来。\n"
  + "拿到文字结论后，用一句话转述给用户，别长篇、别列表。"
  + "如果是锁屏或黑屏，就说明一句「屏幕锁着/黑着」。";

/**
 * Runtime schema for the screencap row.
 *
 * The schema is `volatile()` because the settings layer hot-applies these
 * fields: the host re-reads `config` on every change, and the timer consults
 * it through `cfg()` instead of caching a snapshot.
 */
const Config = z.object({
  /** Master switch for the background timer. */
  enabled: z.boolean().default(true),
  /** Minutes between captures. */
  intervalMinutes: z.number().default(30),
  /** Downscale so the shot is at most this wide; 0 keeps the native size. */
  maxWidth: z.number().default(1600),
  /** JPEG quality, 1–100. */
  quality: z.number().default(80),
  /** Delete shots older than this many days; 0 disables pruning. */
  keepDays: z.number().default(3),
  /**
   * Only capture inside this local time window, `"HH:MM-HH:MM"`.
   * Empty means all day. A window whose end precedes its start (e.g.
   * `"22:00-06:00"`) wraps past midnight.
   */
  activeHours: z.string().default(""),
  /** Skip a capture while the desktop is in active use. */
  skipWhenIdle: z.boolean().default(false),
  /** "In active use" means the last input is newer than this many seconds. */
  idleSeconds: z.number().default(60),
  /**
   * Wake the agent with a follow-up message after every successful capture.
   *
   * Off by default: this turns a silent 20-minute timer into a full agent turn
   * each time, which costs tokens on every shot.
   */
  inspectEnabled: z.boolean().default(false),
  /** Instruction delivered on each capture; `{{path}}` and `{{time}}` expand. */
  inspectPrompt: z.string().default(DEFAULT_INSPECT_PROMPT),
  /** Explicit target Session id; empty means "the session last used by a human". */
  inspectSessionId: z.string().default(""),
}).volatile();

/**
 * Coerce one numeric setting into range.
 *
 * Settings can arrive from a hand-edited YAML file, so every number is clamped
 * rather than trusted. A non-finite value falls back to the default.
 */
function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Normalized effective settings for one tick. */
function normalize(c) {
  return {
    enabled: c.enabled !== false,
    intervalMinutes: clampNumber(c.intervalMinutes, 30, LIMITS.minIntervalMinutes, LIMITS.maxIntervalMinutes),
    maxWidth: clampNumber(c.maxWidth, 1600, 0, LIMITS.maxWidthMax),
    quality: clampNumber(c.quality, 80, LIMITS.minQuality, LIMITS.maxQuality),
    keepDays: clampNumber(c.keepDays, 3, LIMITS.minKeepDays, LIMITS.maxKeepDays),
    activeHours: typeof c.activeHours === "string" ? c.activeHours.trim() : "",
    skipWhenIdle: c.skipWhenIdle === true,
    idleSeconds: clampNumber(c.idleSeconds, 60, 1, 3600),
    inspectEnabled: c.inspectEnabled === true,
    inspectPrompt: typeof c.inspectPrompt === "string" && c.inspectPrompt.trim() !== ""
      ? c.inspectPrompt
      : DEFAULT_INSPECT_PROMPT,
    inspectSessionId: typeof c.inspectSessionId === "string" ? c.inspectSessionId.trim() : "",
  };
}

/** Absolute path of the bundled capture script. */
const SCRIPT = fileURLToPath(new URL("./capture.ps1", import.meta.url));

/** Absolute path of the PowerShell host executable. */
function powershellPath() {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Run capture.ps1 once and return the written path.
 *
 * `SKIP_IDLE` on stdout is a normal outcome, not an error: it means the idle
 * probe declined this shot.
 *
 * @param settings - normalized settings for this run.
 * @param logger - host logger.
 * @returns the shot path, or `null` when the shot was skipped.
 */
function runCapture(settings, logger) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("dsh-screencap: capture is only implemented for Windows hosts"));
      return;
    }
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", SCRIPT,
      "-OutDir", shotsDir(),
      "-MaxWidth", String(settings.maxWidth),
      "-Quality", String(settings.quality),
      "-IdleSeconds", settings.skipWhenIdle ? String(settings.idleSeconds) : "0",
    ];
    const child = spawn(powershellPath(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(new Error(`dsh-screencap: capture timed out after ${CAPTURE_TIMEOUT_MS} ms`));
    }, CAPTURE_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = stdout.trim();
      if (text.includes("SKIP_IDLE")) {
        resolve(null);
        return;
      }
      if (code !== 0) {
        reject(new Error(`dsh-screencap: capture.ps1 exited ${code}: ${(stderr || stdout).trim().slice(0, 500)}`));
        return;
      }
      const line = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).pop();
      if (!line) {
        reject(new Error("dsh-screencap: capture.ps1 produced no path"));
        return;
      }
      resolve(line);
    });
  });
}

/** Managed capture directory (created on demand). */
function shotsDir() {
  return join(resolveDshHome(), SHOT_DIR);
}

/**
 * Expand the `{{path}}` / `{{time}}` placeholders of the inspect instruction.
 *
 * Unknown placeholders are left untouched rather than blanked, so a typo in a
 * user-authored instruction is visible instead of silently swallowed.
 *
 * @param template - raw instruction from settings.
 * @param shotPath - absolute path of the shot just written.
 * @param shotTime - the shot's timestamp.
 * @returns the instruction actually delivered.
 */
function expandInspectPrompt(template, shotPath, shotTime) {
  return String(template)
    .replaceAll("{{path}}", shotPath)
    .replaceAll("{{time}}", shotTime.toISOString());
}

/**
 * Choose the Session that should receive a capture follow-up.
 *
 * Preference order:
 *   1. the explicitly configured id;
 *   2. the Session whose last *human* message is the most recent;
 *   3. the most recently used Session the controller can list (this is what
 *      makes the very first shot after a restart work: tier 2 is empty then,
 *      because no human has typed since the plugin loaded);
 *   4. the only live root agent, when there is exactly one.
 *
 * With nothing to go on this answers `null` rather than guessing — waking the
 * wrong conversation is worse than not waking one.
 *
 * @param configured - the `inspectSessionId` setting.
 * @param lastHuman - Session id remembered from `api-session/activity`.
 * @param agents - the host `agents` service, when present.
 * @param listSessions - async `() => string[]`, newest-updated first; may fail.
 * @returns a session id, or `null` when no target can be justified.
 */
async function pickInspectSession(configured, lastHuman, agents, listSessions) {
  if (configured !== "") return configured;
  if (lastHuman !== null) return lastHuman;

  if (typeof listSessions === "function") {
    try {
      const ids = await listSessions();
      if (Array.isArray(ids) && ids.length > 0 && typeof ids[0] === "string" && ids[0] !== "") {
        return ids[0];
      }
    } catch {
      /* the listing is a convenience: fall through to the live-agent tier */
    }
  }

  const roots = typeof agents?.roots === "function" ? agents.roots() : [];
  return roots.length === 1 ? roots[0].id : null;
}

/** Timestamp encoded in a shot file name, or `null` when it is not one of ours. */
function shotTime(file) {
  const m = SHOT_RE.exec(file);
  if (m === null) return null;
  const d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * List shot files, newest first.
 *
 * The file name is the authority for ordering, not `mtime`: a shot copied in
 * from elsewhere keeps its encoded time, and a clock-adjusting sync tool that
 * rewrites mtimes cannot reorder the list.
 *
 * @returns `{ file, path, time, bytes }[]`, newest first.
 */
async function listShots() {
  const dir = shotsDir();
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of names) {
    const time = shotTime(file);
    if (time === null) continue;
    const path = join(dir, file);
    let bytes = 0;
    try {
      bytes = (await stat(path)).size;
    } catch {
      continue; // vanished between readdir and stat
    }
    out.push({ file, path, time, bytes });
  }
  out.sort((a, b) => b.time.getTime() - a.time.getTime());
  return out;
}

/**
 * Delete shots older than `keepDays`.
 *
 * @param keepDays - retention window; 0 or less disables pruning.
 * @param logger - host logger.
 * @returns the number of deleted files.
 */
async function pruneShots(keepDays, logger) {
  if (!(keepDays > 0)) return 0;
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const shot of await listShots()) {
    if (shot.time.getTime() >= cutoff) continue;
    try {
      await unlink(shot.path);
      removed += 1;
    } catch (error) {
      logger.warn(`[screencap] could not delete ${shot.path}: ${String(error)}`);
    }
  }
  if (removed > 0) logger.info(`[screencap] pruned ${removed} shot(s) older than ${keepDays} day(s)`);
  return removed;
}

/**
 * Bind the plugin to the host tree.
 *
 * @param ctx - host cordis context.
 * @param config - the resolved Config for this entry (live object).
 */
function apply(ctx, config) {
  // ── floating widget: boot injection row ──────────────────────────────────
  // Registered FIRST and unconditionally: the desktop shell collects the
  // injection table once at host startup, so a row added later never reaches
  // the page. This does not touch `webServer`, so it must not wait for it.
  ctx.on("webserver/index-inject", (table) => {
    try {
      if (!Array.isArray(table)) return;
      for (const row of table) {
        if (!row) continue;
        if (row.kind === "script" && typeof row.text === "string"
          && row.text.indexOf(ROUTE_PREFIX + "/widget.js") >= 0) return; // already present
        if (row.kind === "script-src" && row.src === ROUTE_PREFIX + "/widget.js") return;
      }
      table.push({ kind: "script", placement: "body", text: WIDGET_ROW_TEXT });
    } catch {
      /* a malformed table must never break boot */
    }
  });

  /**
   * Live settings reader.
   *
   * The host re-resolves `config` in place on every settings change, so reading
   * through it here is what makes the timer honour edits without a restart.
   * `config.get()` is the volatile accessor when the host provides one.
   */
  const cfg = () => normalize(typeof config.get === "function" ? config.get() : config);

  /** Whether a capture is currently in flight (the timer never overlaps them). */
  let capturing = false;
  /** Whether a capture follow-up is still being delivered. */
  let notifying = false;
  /** Pending re-arm handle. */
  let timer = undefined;
  /** Set once the effect is disposed, so a late tick stops re-arming. */
  let disposed = false;
  /** Last activeHours text we warned about, so a typo logs once, not per tick. */
  let warnedWindow = null;
  /**
   * Session that most recently received a message from a human.
   *
   * Tracked from `api-session/activity`, which the Session controller emits only
   * for `source.kind === "user"` messages — so the plugin's own follow-ups (and
   * scheduled reminders) never retarget this.
   */
  let lastHumanSession = null;
  ctx.on("api-session/activity", (sessionId) => {
    if (typeof sessionId === "string" && sessionId !== "") lastHumanSession = sessionId;
  });

  /** Read one OPTIONAL host service without joining the `inject` list. */
  const optionalService = (serviceName) => {
    try {
      return typeof ctx.get === "function" ? ctx.get(serviceName) : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Wake the chosen Session with the rendered instruction.
   *
   * Uses `sessionController.resolveAgent` (which resumes a cold Session) with a
   * live-agent fallback, then hands the message to `agent.followup()` — the same
   * entry point `dsh-schedule` and `dsh-webhook` deliver through. The message is
   * tagged `source.kind === "schedule"` so the transcript shows it as a
   * triggered turn rather than something the user typed.
   *
   * Every failure is logged and swallowed: a screenshot must never be lost
   * because the agent half is unavailable.
   *
   * @param c - normalized settings for this tick.
   * @param shotPath - absolute path of the shot just written.
   */
  async function notifyShot(c, shotPath) {
    try {
      const when = shotTime(shotPath.split(/[\\/]/).pop() ?? "") ?? new Date();
      const text = expandInspectPrompt(c.inspectPrompt, shotPath, when);
      const controller = optionalService("sessionController");
      const sessionId = await pickInspectSession(
        c.inspectSessionId,
        lastHumanSession,
        optionalService("agents"),
        // `sessionController.list()` is newest-updated first and needs no live
        // agent, so it covers the "just restarted, nobody has typed yet" case.
        typeof controller?.list === "function"
          ? async () => {
            const { items } = await controller.list({});
            // Skip subagent sessions: a capture review belongs in the
            // conversation the human is actually looking at.
            return (items ?? []).filter((item) => item.parentSessionId === undefined).map((item) => item.sessionId);
          }
          : undefined,
      );
      if (sessionId === null) {
        ctx.logger.warn("[screencap] inspect is on but no target Session could be chosen; set \"inspectSessionId\" or send a message in the Session you want woken");
        return;
      }

      let agent;
      if (controller !== undefined && typeof controller.resolveAgent === "function") {
        const resolved = await controller.resolveAgent(sessionId);
        if (resolved !== undefined && resolved !== null && "error" in resolved) {
          ctx.logger.warn(`[screencap] could not resume Session "${sessionId}": ${String(resolved.error)}`);
          return;
        }
        agent = resolved?.agent;
      }
      if (agent === undefined) agent = optionalService("agents")?.get?.(sessionId);
      if (agent === undefined || agent === null || typeof agent.followup !== "function") {
        ctx.logger.warn(`[screencap] Session "${sessionId}" has no live agent to wake; the shot is still on disk`);
        return;
      }

      agent.followup({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "schedule" },
      });
      // Durability is the Session's job; ask for the flush so a crash right
      // after the capture does not drop the wake-up.
      const sessions = optionalService("sessions");
      if (sessions !== undefined && typeof sessions.flush === "function") {
        const acknowledged = await sessions.flush(agent.session);
        if (acknowledged !== true) ctx.logger.warn(`[screencap] Session "${sessionId}" did not acknowledge the capture follow-up`);
      }
      ctx.logger.info(`[screencap] woke Session "${sessionId}" for ${shotPath}`);
    } catch (error) {
      ctx.logger.warn(`[screencap] inspect notify failed: ${String(error)}`);
    }
  }

  /**
   * Compute the delay until the next tick.
   *
   * Two things can end the current state: the interval elapsing, or the
   * active-hours window opening. Scheduling at the window edge (instead of
   * polling every minute) means a `"22:00-06:00"` window starts capturing at
   * 22:00 sharp rather than at the next multiple of the interval.
   */
  const nextDelay = (c, now) => {
    const base = Math.max(MIN_TICK_MS, c.intervalMinutes * 60_000);
    if (c.activeHours === "") return base;
    const window = parseActiveHours(c.activeHours);
    if (window === null || window.mode === "always") return base;
    const inside = allowsCaptureNow(c.activeHours, now);
    if (inside) {
      // Still leave before the window closes.
      const msLeft = msUntilClock(window.end, now);
      return Math.min(base, msLeft);
    }
    // Outside: wake at the next opening.
    return Math.min(base, msUntilClock(window.start, now));
  };

  /** Arm the next tick. Safe to call repeatedly; the previous timer is cleared. */
  function arm(delayMs) {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    const c = cfg();
    const delay = delayMs ?? nextDelay(c, new Date());
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, delay);
    // Do not hold the process open for a screenshot.
    if (typeof timer.unref === "function") timer.unref();
  }

  /** One scheduled wake-up: maybe capture, maybe prune, then re-arm. */
  async function tick() {
    if (disposed) return;
    const c = cfg();
    try {
      if (!c.enabled) {
        // Disabled: re-check soon so flipping the switch is picked up even if
        // the settings event is missed, but stay cheap.
        arm(60_000);
        return;
      }

      if (c.activeHours !== "") {
        const window = parseActiveHours(c.activeHours);
        if (window === null) {
          if (warnedWindow !== c.activeHours) {
            warnedWindow = c.activeHours;
            ctx.logger.warn(`[screencap] activeHours "${c.activeHours}" is not "HH:MM-HH:MM"; capturing without a time window`);
          }
        } else if (!allowsCaptureNow(c.activeHours)) {
          arm(nextDelay(c, new Date()));
          return;
        }
      }

      if (!capturing) {
        capturing = true;
        let fresh = null;
        try {
          const path = await runCapture(c, ctx.logger);
          if (path === null) ctx.logger.info("[screencap] skipped: desktop is in use");
          else {
            ctx.logger.info(`[screencap] captured ${path}`);
            fresh = path;
          }
        } catch (error) {
          ctx.logger.warn(`[screencap] capture failed: ${String(error)}`);
        } finally {
          capturing = false;
        }
        // Detached on purpose: waking a Session can resume a cold agent, which
        // can take seconds. Awaiting it here would hold the capture loop and
        // push the next tick late, so the shot is already safe on disk and the
        // wake-up runs on its own. `notifying` keeps a slow agent from stacking
        // one notification per tick.
        if (fresh !== null && c.inspectEnabled && !notifying) {
          notifying = true;
          void notifyShot(c, fresh).finally(() => { notifying = false; });
        }
      }

      await pruneShots(c.keepDays, ctx.logger).catch((error) => {
        ctx.logger.warn(`[screencap] prune failed: ${String(error)}`);
      });
    } catch (error) {
      ctx.logger.warn(`[screencap] tick failed: ${String(error)}`);
    }
    arm();
  }

  // Re-arm on every settings change so `intervalMinutes` / `activeHours` /
  // `enabled` take effect immediately. `settings/document-updated` carries the
  // namespace id; other namespaces are ignored.
  const onSettingsChange = (id) => {
    if (id !== undefined && id !== NS) return;
    arm();
  };
  ctx.on("settings/document-updated", onSettingsChange);

  ctx.effect(() => {
    disposed = false;
    void (async () => {
      await mkdir(shotsDir(), { recursive: true }).catch(() => {});
      const c = cfg();
      ctx.logger.info(
        `[screencap] ready — enabled=${c.enabled} interval=${c.intervalMinutes}m `
        + `keep=${c.keepDays}d activeHours="${c.activeHours || "all-day"}" dir=${shotsDir()}`,
      );
      // First shot does not wait a full interval when the window is open.
      arm(MIN_TICK_MS);
    })();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
  }, "dsh-screencap: capture timer");

  // ── floating widget: host routes ─────────────────────────────────────────
  // Registered through a local `inject` so a profile without a webserver (a
  // headless/CLI run) still loads the plugin and keeps the settings section
  // and the agent tools working. A context that has no `inject` at all (an
  // older host, or a minimal test stub) simply gets no routes — and, crucially,
  // still gets the tools below.
  if (typeof ctx.inject === "function") ctx.inject(["webServer"], (scope) => {
    const webServer = (typeof scope.get === "function" ? scope.get("webServer") : undefined) ?? scope.webServer;
    if (webServer === undefined || webServer === null || typeof webServer.register !== "function") return;
    const log = scope.logger ?? ctx.logger;
    /**
     * Read an OPTIONAL service.
     *
     * `settings` and `connection` must never join the `inject` list: a profile
     * that lacks either would then never run this callback at all, and the
     * widget routes would silently vanish. `get()` is a plain synchronous
     * lookup that simply answers `undefined` when the service is absent — the
     * same pattern dsh-whale-widget documents for `deepseekAccount`.
     */
    const service = (name) => {
      try {
        const fromRoot = typeof ctx.get === "function" ? ctx.get(name) : undefined;
        if (fromRoot !== undefined) return fromRoot;
      } catch {
        /* older host: fall through to the scope */
      }
      try {
        return typeof scope.get === "function" ? scope.get(name) : undefined;
      } catch {
        return undefined;
      }
    };
    /** One guarded route registration. */
    const route = (kind, path, handler) => scope.effect(() => {
      return webServer.register({
        kind,
        path,
        handler: async (req, res) => {
          if (refuseRequest(req, service("connection"))) {
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("forbidden");
            return;
          }
          try {
            await handler(req, res);
          } catch (error) {
            log.warn(`[screencap] ${path} failed: ${String(error)}`);
            try {
              res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
              res.end("internal error");
            } catch {
              /* response already started */
            }
          }
        },
      });
    }, `dsh-screencap: route ${path}`);

    // The widget bundle itself. Inline row → this route; 404 here is harmless
    // because the loader swallows the error.
    route("exact", `${ROUTE_PREFIX}/widget.js`, async (_req, res) => {
      const source = await loadWidgetSource();
      if (source === null) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("widget bundle missing");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(source);
    });

    // Status + statistics for the panel.
    route("exact", `${ROUTE_PREFIX}/status.json`, async (_req, res) => {
      const c = cfg();
      const shots = await listShots();
      const bytes = shots.reduce((sum, s) => sum + s.bytes, 0);
      const latest = shots.length > 0 ? shots[0] : null;
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({
        enabled: c.enabled,
        intervalMinutes: c.intervalMinutes,
        keepDays: c.keepDays,
        activeHours: c.activeHours,
        skipWhenIdle: c.skipWhenIdle,
        idleSeconds: c.idleSeconds,
        maxWidth: c.maxWidth,
        quality: c.quality,
        inspectEnabled: c.inspectEnabled,
        dir: shotsDir(),
        count: shots.length,
        bytes,
        capturing,
        latest: latest === null ? null : {
          file: latest.file,
          time: latest.time.toISOString(),
          bytes: latest.bytes,
        },
      }));
    });

    // Recent conversations, for the settings-page picker.
    //
    // The picker exists because `inspectSessionId` is a bare session id: without
    // it the only usable value is "empty" (= auto), and a hand-typed id is
    // exactly the kind of field a non-technical reader cannot fill in. Titles
    // come from the same list projection the sidebar renders, so the dropdown
    // shows what the reader already recognizes.
    //
    // A failure is reported as `ok:false` with an empty list rather than an HTTP
    // error: the browser half falls back to a plain text box, which still works.
    route("exact", `${ROUTE_PREFIX}/sessions.json`, async (_req, res) => {
      const controller = service("sessionController");
      if (controller === undefined || controller === null || typeof controller.list !== "function") {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, sessions: [], auto: null, reason: "no session controller in this profile" }));
        return;
      }
      try {
        const { items } = await controller.list({});
        const sessions = (items ?? [])
          // Subagent sessions are not conversations the human can look at.
          .filter((item) => item !== null && typeof item === "object" && item.parentSessionId === undefined)
          .filter((item) => item.blank !== true)
          .map((item) => {
            const title = item.projections?.values?.title;
            return {
              id: String(item.sessionId),
              title: typeof title === "string" ? title : "",
              updatedAt: Number(item.updatedAt) || 0,
              running: item.running === true,
            };
          })
          .slice(0, 30);
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, sessions, auto: lastHumanSession }));
      } catch (error) {
        ctx.logger.warn(`[screencap] sessions.json failed: ${String(error)}`);
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, sessions: [], auto: null, error: String((error && error.message) || error) }));
      }
    });

    // The newest shot's bytes, as a real image response the page can fetch.
    // `?file=` is validated against the on-disk listing, never joined blindly.
    route("exact", `${ROUTE_PREFIX}/latest.jpg`, async (req, res) => {
      const url = new URL(req.url ?? "/", "http://dsh.invalid");
      const want = url.searchParams.get("file");
      const shots = await listShots();
      const shot = want === null
        ? (shots.length > 0 ? shots[0] : null)
        : (shots.find((s) => s.file === want) ?? null);
      if (shot === null) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("no screenshot");
        return;
      }
      const bytes = await readFile(shot.path);
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
      });
      res.end(bytes);
    });

    // Write one or more settings fields from the floating panel. Goes through
    // the same `settings` service the settings page uses, so revision fencing
    // and hot-apply behave identically; the revision is re-read per attempt.
    route("exact", `${ROUTE_PREFIX}/settings.json`, async (req, res) => {
      if (String(req.method || "GET").toUpperCase() !== "POST") {
        res.writeHead(405, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "POST required" }));
        return;
      }
      const patch = await readJsonBody(req);
      const clean = pickSettingsPatch(patch);
      if (Object.keys(clean).length === 0) {
        res.writeHead(400, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "no writable field supplied" }));
        return;
      }
      const settings = service("settings");
      if (settings === undefined || settings === null || typeof settings.update !== "function") {
        res.writeHead(503, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "settings service unavailable" }));
        return;
      }
      // Retry once on a revision conflict: the settings page (or another
      // writer) may have moved the document between our read and our write.
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const descriptor = settings.describe().find((row) => row.ns === NS);
          await settings.update(NS, clean, descriptor === undefined ? undefined : descriptor.revision);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError !== null) {
        res.writeHead(409, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: String(lastError && lastError.message || lastError) }));
        return;
      }
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: true }));
    });

    // Take one shot right now, bypassing the interval and the active-hours
    // window. Mirrors the `screencap_capture` tool, including the enabled gate.
    route("exact", `${ROUTE_PREFIX}/shoot.json`, async (req, res) => {
      if (String(req.method || "GET").toUpperCase() !== "POST") {
        res.writeHead(405, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "POST required" }));
        return;
      }
      const c = cfg();
      if (!c.enabled) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, captured: false, skipped: "disabled" }));
        return;
      }
      if (capturing) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, captured: false, skipped: "busy" }));
        return;
      }
      capturing = true;
      try {
        const path = await runCapture(c, log);
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(path === null
          ? { ok: true, captured: false, skipped: "idle" }
          : { ok: true, captured: true, path }));
      } finally {
        capturing = false;
      }
    });

    // Open the shot directory in the OS file manager. Loopback-only by the
    // guard above; no path comes from the request.
    route("exact", `${ROUTE_PREFIX}/open-folder.json`, async (req, res) => {
      if (String(req.method || "GET").toUpperCase() !== "POST") {
        res.writeHead(405, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "POST required" }));
        return;
      }
      const dir = shotsDir();
      await mkdir(dir, { recursive: true }).catch(() => {});
      let opened = false;
      let error = "";
      try {
        if (process.platform === "win32") {
          const child = spawn("explorer.exe", [dir], { detached: true, stdio: "ignore", windowsHide: false });
          child.unref();
          opened = true;
        } else {
          const opener = process.platform === "darwin" ? "open" : "xdg-open";
          const child = spawn(opener, [dir], { detached: true, stdio: "ignore" });
          child.unref();
          opened = true;
        }
      } catch (e) {
        error = String(e && e.message || e);
      }
      res.writeHead(opened ? 200 : 500, JSON_HEADERS);
      res.end(JSON.stringify({ ok: opened, dir, error }));
    });
  });

  // ── tools ────────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "screencap_list",
    description:
      "List recent desktop screenshots captured by the dsh-screencap plugin, newest first. Returns the absolute file paths (readable with the read tool) plus their capture times and sizes. Use it to find a shot to look at when the user asks what was on screen.",
    parameters: {
      limit: { type: "integer", description: "Maximum number of shots to return (default 20, max 200)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dir: { type: "string" },
          total: { type: "integer" },
          count: { type: "integer" },
          shots: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                time: { type: "string" },
                bytes: { type: "integer" },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.count === 0
          ? `No screenshots in ${value.dir} yet.`
          : `${value.count} of ${value.total} screenshot(s) in ${value.dir} (newest first):\n`
            + value.shots.map((s) => `- ${s.path}  (${s.time}, ${s.bytes} bytes)`).join("\n"),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const all = await listShots();
      const limit = clampNumber(args?.limit, 20, 1, 200);
      const shots = all.slice(0, limit).map((s) => ({
        path: s.path,
        time: s.time.toISOString(),
        bytes: s.bytes,
      }));
      return { dir: shotsDir(), total: all.length, count: shots.length, shots };
    },
  }));

  ctx.tools.register(defineTool({
    name: "screencap_latest",
    description:
      "Return the absolute path of the most recent desktop screenshot captured by dsh-screencap, or report that none exists yet. Read the returned path with the read tool to see what was on screen.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          exists: { type: "boolean" },
          path: { type: "string" },
          time: { type: "string" },
          bytes: { type: "integer" },
          dir: { type: "string" },
          total: { type: "integer" },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.exists
          ? `Latest screenshot: ${value.path} (${value.time}, ${value.bytes} bytes)`
          : `No screenshots yet in ${value.dir}.`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const all = await listShots();
      const dir = shotsDir();
      if (all.length === 0) {
        return { exists: false, path: "", time: "", bytes: 0, dir, total: 0 };
      }
      const [latest] = all;
      return {
        exists: true,
        path: latest.path,
        time: latest.time.toISOString(),
        bytes: latest.bytes,
        dir,
        total: all.length,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "screencap_capture",
    description:
      "Take one desktop screenshot right now with the current dsh-screencap settings, ignoring the interval and the active-hours window (the enabled switch and the idle check still apply). Returns the path of the new file.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          captured: { type: "boolean" },
          path: { type: "string" },
          skipped: { type: "string" },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.captured
          ? `Captured ${value.path}`
          : `Capture skipped${value.skipped ? `: ${value.skipped}` : ""}.`,
      }],
    },
    isConcurrencySafe: () => false,
    async execute() {
      const c = cfg();
      if (!c.enabled) return { captured: false, path: "", skipped: "the plugin is disabled in settings" };
      if (capturing) return { captured: false, path: "", skipped: "another capture is already running" };
      capturing = true;
      try {
        const path = await runCapture(c, ctx.logger);
        if (path === null) return { captured: false, path: "", skipped: "the desktop is in use (skipWhenIdle)" };
        return { captured: true, path, skipped: "" };
      } finally {
        capturing = false;
      }
    },
  }));
}

export {
  Config,
  DEFAULT_INSPECT_PROMPT,
  NS,
  SHOT_DIR,
  apply,
  expandInspectPrompt,
  inject,
  listShots,
  name,
  normalize,
  pickInspectSession,
  pruneShots,
  shotTime,
};
