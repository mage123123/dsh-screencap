/**
 * dsh-screencap — floating widget (browser half).
 *
 * A plain injected script (NOT a ModuleLoader bundle): the host half pushes an
 * inline `<script>` row into the boot injection table, and that row appends a
 * `<script src="/dsh-screencap/widget.js">` whose `onerror` is swallowed. This
 * file is what that route serves.
 *
 * Why a plain script rather than a client plugin: the settings section is
 * already a client plugin (see `client.js`). This surface is deliberately
 * outside the module graph so that a failure here can never affect boot — the
 * whale-widget plugin documents that a `script-src` row that fails to load
 * rejects `__DSH_BOOT_READY__` and takes the whole app down.
 *
 * The widget talks to four host routes:
 *   GET  /dsh-screencap/status.json      → settings + shot statistics
 *   GET  /dsh-screencap/latest.jpg[?file=] → the newest shot's bytes
 *   POST /dsh-screencap/settings.json    → { enabled?, intervalMinutes? }
 *   POST /dsh-screencap/open-folder.json → reveal the shot directory
 *
 * "Send the latest shot" is implemented as a real clipboard write (verified:
 * `navigator.clipboard.write([new ClipboardItem({'image/png': blob})])` works
 * from a trusted click, so the user just presses Ctrl+V). A secondary,
 * clearly-marked experimental action tries a synthetic paste into the composer.
 */
