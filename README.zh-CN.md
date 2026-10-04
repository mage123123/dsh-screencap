# dsh-screencap

> [English](README.md) | 简体中文

DeepSeek Harness 的**定时截屏**插件：后台按间隔自动截屏，旧图自动清理，设置页里随时开关和调参，保存即生效（不用重启）。另有一个**右下角浮动挂件**，不用进设置页就能看最新截图、复制到剪贴板、打开文件夹。

## 用途

- 让 agent 能「看到」屏幕上发生过什么：配套提供 `screencap_list` / `screencap_latest` / `screencap_capture` 三个工具，agent 可以自己列出、取最新、或立刻抓一张。
- 适合长时间挂机时留一份屏幕记录（配合移动端壳可 7×24 挂）。
- 浮动挂件让「刚才那张图」随手可用：点一下复制，到输入框 `Ctrl+V` 就发给对话。

## 浮动挂件

右下角一个相机按钮，点开是小面板：

| 控件 | 作用 |
| --- | --- |
| 启用定时截屏 | 即时写入 `enabled`（和设置页共用同一个 settings 命名空间，两边同步）。 |
| 间隔（分钟） | 即时写入 `intervalMinutes`，范围夹到 1–1440。 |
| 预览 | 最新一张截图的缩略图，20 秒轮询刷新（面板开着时才刷）。 |
| 复制最新截图（然后 Ctrl+V） | 把最新截图以 **PNG** 写进系统剪贴板；到输入框按 `Ctrl+V` 即可粘成附件。 |
| 试直接插入输入框 | **实验性**：向 `[data-composer-input]` 派发一个带图片的合成 `paste` 事件。见下方「合成 paste 的实测边界」。 |
| 立即截一张 | 忽略间隔与时间段立刻抓图（`enabled` 关掉时仍拒绝，和 `screencap_capture` 一致）。 |
| 打开截图文件夹 | 用系统文件管理器打开截图目录。 |

面板可关闭（`×` / 点外部 / `Esc`），按钮位置会**主动避开余额小鲸鱼挂件**：挂件的盒子宽度随视口和它的缩放设置变化，所以挂件是**实测**小鲸鱼的实时 DOM 矩形后把按钮停在它本体左侧 8–12px，而不是写死一个偏移量（写死的话 1280×800 不撞、1920×1080 就撞上了）。没装小鲸鱼时回落到 CSS 变量 `--sc-right` / `--sc-bottom`。

### 挂件的注入方式（重要）

宿主半端通过 `webserver/index-inject` 推一行**内联 `<script>`**，由这一行自己去建 `<script src="/dsh-screencap/widget.js">` 并**吞掉 `onerror`**。

这不是绕远路，是唯一安全的路子，原因记在 `index.js` 的 `WIDGET_ROW_TEXT` 上方：

- 桌面端 `index.html` 从安装包静态 dist 直出，宿主的 `tapIndex` / `renderIndex` **永远不过去**；唯一通道就是这张结构化行表，而外壳在**宿主启动时收集一次**就缓存，没有刷新路径。
- 页面侧解释器对两种 script 行的处理**不对称**：`script`（内联）只是 `textContent` + `append`，**不可能加载失败**；`script-src` 走 `await loadScript(src)`，失败即 reject，而那个 reject 会 reject 掉 `__DSH_BOOT_READY__` ⇒ **整个应用起不来（白屏）**。
- 表在启动时收集一次且不刷新 ⇒ 运行期关掉插件后那行还在，路由却已注销 ⇒ `script-src` 就是 404 ⇒ 下次重启白屏。

所以行永远是 `kind: "script"`，且自带 `onerror` 兜底。`tests/host-integration.test.mjs` 有一条测试专门钉死这两点（`kind === "script"` 且文本里含 `onerror`）。

### 合成 paste 的实测边界

「试直接插入输入框」是**实验性**功能，实测结论如下：

