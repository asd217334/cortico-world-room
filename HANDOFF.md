# 小房间（cortico-world-room）交接文档

> 更新：2026-11-03
> 阅读对象：下一个接手这个插件的智能体 / 人。
> **先读第一节和第二节**，它们是这个插件的根本理念；后面的接口与目录只是技术落地。

---

## 一、这个插件是什么

`cortico-world-room` 是一个 **dsh 平台上的 world 插件**。dsh 平台的核心理念是「万物皆插件」：桌宠、房间、唱歌、种田……每一个能力都是一个独立插件，彼此不能 import、不能改对方代码，只能通过平台核心能力和「喊 AI」来协作。

room 只做三件事（对应 `src/world.ts` 头部注释）：

1. 起一个本地网页 `http://127.0.0.1:7798/room`，作为自己的 WebUI / 预览；
2. 记住「她」现在在哪个位置、在干什么（发呆 / 看书 / 画图 / 看视频 …）；
3. 给别的插件一个接口：`room_occupy(slot, activity)`，谁都能告诉它「她在沙发看视频」。

它**不负责**内容从哪来，也不负责桌宠长什么样、怎么动——那些是别的插件的职责。

---

## 二、核心理念（接手人必须遵守，勿破坏）

### 2.1 兼容 dsh 平台：只改自己

- room 只 import node 内置模块和 `cortico/core/*`（平台核心 API）。**永远不要 import 任何 `cortico-world-*` 插件**。
- 对其它插件（尤其桌宠 desktop-pet），只能走**公开能力**，不能改它们、不能调用它们没有暴露为公开接口的东西。

**可改 / 不可改边界（2026-11-03 联网核实 Coopanion 官方架构）**

- Coopanion 是「组装品」：**Cortico Core**（独立仓库 `Pal-AI-Lab/Cortico`）+ Cormini Persona + desktop-pet World + computer use；其 `packages/` 只有 `cortico-provider-coo` 和 `cortico-world-desktop-pet`。
- Cortico 四层：Core / Persona / Memory / **World**。World 是「隔离边界」，输入输出只有**事件（events）+ 工具调用（tool calls）**；World 不直接访问 Memory、不互相 import、不互相调用。
- **不可改**：`resources/`（Coopanion 主程序、Cortico core、官方桌宠 `cortico-world-desktop-pet`、`cortico-provider-coo`）——改了会被重装/更新覆盖，且破坏平台隔离。
- **可改**：`data/`（本 room 扩展、桌宠数据/配置、其它自己装的扩展）。
- **对其它 world 只用公开能力**：模型工具（`pet_say`/`pet_ask`/`pet_move_to`/`pet_set`/`pet_quiet`/`pet_act`/`pet_cua_*`，**没有 `pet_face`**）+ 只读 HTTP（`/api/state`/`/api/skin`/`/api/prefs`/`/api/speech`/`/api/avatar`/`/api/figures*`）。

### 2.2 跨插件协作 = 喊 AI

这是本插件最重要的设计原则，也是它可移植的根子：

| 想要的效果 | 实现方式 | 性质 |
|---|---|---|
| 她走到电视旁 | `host.pushEvent({ type:'room.tv', text:'请调 pet_move_to(...) 走过去…' })` | 发自然语言，让 AI 调公开工具 `pet_move_to` |
| 她坐下 / 站起 / 换表情 | `host.pushEvent({ type:'room.tv', text:'请调 pet_act(...) 坐下…' })` | 发自然语言，让 AI 调公开工具 `pet_act` |
| 电视亮起 | room 自己切图（`furn-tv-on.png`）+ SSE 推给桌面层 | 纯 room 内部 |

- 「喊 AI」= 通过事件文本，让模型去调用目标插件**公开暴露的工具**。room 从不直接调用 `pet_act` 的实现，只写工具名。
- **这是优点，不是缺陷**：room 不依赖 desktop-pet 的代码，只依赖「有一个会 `pet_act` 的桌宠角色」这个能力。将来换一个桌宠实现，只要它也提供 `pet_act` / `pet_move_to` 工具名，room 一行都不用改。
- 因此「她看电视没坐下」不是 bug，而是这条原则的边界表现：坐/转身是「请求 AI」，AI 可能自主决定是否执行。**接手人不要试图把它改成直接调用桌宠内部代码**——那会破坏 dsh 平台的插件隔离。