(function () {
  "use strict";

  var PREFIX = "/dsh-screencap";
  var FLAG = "__dshScreencapWidget";
  if (window[FLAG]) return;
  window[FLAG] = true;

  // ── styles ──────────────────────────────────────────────────────────────
  // `data-plugin` is REQUIRED. An unlabelled <style> is claimed by whichever
  // client plugin is being materialised at that moment, and is then removed
  // when that plugin reloads — which would drop every fixed-position node back
  // into normal document flow.
  var CSS = [
    // The button must not sit on top of the whale widget, whose own box is
    // `clamp(122px, min(250, min(100vw,100vh) * 0.28) * scale, 625px)` wide with
    // the character art in the bottom-right 59.45%. That width depends on the
    // viewport AND on the user's scale setting, so a fixed offset cannot work:
    // a 196px offset clears the art at 1280x800 but overlaps it at 1920x1080.
    // `position()` below therefore MEASURES the whale's live DOM box and parks
    // the button just left of the art, falling back to `--sc-right` when the
    // whale is absent. `--sc-right` is still honoured as a manual override.
    ".dshsc-root{position:fixed;right:var(--sc-right,196px);bottom:var(--sc-bottom,20px);z-index:9998;font-family:inherit;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;transition:right .16s ease}",
    ".dshsc-root>*{pointer-events:auto}",
    ".dshsc-btn{width:44px;height:44px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,rgba(151,169,216,.34));background:var(--dsw-alias-bg-overlay,rgba(13,25,59,.96));color:var(--dsw-alias-label-primary,#e5eaf6);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.28);padding:0;transition:transform .15s ease,border-color .15s ease}",
    ".dshsc-btn:hover{border-color:var(--dsw-alias-state-business-primary,#536eae);transform:translateY(-1px)}",
    ".dshsc-btn:active{transform:translateY(0)}",
    ".dshsc-btn svg{width:20px;height:20px;display:block}",
    ".dshsc-btn.dshsc-off{opacity:.55}",
    ".dshsc-panel{width:268px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(151,169,216,.34));background:var(--dsw-alias-bg-overlay,rgba(13,25,59,.97));color:var(--dsw-alias-label-primary,#e5eaf6);border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.38);padding:10px 12px;display:none;flex-direction:column;gap:9px;font-size:12px;line-height:1.5}",
    ".dshsc-panel.dshsc-open{display:flex}",
    ".dshsc-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
    ".dshsc-title{font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px}",
    ".dshsc-x{border:none;background:none;color:var(--dsw-alias-label-tertiary,#8a94aa);cursor:pointer;font:inherit;font-size:16px;line-height:1;padding:0 2px}",
    ".dshsc-x:hover{color:var(--dsw-alias-label-primary,#e5eaf6)}",
    ".dshsc-row{display:flex;align-items:center;gap:8px}",
    ".dshsc-row label{flex:1;color:var(--dsw-alias-label-secondary,#4d5d7f)}",
    ".dshsc-num{width:64px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(151,169,216,.34));background:var(--dsw-alias-bg-layer-3,rgba(32,49,91,.94));color:inherit;border-radius:7px;padding:3px 7px;font:inherit;font-size:12px}",
    ".dshsc-num:disabled{opacity:.5}",
    ".dshsc-check{accent-color:var(--dsw-alias-state-business-primary,#536eae);margin:0}",
    ".dshsc-preview{border:1px solid var(--dsw-alias-border-l2,rgba(151,169,216,.34));border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(24,40,80,.92));aspect-ratio:16/10;display:flex;align-items:center;justify-content:center}",
    ".dshsc-preview img{width:100%;height:100%;object-fit:cover;display:block}",
    ".dshsc-empty{color:var(--dsw-alias-label-tertiary,#8a94aa);font-size:11px;text-align:center;padding:0 8px}",
    ".dshsc-meta{color:var(--dsw-alias-label-tertiary,#8a94aa);font-size:11px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}",
    ".dshsc-acts{display:flex;flex-direction:column;gap:6px}",
    ".dshsc-act{border:1px solid var(--dsw-alias-border-l2,rgba(151,169,216,.34));background:var(--dsw-alias-bg-layer-3,rgba(32,49,91,.94));color:inherit;border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer;text-align:center}",
    ".dshsc-act:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#536eae)}",
    ".dshsc-act:disabled{opacity:.5;cursor:default}",
    ".dshsc-act.dshsc-primary{border-color:var(--dsw-alias-state-business-primary,#536eae);background:var(--dsw-alias-state-business-primary,#536eae);color:#fff}",
    ".dshsc-status{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a94aa);min-height:16px;word-break:break-word}",
    ".dshsc-status.dshsc-err{color:var(--dsw-alias-state-error-primary,#e06c75)}",
    ".dshsc-status.dshsc-ok{color:var(--dsw-alias-state-business-primary,#536eae)}"
  ].join("\n");

  var styleEl = document.createElement("style");
  styleEl.setAttribute("data-plugin", "dsh-screencap");
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // ── dom ─────────────────────────────────────────────────────────────────
  var ICON_CAMERA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1.2-1.8h5.2L14.8 6h3.7A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/><circle cx="12" cy="12.5" r="3.4"/></svg>';

  var root = document.createElement("div");
  root.className = "dshsc-root";

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dshsc-btn";
  btn.title = "截屏";
  btn.setAttribute("aria-label", "截屏");
  btn.innerHTML = ICON_CAMERA;
  root.appendChild(btn);

  var panel = document.createElement("div");
  panel.className = "dshsc-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "截屏");
  root.appendChild(panel);

  /** Build one panel element. */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // header
  var head = el("div", "dshsc-head");
  var title = el("div", "dshsc-title", "截屏");
  var closeBtn = el("button", "dshsc-x", "\u00d7");
  closeBtn.type = "button";
  closeBtn.title = "关闭";
  head.appendChild(title);
  head.appendChild(closeBtn);
  panel.appendChild(head);

  // enable + interval
  var rowEnable = el("div", "dshsc-row");
  var enable = el("input", "dshsc-check");
  enable.type = "checkbox";
  var enableLabel = el("label", null, "启用定时截屏");
  rowEnable.appendChild(enable);
  rowEnable.appendChild(enableLabel);
  panel.appendChild(rowEnable);

  var rowInterval = el("div", "dshsc-row");
  var intervalLabel = el("label", null, "间隔（分钟）");
  var interval = el("input", "dshsc-num");
  interval.type = "number";
  interval.min = "1";
  interval.max = "1440";
  interval.step = "1";
  rowInterval.appendChild(intervalLabel);
  rowInterval.appendChild(interval);
  panel.appendChild(rowInterval);

  // preview
  var preview = el("div", "dshsc-preview");
  panel.appendChild(preview);

  // stats
  var meta = el("div", "dshsc-meta");
  var metaCount = el("span", null, "");
  var metaBytes = el("span", null, "");
  meta.appendChild(metaCount);
  meta.appendChild(metaBytes);
  panel.appendChild(meta);

  // actions
  var acts = el("div", "dshsc-acts");
  var copyBtn = el("button", "dshsc-act dshsc-primary", "复制最新截图（然后 Ctrl+V）");
  copyBtn.type = "button";
  var pasteBtn = el("button", "dshsc-act", "试直接插入输入框");
  pasteBtn.type = "button";
  pasteBtn.title = "实验性：向输入框派发合成 paste 事件";
  var folderBtn = el("button", "dshsc-act", "打开截图文件夹");
  folderBtn.type = "button";
  var shootBtn = el("button", "dshsc-act", "立即截一张");
  shootBtn.type = "button";
  acts.appendChild(copyBtn);
  acts.appendChild(pasteBtn);
  acts.appendChild(shootBtn);
  acts.appendChild(folderBtn);
  panel.appendChild(acts);

  var status = el("div", "dshsc-status", "");
  panel.appendChild(status);

  // ── helpers ─────────────────────────────────────────────────────────────
  function setStatus(text, kind) {
    status.textContent = text || "";
    status.className = "dshsc-status" + (kind ? " dshsc-" + kind : "");
  }

  /** Human-readable byte size. */
  function fmtBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
    if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + " MB";
    return (v / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  /** GET a JSON route. */
  function getJson(path) {
    return fetch(PREFIX + path, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); });
  }

  /** POST a JSON route. */
  function postJson(path, body) {
    return fetch(PREFIX + path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok || data.ok === false) {
          throw new Error((data && data.error) || ("HTTP " + r.status));
        }
        return data;
      });
    });
  }

  // ── state ───────────────────────────────────────────────────────────────
  var state = { status: null, latestFile: null, pngCache: null, pngCacheFile: null, busy: false };
  var pollTimer = null;

  function renderStatus(s) {
    state.status = s;
    enable.checked = s.enabled === true;
    if (document.activeElement !== interval) interval.value = String(s.intervalMinutes);
    btn.classList.toggle("dshsc-off", s.enabled !== true);
    btn.title = s.enabled === true
      ? "截屏（每 " + s.intervalMinutes + " 分钟）"
      : "截屏（已关闭）";
    metaCount.textContent = s.count + " 张";
    metaBytes.textContent = fmtBytes(s.bytes);

    var latest = s.latest;
    var file = latest === null || latest === undefined ? null : latest.file;
    if (file === null) {
      preview.innerHTML = "";
      preview.appendChild(el("div", "dshsc-empty", "还没有截图"));
      copyBtn.disabled = true;
      pasteBtn.disabled = true;
    } else {
      if (file !== state.latestFile) {
        preview.innerHTML = "";
        var img = document.createElement("img");
        img.alt = "最新截图";
        img.src = PREFIX + "/latest.jpg?file=" + encodeURIComponent(file) + "&t=" + Date.now();
        img.onerror = function () {
          preview.innerHTML = "";
          preview.appendChild(el("div", "dshsc-empty", "预览加载失败"));
        };
        preview.appendChild(img);
        state.latestFile = file;
      }
      copyBtn.disabled = false;
      pasteBtn.disabled = false;
    }
  }

  function refresh() {
    return getJson("/status.json").then(renderStatus).catch(function (e) {
      setStatus("读取状态失败：" + e.message, "err");
    });
  }

  function withBusy(fn) {
    if (state.busy) return;
    state.busy = true;
    copyBtn.disabled = true;
    pasteBtn.disabled = true;
    shootBtn.disabled = true;
    Promise.resolve()
      .then(fn)
      .catch(function (e) { setStatus(String((e && e.message) || e), "err"); })
      .then(function () {
        state.busy = false;
        copyBtn.disabled = state.latestFile === null;
        pasteBtn.disabled = state.latestFile === null;
        shootBtn.disabled = false;
      });
  }

  // ── clipboard ───────────────────────────────────────────────────────────
  /**
   * Fetch the newest shot and convert it to a PNG blob.
   *
   * The shots are JPEG. `ClipboardItem` is specified for `image/png` and
   * Chromium only reliably accepts PNG there, so the JPEG is redrawn through a
   * canvas. The result is cached per file so the click handler can call
   * `clipboard.write` without waiting on the network — a long await can outlive
   * the transient user activation that the write needs.
   */
  function latestPng(file) {
    if (state.pngCache !== null && state.pngCacheFile === file) {
      return Promise.resolve(state.pngCache);
    }
    var url = PREFIX + "/latest.jpg" + (file ? "?file=" + encodeURIComponent(file) : "");
    return fetch(url, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("读取截图失败 HTTP " + r.status);
        return r.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var objUrl = URL.createObjectURL(blob);
          var img = new Image();
          img.onload = function () {
            try {
              var canvas = document.createElement("canvas");
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              var ctx2d = canvas.getContext("2d");
              ctx2d.drawImage(img, 0, 0);
              canvas.toBlob(function (png) {
                URL.revokeObjectURL(objUrl);
                if (png === null) reject(new Error("PNG 编码失败"));
                else resolve(png);
              }, "image/png");
            } catch (e) {
              URL.revokeObjectURL(objUrl);
              reject(e);
            }
          };
          img.onerror = function () {
            URL.revokeObjectURL(objUrl);
            reject(new Error("图片解码失败"));
          };
          img.src = objUrl;
        });
      })
      .then(function (png) {
        state.pngCache = png;
        state.pngCacheFile = file;
        return png;
      });
  }

  /** Write the newest shot to the OS clipboard as PNG. */
  function copyLatest() {
    var file = state.latestFile;
    if (file === null) { setStatus("还没有截图", "err"); return Promise.resolve(); }
    if (typeof ClipboardItem !== "function" || !navigator.clipboard || typeof navigator.clipboard.write !== "function") {
      setStatus("当前环境不支持写入剪贴板", "err");
      return Promise.resolve();
    }
    return latestPng(file).then(function (png) {
      return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    }).then(function () {
      setStatus("已复制到剪贴板，在输入框按 Ctrl+V 粘贴", "ok");
    });
  }

  /**
   * EXPERIMENTAL: synthesise a paste carrying the image straight into the
   * composer.
   *
   * The composer is a Lexical editor. Its `PASTE_COMMAND` listener reads
   * `event.clipboardData`, collects `kind === "file"` items and hands them to
   * the file intake. A harness built on the same Lexical version showed that a
   * synthetic `ClipboardEvent` dispatched ON THE EDITOR ROOT does reach that
   * command and does deliver the file; nothing in DSH checks `isTrusted`.
   * It is still marked experimental because a synthetic paste is not a browser
   * paste — the editor's own default handling and the OS clipboard are not
   * involved, and this has not been exercised against a live DSH page.
   */
  function pasteIntoComposer() {
    var file = state.latestFile;
    if (file === null) { setStatus("还没有截图", "err"); return Promise.resolve(); }
    var composer = document.querySelector("[data-composer-input]");
    if (composer === null) { setStatus("找不到输入框（先打开一个会话）", "err"); return Promise.resolve(); }
    if (typeof DataTransfer !== "function" || typeof ClipboardEvent !== "function") {
      setStatus("当前环境不支持合成 paste", "err");
      return Promise.resolve();
    }
    return fetch(PREFIX + "/latest.jpg?file=" + encodeURIComponent(file), {
      credentials: "same-origin", cache: "no-store"
    })
      .then(function (r) {
        if (!r.ok) throw new Error("读取截图失败 HTTP " + r.status);
        return r.blob();
      })
      .then(function (blob) {
        // The intake treats an accepted image media type as an image draft, so
        // the synthetic File keeps the JPEG type it actually has.
        var shot = new File([blob], file, { type: "image/jpeg" });
        var dt = new DataTransfer();
        dt.items.add(shot);
        var ev = new ClipboardEvent("paste", {
          clipboardData: dt, bubbles: true, cancelable: true
        });
        composer.focus();
        composer.dispatchEvent(ev);
        setStatus("已向输入框派发 paste，请检查输入框里是否出现了图片", "ok");
      });
  }

  // ── panel wiring ────────────────────────────────────────────────────────
  function openPanel() {
    panel.classList.add("dshsc-open");
    setStatus("");
    refresh().then(function () {
      // Warm the PNG cache while the user is still deciding, so the copy click
      // stays inside its transient activation window.
      if (state.latestFile !== null) latestPng(state.latestFile).catch(function () {});
    });
  }

  function closePanel() {
    panel.classList.remove("dshsc-open");
  }

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (panel.classList.contains("dshsc-open")) closePanel();
    else openPanel();
  });

  closeBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    closePanel();
  });

  // Close on an outside click, but not when the click is inside the widget.
  document.addEventListener("click", function (e) {
    if (!panel.classList.contains("dshsc-open")) return;
    if (root.contains(e.target)) return;
    closePanel();
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panel.classList.contains("dshsc-open")) closePanel();
  });

  enable.addEventListener("change", function () {
    var next = enable.checked;
    withBusy(function () {
      return postJson("/settings.json", { enabled: next }).then(function () {
        setStatus(next ? "已启用定时截屏" : "已关闭定时截屏", "ok");
        return refresh();
      });
    });
  });

  function commitInterval() {
    var raw = String(interval.value).trim();
    var n = Number(raw);
    if (raw === "" || !isFinite(n)) { setStatus("间隔要填数字", "err"); return; }
    n = Math.floor(n);
    if (n < 1 || n > 1440) { setStatus("间隔范围 1–1440 分钟", "err"); return; }
    if (state.status !== null && n === state.status.intervalMinutes) { setStatus("间隔未变"); return; }
    withBusy(function () {
      return postJson("/settings.json", { intervalMinutes: n }).then(function () {
        setStatus("间隔已改为 " + n + " 分钟", "ok");
        return refresh();
      });
    });
  }

  interval.addEventListener("change", commitInterval);
  interval.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commitInterval(); }
  });

  copyBtn.addEventListener("click", function () { withBusy(copyLatest); });
  pasteBtn.addEventListener("click", function () { withBusy(pasteIntoComposer); });

  shootBtn.addEventListener("click", function () {
    withBusy(function () {
      setStatus("正在截屏…");
      return postJson("/shoot.json", {}).then(function (data) {
        state.latestFile = null; // force the preview to reload
        state.pngCache = null;
        state.pngCacheFile = null;
        setStatus(data && data.captured ? "已截取新图" : "本次未截取", data && data.captured ? "ok" : "err");
        return refresh();
      });
    });
  });

  folderBtn.addEventListener("click", function () {
    withBusy(function () {
      return postJson("/open-folder.json", {}).then(function (data) {
        setStatus("已请求打开：" + data.dir, "ok");
      });
    });
  });

  // ── mount / reattach ────────────────────────────────────────────────────
  // The Web UI is an SPA, and another plugin replacing a body subtree can
  // orphan our node (it stays in memory but leaves the document). Re-append it
  // when that happens; this is the same guard the whale widget needed.
  function mount() {
    if (root.parentNode !== document.body) document.body.appendChild(root);
  }

  // ── collision avoidance ─────────────────────────────────────────────────
  /** The whale widget's root, if that plugin is installed and mounted. */
  function whaleRoot() {
    return document.querySelector(".dshwv-root");
  }

  /**
   * Park the button clear of the whale widget's character art.
   *
   * The whale's box width is viewport- and scale-dependent, so the only robust
   * input is its measured box. Its art is the bottom-right 59.45% of that box;
   * we place our right edge `GAP` px to the left of the art's left edge. When
   * the whale is missing (or is parked on the other side of the screen) we
   * leave the CSS fallback in place.
   */
  var GAP = 12;
  function position() {
    var fallback = null;
    try {
      fallback = getComputedStyle(root).getPropertyValue("--sc-right").trim();
    } catch (e) { /* ignore */ }
    var whale = whaleRoot();
    if (whale === null) {
      root.style.right = fallback === "" ? "" : fallback;
      return;
    }
    var box = whale.getBoundingClientRect();
    // Ignore a zero-sized or off-screen whale (still loading, or moved away).
    if (box.width <= 0 || box.height <= 0) return;
    // Only avoid it when it is actually in the bottom-right corner; if the user
    // dragged it elsewhere, its art is not where we are.
    var artLeft = box.left + box.width * (1 - 0.5945);
    var artTop = box.top + box.height * (1 - 0.5945);
    var overlapsVertically = artTop < window.innerHeight && artTop + box.height * 0.5945 > 0;
    if (!overlapsVertically || artLeft < window.innerWidth * 0.5) {
      root.style.right = fallback === "" ? "" : fallback;
      return;
    }
    var desired = Math.max(8, window.innerWidth - artLeft + GAP);
    root.style.right = desired + "px";
  }

  /**
   * Coalesced `position()`.
   *
   * `position()` reads `getBoundingClientRect`, which forces a synchronous
   * layout. The reattach observer fires on EVERY DOM mutation, and a streaming
   * chat turn mutates the DOM hundreds of times a second — so measuring on each
   * one would thrash layout for the whole page. Coalesce to one measurement per
   * frame.
   */
  var positionQueued = false;
  function schedulePosition() {
    if (positionQueued) return;
    positionQueued = true;
    var run = function () { positionQueued = false; position(); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function connected(node) {
    try {
      if (typeof node.isConnected === "boolean") return node.isConnected;
    } catch (e) { /* fall through */ }
    return document.documentElement.contains(node);
  }

  try {
    if (document.body === null) {
      document.addEventListener("DOMContentLoaded", function () { mount(); position(); }, { once: true });
    } else {
      mount();
      position();
    }
  } catch (e) { /* the widget is optional; never break the page */ }

  try {
    if (typeof MutationObserver === "function") {
      var observer = new MutationObserver(function () {
        if (!connected(root)) mount();
        schedulePosition();
      });
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    }
  } catch (e) { /* observer is best-effort */ }

  window.addEventListener("resize", schedulePosition);
  // The whale re-settles on a short transition when the window changes, so
  // re-measure once after it has come to rest.
  window.addEventListener("resize", function () { setTimeout(position, 400); });
  // The whale's scale setting is fetched asynchronously after it boots.
  setTimeout(position, 1200);
  setTimeout(position, 3000);

  // Keep the panel honest while it is open (another window may change settings).
  pollTimer = setInterval(function () {
    if (!panel.classList.contains("dshsc-open")) return;
    if (state.busy) return;
    if (typeof document.hidden === "boolean" && document.hidden) return;
    refresh();
  }, 20000);
  if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();

  // Best-effort first read, so the button title reflects the real state.
  refresh();
})();
