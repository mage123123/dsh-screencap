/**
 * dsh-screencap — browser half.
 *
 * Settings section (截屏记录): the capture switch, interval, active-hours
 * window, idle skip, and the image parameters. Everything is written into the
 * `screencap` settings namespace, which the host plugin reads live — so a save
 * takes effect on the next tick with no restart.
 *
 * Hand-written ModuleLoader bundle — no build step required. The loader `id`
 * must equal the package name, or ModuleLoader reports "loaded without
 * registering dsh-screencap".
 */
window.__ModuleLoader__.load({
  id: "dsh-screencap",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    /** Settings namespace owned by the host half. */
    var SETTINGS_NS = "screencap";
    /** Locale dictionary namespace for this section. */
    var LOCALE_NS = "screencapUi";
    /** URL prefix of the host-half routes this bundle reads. */
    var ROUTE_PREFIX = "/dsh-screencap";

    // ── CSS (theme tokens) ────────────────────────────────────────────────
    var CSS = ".__sc_root{max-width:640px;display:flex;flex-direction:column;gap:10px}" +
      ".__sc_group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}" +
      ".__sc_field{display:flex;flex-direction:column;gap:4px}" +
      ".__sc_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__sc_hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}" +
      ".__sc_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__sc_input:disabled{opacity:.5}" +
      ".__sc_num{max-width:180px}" +
      ".__sc_textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;resize:vertical;min-height:120px}" +
      ".__sc_row{display:flex;align-items:center;gap:8px}" +
      ".__sc_check{accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__sc_actions{display:flex;gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap}" +
      ".__sc_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__sc_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__sc_btn:disabled{opacity:.5;cursor:default}" +
      ".__sc_btnPrimary{border-color:var(--dsw-alias-state-business-primary, #3964fe);background:var(--dsw-alias-state-business-primary, #3964fe);color:#fff}" +
      ".__sc_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__sc_select{appearance:none;cursor:pointer}" +
      ".__sc_select:disabled{cursor:default}" +
      ".__sc_sessionRow{display:flex;gap:8px;align-items:center}" +
      ".__sc_sessionRow .__sc_input{flex:1 1 auto}" +
      ".__sc_sessionRow .__sc_btn{flex:0 0 auto;white-space:nowrap}" +
      ".__sc_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__sc_unavailable{font-size:13px;color:var(--dsw-alias-label-tertiary)}";
    var tagId = "dsh-screencap/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-screencap";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    var zh = {
      nav: "截屏记录",
      intro: "后台按间隔自动截屏，图片存在 %DSH_HOME%\\screencap\\shots，超期的自动清理。改完点「保存」，下一次计时立刻用新设置，不用重启。",
      basicTitle: "基础",
      switchLabel: "启用定时截屏",
      switchHint: "总开关。关掉后后台不再自动截屏（agent 仍可用 screencap_capture 手动抓一张）。",
      intervalLabel: "截屏间隔（分钟）",
      intervalHint: "默认 30 分钟。1–1440。",
      keepDaysLabel: "保留天数",
      keepDaysHint: "默认 3 天。超过这个天数的截图会在每次截屏后被删除；填 0 = 永不清理。",
      windowTitle: "时间段限制（可选）",
      activeHoursLabel: "只在指定时间段截屏",
      activeHoursHint: "留空 = 全天不限。格式 HH:MM-HH:MM，例如 08:00-23:00。跨天也支持，例如 22:00-06:00 表示晚上十点到次日早上六点。",
      idleLabel: "桌面正在使用时跳过本次截屏",
      idleHint: "默认关闭。开启后，如果最近 60 秒内有键鼠输入（看得到你正在干活），这一次就不截。",
      idleSecondsLabel: "「正在使用」的判定秒数",
      idleSecondsHint: "最近这么多秒内有键鼠输入就算在用。默认 60 秒。",
      inspectTitle: "拍完自动叫我（巡检）",
      inspectLabel: "每拍一张就唤醒 agent 看一眼",
      inspectHint: "默认关闭。开启后，每次截图成功都会往会话里投一条消息，agent 会读那张图并点评——也就是「拍一张、看一眼」。注意：每张图都会消耗 token，间隔别设太短。",
      inspectPromptLabel: "巡检提示词",
      inspectPromptHint: "留空 = 用内置指令（推荐新手）。想改的话点下面的「填入内置指令」拿到完整起点再改；必须保留 {{path}}、{{time}} 两个占位符，以及派子助手读图那段——否则图片会进主会话，之后每次提问都要重传，很费流量。",
      inspectPromptFill: "填入内置指令",
      inspectPromptFilled: "已填入，可直接编辑",
      inspectSessionLabel: "唤醒哪个会话",
      inspectSessionHint: "巡检消息会出现在这个会话里。默认「自动跟随」= 你最近说过话的那个会话——开新对话后它会自动跟过去，不用改设置。",
      inspectSessionAuto: "自动跟随（推荐）",
      inspectSessionOther: "手动输入 id",
      inspectSessionRefresh: "刷新列表",
      inspectSessionLoading: "正在读取会话列表…",
      inspectSessionEmpty: "没读到会话列表，用下面的框手动填 id。",
      inspectNoTarget: "巡检已开启，但找不到该唤醒的会话，本次已跳过（看日志）。",
      imageTitle: "图片参数",
      maxWidthLabel: "最大宽度（像素）",
      maxWidthHint: "默认 1600。超过这个宽度就等比缩小；填 0 = 原始分辨率不缩放。",
      qualityLabel: "JPEG 质量",
      qualityHint: "默认 80。1–100，越大越清晰、文件越大。",
      save: "保存",
      saving: "保存中…",
      saved: "已保存",
      reset: "重新载入",
      error: "操作失败",
      notApplied: "写入未生效，请检查当前设置",
      invalidNumber: "数字填写有误，请检查各字段的取值范围",
      invalidHours: "时间段格式不对，应为 HH:MM-HH:MM（如 08:00-23:00），留空表示全天",
      unavailable: "设置命名空间不可用（服务端未注册 screencap 命名空间？）",
      loading: "加载中…",
      dirHint: "截图目录："
    };
    var en = {
      nav: "Screenshots",
      intro: "Captures the desktop on a timer into %DSH_HOME%\\screencap\\shots and prunes old files. Press Save and the next tick uses the new values — no restart.",
      basicTitle: "Basics",
      switchLabel: "Enable scheduled capture",
      switchHint: "Master switch. When off, nothing is captured automatically (the agent can still take one shot with screencap_capture).",
      intervalLabel: "Interval (minutes)",
      intervalHint: "Default 30. Range 1–1440.",
      keepDaysLabel: "Keep (days)",
      keepDaysHint: "Default 3. Shots older than this are deleted after each capture; 0 disables pruning.",
      windowTitle: "Time window (optional)",
      activeHoursLabel: "Only capture inside this window",
      activeHoursHint: "Empty means all day. Format HH:MM-HH:MM, e.g. 08:00-23:00. Cross-midnight works too: 22:00-06:00 means 10pm through 6am.",
      idleLabel: "Skip while the desktop is in use",
      idleHint: "Off by default. When on, a capture is skipped if there was keyboard/mouse input in the last 60 seconds.",
      idleSecondsLabel: "\"In use\" threshold (seconds)",
      idleSecondsHint: "Input within this many seconds counts as active. Default 60.",
      inspectTitle: "Wake the agent after a capture",
      inspectLabel: "Wake the agent on every capture",
      inspectHint: "Off by default. When on, each successful capture posts a message into a Session so the agent reads that shot and comments. Every shot costs tokens — keep the interval sane.",
      inspectPromptLabel: "Instruction",
      inspectPromptHint: "Leave empty to use the built-in instruction (the easy option). To change the tone, click \"Fill in the built-in instruction\" below and edit from there. Keep the {{path}} and {{time}} placeholders and the delegation to a subagent — without them the shot enters the main Session and gets re-uploaded on every later request.",
      inspectPromptFill: "Fill in the built-in instruction",
      inspectPromptFilled: "Filled in — edit freely",
      inspectSessionLabel: "Session to wake",
      inspectSessionHint: "Inspect messages appear in this Session. \"Follow automatically\" (the default) uses the Session you most recently typed in, so a new conversation is picked up without touching this setting.",
      inspectSessionAuto: "Follow automatically (recommended)",
      inspectSessionOther: "Type an id",
      inspectSessionRefresh: "Refresh list",
      inspectSessionLoading: "Reading the Session list…",
      inspectSessionEmpty: "Could not read the Session list — type an id in the box below.",
      inspectNoTarget: "Inspect is on but no Session could be chosen; this shot was skipped (see the log).",
      imageTitle: "Image",
      maxWidthLabel: "Max width (px)",
      maxWidthHint: "Default 1600. Wider shots are downscaled; 0 keeps the native resolution.",
      qualityLabel: "JPEG quality",
      qualityHint: "Default 80. Range 1–100; higher is sharper and larger.",
      save: "Save",
      saving: "Saving…",
      saved: "Saved",
      reset: "Reload",
      error: "Operation failed",
      notApplied: "Write did not take effect; check the current settings",
      invalidNumber: "A number is out of range",
      invalidHours: "The window must look like HH:MM-HH:MM (e.g. 08:00-23:00); leave it empty for all day",
      unavailable: "Settings namespace unavailable (screencap namespace not registered server-side?)",
      loading: "Loading…",
      dirHint: "Shot directory: "
    };

    /**
     * Whether a namespace section now reflects every queued operation.
     *
     * A settled write says nothing about whether it was APPLIED: the scope
     * contract is "settle after the write and any recovery read", so a write
     * the Host refused still resolves. Inspecting the section afterwards is the
     * only way to tell a committed change from a refused one.
     */
    function settingsOpsApplied(snapshot, ops) {
      if (!snapshot || snapshot.status !== "ready" || snapshot.value === void 0) return false;
      var user = snapshot.user && typeof snapshot.user === "object" ? snapshot.user : {};
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        var key = op.path[0];
        if (op.op === "unset") {
          if (key in user) return false;
        } else if (JSON.stringify(snapshot.value[key]) !== JSON.stringify(op.value)) {
          return false;
        }
      }
      return true;
    }

    /**
     * Apply one batch of namespace operations; resolves whether it took effect.
     *
     * One `mutate()` carries one revision fence and one persistence decision for
     * the whole batch. Issuing the same changes as separate `set()` calls gives
     * each its own fence, and a fence behind the Host document is refused — so
     * an edit could be rejected while the UI still reported success.
     */
    function commitSettingsOps(scope, ops) {
      if (ops.length === 0) return Promise.resolve(true);
      var run;
      if (typeof scope.mutate === "function") {
        run = scope.mutate(ops, scope.getSnapshot().revision);
      } else {
        run = ops.reduce(function (chain, op) {
          return chain.then(function () {
            return op.op === "unset" ? scope.unset(op.path[0]) : scope.set(op.path[0], op.value);
          });
        }, Promise.resolve());
      }
      return Promise.resolve(run).then(function () {
        return settingsOpsApplied(scope.getSnapshot(), ops);
      });
    }

    /**
     * The host's built-in inspect instruction, mirrored verbatim.
     *
     * The settings box starts empty and an empty box is legal — the host falls
     * back to this text. Offering it as a "fill it in" button is what makes the
     * field usable at all: a reader who wants a different tone has no way to
     * guess the required delegation clauses, and a wrong guess silently costs
     * tokens on every capture from then on.
     *
     * `tests/client-smoke.test.mjs` pins this against the host's export, so the
     * two copies cannot drift.
     */
    var DEFAULT_INSPECT_PROMPT = "【截图巡检】刚拍了一张屏幕截图：{{path}}（{{time}}）。\n"
      + "请用 subagent 工具派一个子助手去读这张图（让它用 read_image 读），并要求它只回报文字结论：两行以内——第一行说用户在做什么，第二行在学习/上课时补一句有用的知识，否则写「无」。\n"
      + "你自己不要直接读图：图片一旦进入本会话就会永久留在历史里，之后每次提问都要重传一遍，很费流量。子助手在它自己的会话里读，只把文字带回来。\n"
      + "拿到文字结论后，用一句话转述给用户，别长篇、别列表。如果是锁屏或黑屏，就说明一句「屏幕锁着/黑着」。";

    /** Effective defaults, mirroring the host schema. */
    var DEFAULTS = {
      enabled: true,
      intervalMinutes: 30,
      keepDays: 3,
      activeHours: "",
      skipWhenIdle: false,
      idleSeconds: 60,
      maxWidth: 1600,
      quality: 80,
      inspectEnabled: false,
      inspectPrompt: "",
      inspectSessionId: ""
    };

    /** Numeric fields: key, locale labels, inclusive range, and whether 0 is legal. */
    var NUM_FIELDS = [
      { key: "intervalMinutes", label: "intervalLabel", hint: "intervalHint", min: 1, max: 1440, integer: true },
      { key: "keepDays", label: "keepDaysLabel", hint: "keepDaysHint", min: 0, max: 3650, integer: true },
      { key: "idleSeconds", label: "idleSecondsLabel", hint: "idleSecondsHint", min: 1, max: 3600, integer: true },
      { key: "maxWidth", label: "maxWidthLabel", hint: "maxWidthHint", min: 0, max: 16384, integer: true },
      { key: "quality", label: "qualityLabel", hint: "qualityHint", min: 1, max: 100, integer: true }
    ];

    /** Validate an `HH:MM-HH:MM` window; empty is legal (= all day). */
    function validActiveHours(text) {
      var raw = String(text == null ? "" : text).trim();
      if (raw === "") return true;
      var parts = raw.split("-");
      if (parts.length !== 2) return false;
      for (var i = 0; i < parts.length; i++) {
        if (!/^\d{1,2}:\d{2}$/.test(parts[i].trim())) return false;
        var bits = parts[i].trim().split(":");
        var hh = Number(bits[0]);
        var mm = Number(bits[1]);
        if (hh > 23 || mm > 59) return false;
      }
      return true;
    }

    function ScreencapSection(props) {
      var t = props.t;
      var scope = props.scope;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      /** Staged edits, keyed by field; absent = follow the stored value. */
      var [draft, setDraft] = react.useState({});
      var [busy, setBusy] = react.useState(false);
      var writePending = react.useRef(false);
      var [notice, setNotice] = react.useState(null);
      var [error, setError] = react.useState(null);
      /**
       * Session picker state.
       *
       * `list` is the host's recent-conversation list, `state` tracks the read
       * so the field can say what it is doing, and `manual` reveals the raw id
       * box when the reader wants an id the list does not offer (or when the
       * list could not be read at all).
       */
      var [sessions, setSessions] = react.useState([]);
      var [sessionsState, setSessionsState] = react.useState("idle");
      var [manual, setManual] = react.useState(false);

      function loadSessions() {
        setSessionsState("loading");
        fetch(ROUTE_PREFIX + "/sessions.json", { credentials: "same-origin", cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
          .then(function (data) {
            setSessions(Array.isArray(data && data.sessions) ? data.sessions : []);
            setSessionsState("ready");
          })
          .catch(function () {
            setSessions([]);
            setSessionsState("error");
          });
      }

      react.useEffect(function () {
        // Read once on mount. The list is only a convenience for the picker, so
        // a failure degrades to the raw id box instead of blocking the section.
        loadSessions();
      }, []);

      react.useEffect(function () {
        // No refresh call: reads ride the shared describe mirror, which re-reads
        // on every Host `settings/document-updated`. The scope is bound once for
        // this plugin and shared across mounts, so unmounting must only
        // unsubscribe — disposing it would make a later remount silently drop
        // writes.
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        return function () { alive = false; if (un) un(); };
      }, [scope]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__sc_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__sc_status" }, t("loading"));

      var value = snapshot.value;

      function stored(key) {
        var v = value[key];
        return v === void 0 || v === null ? DEFAULTS[key] : v;
      }
      function fieldValue(key) {
        return draft[key] !== void 0 ? draft[key] : stored(key);
      }
      function setField(key, v) {
        setDraft(function (prev) { var next = Object.assign({}, prev); next[key] = v; return next; });
        setNotice(null); setError(null);
      }
      function clearNotices() { setNotice(null); setError(null); }

      /** One write path for every field of this section. */
      function runWrite(ops, onOk) {
        if (writePending.current) return;
        writePending.current = true;
        setBusy(true); clearNotices();
        commitSettingsOps(scope, ops).then(function (ok) {
          writePending.current = false;
          setBusy(false);
          setSnapshot(scope.getSnapshot());
          if (!ok) { setError(t("error") + "：" + t("notApplied")); return; }
          setNotice(t("saved"));
          if (onOk) onOk();
        }).catch(function (e) {
          writePending.current = false;
          setBusy(false); setSnapshot(scope.getSnapshot());
          setError(t("error") + ": " + String((e && e.message) || e));
        });
      }

      /** Immediate single-key write, for the two checkboxes. */
      function toggle(key, next) {
        runWrite([{ op: "set", path: [key], value: next }]);
      }

      function onSave() {
        var ops = [];
        // Checkboxes: written immediately on toggle, so only reconcile if the
        // user staged them (they never do) — compare against stored instead.
        NUM_FIELDS.forEach(function (f) {
          var raw = fieldValue(f.key);
          var num = Number(raw);
          if (String(raw).trim() === "" || !Number.isFinite(num)) { ops.push({ invalid: f.key }); return; }
          var n = Math.floor(num);
          if (n < f.min || n > f.max) { ops.push({ invalid: f.key }); return; }
          if (n !== Number(stored(f.key))) ops.push({ op: "set", path: [f.key], value: n });
        });
        var hours = String(fieldValue("activeHours") == null ? "" : fieldValue("activeHours")).trim();
        var hoursOk = validActiveHours(hours);
        if (ops.some(function (o) { return o.invalid !== void 0; })) {
          setError(t("error") + "：" + t("invalidNumber"));
          return;
        }
        if (!hoursOk) {
          setError(t("error") + "：" + t("invalidHours"));
          return;
        }
        if (hours !== String(stored("activeHours") || "")) {
          ops.push(hours === ""
            ? { op: "unset", path: ["activeHours"] }
            : { op: "set", path: ["activeHours"], value: hours });
        }
        // Inspect fields are plain text: an emptied box unsets the key so the
        // Host falls back to its own default rather than storing "".
        var textFields = ["inspectPrompt", "inspectSessionId"];
        textFields.forEach(function (key) {
          var next = String(fieldValue(key) == null ? "" : fieldValue(key));
          if (next === String(stored(key) || "")) return;
          ops.push(next.trim() === ""
            ? { op: "unset", path: [key] }
            : { op: "set", path: [key], value: next });
        });
        if (ops.length === 0) { setNotice(t("saved")); return; }
        runWrite(ops, function () { setDraft({}); });
      }

      function onReload() {
        setDraft({});
        setSnapshot(scope.getSnapshot());
        clearNotices();
      }

      function numberField(f) {
        return h("label", { className: "__sc_field", key: f.key },
          h("span", { className: "__sc_label" }, t(f.label)),
          h("span", { className: "__sc_hint" }, t(f.hint)),
          h("input", {
            className: "__sc_input __sc_num",
            type: "number",
            min: f.min,
            max: f.max,
            step: 1,
            value: String(fieldValue(f.key)),
            disabled: busy,
            onChange: function (e) { setField(f.key, e.target.value); }
          })
        );
      }

      function checkbox(key, labelKey, hintKey) {
        return h("div", { className: "__sc_field" },
          h("label", { className: "__sc_row" },
            h("input", {
              className: "__sc_check",
              type: "checkbox",
              checked: Boolean(fieldValue(key)),
              disabled: busy,
              onChange: function (e) { setField(key, e.target.checked); toggle(key, e.target.checked); }
            }),
            h("span", { className: "__sc_label" }, t(labelKey))
          ),
          h("span", { className: "__sc_hint" }, t(hintKey))
        );
      }

      /**
       * The inspect instruction: a multi-line box plus a button that seeds it
       * with the built-in text.
       *
       * The button is the point. A reader who wants their own wording otherwise
       * has to retype a paragraph whose exact clauses matter, and getting one
       * wrong is silent — it only shows up later as token traffic. Seeding the
       * box with known-good text turns "write a prompt" into "edit a prompt".
       */
      function promptField() {
        var filled = String(fieldValue("inspectPrompt") == null ? "" : fieldValue("inspectPrompt")) !== "";
        return h("label", { className: "__sc_field", key: "inspectPrompt" },
          h("span", { className: "__sc_label" }, t("inspectPromptLabel")),
          h("span", { className: "__sc_hint" }, t("inspectPromptHint")),
          h("textarea", {
            className: "__sc_input __sc_textarea",
            rows: 7,
            spellCheck: false,
            placeholder: "【截图巡检】刚拍了一张：{{path}}（{{time}}）……",
            value: String(fieldValue("inspectPrompt") == null ? "" : fieldValue("inspectPrompt")),
            disabled: busy,
            onChange: function (e) { setField("inspectPrompt", e.target.value); }
          }),
          h("div", { className: "__sc_row" },
            h("button", {
              type: "button",
              className: "__sc_btn",
              disabled: busy,
              onClick: function () { setField("inspectPrompt", DEFAULT_INSPECT_PROMPT); }
            }, t("inspectPromptFill")),
            filled ? h("span", { className: "__sc_status" }, t("inspectPromptFilled")) : null
          )
        );
      }

      /**
       * Which conversation receives the inspect message.
       *
       * A dropdown, not a text box, because the stored value is a raw session id
       * and the interesting question ("which conversation?") is one only the
       * host can answer. "Follow automatically" writes an empty value, which is
       * the host's auto tier — that is the entry a new conversation needs, and
       * it is what keeps a fresh conversation picked up without editing this
       * setting again.
       *
       * A stored id that is not in the list (an older conversation, another
       * profile) is kept as its own option so opening the page and pressing Save
       * never silently rewrites the setting.
       */
      function sessionPicker() {
        var storedId = String(fieldValue("inspectSessionId") == null ? "" : fieldValue("inspectSessionId")).trim();
        var known = sessions.some(function (s) { return s.id === storedId; });
        var showManual = manual || sessionsState === "error" || (storedId !== "" && !known);
        var options = [h("option", { value: "", key: "" }, t("inspectSessionAuto"))];
        sessions.forEach(function (s) {
          var label = s.title !== "" ? s.title : s.id.slice(0, 18) + "…";
          options.push(h("option", { value: s.id, key: s.id }, s.running ? "● " + label : label));
        });
        if (storedId !== "" && !known) {
          options.push(h("option", { value: storedId, key: storedId }, storedId.slice(0, 18) + "…"));
        }
        return h("label", { className: "__sc_field", key: "inspectSessionId" },
          h("span", { className: "__sc_label" }, t("inspectSessionLabel")),
          h("span", { className: "__sc_hint" }, t("inspectSessionHint")),
          h("div", { className: "__sc_sessionRow" },
            h("select", {
              className: "__sc_input __sc_select",
              value: storedId,
              disabled: busy,
              onChange: function (e) { setField("inspectSessionId", e.target.value); }
            }, options),
            h("button", {
              type: "button",
              className: "__sc_btn",
              disabled: busy || sessionsState === "loading",
              onClick: function () { loadSessions(); }
            }, sessionsState === "loading" ? t("inspectSessionLoading") : t("inspectSessionRefresh"))
          ),
          h("div", { className: "__sc_row" },
            h("button", {
              type: "button",
              className: "__sc_btn",
              disabled: busy,
              onClick: function () { setManual(!showManual); }
            }, t("inspectSessionOther"))
          ),
          showManual ? h("input", {
            className: "__sc_input",
            type: "text",
            placeholder: "session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            value: storedId,
            disabled: busy,
            onChange: function (e) { setField("inspectSessionId", e.target.value); }
          }) : null,
          sessionsState === "error" ? h("span", { className: "__sc_hint" }, t("inspectSessionEmpty")) : null
        );
      }

      return h("div", { className: "__sc_root" },
        h("p", { className: "__sc_hint", style: { margin: "0 0 4px" } }, t("intro")),

        h("div", { className: "__sc_group" },
          h("p", { className: "__sc_label", style: { margin: 0 } }, t("basicTitle")),
          checkbox("enabled", "switchLabel", "switchHint"),
          numberField(NUM_FIELDS[0]),
          numberField(NUM_FIELDS[1])
        ),

        h("div", { className: "__sc_group" },
          h("p", { className: "__sc_label", style: { margin: 0 } }, t("windowTitle")),
          h("label", { className: "__sc_field" },
            h("span", { className: "__sc_label" }, t("activeHoursLabel")),
            h("span", { className: "__sc_hint" }, t("activeHoursHint")),
            h("input", {
              className: "__sc_input",
              type: "text",
              placeholder: "08:00-23:00",
              value: String(fieldValue("activeHours") == null ? "" : fieldValue("activeHours")),
              disabled: busy,
              onChange: function (e) { setField("activeHours", e.target.value); }
            })
          ),
          checkbox("skipWhenIdle", "idleLabel", "idleHint"),
          numberField(NUM_FIELDS[2])
        ),

        h("div", { className: "__sc_group" },
          h("p", { className: "__sc_label", style: { margin: 0 } }, t("inspectTitle")),
          checkbox("inspectEnabled", "inspectLabel", "inspectHint"),
          promptField(),
          sessionPicker()
        ),

        h("div", { className: "__sc_group" },
          h("p", { className: "__sc_label", style: { margin: 0 } }, t("imageTitle")),
          numberField(NUM_FIELDS[3]),
          numberField(NUM_FIELDS[4])
        ),

        h("div", { className: "__sc_actions" },
          h("button", { type: "button", className: "__sc_btn __sc_btnPrimary", onClick: onSave, disabled: busy }, t("save")),
          h("button", { type: "button", className: "__sc_btn", onClick: onReload, disabled: busy }, t("reset")),
          busy ? h("span", { className: "__sc_status" }, t("saving")) : null,
          notice ? h("span", { className: "__sc_status" }, notice) : null,
          error ? h("span", { className: "__sc_error", role: "alert" }, error) : null
        ),

        h("p", { className: "__sc_hint", style: { margin: "2px 0 0" } },
          t("dirHint") + "%DSH_HOME%\\screencap\\shots")
      );
    }

    // ── plugin ────────────────────────────────────────────────────────────
    var inject = ["slots", "locale", "configForms"];

    function apply(ctx) {
      var t = ctx.locale.bind(LOCALE_NS);
      ctx.effect(function () { return ctx.locale.register(LOCALE_NS, { zh: zh, en: en }); }, "dsh-screencap: dictionaries");
      // ONE scope for the namespace: two binds would each keep their own
      // revision bookkeeping over one Host document, so a write could fence
      // against a revision the other had already superseded.
      var scope = ctx.configForms.get(SETTINGS_NS);
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "screencap",
          order: 26,
          label: function () { return t("nav"); },
          locale: LOCALE_NS
        }, function (props) {
          return h(ScreencapSection, Object.assign({}, props, { scope: scope, t: t }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__test = {
      validActiveHours: validActiveHours,
      settingsOpsApplied: settingsOpsApplied,
      DEFAULTS: DEFAULTS,
      DEFAULT_INSPECT_PROMPT: DEFAULT_INSPECT_PROMPT,
    };
    return module.exports;
  }
});