### 2.3 一个相关的边界事实（能力依赖，不是代码耦合）

- 当前桌宠形象是 `whale`，它的词表含 `sit`（坐下/坐）、`stand`（站起/站）。
- 若换成 `deepseek` 形象（Live2D 立绘），它只有 18 个表情词、**没有任何动作词**，`pet_act(["sit"])` 会被静默丢弃。这是「能力」问题，不是「代码」问题——room 该喊还是喊，只是这个形象不会坐。

---

## 三、目录结构

```
cortico-world-room/
├─ src/
│  ├─ world.ts          # 核心：状态、接口路由、bridgeTv/bridgeRead、看书心跳、FURNITURE、VIDEO_APPS
│  ├─ decls.ts          # 工具与事件的静态声明（describe.json 由它生成）
│  ├─ index.ts          # 入口：export { ROOM as default } from './world.ts'
│  ├─ prompts/          # 行为提示词（behavior.md）
│  ├─ room.js / room.css # /room 网页前端
│  └─ img/              # 进包的家具精灵：电视 / 书架 / 书
├─ scene-host/          # 桌面透明层（main.js / renderer.html / anchors.json），随包分发
├─ dist/                # WebUI 面板脚本（webui.js）
├─ assets/              # 市场用的图标
├─ design/              # 未进包的原始素材（背景图、书桌/沙发/床），不发布
├─ tools/               # 开发脚本（生成 describe.json），不发布
├─ describe.json        # 扩展自描述，市场与详情页读它
├─ package.json         # main 指向 ./src/index.ts，cortico.kind = world
└─ HANDOFF.md           # 本文档
```

**运行时依赖**：`scene-host/` 已进包。只剩 Electron 可执行文件在包外，`resolveElectron()`
按「`overlayElectron` 配置 → `CORTICO_ELECTRON` → 宿主 `<data>/overlay-runtime/electron/` →
`require('electron')`」四级查找，都找不到时桌面层不启动，网页与接口照常。

---

## 四、room 自己提供的本地接口

服务默认端口 `7798`（配置项 `worlds.room.port`）。

| 方法/路径 | 作用 |
|---|---|
| `GET /api/state` | 查房间状态（`slot/activity/pose/tv/app` 等） |
| `GET /api/scene/stream` | SSE 场景流，桌面 scene-host 订阅 |
| `GET /api/tv` | 查电视状态 |
| `POST /api/tv` | `{on, activity, minutes, source, app}` 开/关电视 |
| `POST /api/tv/on` | `{activity, minutes, source, app}` 开电视 |
| `POST /api/tv/off` | 关电视 |
| `GET/POST /api/tv/position` | 查/设电视横向位置（0..1） |
| `GET/POST /api/tv/display`、`/api/tv/display/next` | 查/切屏幕 |
| `GET/POST /api/read`、`/api/read/on`、`/api/read/off` | 查/开关书架（看书）；`{on, book, minutes, source}` |
| `POST /api/occupy` | 外部直接推送位置/活动 |
| `POST /api/furniture/position` | 通用家具拖动：`{id, x}`，`id` 见家具能力表（`tv` / `read`） |
| WebUI `invoke` | `url / state / images`；家具操作**第一个参数是家具 id**：`setPosition(id,x)` / `setSize(id,w)` / `setHidden(id,b)` / `setFlip(id,b)` / `setPower(id,b)` |

