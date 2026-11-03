/**
 * 场景宿主 —— 一个通用的透明全屏桌面层。
 *
 * 与旧的 overlay 不同：它不读 state.json，而是通过 SSE 订阅各 World 推送的场景。
 * electron 本体放在 data/overlay-runtime/electron/，所有 World 共用这一份。
 */
const { app, BrowserWindow, screen, ipcMain } = require('electron')
const path = require('node:path')
const http = require('node:http')

const argv = process.argv
function arg(name, fallback = '') {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const sceneUrl = arg('scene-url', '')
// 优先读环境变量：--display-index 会被 Chromium 当内部开关消费，实测会让进程秒崩
// 运行时可被 room 的换屏接口更新（pollDisplay 轮询到新屏号后改这里）
let displayIndex = Number(process.env.SCENE_DISPLAY_INDEX ?? arg('display-index', '-1'))

let win = null
let leaseTimer = null
let pollTimer = null
let pollFail = 0

// 电视当前状态（由渲染层通过 IPC 同步）：位置比例 0~1、宽度（vw）、
// sw = 电视旁电源开关的窗口比例矩形。渲染层还没上报家具矩形时用它兜底。
let tvState = { x: 0.8, width: 9, hidden: false, sw: null }
// 所有家具在窗口里的矩形（渲染层经 furn-state 上报）：鼠标热区判定用。
// 只按电视几何判定的话，鼠标在别的家具上时整层是穿透的，那些家具就拖不动。
let furnRects = []
// 正在拖动家具：这期间窗口保持不穿透，接住 mouseup
let dragging = false
// 拖动保险：渲染层卡死没发 tv-drag(false) 时到点强制恢复穿透
let dragGuard = null
// 上一次的鼠标热区状态，只在变化时调 setIgnoreMouseEvents，避免每 60ms 反复切
let mouseHot = false

function quit() {
  if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (win) { try { win.destroy() } catch {} win = null }
  app.quit()
}

/** 按横向排序选屏：-1 主屏，0..n 用显示器索引（越界取模）。 */
function pickDisplay() {
  const all = screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x)
  if (Number.isFinite(displayIndex) && displayIndex >= 0 && all.length > 0) {
    return all[Math.round(displayIndex) % all.length]
  }
  return screen.getPrimaryDisplay()
}

function boundsFor(display) {
  const wa = display.workArea
  return {
    x: Math.round(wa.x),
    y: Math.round(wa.y),
    width: Math.round(wa.width),
    height: Math.round(wa.height),
  }
}

/** 显示器增删 / 分辨率变化时，把窗口重新铺到当前选中的那块屏。 */
function applyBounds() {
  if (!win) return
  try { win.setBounds(boundsFor(pickDisplay())) } catch {}
}

/** 轮询 room 的换屏接口：屏号变了就运行时把窗口挪过去（不重启进程，避免单例锁崩溃）。
 *  顺带当 world 的存活探针：连续 8 次连不上（约 16 秒）就判定 Coopanion 已停，自己退出。 */
function pollDisplay() {
  if (!sceneUrl) return
  let base
  try { base = new URL(sceneUrl).origin } catch { return }
  let settled = false
  const markFail = () => {
    if (settled) return
    settled = true
    pollFail++
    if (pollFail >= 8) quit()
  }
  const req = http.get(`${base}/api/tv/display`, (res) => {
    let data = ''
    res.on('data', (c) => { data += c })
    res.on('end', () => {
      settled = true
      pollFail = 0
      try {
        const idx = Number(JSON.parse(data).index)
        if (Number.isFinite(idx) && idx !== displayIndex) {
          displayIndex = idx
          applyBounds()
        }
      } catch { /* 忽略 */ }
    })
  })
  req.on('error', markFail)
  req.setTimeout(1500, () => { req.destroy(); markFail() })
}

/** 通知 room 换屏（持久化 displayIndex）；scene-host 本地也立即切，不等轮询。 */
function postDisplay(idx) {
  if (!sceneUrl) return
  let base
  try { base = new URL(sceneUrl).origin } catch { return }
  const data = JSON.stringify({ index: idx, count: screen.getAllDisplays().length })
  const req = http.request(`${base}/api/tv/display`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (res) => { res.resume() })
  req.on('error', () => {})
  req.write(data)
  req.end()
}

function createWindow() {
  const b = boundsFor(pickDisplay())
  // 副屏坐标是负数，直接拿它创建透明窗口会让 Electron 秒崩：
  // 先用主屏位置建好窗口，再把窗口挪到目标屏。
  const safe = boundsFor(screen.getPrimaryDisplay())
  win = new BrowserWindow({
    ...safe,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      webSecurity: false,
    },
  })

  // 挪到目标屏（构造时用的是主屏位置）
  if (b.x !== safe.x || b.y !== safe.y || b.width !== safe.width || b.height !== safe.height) {
    try { win.setBounds(b) } catch {}
  }

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch {}

  win.loadFile(path.join(__dirname, 'renderer.html'), {
    query: { scene: sceneUrl },
  })

  win.once('ready-to-show', () => {
    win.show()
    win.moveTop()
  })
  win.on('closed', () => { win = null })
}