- **合成 `paste` 事件确实能带文件进 Lexical 的 paste 处理链路。** DSH 的输入框是 Lexical 编辑器，它的 `PASTE_COMMAND` 监听器读 `event.clipboardData`、收集 `kind === "file"` 的条目再交给附件入口，**全程没有 `isTrusted` 检查**。用 DSH 同版本的 Lexical（0.49.0）搭的复现环境里，`new DataTransfer()` + `new ClipboardEvent("paste", {clipboardData: dt})` 派发到编辑器根节点，命令**确实触发**、文件**确实被读到**（`1:shot_....jpg/image/jpeg`）。
- **但必须派发在编辑器根节点上**：派发到 `document.body` 时命令不会触发（事件不会向上冒泡到根节点的监听器）。挂件就是按这个方式派的。
- **它仍然标为实验性**，因为合成事件不是浏览器 paste：没有真实剪贴板参与、编辑器自身的默认行为也不会跑。这套逻辑没有在**活的 DSH 页面**上端到端验证过（本机拿不到桌面端渲染进程的调试通道），所以界面上把它和「复制」分开，且文案明说「请检查输入框里是否出现了图片」。
- **兜底路径是可靠的**：`navigator.clipboard.write([new ClipboardItem({'image/png': png})])` 在**真实用户点击**下实测成功（CDP 派发的可信点击 + `clipboard-write` 权限 `granted`）。截图是 JPEG，而 `ClipboardItem` 在 Chromium 上要 PNG，所以挂件先把 JPEG 画到 canvas 再 `toBlob('image/png')`；并且**在打开面板时就预热**这张 PNG，好让点击处理器里的 `clipboard.write` 不跨越用户激活窗口。

## 截图存放位置

```
%DSH_HOME%\screencap\shots\shot_YYYY-MM-DD_HH-mm-ss.jpg
```