- `app` 对接市场视频插件：`bilibili`(看B站) / `douyin`(看抖音)；不填=普通看电视。
- **家具能力表 `FURNITURE`**（`world.ts`）：每件家具声明 `label / layer / caps(drag,resize,hide,flip,power) / keys(配置字段名) / sprites(off,on)`。`sceneJson()`、`stateJson().furniture`、WebUI 面板全部由它派生——**加新家具只需加一条表项 + RoomConfig 四个字段 + 两张图**，面板不用改。电视 `power:true`；书架 `power:true`（开关接 `setRead`，按钮文案「开始看书 / 合上书」），并带 `status` 文案（「在看 / 空着」）。
- WebUI 面板：`panels` 只有一项 `id: 'furniture'`（标题「拖动家具」），客户端脚本 `dist/webui-v11.js`。**没有家具标签页**：舞台同台显示所有家具（都能拖），下方控制项按 `state.furniture` 顺序纵向堆叠（电视一行在上、书架一行在下），每行按 `caps` 渲染大小/开关/隐藏/镜像。
- **桌面拖动**（`scene-host`）：任意家具都能在桌面上拖，松手 `POST /api/furniture/position`。链路是「渲染层量每件家具的窗口矩形 → IPC `furn-state` 报给主进程 → 主进程只在鼠标命中矩形时关掉 `setIgnoreMouseEvents`」。**只按电视几何判定的话，鼠标落不到别的家具上，就表现为「拖不动」**，排查时先看这里。
- **书本飞出（纯视觉）**：`sceneJson()` 额外推送 `sprites['book-off']`(合上) / `sprites['book-on']`(摊开) 和 `book: { on, from, to, width }`；`scene-host/renderer.html` 的 `syncBook()` 监听 `book.on` 的跳变：false→true 播「从书架 `from` 飞到 `to` → 沿中书脊摊开 → 轻浮动」；true→false 反向收回书架。`to` 用 `bookX ?? petXGuess()`：`bookX` 在开书那一下同步定为书架坐点 `readPetX()`（从家具配置推导，拖书架坐点跟书一起动）；之后她再走动 `to` 不变，书不跟随。她**不动**，是书飞过去。
- **看书时她走去书架**：`bridgeRead()` 事件文本让 AI 调 `pet_move_to` 走到书架旁、`pet_act(sit)` 坐下（不直连 `/api/move`）；`followPet()` 里书架不移动她（只有电视会）。
- **`petXGuess()` 的能力边界**：桌宠只暴露 `GET /api/state`（皮肤/配置，含 `startX`），**没有实时坐标**。`probePetX()` 只在启动时读一次 `startX` 作 `lastPetX` 种子、读完自收定时器（`startX` 只在桌宠 stop 时落盘，运行中不更新）；之后 `lastPetX` 由 room 的 `movePet()` 乐观更新。她若被别的工具（`pet_move_to` / 她自己的 roam）挪走，room 不知道——但书现在落在书架坐点 `readPetX()`，不受影响。要真跟随需在桌宠侧上游化只读位置路由（另一个插件的改动）。
- **跨屏**：任意家具拖到屏幕左右边缘（24px 内）都会触发换屏——IPC `switch-display` → 主进程 clamp 屏号 → `applyBounds()` 整层挪到相邻屏 → `/api/tv/display` 持久化 `displayIndex`。被拖的那件落到新屏对侧边缘（向右切 0.05、向左切 0.95）并写回自己的位置。**换屏是场景级动作**：一个透明窗口只铺一块屏，两件家具会一起到新屏上；换屏后本次拖动结束（跨窗口坐标会漂），桌宠与桌面坐标系不一致是已知 P2。
- **看书**：工具 `room_read(on, book, minutes)`、事件 `room.read`、槽位 `read`(书架)。链路与看电视完全同构（`bridgeRead`）；书架位置/大小读配置 `worlds.room.readX`(默认 0.55) / `readWidth`(默认 8vw)，她坐在家具左侧一个身位（默认 x≈0.46）。看电视/看书互斥，互相切换时会先收掉另一个。
- **看电视心跳 / 自动关电视**：`room_tv_tick(note)` 刷新 `lastTvTick`，作为「她还在看」的证据。常量 `TV_TICK_TIMEOUT_MS = 60_000`；timer 每 5 秒检查，`state.tv && now - lastTvTick > 60s` 就 `setTv(false, ..., 'timeout')` 自动关电视。看电视期间 `startTvPing()` 每 60 秒 `pushEvent` 一次「你还在看吗」，给她主动续期（`room_tv_tick`）或主动关掉（`room_tv(on=false)`）的时机。**所有能改 `state.tv` 的路径都走 `syncTvRuntime(on)`**（`setTv` / `occupyTool` / `POST /api/occupy` / `release`）。
- **看书心跳 / 自动合书**：`room_read_tick(note)` 刷新 `lastReadTick`，作为「她还在真读」的证据。常量 `READ_TICK_TIMEOUT_MS = 60_000`；`start()` 里的 timer 每 5 秒检查，`state.read && now - lastReadTick > 60s` 就 `setRead(false, ..., 'timeout')` 自动合书。看书期间 `startReadPing()` 每 60 秒 `pushEvent` 一次「你还在读吗」，给她主动续期（`room_read_tick`）或主动合书（`room_read(on=false)`）的时机；合书/离开时 `stopReadPing()`。**所有能改 `state.read` 的路径都走 `syncReadRuntime(on)`**（`setRead` / `occupyTool` / `POST /api/occupy` / `release`），否则 `lastReadTick` 还是旧值，刚开书就会被判超时直接合上。
- **提示词模板变量**：`webUi().promptDocs[0].vars` 声明 11 个 `room.*` 变量，`envPromptVars()` 提供对应值：`room.url / now / slot / activity / book / tv / read / tvPos / shelfPos / theme / videoApps`。设置页「模板变量」面板从这里读，新增变量两处必须同步加。
- **环境提示词读哪份文件（坑）**：`envPromptTemplateSource()`（`cortico/src/core/prefix.ts`）按「部署目录 → 代码包 → 模块自带模板」找**第一份存在**的 `<dir>/worlds/<id>/ENV_PROMPT.md`。room 的部署覆盖是 `data/home/companion/worlds/room/ENV_PROMPT.md`，**它优先于 `src/prompts/behavior.md`**。所以改模块里的 `behavior.md` 在 UI 和运行时都不会生效；要么改部署覆盖文件，要么删掉它让框架回退到模块模板。
- 工具名 `room_occupy` 是给别的插件/模型用的入口；HTTP 是给脚本和其它 world 用的。

