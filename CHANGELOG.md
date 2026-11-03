# 变更记录

## 0.1.0

首个公开版本。

- 桌面电视层 `scene-host/` 移入包内，随包分发，不再依赖宿主目录
- Electron 运行时改为按 `worlds.room.overlayElectron` → `CORTICO_ELECTRON` → 宿主
  `<data>/overlay-runtime` → `require('electron')` 依次查找
- 场景精灵路径改用 `pathToFileURL`，不再拼出跨平台不可靠的 `file:///` URL
- `/art/` 只允许读取 `artDir` 内的图片，挡掉目录穿越
- 补充 `describe.json`、`keywords`、`icon`、`locales`、`repository` 等市场所需字段
- 授权改为 AGPL-3.0-or-later
- `/room` 预览页的电视跟随 `tvWidth` / `tvHidden` / `tvFlip`
- `petWidth` 配置真正生效（原先硬编码 0.09）
- 书架贴边基准宽度改为从排布表推导
- 工具与事件声明抽到 `src/decls.ts`，`describe.json` 由 `tools/make-describe.mjs` 生成