`%DSH_HOME%` 由 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()` 解析（优先 `$DSH_HOME`，否则 `~\.dsh`）。默认落在 `~\.dsh\screencap\shots`。

文件名里的时间戳是**排序与清理的唯一依据**（不看 mtime），所以外部工具改写 mtime 也不会打乱顺序。

## 配置项

在「设置 → 截屏记录」里改，保存后下一次计时立刻生效。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 定时截屏总开关。关掉后后台不再自动截屏（agent 仍可用 `screencap_capture` 手动抓一张）。 |
| `intervalMinutes` | `30` | 截屏间隔（分钟），1–1440。 |
| `maxWidth` | `1600` | 缩放后最大宽度。超过就等比缩小；`0` = 原始分辨率不缩放。 |
| `quality` | `80` | JPEG 质量，1–100。 |
| `keepDays` | `3` | 截图保留天数，超过的会在每次截屏后被删除；`0` = 永不清理。 |
| `activeHours` | `""` | 只在指定时间段截屏，格式 `HH:MM-HH:MM`。留空 = 全天不限。**支持跨天**，如 `22:00-06:00`。 |
| `skipWhenIdle` | `false` | 桌面正在使用时跳过本次截屏。 |
| `idleSeconds` | `60` | 「正在使用」的判定阈值（秒）：最近这么多秒内有键鼠输入就算在用。 |
| `inspectEnabled` | `false` | **拍完自动叫我**：每次截图成功后唤醒 agent 看一眼。见下节。 |
| `inspectPrompt` | （内置中文指令） | 巡检时发给 agent 的指令，支持 `{{path}}` / `{{time}}` 占位符。 |
| `inspectSessionId` | `""` | 唤醒哪个 Session。留空 = 自动（见下）。 |

所有数值在读取时都会被**夹到合法范围**（settings.yaml 被手改坏也不会崩），非法值回落到默认。

## 拍完自动叫我（capture-triggered inspect）

默认关闭。打开后，**每次截图成功**都会往一个 Session 里投一条消息，agent 收到后会看那张图并点评——也就是「拍一张、看一眼」。

这解决的是「定时巡检」和「截图器」两条时间线不同步的问题：截图器自己按 `intervalMinutes` 跑，巡检不再需要另设一个 cron，两者天然对齐（截图 20 分钟一张，就 20 分钟看一次）。

### ⚠️ 图必须由**子助手**去读（这是设计，不是风格）

默认指令要求主 agent **用 `subagent` 派一个子助手**去 `read_image`，只把文字结论带回来；主 agent **不许自己读图**。

原因是流量，不是洁癖：

- 图片一旦进入**主会话**，就**永久留在历史里**；之后每一次请求都要把整段历史（含所有图）重传一遍。
- 实测：开 20 分钟间隔、满质量截图，一天 57 张共 66 MB；因为不断重传，当天模型请求累计搬运图片 **约 295 MB（base64 后约 404 MB）**。
- 子助手在**它自己的会话**里读图，那张图不进主对话，主会话历史保持干净。

改 `inspectPrompt` 时**请保留这一条**。`tests/host-integration.test.mjs` 有一条测试钉死默认指令里必须同时出现 `subagent`、`read_image` 和「不要直接读图」。

> 另外记得把 `maxWidth` / `quality` 调小（例如 `1280` / `75`）。默认 `1600` / `80` 下，一张 2560 宽的屏幕截图有 1–2 MB；调到 `1280`/`75` 后同样画面约 150–350 KB。

### 怎么投的

调 `sessionController.resolveAgent(sessionId)` 拿到（必要时**唤醒冷 Session**）agent，然后 `agent.followup(message)`，消息的 `source.kind` 是 `"schedule"`——所以会话里显示成「定时触发」的轮次，而不是你自己打的字。投完再调 `sessions.flush(agent.session)` 要一次落盘确认，这样刚截完图就崩也不会丢这条唤醒。

和 `dsh-schedule` / `dsh-webhook` 走的是同一个入口。

### 唤醒哪个 Session

按优先级：

1. `inspectSessionId` 填了 → 就用它（必须是完整 session id）。
2. 否则用**你最近说过话的那个 Session**（从 `api-session/activity` 跟踪；该事件只对 `source.kind === "user"` 的消息发出，所以插件自己的投递不会把它带偏）。
3. 否则用 `sessionController.list()` 里**最近更新的那个会话**（它按更新时间倒序，且不需要有活着的 agent）。这一层是为了「刚重启、还没人说话」的情况——否则第一张图会白拍。
4. 否则，如果**当前只有一个**顶层 agent → 用它。
5. 都不满足 → **跳过并记一条 warning**，不猜。截的图仍在磁盘上。

子会话（subagent）在第 3 层会被跳过：截图点评应该落在你正在看的那个对话里，而不是某个后台子任务里。

宁可这次不叫，也不叫错人。

### 成本与调度

- **每张图都会真的跑一轮 agent**（外加一轮子助手），所以 `inspectEnabled` 默认关着，开之前想清楚 `intervalMinutes`。
- 唤醒是**脱离**截图循环执行的（`void notifyShot(...)`）。唤醒冷 Session 可能要好几秒，await 它会把下一次截图推迟；图已经安全落盘了，没必要等。
- 用一个 `notifying` 标志防止「唤醒比截图还慢」时堆积：上一轮还没投完，这一轮就跳过投递（图照截）。
- 任何投递失败都只记 warning，**绝不影响截图**。Session 找不到、resume 失败、flush 没确认，都会在日志里说清楚。

### `activeHours` 的时间段语义

- 留空 / 全空白 → 全天不限。
- 起止相同（如 `08:00-08:00`）→ 视为全天（而不是「永不截屏」）。
- 结束早于开始（如 `22:00-06:00`）→ **跨天**，覆盖 `22:00–24:00` 与 `00:00–06:00` 两段。
- 结束时刻是**开区间**：`08:00-23:00` 不含 23:00 本身，所以 `08:00-12:00` 与 `12:00-18:00` 不会同时认领 12:00。
- 格式写错（如 `8am-11pm`）→ 记一条 warning 后**按全天处理**并继续截屏。宁可多截，也不因为一个笔误把功能静默关掉。

调度上不是每分钟轮询：计时器会在「间隔到期」和「时间段开/关边界」两个时刻里取更早的那个唤醒，所以 `22:00-06:00` 会在 22:00 准点开始，而不是等到间隔的整数倍。

## 截图怎么实现的

调 PowerShell 跑包内的 `capture.ps1`（`System.Windows.Forms` + `System.Drawing`，抓虚拟屏幕，等比缩放后按指定质量存 JPEG）。

选它而不是 Node 原生实现的原因：Node 没有内置截屏 API，原生方案要么很重（node-ffmpeg / sharp 裸管线），要么需要一个本机编译的原生模块——而**本机无法创建符号链接**，pnpm 装原生模块会 `EPERM`。PowerShell 在每个 Windows 上都自带，脚本又是包内资源，零安装。

> `capture.ps1` **保持纯 ASCII**：Windows PowerShell 5.1 会把无 BOM 文件按 GBK 解码，非 ASCII 字符（哪怕只是注释里的中文）可能直接语法报错。写成纯 ASCII 就与代码页无关，BOM 丢了也不会坏。

脚本在查询任何屏幕尺寸**之前**先调 `SetProcessDpiAwarenessContext(-4)`（per-monitor-v2），老系统回落到 `SetProcessDPIAware()`。这一步不能省：DPI 不感知的进程在 2560×1600 / 125% 缩放的屏幕上会被告知虚拟屏幕是 2048×1280，`CopyFromScreen` 于是只抓走真实桌面的**左上角**——任务栏时钟和右边整块内容静默丢失。开启 DPI 感知后，上报尺寸、抓取矩形和物理像素三者才一致。

`skipWhenIdle` 的「无操作」判定用 P/Invoke 调 `GetLastInputInfo`（`user32.dll`），在 PowerShell 侧完成，且**只在开启时才编译那段代码**（`Add-Type` 有约 0.3 秒开销）。取到的时间差用无符号减法，能跨 `TickCount` 的 32 位回绕（约 49.7 天）。探测失败只记 warning 并照常截屏——探测是锦上添花，不该成为丢图的原因。

## 如何开关

1. 打开「设置」，左侧选「截屏记录」。
2. 勾掉「启用定时截屏」→ 保存（复选框是即时写入的，点一下就生效）。
3. 想完全停用：把 `enabled` 关掉即可；想临时抓一张可以用 `screencap_capture`。

## 给 agent 的工具

| 工具 | 作用 |
| --- | --- |
| `screencap_list` | 列出最近的截图绝对路径（新→旧），带时间与字节数。`limit` 默认 20，上限 200。 |
| `screencap_latest` | 返回最新一张图的路径；没有图时如实返回 `exists: false`。 |
| `screencap_capture` | 立刻抓一张，忽略间隔与时间段（但 `enabled` 开关和 idle 检查仍然生效）。 |

## 挂件的 HTTP 路由

全部是 `kind: "exact"` 的只读/小写入路由，注册在 `/dsh-screencap/` 前缀下。每条都先过一次**回环/同源栅栏**（`sec-fetch-site: cross-site` 直接 403；带 `Origin` 时必须与 `Host` 同源；宿主 `connection.requestRejection` 可用时委托它，不可用则只靠前面的自校验，校验器自身抛异常按拒绝处理）。

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/dsh-screencap/widget.js` | GET | 挂件脚本本体。文件缺失时 404（加载方吞掉错误，无害）。 |
| `/dsh-screencap/status.json` | GET | 设置 + 张数/占用 + 最新图信息。 |
| `/dsh-screencap/latest.jpg` | GET | 最新图字节；`?file=` 只能命中**磁盘上真实存在**的文件名，不做路径拼接。 |
| `/dsh-screencap/settings.json` | POST | 只接受 `enabled` 与 `intervalMinutes`，其余字段一律丢弃；写入走宿主 `settings` 服务（与设置页同一套 revision fencing），冲突重试一次。 |
| `/dsh-screencap/shoot.json` | POST | 立刻抓一张。 |
| `/dsh-screencap/open-folder.json` | POST | 打开截图目录。路径完全由服务端决定，请求里不带路径。 |