---

## 五、room 依赖的外部能力（全部是公开能力，无 import）

| 能力 | 形态 | 来源 |
|---|---|---|
| `GET /api/state` | 公开 HTTP（只读配置） | 桌宠 desktop-pet，端口 7797（配置 `worlds.room.petPort`）；只用于取 `startX` 作启动种子 |
| `pet_act` / `pet_move_to` | 模型工具名（写在事件文本里） | 桌宠暴露给模型的工具 |
| `host.pushEvent` / `host.log` | 平台核心 API | `cortico/core` |
| `describeTools` / `WorldDefinition` | 平台核心 API | `cortico/world.ts` |

桌宠官方没有 `/api/move`、`/api/act`、`/api/roam`、`/api/face`、`/api/position` 这些 HTTP 路由（早期会话曾违规自加，重装 Coopanion 后已清除，桌宠回到官方原版）。room 走位一律走「喊 AI」的 `pet_move_to` / `pet_act` 工具。

---

## 六、跨插件联动的完整时序（看电视为例）

1. 触发：模型调 `room_tv(on=true, activity=...)`，或 HTTP `POST /api/tv/on`，或 WebUI `setTv`。
2. `setTv(true,...)` 更新 `state = { slot:'tv', activity, pose, tv:true, app }`（`world.ts:591-600`）。
3. `syncOverlay()` → `broadcastScene()`：SSE 通知桌面层把电视图切到 `furn-tv-on.png`（静态亮屏）。
4. `bridgeTv(on, activity, app)`（`world.ts:620-660`）：
   - 算桌宠目标位置 `petX`（电视中心 + `petOffset`，镜像时翻转）；
   - `pushEvent({ type:'room.tv', text: ..., }, { trigger:'flush' })` —— 喊 AI 调 `pet_move_to` 走过去、`pet_act` 坐下。
5. 坐下/转身由 AI 决定是否执行。
6. 看电视期间 `startTvPing()` 每 60 秒问一次「还在看吗」：她调 `room_tv_tick` 续期，或调 `room_tv(on=false)` 自己关；60 秒没有任何心跳则 timer 判定超时，`setTv(false, …, 'timeout')` 自动关电视。

`flush` 只表示「立即投递事件并唤醒一次请求」，不保证 AI 执行任何工具（`TriggerMode` 定义在 `resources/app/build/cortico/src/core/types.ts:604-620`）。这符合「喊 AI」的定位。

### 看书（含心跳）的完整时序

