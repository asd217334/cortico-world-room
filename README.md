# 小房间 · cortico-world-room

一个有纵深感的桌面房间：她在里面看电视、看书、发呆。

它只做三件事：

1. 起一个本地网页 `http://127.0.0.1:7798/room`，作为自己的 WebUI 页 / 预览；
2. 记住她此刻在哪个位置、在干什么（发呆 / 看书 / 看视频 / 听课 …）；
3. 给别的 World 一个入口：`room_occupy(slot, activity)`，谁都能告诉它「她在书架看书」。

内容从哪来不归它管，桌宠长什么样也不归它管——那些是别的插件的职责。

## 安装

在 Coopanion 的扩展页搜索 `cortico-world-room`，或：

```bash
cd data/extensions
pnpm add cortico-world-room
```

装完要重启 Coopanion（ESM 模块缓存不支持运行中换代码）。

## 桌面层需要一份 Electron

桌面上看到的电视和书架，是一个独立的 Electron 透明层（`scene-host/`），通过 SSE
订阅 `/api/scene/stream`。**只装这个包还不够**，还需要一份 Electron 运行时，按以下顺序查找：

1. 配置 `worlds.room.overlayElectron` —— 可执行文件的绝对路径；
2. 环境变量 `CORTICO_ELECTRON`；
3. 宿主提供的 `<data>/overlay-runtime/electron/`；
4. `require('electron')`（自己 `npm i electron` 时可用，macOS 也走这条）。

四条都找不到时，`/room` 网页和所有本地接口照常工作，只是桌面上不显示电视——运行日志里会有
一条「桌面层没启动：找不到 electron」。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `worlds.room.port` | `7798` | 本地服务端口 |
| `worlds.room.tvX` | `0.8` | 电视横向位置，0 最左、1 最右 |
| `worlds.room.tvWidth` | `9` | 电视宽度（vw，4~20） |
| `worlds.room.tvHidden` | `false` | 隐藏电视（不动开关状态） |
| `worlds.room.tvFlip` | `false` | 镜像电视，桌宠自动换到另一侧 |
| `worlds.room.readX` | `0.55` | 书架横向位置 |
| `worlds.room.readWidth` | `8` | 书架宽度（vw，4~20） |
| `worlds.room.readHidden` | `false` | 隐藏书架（不影响看书状态） |
| `worlds.room.readFlip` | `false` | 镜像书架（只镜图，桌宠不动） |
| `worlds.room.displayIndex` | `-1` | 桌面层放哪块屏，`-1` 主屏，`0/1/2…` 按横向排序 |
| `worlds.room.petPort` | `7797` | 桌宠端口（可选联动） |
| `worlds.room.petWidth` | `0.09` | 桌宠模型宽度，决定「往外推一个身位」推多远 |
| `worlds.room.petOffset` | `-0.09` | 在坐点上再微调，正数往右 |
| `worlds.room.theme` | `dusk` | 房间光线：`day` / `dusk` / `night` |
| `worlds.room.idleSwitchSec` | `45` | 没人占用时多久换一次发呆姿势（秒） |
| `worlds.room.overlayAuto` | `true` | World 启动时自己拉起桌面层 |
| `worlds.room.overlayElectron` | 空 | 指定 Electron 可执行文件 |

## 工具

| 工具 | 说明 |
|---|---|
| `room_occupy` | 去某个位置做某件事；去 `tv` 自动开电视，去 `read` 自动看书 |
| `room_tv` | 开 / 关电视 |
| `room_tv_tick` | 看电视心跳，续期避免被自动关掉 |
| `room_read` | 开始看书 / 合上书 |
| `room_read_tick` | 看书心跳，续期避免被自动合上 |
| `room_release` | 放下手头的事，回房间中间发呆 |
| `room_state` | 查她现在在干什么 |

看电视和看书都有 60 秒心跳兜底：超过 1 分钟没有 `room_*_tick`，会自动收掉。

## HTTP

| 路径 | 说明 |
|---|---|
| `GET /room` | 房间网页预览 |
| `GET /api/state` | 房间状态（含家具列表） |
| `GET /api/scene/stream` | SSE 场景流，桌面层订阅 |
| `GET/POST /api/tv` | 查 / 开关电视，`{on, activity, minutes, source, app}` |
| `POST /api/tv/on`、`/api/tv/off` | 强制开关 |
| `GET/POST /api/tv/position` | 查 / 设电视横向位置 |
| `GET/POST /api/tv/display`、`/api/tv/display/next` | 查 / 切屏幕 |
| `GET/POST /api/read`、`/api/read/on`、`/api/read/off` | 查 / 开关看书 |
| `POST /api/furniture/position` | 通用家具拖动：`{id, x}` |
| `POST /api/occupy` | 外部直接推送位置 / 活动 |

## 跨插件协作

本包不 import 任何 `cortico-world-*`，只走公开能力：

- **走路**：通过 `host.pushEvent` 发自然语言，让模型去调桌宠公开工具 `pet_move_to`（原版桌宠没有 `/api/move` 直连 HTTP）；
- **坐下 / 站起 / 换表情**：通过 `host.pushEvent` 发自然语言，让模型去调桌宠公开的工具名
  （`pet_act` / `pet_move_to`）。room 只写工具名，不碰实现。

所以「她没坐下」不是 bug，而是这条边界的表现：坐不坐由 AI 决定。换一个桌宠实现，只要它
提供同名的工具，room 一行都不用改。

## 授权

AGPL-3.0-or-later。见 [LICENSE](LICENSE)。