路由注册在 `ctx.inject(["webServer"], ...)` 里，所以没有 webserver 的 profile（headless / CLI）仍然会加载插件、保留设置页和三个工具，只是没有挂件。

## 已知限制

- **仅 Windows**。`capture.ps1` 依赖 `System.Windows.Forms`；在非 Windows 上调用会明确报错，不会静默失败。
- **需要 Windows 10 1703（创意者更新）或更新版本**；所有 Windows 11 都满足。截屏脚本用 `SetProcessDpiAwarenessContext` 开启 per-monitor-v2 DPI 感知，该函数[自 1703 起提供](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext)。更老的系统上脚本会回落到 `SetProcessDPIAware()`：单显示器仍可用，但**多显示器且各屏缩放比例不同**时可能截偏。
- 抓的是**虚拟屏幕**（多显示器会合成一张宽图），不是单个窗口或单个显示器。
- 只有一张图的时间分辨率是「间隔」；间隔期间的变化不会被记录。
- `activeHours` 读的是**本机本地时间**，改系统时区不会追溯已有文件。
- 挂件的「试直接插入输入框」未在活的 DSH 页面上端到端验证（见上）。
- 挂件靠 `.dshwv-root` 这个类名识别小鲸鱼。小鲸鱼换类名的话避让会失效（退回 CSS 默认偏移），但**不会**报错或挡住操作。
- 「拍完自动叫我」需要一个**能承载消息的宿主**（`sessionController` / `sessions` / `agents` 至少有一个可用）。headless / CLI 组合下没有 `sessionController`，此时会回落到 `agents.get()`，再拿不到就只记 warning——截图本身照常。

## 开发

```powershell
# 纯函数单测（无外部依赖）
node --test tests/schedule.test.mjs

# 宿主半端集成测试：需要先把运行时依赖从 app.asar 解出来
# 把 <DSH 安装目录> 换成你自己的（资源管理器里右键 DSH 快捷方式 → 打开文件位置）
node tests/extract-deps.mjs "<DSH 安装目录>\resources\app.asar" .. --max-mb 4
node --test tests/host-integration.test.mjs tests/client-smoke.test.mjs
node --test tests/schedule-runtime.test.mjs   # 会真的截图，较慢
node --test tests/inspect.test.mjs            # 会真的截图并投递唤醒，较慢
```

`tests/extract-deps.mjs` 把 `app.asar` 里的 `@deepseek-ai/*` 解到 `plugin-src/node_modules`（普通 Node 读不进 asar，只有 Electron 打了补丁），解完**不要提交**——它只是让 `import "../index.js"` 能真跑起来。缺依赖时测试会自动 skip 并说明原因，不会假失败。

## 许可

MIT，见 [LICENSE](LICENSE)。