1. 触发：模型调 `room_read(on=true, book)`，或 HTTP `POST /api/read/on`，或面板「开始看书」→ `setRead`。
2. `setRead` 更新 `state = { slot:'read', read:true, book, until }`；同步定 `bookX = readPetX()`（书架坐点，从家具配置推导）并 `movePet(seat)` 做乐观跟踪；`syncReadRuntime(true)` 重置 `lastReadTick` 并启动续期检查。
3. `syncOverlay()` → SSE：桌面层 `syncBook` 播「书架 → 她面前」的飞书动画（纯视觉，她本人不动）。
4. `bridgeRead(true, book)` 发 `room.read` 事件：真读 / 读不到就合书 / 每读一段调 `room_read_tick`。
5. 看书期间 `startReadPing()` 每 60 秒问一次「还在读吗」：
   - 她调 `room_read_tick` → `lastReadTick` 刷新，书继续开着；
   - 她调 `room_read(on=false)` / `room_occupy` 去别处 / `room_tv(on=true)` / `release` → 合书并 `stopReadPing()`。
6. 兜底：`start()` 里的 timer 每 5 秒检查，60 秒没有任何心跳 → `setRead(false, …, 'timeout')` 自动合书。

---

## 七、上 GitHub / 市场的移植性清单

核心逻辑已经可移植（`dependencies` 为空、无运行时绝对路径、找不到资源时优雅降级）。

已完成（0.1.0）：

1. **桌面层资源进包**：`scene-host/` 随包分发；electron 由 `resolveElectron()` 四级查找，
   宿主只需在 `<data>/overlay-runtime/electron/` 放一份，或用 `worlds.room.overlayElectron` /
   `CORTICO_ELECTRON` 指定。
2. **硬编码路径**：`src/world.ts` 头部注释里的本机绝对路径已清掉。
3. **旧文件**：`overlay/`、`runtime/`、`demo/`、`pnpm-lock.yaml`、`src/ENV_PROMPT.md` 已删；
   `dist/` 只留 `webui.js`；未被引用的背景图与书桌/沙发/床挪到 `design/`（不发布）。
4. **市场元数据**：`keywords`（必须含 `cortico-world`）、`cortico.describe`、`cortico.icon`、
   `locales`、`tags`、`repository`、`homepage`、`bugs`、`publishConfig`、`os` 均已补。
5. **自描述**：`describe.json` 由 `node tools/make-describe.mjs` 生成；改 `src/decls.ts` 后要重跑。
6. **授权**：AGPL-3.0-or-later，`LICENSE` 为 AGPL 全文。

仍需注意：

- **TS 入口**：`main: "./src/index.ts"`，依赖宿主用 tsx 加载；发布前已在 tarball 安装下实测。
- `os` 目前只有 `win32`，mac / linux 未实测，验证后再放开。
- `tools/` 与 `design/` 不进包（`files` 白名单外），但仍在仓库里。

---

## 八、已知待办（按优先级，先不修改不是问题）

- **P1 换屏崩溃**：`POST /api/tv/display/next` 切副屏时 scene-host 25ms 退出 code -1，疑为单例锁冲突。排查方向：`restartOverlay` 时序加长、给 scene-host 独立 `--user-data-dir`、加崩溃日志。
- **P2 跨屏对齐**：桌宠 `to` 比例相对它自己窗口，场景层切副屏后两边坐标系不一致（任何家具跨屏都会触发），需把桌宠也拖到同一屏。
- **P3 重复事件**：拖电视/缩放/镜像/改偏移都会重发 `bridgeTv`（`world.ts:439/450/474/935`），喊 AI 的 sit/stand 会反复，观感上坐不住。可给 `bridgeTv` 加去重。
- **P4 书架素材**：已换成**书架**正式图（用户提供）。导入方式：`python tools/import-read-asset.py "<图片路径>"` —— 自动去白底（四角洪水填充）、清半透明边缘、按内容裁边、宽度统一到 560，并生成两态：`furn-read-off.png` 原图、`furn-read-on.png` 提亮 3% + 中心暖光。换图后要按新图重测 `renderer.html` 里的 `READ_LAMP` 光斑比例（当前按书架量：X 16%~84%、Y 35%~78%）。`tools/make-read-art.py` 是早期的纯占位绘图脚本，可留作兜底。书本飞出动画已做（`scene-host/renderer.html` 的 `bookShow` / `syncBook`）；尚未做：翻页动画。

---

## 九、接手后的操作要点

