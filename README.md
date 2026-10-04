# dsh-screencap

> English | [简体中文](README.zh-CN.md)

A **scheduled screen capture** plugin for DeepSeek Harness: it captures the desktop on an interval in the background, prunes old shots automatically, and lets you toggle it and tune every parameter from the settings page — saving takes effect immediately, with no restart. There is also a **floating widget in the bottom-right corner** that shows the newest shot, copies it to the clipboard, and opens the shot folder without ever opening the settings page.

> **⚠️ Read this before installing: this plugin screenshots your screen.**
>
> That is the whole feature, but it has consequences worth knowing up front:
>
> - **Shots are written to disk in plain JPEG.** They are not encrypted, not redacted and not sandboxed — they sit under `%DSH_HOME%\screencap\shots\` like any other file. Anything that appears on your screen while the timer fires (chat windows, e-mail, password managers, private documents) can end up in one.
> - **The agent can read them.** The bundled `screencap_list` / `screencap_latest` / `screencap_capture` tools let the model open a shot and look at it. Whatever it sees becomes part of the conversation it is serving.
> - **"Wake me after a capture" costs traffic.** With `inspectEnabled` on, every shot triggers a real agent turn. The default instruction deliberately routes the image read through a **subagent** so the picture never enters the main Session — a main-Session image is re-uploaded on every later request. Keep `intervalMinutes` sane and turn `maxWidth` / `quality` down.
> - **Nothing is uploaded by this plugin.** There is no telemetry and no network call to any server other than the one DSH already talks to; the capture path is a local PowerShell script writing a local file. What leaves your machine is decided by the agent, not by this plugin.
>
> Defaults are conservative (`maxWidth: 1600`, `quality: 80`, `keepDays: 3`, `inspectEnabled: false`), but the master switch is `enabled` — if you are not sure, turn it off until you are.

## Purpose

- Lets the agent "see" what happened on screen: three tools ship with it — `screencap_list` / `screencap_latest` / `screencap_capture` — so the agent can list shots, fetch the newest one, or take one right now.
- Good for keeping a screen log on a machine that stays up for a long time (paired with the mobile shell it can run 24/7).
- The floating widget keeps "that shot from a moment ago" within reach: one click copies it, then `Ctrl+V` in the composer sends it to the conversation.

## Floating widget

A camera button in the bottom-right corner opens a small panel:

| Control | What it does |
| --- | --- |
| Enable scheduled capture | Writes `enabled` immediately (it shares one settings namespace with the settings page, so both sides stay in sync). |
| Interval (minutes) | Writes `intervalMinutes` immediately; the value is clamped to 1–1440. |
| Preview | A thumbnail of the newest shot, refreshed by a 20-second poll (it polls only while the panel is open). |
| Copy latest shot (then Ctrl+V) | Writes the newest shot to the system clipboard as **PNG**; press `Ctrl+V` in the composer to paste it as an attachment. |
| Try inserting straight into the composer | **EXPERIMENTAL**: dispatches a synthetic `paste` event carrying the image to `[data-composer-input]`. See "The measured limits of synthetic paste" below. |
| Capture now | Takes a shot immediately, ignoring the interval and the time window (it still refuses when `enabled` is off, matching `screencap_capture`). |
| Open shot folder | Opens the shot directory in the system file manager. |

The panel can be closed (`×` / click outside / `Esc`), and the button position deliberately **steers clear of the balance whale widget**: that widget's box width varies with the viewport and with its own scale setting, so this widget **measures** the whale's live DOM rect and parks the button 8–12px to the left of its body instead of hard-coding an offset (a hard-coded offset misses at 1280×800 but collides at 1920×1080). When the whale is not installed it falls back to the CSS variables `--sc-right` / `--sc-bottom`.

### How the widget is injected (important)

The host half pushes one **inline `<script>`** line through `webserver/index-inject`, and that line builds `<script src="/dsh-screencap/widget.js">` itself and **swallows `onerror`**.

This is not a detour — it is the only safe route. The reasons are recorded above `WIDGET_ROW_TEXT` in `index.js`:

- On desktop, `index.html` is served straight from the installer's static dist, so the host's `tapIndex` / `renderIndex` **never run on it**. The only channel is this structured row table, and the shell collects it **once at host startup** and then caches it — there is no refresh path.
- The page-side interpreter handles the two kinds of script row **asymmetrically**: `script` (inline) is just `textContent` + `append`, so it **cannot fail to load**; `script-src` goes through `await loadScript(src)`, which rejects on failure — and that rejection rejects `__DSH_BOOT_READY__` ⇒ **the whole app fails to start (white screen)**.
- The table is collected once at startup and never refreshed ⇒ if the plugin is turned off at runtime the row is still there while its routes are already unregistered ⇒ `script-src` becomes a 404 ⇒ white screen on the next restart.

So the row is always `kind: "script"` and carries its own `onerror` fallback. A test in `tests/host-integration.test.mjs` pins down exactly these two points (`kind === "script"` and `onerror` present in the text).

### The measured limits of synthetic paste

"Try inserting straight into the composer" is **EXPERIMENTAL**. Here is what was actually measured:

- **A synthetic `paste` event does carry files into Lexical's paste pipeline.** The DSH composer is a Lexical editor; its `PASTE_COMMAND` listener reads `event.clipboardData`, collects the entries with `kind === "file"`, and hands them to the attachment entry point, **with no `isTrusted` check anywhere along the way**. In a reproduction environment built on the same Lexical version DSH uses (0.49.0), dispatching `new DataTransfer()` + `new ClipboardEvent("paste", {clipboardData: dt})` at the editor root **did fire** the command and the file **was** read (`1:shot_....jpg/image/jpeg`).
- **But it must be dispatched on the editor root**: dispatched at `document.body` the command does not fire (the event does not bubble up to the listener on the root). The widget dispatches it that way.
- **It is still labelled experimental**, because a synthetic event is not a browser paste: no real clipboard is involved, and the editor's own default behaviour never runs. This logic has **not been verified end to end on a live DSH page** (on this machine there is no way to get a debug channel into the desktop renderer process), so the UI keeps it separate from "Copy" and the label explicitly says "please check whether an image appeared in the composer".
- **The fallback path is reliable**: `navigator.clipboard.write([new ClipboardItem({'image/png': png})])` was measured to succeed under a **real user click** (a CDP-dispatched trusted click with `clipboard-write` permission `granted`). Shots are JPEG, and `ClipboardItem` wants PNG on Chromium, so the widget first draws the JPEG onto a canvas and then calls `toBlob('image/png')`; it also **pre-warms** that PNG when the panel opens, so the `clipboard.write` inside the click handler does not have to cross a user-activation window.

## Where shots are stored

```
%DSH_HOME%\screencap\shots\shot_YYYY-MM-DD_HH-mm-ss.jpg
```

`%DSH_HOME%` is resolved by `resolveDshHome()` from `@deepseek-ai/dsh-home-paths` (it prefers `$DSH_HOME`, otherwise `~\.dsh`). By default shots land in `~\.dsh\screencap\shots`.

The timestamp in the filename is the **only** basis for sorting and pruning (mtime is not consulted), so rewriting mtime from an external tool cannot scramble the order.

## Settings

Change these in **Settings → Screenshots**; after saving they take effect on the very next tick.

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch for scheduled capture. When off, nothing is captured automatically in the background (the agent can still take one shot manually with `screencap_capture`). |
| `intervalMinutes` | `30` | Capture interval in minutes, 1–1440. |
| `maxWidth` | `1600` | Maximum width after downscaling. Anything wider is scaled down proportionally; `0` = keep the native resolution, no scaling. |
| `quality` | `80` | JPEG quality, 1–100. |
| `keepDays` | `3` | How many days shots are kept; older ones are deleted after each capture; `0` = never prune. |
| `activeHours` | `""` | Capture only inside this time window, format `HH:MM-HH:MM`. Empty = all day, no restriction. **Cross-midnight windows are supported**, e.g. `22:00-06:00`. |
| `skipWhenIdle` | `false` | Skip this capture while the desktop is in use. |
| `idleSeconds` | `60` | The "in use" threshold in seconds: keyboard or mouse input within the last this many seconds counts as in use. |
| `inspectEnabled` | `false` | **Wake me after a capture**: wake the agent to look at the shot after every successful capture. See the next section. |
| `inspectPrompt` | (built-in Chinese instruction) | The instruction sent to the agent for the inspection; supports the `{{path}}` / `{{time}}` placeholders. |
| `inspectSessionId` | `""` | Which Session to wake. Empty = automatic (see below). |

Every numeric value is **clamped to its legal range** when it is read (a hand-broken settings.yaml will not crash anything), and an illegal value falls back to the default.

## Wake me after a capture (capture-triggered inspect)

Off by default. When it is on, **every successful capture** posts a message into a Session, and the agent that receives it looks at that shot and comments — in other words, one capture, one look.

This solves the mismatch between two timelines — the scheduled inspection and the capturer: the capturer already runs on `intervalMinutes`, so the inspection needs no separate cron and the two line up by construction (a shot every 20 minutes means a look every 20 minutes).

### ⚠️ The image must be read by a **subagent** (this is design, not style)

The default instruction tells the main agent to **dispatch a subagent with `subagent`** to do the `read_image`, bringing back only the text conclusion; the main agent **must not read the image itself**.

The reason is token traffic, not tidiness:

- Once an image enters the **main conversation** it **stays in the history forever**; every later request has to re-upload the whole history, images included.
- Measured: with a 20-minute interval and full-quality shots, one day produced 57 shots totalling 66 MB; because of that constant re-uploading, the day's model requests moved **about 295 MB of image data (about 404 MB after base64)** in total.
- The subagent reads the image inside **its own conversation**, so the image never enters the main thread and the main history stays clean.

If you edit `inspectPrompt`, **please keep this rule**. A test in `tests/host-integration.test.mjs` pins down that the default instruction must contain `subagent`, `read_image`, and the "do not read the image yourself" clause.

> Also remember to turn `maxWidth` / `quality` down (for example `1280` / `75`). At the defaults of `1600` / `80`, a shot of a 2560-wide screen is 1–2 MB; at `1280`/`75` the same frame is about 150–350 KB.

### How the message is posted

It calls `sessionController.resolveAgent(sessionId)` to get an agent (**waking a cold Session** if necessary), then `agent.followup(message)` with the message's `source.kind` set to `"schedule"` — that is why the conversation shows it as a scheduled run rather than as something you typed. After posting it calls `sessions.flush(agent.session)` for a write-to-disk acknowledgement, so a crash right after the capture cannot lose that wake-up.

It goes through the same entry point as `dsh-schedule` / `dsh-webhook`.

### Which Session gets woken

In priority order:

1. `inspectSessionId` is set → use it (it must be a full session id).
2. Otherwise the **Session you most recently spoke in** (tracked from `api-session/activity`; that event only fires for messages with `source.kind === "user"`, so the plugin's own deliveries cannot skew it).
3. Otherwise the **most recently updated conversation** in `sessionController.list()` (it is ordered by update time, newest first, and does not need a live agent). This tier exists for the "just restarted, nobody has typed yet" case — without it the first shot would be captured for nothing.
4. Otherwise, if there is exactly **one** top-level agent → use it.
5. If none of the above holds → **skip and log a warning**; no guessing. The shot is still on disk.

Subagent conversations are skipped at tier 3: a shot review belongs in the conversation you are looking at, not inside some background subtask.

Better to stay silent this time than to wake the wrong one.

### Cost and scheduling

- **Every shot really runs an agent turn** (plus one subagent turn), which is why `inspectEnabled` is off by default. Think through `intervalMinutes` before turning it on.
- The wake-up runs **detached** from the capture loop (`void notifyShot(...)`). Waking a cold Session can take several seconds, and awaiting it would push the next capture back; the shot is already safely on disk, so there is no reason to wait.
- A `notifying` flag prevents a pile-up when the wake-up is slower than the capture: if the previous delivery is still in flight, this round skips the post (the shot is still taken).
- Any delivery failure only logs a warning and **never affects capturing**. A Session that cannot be found, a failed resume, a flush that was not acknowledged — each one is spelled out in the log.

### The time-window semantics of `activeHours`

- Empty / all whitespace → all day, no restriction.
- Same start and end (e.g. `08:00-08:00`) → treated as all day (not as "never capture").
- End earlier than start (e.g. `22:00-06:00`) → **crosses midnight**, covering both `22:00–24:00` and `00:00–06:00`.
- The end instant is **exclusive**: `08:00-23:00` does not include 23:00 itself, so `08:00-12:00` and `12:00-18:00` do not both claim 12:00.
- A malformed value (e.g. `8am-11pm`) → logs a warning and then **treats it as all day**, continuing to capture. Better to capture too much than to silently switch the feature off over a typo.

The scheduler does not poll every minute: the timer wakes at whichever comes first — the interval expiring or a time-window open/close boundary — so a `22:00-06:00` window starts exactly at 22:00 instead of waiting for a multiple of the interval.

## How the capture works

It shells out to PowerShell to run the bundled `capture.ps1` (`System.Windows.Forms` + `System.Drawing`; grabs the virtual screen, scales it proportionally, and saves a JPEG at the configured quality).

Why this instead of a native Node implementation: Node has no built-in screen-capture API, and the native options are either heavy (node-ffmpeg / a bare sharp pipeline) or need a module compiled on this machine — and **this machine cannot create symbolic links**, so pnpm installing a native module fails with `EPERM`. PowerShell ships with every Windows, and the script is a bundled resource, so the installation cost is zero.

> `capture.ps1` **stays pure ASCII**: Windows PowerShell 5.1 decodes a file without a BOM as GBK, and a non-ASCII character (even one inside a comment) can turn into a straight syntax error. Keeping it pure ASCII makes it independent of the code page, and it survives a lost BOM.

Before querying any screen size, the script calls `SetProcessDpiAwarenessContext(-4)` (per-monitor-v2), falling back to `SetProcessDPIAware()` on older systems. This step is not optional: on a 2560×1600 screen at 125% scaling, a DPI-unaware process is told the virtual screen is 2048×1280, so `CopyFromScreen` captures only the **top-left corner** of the real desktop — the taskbar clock and the whole right-hand side silently disappear. With DPI awareness on, the reported size, the capture rectangle, and the physical pixels finally agree.

The "no input" test behind `skipWhenIdle` calls `GetLastInputInfo` (`user32.dll`) through P/Invoke, entirely on the PowerShell side, and that code is **compiled only when the option is on** (`Add-Type` costs about 0.3 seconds). The elapsed time is computed with unsigned subtraction, so it survives the 32-bit wraparound of `TickCount` (about 49.7 days). A failed probe only logs a warning and captures anyway — the probe is a nice-to-have, and it should never be the reason a shot is lost.

## How to turn it on and off

1. Open **Settings** and choose **Screenshots** on the left.
2. Clear **Enable scheduled capture** → Save (the checkbox writes immediately, so a single click already takes effect).
3. To stop it completely, just turn `enabled` off; to grab one shot on demand, use `screencap_capture`.

## Tools for the agent

| Tool | What it does |
| --- | --- |
| `screencap_list` | Lists the absolute paths of recent shots (newest → oldest) with their times and byte sizes. `limit` defaults to 20, capped at 200. |
| `screencap_latest` | Returns the path of the newest shot; when there is none it honestly returns `exists: false`. |
| `screencap_capture` | Takes one shot right now, ignoring the interval and the time window (the `enabled` switch and the idle check still apply). |

## Widget HTTP routes

All of them are `kind: "exact"` read-only / small-write routes registered under the `/dsh-screencap/` prefix. Every one first passes a **loopback / same-origin fence** (`sec-fetch-site: cross-site` is an immediate 403; when an `Origin` is present it must be same-origin with `Host`; if the host's `connection.requestRejection` is available the check is delegated to it, otherwise the self-check above stands alone, and a validator that throws is treated as a rejection).

| Route | Method | What it does |
| --- | --- | --- |
| `/dsh-screencap/widget.js` | GET | The widget script itself. 404 when the file is missing (the loading side swallows the error, so it is harmless). |
| `/dsh-screencap/status.json` | GET | Settings + shot count/size + newest-shot info. |
| `/dsh-screencap/latest.jpg` | GET | The newest shot's bytes; `?file=` can only hit a filename that **actually exists on disk** — no path concatenation. |
| `/dsh-screencap/settings.json` | POST | Accepts only `enabled` and `intervalMinutes`; every other field is discarded; the write goes through the host `settings` service (the same revision fencing the settings page uses) and retries once on conflict. |
| `/dsh-screencap/shoot.json` | POST | Takes one shot right now. |
| `/dsh-screencap/open-folder.json` | POST | Opens the shot directory. The path is decided entirely server-side; the request carries no path. |

The routes are registered inside `ctx.inject(["webServer"], ...)`, so a profile without a webserver (headless / CLI) still loads the plugin and keeps the settings page and the three tools — it just has no widget.

## Known limitations

- **Windows only.** `capture.ps1` depends on `System.Windows.Forms`; calling it on a non-Windows host raises an explicit error rather than failing silently.
- **Requires Windows 10 version 1703 (Creators Update) or newer** — all Windows 11 releases qualify. The capture script opts into per-monitor-v2 DPI awareness via `SetProcessDpiAwarenessContext`, which was [introduced in 1703](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext). On older builds the script falls back to `SetProcessDPIAware()`, which still works on a single monitor but can crop the shot on a multi-monitor setup where the monitors use different scale factors.
- It captures the **virtual screen** (multiple monitors are merged into one wide image), not a single window or a single monitor.
- The time resolution is one image per interval; whatever happens between intervals is not recorded.
- `activeHours` reads the **machine's local time**; changing the system time zone does not retroactively affect existing files.
- The widget's "try inserting straight into the composer" has not been verified end to end on a live DSH page (see above).
- The widget recognises the whale by the `.dshwv-root` class name. If the whale changes its class name the avoidance stops working (it falls back to the CSS default offset), but it **will not** error out or get in your way.
- "Wake me after a capture" needs a **host that can carry messages** (at least one of `sessionController` / `sessions` / `agents` available). In a headless / CLI configuration there is no `sessionController`, so it falls back to `agents.get()`, and if that also comes up empty it only logs a warning — capturing itself carries on as usual.

## Development

```powershell
# Pure-function unit tests (no external dependencies)
node --test tests/schedule.test.mjs

# Host-half integration tests: extract the runtime dependencies from app.asar first
# Replace the <DSH 安装目录> placeholder with your own path (right-click the DSH shortcut in Explorer → Open file location)
node tests/extract-deps.mjs "<DSH 安装目录>\resources\app.asar" .. --max-mb 4
node --test tests/host-integration.test.mjs tests/client-smoke.test.mjs
node --test tests/schedule-runtime.test.mjs   # really takes a screenshot, slow
node --test tests/inspect.test.mjs            # really takes a screenshot and posts a wake-up, slow
```

`tests/extract-deps.mjs` extracts the `@deepseek-ai/*` packages from `app.asar` into `plugin-src/node_modules` (plain Node cannot read inside asar; only the patched Electron can). **Do not commit** the extracted files — they exist only so that `import "../index.js"` actually runs. When dependencies are missing, the tests skip themselves automatically and say why; they never fail spuriously.

## License

MIT, see [LICENSE](LICENSE).