app.commandLine.appendSwitch('enable-transparent-visuals')
// QQ 截图等全屏覆盖窗口会让本窗口被判定「被遮挡」，Chromium 随即后台化/冻结渲染层
// （画面还在，但鼠标、拖动、点击全失效）。下面三个开关禁止遮挡后台化。
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) win.showInactive() })
  app.whenReady().then(() => {
    createWindow()
    // 启动即把显示器数量报给 world，供它 clamp 换屏上限
    postDisplay(displayIndex)
    // 渲染进程判定 SSE 断流超时后，通知主进程退出
    ipcMain.on('lease-expired', () => quit())

    // 渲染层同步电视位置/宽度，供鼠标热区判断
    ipcMain.on('tv-state', (_e, s) => {
      if (!s) return
      if (typeof s.x === 'number' && Number.isFinite(s.x)) tvState.x = s.x
      if (typeof s.width === 'number' && Number.isFinite(s.width)) tvState.width = s.width
      if (typeof s.hidden === 'boolean') tvState.hidden = s.hidden
      // 电视旁电源开关的矩形：热区把它也算上，按钮才点得到
      if (s.sw && typeof s.sw.x0 === 'number' && typeof s.sw.x1 === 'number'
        && typeof s.sw.y0 === 'number' && typeof s.sw.y1 === 'number') tvState.sw = s.sw
    })
    // 渲染层上报所有家具的窗口矩形 + 电源开关矩形
    ipcMain.on('furn-state', (_e, s) => {
      if (!s) return
      if (Array.isArray(s.rects)) {
        furnRects = s.rects.filter((r) => r
          && typeof r.x0 === 'number' && typeof r.x1 === 'number'
          && typeof r.y0 === 'number' && typeof r.y1 === 'number')
      }
      // 电视隐藏时渲染层给 null：开关也一起不接鼠标
      tvState.sw = s.sw ?? null
    })

    // 拖动开始/结束：拖动期间保持窗口可接鼠标
    ipcMain.on('tv-drag', (_e, on) => {
      dragging = !!on
      mouseHot = dragging
      if (win) win.setIgnoreMouseEvents(!dragging, { forward: true })
      if (dragGuard) { clearTimeout(dragGuard); dragGuard = null }
      // 渲染层卡死没发 tv-drag(false) 时，30 秒后强制恢复穿透，
      // 避免透明全屏层一直接住鼠标、把整个桌面挡死
      if (dragging) {
        dragGuard = setTimeout(() => {
          dragGuard = null
          if (!dragging) return
          dragging = false
          mouseHot = false
          if (win) win.setIgnoreMouseEvents(true, { forward: true })
        }, 30000)
      }
    })
    // 任意家具拖到屏幕边缘 → 整个场景层切到相邻屏（本地立即换，再通知 room 持久化）
    ipcMain.on('switch-display', (_e, dir) => {
      // 拖到屏幕边缘换屏：把目标屏 clamp 到 [-1, 屏数-1]，拖到尽头就停在最后一块屏，
      // 不再无限累加出越界屏号（之前越界成 5，导致窗口/热区错位、电视拖不动）。
      const maxIdx = screen.getAllDisplays().length - 1
      const target = Math.max(-1, Math.min(maxIdx, (displayIndex ?? -1) + (dir === 1 ? 1 : -1)))
      displayIndex = target
      applyBounds()
      postDisplay(target)
    })

    // 鼠标靠近家具 → 接住鼠标并亮起小十字；离开 → 恢复整层穿透
    setInterval(() => {
      if (!win) return
      if (dragging) {
        if (!mouseHot) { mouseHot = true; win.setIgnoreMouseEvents(false) }
        return
      }
      const pt = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const pad = 18
      const hit = (r) => pt.x >= b.x + b.width * r.x0 - pad && pt.x <= b.x + b.width * r.x1 + pad &&
                         pt.y >= b.y + b.height * r.y0 - pad && pt.y <= b.y + b.height * r.y1 + pad

      let on = false
      if (furnRects.length) {
        // 家具矩形由渲染层逐件量出来（含位置/大小/翻转后的实际占位），隐藏的不接鼠标
        for (const r of furnRects) {
          if (r.hidden) continue
          if (hit(r)) { on = true; break }
        }
      } else {
        // 渲染层还没上报（刚启动的一瞬）：退回电视几何估算
        const w = Math.max(20, b.width * (tvState.width / 100))
        const cx = b.x + b.width * tvState.x
        const top = b.y + b.height - w * 1.15
        on = pt.x >= cx - w / 2 - pad && pt.x <= cx + w / 2 + pad &&
             pt.y >= top - pad && pt.y <= b.y + b.height + pad
        if (tvState.hidden) on = false
      }
      // 电视旁的电源开关也接鼠标（渲染层经 furn-state 同步按钮矩形）
      if (!on && tvState.sw && !tvState.hidden) on = hit(tvState.sw)

      if (on !== mouseHot) {
        mouseHot = on
        win.setIgnoreMouseEvents(!on, { forward: true })
        // 通知渲染层切换光标：靠近电视显示手型，离开恢复
        win.webContents.send('cursor-hot', on)
      }
    }, 60)

    // 保活：QQ 截图等工具可能抢走置顶层级、或改掉窗口的鼠标穿透状态，
    // 而热区 interval 只在「状态变化」时才重设，会漏掉这类外部改动。
    // 每 2 秒强制刷新一次，确保桌面层始终最上、穿透状态正确。
    setInterval(() => {
      if (!win) return
      try { win.setAlwaysOnTop(true, 'screen-saver') } catch {}
      try { win.moveTop() } catch {}
      try { win.setIgnoreMouseEvents(!mouseHot && !dragging, { forward: true }) } catch {}
    }, 2000)

    // 显示器增删 / 分辨率变化时重新铺开
    screen.on('display-added', applyBounds)
    screen.on('display-removed', applyBounds)
    screen.on('display-metrics-changed', applyBounds)

    // 每 2 秒问一次 room 的换屏接口，屏号变了就运行时换屏（不重启，避免单例锁崩溃）
    pollDisplay()
    pollTimer = setInterval(pollDisplay, 2000)
  })
}

app.on('before-quit', () => { if (win) { try { win.destroy() } catch {} } })
app.on('window-all-closed', () => quit())