1. **改 `world.ts` 后必须重启 Coopanion**：World 热重启不重载 TS 模块，只重建实例。
2. **改 `dist/webui*.js` 必须换文件名**：`Cache-Control: immutable` 会导致浏览器永不重新请求。
3. **桌面层传屏号用环境变量 `SCENE_DISPLAY_INDEX`**，不要用 `--display-index` 参数（会被 Chromium 当内部开关消费导致秒崩）。
4. 验证走位：开电视/去位置后看事件文本是否带 `pet_move_to` 指引（原版桌宠没有 `/api/move` 直连路由，走位靠「喊 AI」）。
5. 开电视验证：`curl http://127.0.0.1:7798/api/tv -X POST -H "Content-Type: application/json" -d "{\"on\":true,\"activity\":\"看B站\",\"app\":\"bilibili\"}"` → 电视亮起 + 桌宠走到电视旁。**不传 `minutes` 时靠心跳兜底**：60 秒内没有 `room_tv_tick`，timer 会自动关电视——验证时看 `/api/tv` 返回的 `tv` 约 1 分钟后变 `false`。
6. 开看书验证：`curl http://127.0.0.1:7798/api/read/on -X POST -H "Content-Type: application/json" -d "{\"book\":\"三体\",\"minutes\":30}"` → 桌面书架换成亮灯图 + 暖光，书从书架飞到她面前摊开；`/api/read/off` 恢复灯灭图。**不传 `minutes` 时靠心跳兜底**：开书后 60 秒内没有 `room_read_tick`，timer 会自动合书——验证时看 `/api/read` 返回的 `read` 约 1 分钟后变 `false`。
7. 改书架位置/大小：改配置 `worlds.room.readX` / `worlds.room.readWidth` / `readFlip` / `readHidden`（x-hot，不用重启），或在设置页「拖动家具」面板里直接拖。
8. 拖动家具验证：设置页「小房间 → 拖动家具」舞台里应同时看到电视和书架，下方是两行控制项（电视在上、书架在下，两行都有开关按钮：电视「开电视/关电视」、书架「开始看书/合上书」，状态文案分别读 `status` 字段「开着/关着」「在看/空着」）。拖任一件松手后 `curl http://127.0.0.1:7798/api/state` 里对应的 `tvX`/`readX` 应更新。也可直接 `curl http://127.0.0.1:7798/api/furniture/position -X POST -H "Content-Type: application/json" -d "{\"id\":\"read\",\"x\":0.4}"`。
9. 桌面拖动验证：鼠标移到书架上应出现手型，按住左右拖动 → `/room` 与面板里的 `readX` 同步变化。若只有电视能拖，说明 `scene-host` 没重启（渲染层没上报 `furn-state`），或 `main.js` 的热区还在用电视几何兜底。
10. 跨屏验证：把书架拖到屏幕最右侧 24px 内 → 整层切到右邻屏，书架落在新屏左边缘（`/api/state` 的 `readX` ≈ 0.05）；再拖到最左 → 切回并落在 0.95 附近。电视行为不变；只有一块屏时原地不动（屏号被 clamp）。

---

## 十、2026-11-03 会话改动记录：书本落点改为确定性坐点（最终：只改 room 自己）

> 现象：第二次开书，书总是飞第一次的坐标。
> 最终方案（v2）：书的落点不再依赖「她此刻在哪」，改为书架旁的固定坐点。
> 接手人先读「结论」，再核对文件清单。

### 结论（三层原因，逐层修掉）

1. `bookX` 不随各出口清理/刷新 → 已收敛到各开书/合书路径统一清理，`occupyTool` 与
   `/api/occupy` 还把清理提前到了 `syncOverlay()` 之前。
2. 坐标源头是死的（实测坐实）：桌宠 `/api/state` 的 `startX` 来自 `cfg.petX`，而桌宠只在
   **World stop 时**才把位置写进配置（`savePosition()`）——运行中不随任何移动更新，
   实测 `POST /api/move` 前后三次读数纹丝不动。
3. 桌宠运行时的真实位置（宠物页每挪 ≥1px 上报的 standX）只存在于桌宠进程内存，公开 HTTP
   拿不到；桌宠窗口是全屏宽透明条、本身不动，OS 层查窗口也看不到「人在条里哪里」。
   **不改桌宠包 = 注定读不到她的实时位置。**（本会话曾在本机给桌宠打过只读路由补丁验证过
   方案可行，后按 2.1「只改自己」的边界全部回退，桌宠包已恢复原版内容。）

### 最终方案（v2，平台边界内：只改 room 自己）

学家具的做法——家具为什么没这个问题？tvX/readX 是配置值，拖动写回配置，位置永远可知。
书的落点原来绑在「她此刻在哪」（读不到），现在解绑：

- **开书 = 她走去书架旁的坐点**：room 只做乐观跟踪 `movePet(readPetX())`，真正走过去
  交给 `bridgeRead` 喊 AI 调 `pet_move_to`（书架位置 + 桌宠身位偏移，全部由配置推导——拖书架，坐点跟着动）；
- **书的落点 = 那个坐点**：`bookX = readPetX()` 同步确定（不再有异步读坐标的时序窗口），
  书在坐点等她，她到了就读；
- 「她不动、书飞过去」的旧设计作废（它要求知道她的实时位置，公开接口给不了）；
- 坐下（`pet_act` sit）仍走「喊 AI」：`bridgeRead` 的事件里带上坐点位置和坐下请求；
- 心跳兜底（60 秒内须有 `room_read_tick`）不变。

**遗留边界**：AI 用 `pet_move_to` 挪她、或用户手动拖动她，room 仍无从得知
（`lastPetX` 只是 room 自己命令过的位置）——但书不再受影响（落点是坐点）。
若将来想让书跟着她飞到任何位置，需要桌宠侧上游化提供只读位置路由，届时在开书处
接一个「读她实时位置」的函数即可（v1 的 `refreshBookTarget()` 已删除，需要时重新引入）。

### 改动清单（本会话最终落盘的全部文件，全在 room 包内）

| 文件 | 改动 |
|---|---|
| `src/world.ts` | ① `setRead(true)` / `occupyTool` / `/api/occupy` 开书时 `movePet(readPetX())` 并同步定 `bookX`；② 各合书出口清 `bookX`（并提前于 `syncOverlay`）；③ 删除 `alignBook()` / `refreshBookTarget()`；④ `probePetX()` 改为「startX 仅作启动种子、读完自收定时器」；⑤ `bridgeRead` 事件带坐点位置与坐下请求 |
| `src/decls.ts` | `room_read` 描述改为「她会自己走到书架旁坐下，书从书架飞出来摊在她面前」 |
| `describe.json` | `node tools/make-describe.mjs` 重新生成（补上此前缺失的 `room.move` 事件） |
| `data/extensions/node_modules/cortico-world-room/`（junction → `.pnpm` store） | `world.ts` / `describe.json` 整文件复制同步（sha256 一致）。**Coopanion 运行时加载的是这份**；改源码后必须同步再重启 |

### 没有动过的东西（如实记录）

- `resources/app/node_modules/cortico-world-desktop-pet/`——早期会话曾违规加过 `/api/move` 等路由与只读补丁，
  用户已重装 Coopanion，现确认回到官方原版（无 `/api/move`、`/api/act`、`/api/roam`、`/api/face`、`/api/position`）。
  本仓库（room）从头到尾只改 `data/` 下的自己，不碰 `resources/`。
- `data/extensions/node_modules/` 下所有其他 `cortico-world-*` 包、`data/home/companion/worlds/`
  部署目录、Coopanion 主程序、`data/` 下配置/数据文件——一个都没改。

### 接手注意

1. **重启 Coopanion 生效**（room 启动时经 tsx 加载 TS 源码）。
2. **改 `src/` 后必须同步安装拷贝再重启**：运行时加载的是 extensions junction 指向的
   `.pnpm` store 拷贝，不是 `data/room/` 源码目录（本会话实测踩过：只改源码 = 白改）。
3. 验证闭环：`POST 7798/api/read/on` → SSE 首帧 `book.to` ≈ `readPetX()`（书架坐点），
   桌宠应自己走过去坐下；`read/off` → 书收回书架；反复开关书，落点永远相同（坐点是确定的）。
4. 顺带核对：第八节 P1「换屏崩溃」在现实现（轮询 `/api/tv/display` + `setBounds`，不重启
   进程）下应已规避，待办可降级，未单独验证。
