/**
 * 小房间 World —— 一个能装下"她在干嘛"的场景容器。
 *
 * 它只做三件事：
 *   1. 起一个本地网页 http://127.0.0.1:7798/room（平面排版：三件家具原图水平并排）
 *   2. 记住她现在在哪个位置、在做什么（发呆 / 看书 / 画图 / 看视频 / 听课）
 *   3. 给别的 World 一个接口：room_occupy(slot, activity)
 *
 * 注意：用户在桌面上真正看到的**不是**这个网页，而是与本包同级的 scene-host/ 那个
 * Electron 透明层（通过 SSE 订阅 /api/scene/stream 渲染）。
 * 本文件里的网页只是 World 的 WebUI 页 / 预览，两者互相独立。
 *
 * 内容从哪来不归它管——别的 World 告诉它"我在沙发看视频"，它只负责让她
 * 坐到沙发上、摆出看视频的样子。没人告诉她干什么的时候，她就发呆。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ConfigGroup, ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts'
import { nowIso } from 'cortico/core/util.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { ROOM_EVENTS, ROOM_TOOL_DECLS, TOOL_SUMMARIES, toolDecl } from './decls.ts'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

// ── 房间里的位置 ────────────────────────────────────────────
// 平面方案：只有横向 x 有意义。z 是 2.5D 尝试留下的字段，
// 现在**不再参与任何渲染**（overlay 和网页都不做纵深缩放），保留只为兼容旧数据。
export type Slot = 'desk' | 'sofa' | 'window' | 'bed' | 'floor' | 'tv' | 'read'

export interface SlotDef {
  id: Slot
  label: string
  /** 站在这里时的横向位置，0 最左、1 最右 */
  x: number
  /** @deprecated 平面方案不再使用纵深，保留只为兼容旧配置 */
  z: number
  /** 这个位置适合干什么 */
  activities: string[]
}

export const SLOTS: SlotDef[] = [
  { id: 'floor', label: '房间中间', x: 0.5, z: 0.35, activities: ['发呆', '走神', '站着'] },
  { id: 'desk', label: '书桌', x: 0.28, z: 0.22, activities: ['画图', '写字', '听课'] },
  { id: 'sofa', label: '沙发', x: 0.68, z: 0.3, activities: ['看视频', '听歌', '躺着发呆'] },
  { id: 'window', label: '窗边', x: 0.84, z: 0.72, activities: ['看外面', '晒太阳', '打电话'] },
  { id: 'bed', label: '床', x: 0.18, z: 0.78, activities: ['睡觉', '看书', '赖床'] },
  { id: 'tv', label: '电视前', x: 0.8, z: 0.18, activities: ['看视频', '看直播', '打游戏'] },
  { id: 'read', label: '书架', x: 0.55, z: 0.35, activities: ['看书', '读书', '听书'] },
]

/**
 * 内置的视频平台映射：只说「能力」，不提任何插件名或工具名。
 * 这样换插件、换电脑都不用改配置——LLM 会从自己当前拥有的工具里挑能用的那个；
 * 一个都没装也不影响观感：电视自己会切到亮屏图（furn-tv-on），不用让 Agent 用文字演电视内容。
 */
export const VIDEO_APPS: Record<string, { label: string; hint: string }> = {
  bilibili: {
    label: 'B站',
    hint: '如果当前装有能看 B 站的插件，就用它打开并播放',
  },
  douyin: {
    label: '抖音',
    hint: '如果当前装有能刷抖音的插件，就用它打开并播放',
  },
  video: {
    label: '视频',
    hint: '如果当前装有能播放视频的插件，就用它打开并播放',
  },
}

/** 从活动文本里猜平台：看B站 → bilibili，看抖音 → douyin，否则 undefined。 */
function detectApp(activity: string): string | undefined {
  const a = activity
  if (/b站|bili|哔哩/.test(a)) return 'bilibili'
  if (/抖音|douyin|tiktok/.test(a)) return 'douyin'
  return undefined
}

/** 向本地 HTTP 服务发一个 JSON POST；失败静默忽略（桌宠没起或接口不存在时不崩）。 */
function postJson(url: string, body: unknown): void {
  const data = JSON.stringify(body)
  const req = httpRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (res) => { res.resume() })
  req.on('error', () => { /* 忽略：桌宠未启动等情况 */ })
  req.write(data)
  req.end()
}

/** 每个位置摆哪张家具图（放在 src/img 下），空表示不放。
 *  目前只有电视和书架两张精灵进包；书桌 / 沙发 / 床的原图在 design/furniture/，
 *  转成透明精灵并定好锚点后再接进来。 */
export const SLOT_FURNITURE: Record<string, string> = {
  tv: 'furn-tv-off.png',
  read: 'furn-read-off.png',
}

/** 电视亮起时换这张图（像素风，与关屏图逐像素对齐）。 */
export const TV_ON_IMAGE = 'furn-tv-on.png'
export const TV_OFF_IMAGE = 'furn-tv-off.png'

/** 书架：灯灭/灯亮两张。目前是占位图（tools/make-read-art.py 生成），
 *  外观定下来后直接替换同名文件即可，这里不用改。 */
export const READ_ON_IMAGE = 'furn-read-on.png'
export const READ_OFF_IMAGE = 'furn-read-off.png'

/** 书：合上 / 摊开。桌面层在看书时把它从书架「飞」到她面前（纯视觉，不影响状态）。 */
export const BOOK_CLOSED_IMAGE = 'book-closed.png'
export const BOOK_OPEN_IMAGE = 'book-open.png'

/** 看书心跳超时（毫秒）：她多久没有任何阅读动作/回应，就自动合书。 */
const READ_TICK_TIMEOUT_MS = 60_000

/** 看电视心跳超时（毫秒）：她多久没有「还在看」的信号，就自动关电视。 */
const TV_TICK_TIMEOUT_MS = 60_000

/** 桌面场景的家具排布：x 为横向位置（0 最左、1 最右），width 单位为 vw。
 *  目前只放电视和书架；床/书桌/沙发先撤下，等透明精灵和锚点准备好再接进来。 */
export const OVERLAY_LAYOUT: ReadonlyArray<{ id: string; x: number; width: number }> = [
  { id: 'tv', x: 0.8, width: 9 },
  { id: 'read', x: 0.55, width: 8 },
]

/**
 * 桌面家具能力表：几何配置键、层级、面板允许的操作集中在这里。
 * 加新家具 = 这里加一条 + RoomConfig 加四个字段 + 两张图；sceneJson / state / 面板都自动跟上。
 */
export interface FurnitureSpec {
  id: string
  label: string
  /** 桌面层级：数字大的压在上面 */
  layer: number
  /** 面板允许的操作；false 的项面板不渲染对应控件 */
  caps: { drag: boolean; resize: boolean; hide: boolean; flip: boolean; power: boolean }
  /** 开关按钮文案（仅 caps.power 时使用） */
  powerLabels?: { on: string; off: string }
  /** 状态文案（面板/HUD 显示用）；不填则按 power 有无显示「开着/关着」或「亮着/灭着」 */
  status?: { on: string; off: string }
  /** 对应 RoomConfig 里的字段名 */
  keys: { x: keyof RoomConfig; width: keyof RoomConfig; hidden: keyof RoomConfig; flip: keyof RoomConfig }
  /** 关/开两张图（电视是关屏/亮屏，书架是灯灭/灯亮） */
  sprites: { off: string; on: string }
}

export const FURNITURE: ReadonlyArray<FurnitureSpec> = [
  {
    id: 'tv',
    label: '电视',
    layer: 10,
    caps: { drag: true, resize: true, hide: true, flip: true, power: true },
    powerLabels: { on: '开电视', off: '关电视' },
    keys: { x: 'tvX', width: 'tvWidth', hidden: 'tvHidden', flip: 'tvFlip' },
    sprites: { off: TV_OFF_IMAGE, on: TV_ON_IMAGE },
  },
  {
    id: 'read',
    label: '书架',
    layer: 9,
    // 开关 = 开始看书 / 合上书（面板按钮、点桌面上的书架、工具、HTTP 都走这一条）
    caps: { drag: true, resize: true, hide: true, flip: true, power: true },
    powerLabels: { on: '开始看书', off: '合上书' },
    status: { on: '在看', off: '空着' },
    keys: { x: 'readX', width: 'readWidth', hidden: 'readHidden', flip: 'readFlip' },
    sprites: { off: READ_OFF_IMAGE, on: READ_ON_IMAGE },
  },
]

/** 按 id 找家具；未知 id 直接报错，避免静默改错家具。 */
export function furnitureById(id: unknown): FurnitureSpec {
  const key = String(id ?? '').trim()
  if (!key) throw new Error('missing furniture id')
  const found = FURNITURE.find((f) => f.id === key)
  if (!found) throw new Error(`unknown furniture: ${key}`)
  return found
}

/**
 * 电视在桌面上的几何，用来算「桌宠该坐在电视屏幕外侧一个身位」的位置。
 * 图片 furn-tv-on.png 为 1328×1328，像素测量：电视主体 X 16.6%~81.3%，
 * 屏幕（画面）X 22.6%~52.4%，屏幕朝左。x / width 与 OVERLAY_LAYOUT 保持一致。
 */
export const TV_GEOM = {
  /** 图片中心，屏幕宽度比例 */
  x: 0.8,
  /** 图片宽度，屏幕宽度比例（9vw） */
  width: 0.09,
  /** 屏幕左边缘在图片内的比例 */
  screenLeft: 0.226,
  /** 屏幕右边缘在图片内的比例 */
  screenRight: 0.524,
} as const

/** 在做某件事时摆什么样子。前端照着画。 */
const POSES: Record<string, string> = {
  发呆: 'idle',
  走神: 'idle',
  站着: 'idle',
  睡觉: 'sleep',
  赖床: 'sleep',
  看书: 'read',
  读书: 'read',
  听书: 'listen',
  画图: 'draw',
  写字: 'read',
  听课: 'listen',
  看视频: 'watch',
  看直播: 'watch',
  打游戏: 'watch',
  听歌: 'listen',
  看外面: 'watch',
  晒太阳: 'idle',
  打电话: 'talk',
  躺着发呆: 'sleep',
}

// ── 配置 ────────────────────────────────────────────────────
export interface RoomConfig {
  enabled: boolean
  port: number
  /** 立绘目录（她的三视图和表情图） */
  artDir: string
  /** 没人占用时，多久换一次发呆姿势（秒） */
  idleSwitchSec: number
  /** 房间主题：day / dusk / night */
  theme: string
  /** 桌面层读取的状态文件；留空则自动用本 World 的 overlay/state.json */
  overlayStatePath: string
  /** 桌面层刷新间隔（毫秒）。overlay 超过 20 秒没新状态会自己退出，别设太大。 */
  overlaySyncMs: number
  /** World 启动时自己拉起桌面层，停用时收掉 */
  overlayAuto: boolean
  /** 桌面层用哪个 electron 可执行文件；留空则自动查找 runtime/ 或 node_modules/ */
  overlayElectron: string
  /** 桌宠（desktop-pet）本地端口；看电视时直接 POST 它让它跑到电视前坐下 */
  petPort: number
  /** 看电视时桌宠相对电视中心的水平偏移（0~1，屏幕宽度的比例），控制"一个身位"的距离 */
  /** 桌宠模型宽度（屏幕宽度比例），决定"向外推一个身位"推多远；默认 0.09 */
  petWidth: number
  /** 在"屏幕外侧一个身位"的坐点上再微调（屏幕宽度比例），正数往右、负数往左 */
  petOffset: number
  /** 电视在桌面上的横向位置（0~1，屏幕宽度比例）；默认 0.8 */
  tvX: number
  /** 电视整体宽度（vw，4~20）；默认 9。桌面层、预览面板、桌宠贴边都按它算 */
  tvWidth: number
  /** 电视隐藏：true 时桌面层不画电视（只是藏起来，不动开关状态） */
  tvHidden: boolean
  /** 电视镜像：true 时电视图水平翻转，屏幕朝向左右对调，桌宠自动换到另一侧 */
  tvFlip: boolean
  /** 视频平台映射（JSON）；留空用内置 B站/抖音映射，换插件时可覆盖 */
  videoApps: string
  /** 书架在桌面上的横向位置（0~1，屏幕宽度比例）；默认 0.55 */
  readX: number
  /** 书架整体宽度（vw，4~20）；默认 8。桌宠贴边按它算 */
  readWidth: number
  /** 书架隐藏：true 时桌面层不画（只是藏起来，不动看书状态） */
  readHidden: boolean
  /** 书架镜像：true 时家具图水平翻转；只镜图，桌宠位置不动 */
  readFlip: boolean
  /** 电视铺在哪块屏：-1 主屏；0/1/2… 按横向排序的显示器索引 */
  displayIndex: number
}

export const ROOM_DEFAULTS: RoomConfig = {
  enabled: false,
  port: 7798,
  artDir: '',
  idleSwitchSec: 45,
  theme: 'dusk',
  overlayStatePath: '',
  overlaySyncMs: 4000,
  overlayAuto: true,
  overlayElectron: '',
  petPort: 7797,
  petWidth: 0.09,
  petOffset: -0.09,
  tvX: 0.8,
  tvWidth: 9,
  tvHidden: false,
  tvFlip: false,
  videoApps: '',
  readX: 0.55,
  readWidth: 8,
  readHidden: false,
  readFlip: false,
  displayIndex: -1,
}

export const ROOM_CONFIG_GROUP: ConfigGroup = {
  id: 'world:room',
  owner: 'world:room',
  schema: {
    type: 'object',
    title: '小房间',
    description: '一个有纵深的房间，她坐在不同位置做不同的事。别的 World 告诉它"在干嘛"，它只负责场景和动作。',
    properties: {
      'worlds.room.port': { type: 'integer', title: '网页端口', minimum: 1024, maximum: 65535, description: '浏览器中查看：http://127.0.0.1:7798/room（端口改成别的就替换 7798）' },
      'worlds.room.tvX': { type: 'number', title: '电视位置', minimum: 0, maximum: 1, description: '电视在桌面上的横向位置（0 最左、1 最右），默认 0.8。网页里拖动电视会同步改这里。', 'x-hot': true },
      'worlds.room.tvWidth': { type: 'number', title: '电视大小', minimum: 4, maximum: 20, description: '电视整体宽度（vw），默认 9。WebUI 面板里的「电视大小」滑杆改的就是它；光斑、拖动热区、桌宠贴边都会跟着缩放。', 'x-hot': true },
      'worlds.room.tvFlip': { type: 'boolean', title: '电视镜像（屏幕朝左/朝右）', description: '打开后电视图水平镜像，屏幕朝向左右对调；桌宠会自动换到电视另一侧去贴。', 'x-hot': true },
      'worlds.room.readX': { type: 'number', title: '书架位置', minimum: 0, maximum: 1, description: '书架在桌面上的横向位置（0 最左、1 最右），默认 0.55。看书时桌宠会贴到它左边一个身位。', 'x-hot': true },
      'worlds.room.readWidth': { type: 'number', title: '书架大小', minimum: 4, maximum: 20, description: '书架整体宽度（vw），默认 8；桌宠贴边会跟着缩放。', 'x-hot': true },
      'worlds.room.readFlip': { type: 'boolean', title: '书架镜像', description: '打开后书架家具图水平翻转（只镜图，桌宠位置不动）。', 'x-hot': true },
      'worlds.room.readHidden': { type: 'boolean', title: '隐藏书架', description: '只把书架从桌面上藏起来，不影响她是不是在看书。', 'x-hot': true },
      'worlds.room.displayIndex': { type: 'integer', title: '电视所在屏幕', minimum: -1, maximum: 8, description: '电视铺在哪块屏幕：-1 主屏；0/1/2… 按横向排序的显示器索引。改完桌面层会重开一次；记得把桌宠也拖到同一块屏，否则她按主屏的比例算位置会对不上。' },
      'worlds.room.videoApps': { type: 'string', title: '视频插件映射（JSON）', description: '留空用内置 B站/抖音映射。换插件时按 {"bilibili":{"label":"B站","hint":"用 xxx 插件的播放工具"}} 覆盖。' },
      'worlds.room.petOffset': { type: 'number', title: '桌宠相对电视的偏移', minimum: -0.3, maximum: 0.3, description: '桌宠位置 = 电视位置 + 这个偏移。默认 -0.09（贴电视左边），0 与电视重叠，正数站右边。', 'x-hot': true },
      'worlds.room.petPort': { type: 'integer', title: '桌宠端口', minimum: 1024, maximum: 65535, description: '桌宠（desktop-pet）的本地端口，默认 7797，一般不用改。' },
      'worlds.room.theme': { type: 'string', title: '房间光线', enum: ['day', 'dusk', 'night'], 'x-hot': true },
      'worlds.room.idleSwitchSec': { type: 'integer', title: '发呆换姿势间隔（秒）', minimum: 10, maximum: 600, 'x-hot': true },
    },
    required: [],
  },
} as ConfigGroup

// ── 状态 ────────────────────────────────────────────────────
interface RoomState {
  slot: Slot
  activity: string
  pose: string
  since: number
  /** 到点自动回中间；0 表示不自动 */
  until: number
  /** 谁占的（哪个 World 请求的），空表示自己闲着 */
  owner: string
  /** 电视开着没有。只有它是 true 时桌面层才换成亮屏图。 */
  tv: boolean
  /** 对接的市场视频插件：bilibili / douyin / 空（普通电视） */
  app: string
  /** 在不在看书（书架）。P0 没有家具图，桌面层暂时不画。 */
  read: boolean
  /** 正在看的书名/内容，空表示没说 */
  book: string
}

// ── World ───────────────────────────────────────────────────
/** 从 start 逐级向上找 `<dir>/overlay-runtime/electron/<exe>`，最多 levels 级。
 *  宿主把共享运行时放在部署根（<data>/overlay-runtime），而 ctx.dataDir 是部署里的
 *  data/ 子目录，两者差几级，所以不能写死层数。 */
function findSharedElectron(start: string, exe: string, levels = 6): string {
  if (!start) return ''
  let dir = resolve(start)
  for (let i = 0; i < levels; i += 1) {
    const candidate = join(dir, 'overlay-runtime', 'electron', exe)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

export class RoomWorld implements World {
  /** 实例 id 必须与 WorldDefinition.id 一致，框架据此配对。 */
  readonly id = 'room'

  private host?: WorldHost
  private server?: Server
  private state: RoomState = {
    slot: 'floor',
    activity: '发呆',
    pose: 'idle',
    since: Date.now(),
    until: 0,
    owner: '',
    tv: false,
    app: '',
    read: false,
    book: '',
  }
  private timer?: ReturnType<typeof setInterval>
  private overlayTimer?: ReturnType<typeof setInterval>
  /** 轮询桌宠位置（读它记住的 startX），让她走动时书能跟着 */
  private petTimer?: ReturnType<typeof setInterval>
  /** World 自己拉起的桌面层进程 */
  private overlayProc?: ChildProcess
  /** 桌面层退出后的自动重启定时器（挂久了 SSE 断流/崩溃后自愈用） */
  private overlayRestartTimer?: ReturnType<typeof setTimeout>
  /** 正在停用：stop 后不再自动重启桌面层 */
  private stopping = false
  /** 订阅了场景流（SSE）的客户端连接 */
  private sseClients = new Set<ServerResponse>()
  /** 桌面层上报的实际显示器数-1（换屏上限）；-1 表示还没收到，不限制 */
  private maxDisplay = -1
  /** 她自己最后所在的横向位置（0~1）：room 发起的移动会更新；
   *  启动时问一次桌宠的 /api/state.startX 当初值（它没有实时坐标接口）。 */
  private lastPetX?: number
  /** 看书时书停在哪：开始看书那一下读一次她的位置，之后她走动不再跟着变。 */
  private bookX?: number
  /** 最后一次「还在看书」的信号时间：她每调一次 room_read_tick 或任何 room 工具都刷新。
   *  超过 READ_TICK_TIMEOUT_MS 没刷新，就判定她没在真读，自动合书。 */
  private lastReadTick = 0
  /** 看书期间的续期检查定时器：定期问她「还在读吗」，让她有机会续期或主动合书。 */
  private readPingTimer?: ReturnType<typeof setInterval>
  /** 最后一次「还在看电视」的信号时间：她每调一次 room_tv_tick 刷新。
   *  超过 TV_TICK_TIMEOUT_MS 没刷新，就判定她没在看了，自动关电视。 */
  private lastTvTick = 0
  /** 看电视期间的续期检查定时器：定期问她「还在看吗」，让她有机会续期或主动关掉。 */
  private tvPingTimer?: ReturnType<typeof setInterval>

  constructor(private opts: {
    cfg: RoomConfig
    dataDir: string
    timezone: string
    /** 写回 worlds.room 段（电视位置等）；缺省时只改内存 */
    persist?: (patch: Partial<RoomConfig>) => void
  }) {}

  get port(): number {
    return this.opts.cfg.port || 7798
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host
    this.stopping = false
    try {
      await this.listen()
    } catch (err) {
      host.log.error?.(`房间服务起不来（端口 ${this.port}）：${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
    // 到点自动回中间 / 看书、看电视超时自动收掉
    this.timer = setInterval(() => {
      if (this.state.until && Date.now() >= this.state.until) {
        this.release('到点了')
        return
      }
      // 看书心跳：超过 READ_TICK_TIMEOUT_MS 没有新的阅读动作/回应，判定没在真读，自动合书
      if (this.state.read && Date.now() - this.lastReadTick > READ_TICK_TIMEOUT_MS) {
        this.setRead(false, undefined, undefined, 'timeout')
        return
      }
      // 看电视心跳：超过 TV_TICK_TIMEOUT_MS 没有「还在看」的信号，判定没在看，自动关电视
      if (this.state.tv && Date.now() - this.lastTvTick > TV_TICK_TIMEOUT_MS) {
        this.setTv(false, undefined, undefined, 'timeout')
      }
    }, 5000)
    this.timer.unref?.()

    // 把状态推到桌面层。overlay 全靠这个文件活着：超过 20 秒没新内容它自己退出，
    // 所以这里必须持续写，不能只在状态变化时写一次。
    this.syncOverlay()
    const syncMs = Math.max(1000, Number(this.opts.cfg.overlaySyncMs) || 4000)
    this.overlayTimer = setInterval(() => this.syncOverlay(), syncMs)
    this.overlayTimer.unref?.()

    // state.json 已经有内容了，这时候拉起桌面层它才能立刻画出来
    this.startOverlay()

    // 跟踪她的位置：桌宠没有实时坐标接口，只能读它记住的 startX（会随移动更新）。
    // 位置一变就推一次场景，书才会跟着她挪。
    this.probePetX()
    this.petTimer = setInterval(() => this.probePetX(), 2000)
    this.petTimer.unref?.()

    host.log.info?.(`房间开着：http://127.0.0.1:${this.port}/room`)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.overlayRestartTimer) { clearTimeout(this.overlayRestartTimer); this.overlayRestartTimer = undefined }
    // 先收桌面层，别在桌面上留残影
    this.stopOverlay()
    for (const res of this.sseClients) { try { res.end() } catch { /* 忽略 */ } }
    this.sseClients.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.overlayTimer) clearInterval(this.overlayTimer)
    this.overlayTimer = undefined
    if (this.petTimer) clearInterval(this.petTimer)
    this.petTimer = undefined
    this.stopReadPing()
    this.stopTvPing()
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      this.server = undefined
    })
    this.host = undefined
  }

  envPromptVars(): Record<string, string> {
    // 当前可用的视频平台名（内置或配置覆盖），给提示词直接引用
    const videoApps = Object.values(this.videoApps()).map((v) => v.label).join('、')
    const theme = this.opts.cfg.theme === 'day' ? '白天' : this.opts.cfg.theme === 'night' ? '夜晚' : '黄昏'
    return {
      'room.url': `http://127.0.0.1:${this.port}/room`,
      'room.now': `${this.slotLabel(this.state.slot)} · ${this.state.activity}`,
      'room.slot': this.slotLabel(this.state.slot),
      'room.activity': this.state.activity,
      'room.book': this.state.read ? this.state.book : '',
      'room.tv': this.state.tv ? '开着' : '关着',
      'room.read': this.state.read ? '在看' : '空着',
      'room.tvPos': String(this.tvX()),
      'room.shelfPos': String(this.readX()),
      'room.theme': theme,
      'room.videoApps': videoApps || '无',
    }
  }

  /** 设置页的「小房间」：状态灯、徽章、配置表单和房间页面入口。
   *  config 交给框架渲染成可编辑表单，改完即生效（x-hot 项不用重启）。 */
  webUi(): WorldWebUiDecl {
    const running = this.server !== undefined
    const tv = this.state.tv
    const overlay = !!this.overlayProc
    return {
      label: '小房间',
      lamps: [
        { label: '服务', state: running ? 'online' : 'offline', hint: running ? `http://127.0.0.1:${this.port}/room` : '没启动' },
        { label: '电视', state: tv ? 'online' : 'offline', hint: tv ? `开着 · ${this.state.activity}${this.state.app ? ` · ${this.state.app}` : ''}` : '关着' },
        { label: '书架', state: this.state.read ? 'online' : 'offline', hint: this.state.read ? (this.state.book ? `在看《${this.state.book}》` : '在看书') : '没在看书' },
        { label: '桌面层', state: overlay ? 'online' : 'offline', hint: overlay ? '已拉起' : '没拉起' },
      ],
      badges: [
        { label: '她在', value: this.slotLabel(this.state.slot), tone: 'plain' },
        { label: '在干嘛', value: this.state.activity, tone: 'plain' },
        { label: '电视', value: tv ? '开着' : '关着', tone: tv ? 'on' : 'off' },
        { label: '书架', value: this.state.read ? (this.state.book || '看书') : '没在读', tone: this.state.read ? 'on' : 'off' },
      ],
      panels: [
        { id: 'furniture', title: '拖动家具', description: '舞台上直接拖家具（桌面也一样能拖）；下方每件家具一行，各自调大小、隐藏、朝向。' },
      ],
      invoke: async (_panel, method, args) => {
        if (method === 'url') return { url: `http://127.0.0.1:${this.port}/room` }
        if (method === 'state') return this.stateJson()
        // 图片以 base64 交给 WebUI：跨源 <img> 在 Coopanion 里加载不出来
        if (method === 'images') {
          const base64 = (name: string) => `data:image/png;base64,${readFileSync(join(MODULE_DIR, 'img', name)).toString('base64')}`
          const out: Record<string, { off: string; on: string }> = {}
          for (const f of FURNITURE) out[f.id] = { off: base64(f.sprites.off), on: base64(f.sprites.on) }
          return out
        }
        // ── 家具操作：第一个参数一律是家具 id（见 FURNITURE 能力表），不做旧用法兼容 ──
        if (method === 'setPosition') {
          const spec = furnitureById(args?.[0])
          return { ok: true, x: this.applyFurnitureX(spec, Number(args?.[1])) }
        }
        // 家具整体大小（vw，4~20）：桌面层、光斑、拖动热区、桌宠贴边都跟着缩放
        if (method === 'setSize') {
          const spec = furnitureById(args?.[0])
          return { ok: true, width: this.applyFurnitureSize(spec, Number(args?.[1])) }
        }
        // 隐藏/显示（只是不画，不动开/关状态）
        if (method === 'setHidden') {
          const spec = furnitureById(args?.[0])
          return { ok: true, hidden: this.applyFurnitureHidden(spec, args?.[1] === true || args?.[1] === 'true') }
        }
        // 朝向：镜像家具图（电视开着时还会让她换到另一侧去贴）
        if (method === 'setFlip') {
          const spec = furnitureById(args?.[0])
          return { ok: true, flip: this.applyFurnitureFlip(spec, args?.[1] === true || args?.[1] === 'true') }
        }
        // 开关：电视 = 开/关电视，书架 = 开始看书/合上书
        if (method === 'setPower') {
          const spec = furnitureById(args?.[0])
          if (!spec.caps.power) throw new Error(`${spec.label} 没有开关`)
          const on = args?.[1] === true || args?.[1] === 'true'
          if (spec.id === 'read') {
            this.setRead(on, undefined, undefined, 'panel')
            return { ok: true, on: this.state.read }
          }
          this.setTv(on)
          return { ok: true, on: this.state.tv }
        }
        throw new Error(`unknown method: ${method}`)
      },
      promptDocs: [
        {
          key: 'worlds.room.behavior',
          title: '小房间 · 行为',
          description: '她在小房间里的日常行为约定：可以开着电视不看，也可以自己关掉。',
          path: join(MODULE_DIR, 'prompts', 'behavior.md'),
          role: 'envPrompt',
          // 模板变量：与 envPromptVars() 提供的运行时值一一对应
          vars: [
            { name: 'room.url', description: '房间网页地址（http://127.0.0.1:端口/room）' },
            { name: 'room.now', description: '她此刻的位置和活动，如「书架 · 看书」' },
            { name: 'room.slot', description: '她当前所在位置，如「书架」「电视前」' },
            { name: 'room.activity', description: '她当前在做的事，如「看书」「发呆」' },
            { name: 'room.book', description: '她正在看的书名；没在看书时为空' },
            { name: 'room.tv', description: '电视状态：开着 / 关着' },
            { name: 'room.read', description: '看书状态：在看 / 空着' },
            { name: 'room.tvPos', description: '电视的横向位置（0~1）' },
            { name: 'room.shelfPos', description: '书架的横向位置（0~1）' },
            { name: 'room.theme', description: '房间光线：白天 / 黄昏 / 夜晚' },
            { name: 'room.videoApps', description: '当前可用的视频平台，如「B站、抖音」' },
          ],
        },
      ],
      config: [ROOM_CONFIG_GROUP],
      links: [
        { label: '房间页面', href: `http://127.0.0.1:${this.port}/room`, inheritTheme: true },
      ],
    }
  }

  tools(): ToolDef[] {
    return [this.occupyTool(), this.tvTool(), this.tvTickTool(), this.releaseTool(), this.stateTool(), this.readTool(), this.readTickTool()]
  }

  // ── 工具实现 ──────────────────────────────────────────────
  // 一律按名字取声明（toolDecl），别用下标——插入新工具会让下标全错位。
  private occupyTool(): ToolDef {
    return {
      ...toolDecl('room_occupy'),
      handler: async (args): Promise<string> => {
        const slot = String(args.slot ?? '').trim() as Slot
        const def = SLOTS.find((s) => s.id === slot)
        if (!def) return { text: `没有这个位置：${slot}。可选：${SLOTS.map((s) => s.id).join(' / ')}`, failed: true }
        const activity = String(args.activity ?? '').trim() || '发呆'
        const minutes = Number(args.minutes)
        const wasTv = this.state.tv
        const wasRead = this.state.read
        this.state = {
          slot,
          activity,
          pose: POSES[activity] ?? 'idle',
          since: Date.now(),
          until: Number.isFinite(minutes) && minutes > 0 ? Date.now() + minutes * 60_000 : 0,
          owner: 'tool',
          // 坐到电视前就把电视打开，去书架就开始看书，去别处则都收掉
          tv: slot === 'tv',
          app: slot === 'tv' ? (detectApp(activity) ?? '') : '',
          read: slot === 'read',
          book: '',
        }
        this.syncOverlay()
        if (slot === 'tv') {
          if (wasRead) this.bridgeRead(false, '')
          this.bridgeTv(true, activity, detectApp(activity))
        } else if (slot === 'read') {
          if (wasTv) this.bridgeTv(false, '发呆')
          this.bridgeRead(true, '')
        } else if (wasRead) {
          // 离开书架去做别的（去别的位置/发呆）：把书合上
          this.bridgeRead(false, '')
        }
        // 心跳/续期检查跟着看书、看电视状态走（不管从工具、HTTP 还是面板进来的）
        this.syncReadRuntime(slot === 'read')
        this.syncTvRuntime(slot === 'tv')
        return `她在 ${def.label} ${activity}${Number.isFinite(minutes) && minutes > 0 ? `，大概 ${minutes} 分钟` : ''}。`
      },
    }
  }

  private tvTool(): ToolDef {
    return {
      ...toolDecl('room_tv'),
      handler: async (args): Promise<string> => {
        const on = args.on === true || args.on === 'true'
        if (!on) {
          this.setTv(false, undefined, undefined, 'tool')
          return '电视关了，她回房间中间发呆了。'
        }
        const activity = String(args.activity ?? '').trim() || '看视频'
        const minutes = Number(args.minutes)
        const app = String(args.app ?? '').trim() || undefined
        this.setTv(true, activity, minutes, 'tool', app)
        return `电视打开了，她坐在电视前${activity}${Number.isFinite(minutes) && minutes > 0 ? `，大概 ${minutes} 分钟` : ''}。`
      },
    }
  }

  private tvTickTool(): ToolDef {
    return {
      ...toolDecl('room_tv_tick'),
      handler: async (args): Promise<string> => {
        const note = String(args.note ?? '').trim()
        if (!this.state.tv) return '她这会儿没在看电视，不用报进度。'
        // 刷新「还在看」的心跳：说明她真的还在继续看，重置自动关电视计时
        this.lastTvTick = Date.now()
        return note ? `记下了，她在看：${note}` : '记下了，她还在继续看。'
      },
    }
  }

  private readTool(): ToolDef {
    return {
      ...toolDecl('room_read'),
      handler: async (args): Promise<string> => {
        const on = args.on === true || args.on === 'true'
        if (!on) {
          this.setRead(false, undefined, undefined, 'tool')
          return '她合上书，站起来继续待着了。'
        }
        const book = String(args.book ?? '').trim()
        const minutes = Number(args.minutes)
        this.setRead(true, book, minutes, 'tool')
        return `她在书架坐下看书${book ? `，看的是《${book}》` : ''}${Number.isFinite(minutes) && minutes > 0 ? `，大概 ${minutes} 分钟` : ''}。`
      },
    }
  }

  private readTickTool(): ToolDef {
    return {
      ...toolDecl('room_read_tick'),
      handler: async (args): Promise<string> => {
        const note = String(args.note ?? '').trim()
        if (!this.state.read) return '她这会儿没在看书，不用报进度。'
        // 刷新「还在读」的心跳：说明她真的还在继续读，重置自动合书计时
        this.lastReadTick = Date.now()
        return note ? `记下了，她在读：${note}` : '记下了，她还在继续读。'
      },
    }
  }

  private releaseTool(): ToolDef {
    return {
      ...toolDecl('room_release'),
      handler: async (): Promise<string> => {
        this.release('手动')
        return '她放下手头的事，回房间中间发呆了。'
      },
    }
  }

  private stateTool(): ToolDef {
    return {
      ...toolDecl('room_state'),
      handler: async (): Promise<string> => {
        const s = this.state
        const mins = Math.max(0, Math.round((Date.now() - s.since) / 60000))
        const left = s.until ? `，还有 ${Math.max(0, Math.round((s.until - Date.now()) / 60000))} 分钟` : ''
        const tv = s.tv ? '，电视开着' : ''
        const book = s.read && s.book ? `，在读《${s.book}》` : ''
        return `她在 ${this.slotLabel(s.slot)} ${s.activity}（已经 ${mins} 分钟${left}${tv}${book}）。`
      },
    }
  }

  private release(reason: string): void {
    const wasRead = this.state.read
    const wasTv = this.state.tv
    this.state = {
      slot: 'floor',
      activity: '发呆',
      pose: 'idle',
      since: Date.now(),
      until: 0,
      owner: '',
      tv: false,
      app: '',
      read: false,
      book: '',
    }
    this.syncOverlay()
    // 只有真的开着电视 / 真的在看书时才喊话，避免一次动作连发多条事件
    if (wasTv) this.bridgeTv(false, '发呆')
    if (wasRead) this.bridgeRead(false, '')
    this.syncReadRuntime(false)
    this.syncTvRuntime(false)
    void reason
  }

  /** 开/关电视。开的时候她自动坐到电视前。app 对接市场视频插件（bilibili/douyin）。 */
  private setTv(on: boolean, activity?: string, minutes?: number, owner = 'http', app?: string): void {
    const wasRead = this.state.read
    const wasTv = this.state.tv
    if (on) {
      const act = String(activity ?? '').trim() || '看视频'
      const mins = Number(minutes)
      const platform = app || detectApp(act)
      this.state = {
        slot: 'tv',
        activity: act,
        pose: POSES[act] ?? 'watch',
        since: Date.now(),
        until: Number.isFinite(mins) && mins > 0 ? Date.now() + mins * 60_000 : 0,
        owner,
        tv: true,
        app: platform ?? '',
        read: false,
        book: '',
      }
    } else {
      this.state = {
        slot: 'floor',
        activity: '发呆',
        pose: 'idle',
        since: Date.now(),
        until: 0,
        owner: '',
        tv: false,
        app: '',
        read: false,
        book: '',
      }
    }
    this.syncOverlay()
    // 开电视前如果她在看书，先让她合上书站起来（坐下/走位由 bridgeTv 接手）
    if (on && wasRead) {
      this.bridgeRead(false, '')
      this.syncReadRuntime(false)
    }
    // 状态没变就别重复喊话（重复开关不再发事件）
    if (on !== wasTv) this.bridgeTv(on, this.state.activity, this.state.app || undefined)
    // 看电视期间定期续期检查；关电视就停掉（重置心跳起点，避免刚开电视就被判超时）
    this.syncTvRuntime(on)
  }

  /** 电视开关时的联动：
   *  - 走过去：POST desktop-pet 原生 /api/move（它自带的 HTTP 接口，不改它）→ 确定性。
   *  - 姿态（坐/转/站）：原生没有 HTTP 接口，发事件让 LLM 调 pet_act / pet_face 补。 */
  private bridgeTv(on: boolean, activity: string, app?: string): void {
    // 每次联动都重新读电视位置：网页拖过之后也按最新位置走
    const tvX = this.tvX()
    // 桌宠目标位置 = 电视中心 + 偏移（0~1 比例，相对桌宠自己窗口）；默认 -0.09 贴电视左边
    const rawOffset = Number(this.opts.cfg.petOffset)
    const offset = Number.isFinite(rawOffset) ? rawOffset : -0.09
    // 电视整体缩放后，把贴边点往外/往内挪半个宽度差（petOffset 仍按基准宽度调，不变味），
    // 保证电视放大缩小后她始终贴在电视边外一个身位，不会站进电视机身里。
    const rawBaseWidth = Number(this.opts.cfg.petWidth)
    const basePetWidth = Number.isFinite(rawBaseWidth) && rawBaseWidth > 0 ? rawBaseWidth : 0.09
    const widthShift = (this.tvWidth() / 100 - basePetWidth) / 2
    let petX = Math.max(0, Math.min(1, tvX + offset - widthShift))
    // 镜像后屏幕朝右，把她关于电视中心左右翻转过去，仍贴在外侧一个身位
    if (this.tvFlip()) petX = Math.max(0, Math.min(1, 2 * tvX - petX))
    // 她在电视左边就朝右(1)，在右边朝左(-1)
    const facing = petX < tvX ? 1 : -1

    if (on) {
      // 用 desktop-pet 原生的 /api/move 确定性地让她走过去（她若正坐着，walk 会被忽略，交给下面 LLM 兜底）
      this.movePet(petX)
    }

    const host = this.host
    if (!host?.pushEvent) return

    const petPart = on
      ? `请让桌宠走到电视旁边：如果她还坐着没动，先 pet_act({ actions: ["stand"] }) 再 pet_move_to({ to: ${petX.toFixed(3)}, run: true })；等她到位后 pet_act({ actions: ["sit"] }) 坐下、pet_face({ facing: ${facing} }) 面朝电视。`
      : `请让桌宠 pet_act({ actions: ["stand"] }) 站起来（不用移动位置，也不用回中间）。`

    // 只给行为约束：装没装视频插件、要不要开，Agent 自己最清楚，
    // 这里不替它假设装了哪个，也不给「文字陪看」这种降级路径。
    const info = app ? this.videoApps()[app] : undefined
    const videoPart = on
      ? `另外，如果有能看视频的插件就把「${activity}」打开${info ? `（能播放 ${info.label} 的那个）` : ''}；不想开也要明确说出来（就是不开插件）。没有插件就让电视亮着，不要用文字陪她一起看。看一会儿就调 room_tv_tick 报一下续期；不看、看完了就调 room_tv(on=false) 关掉，超过 1 分钟没报会自己关电视。`
      : ''

    void host.pushEvent({
      type: 'room.tv',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      text: `她在房间${on ? '开' : '关'}了电视，正在「${activity}」。${petPart}${videoPart}`,
    }, { trigger: 'flush' })
  }

  /** 开始/停止看书。开始时她坐到书架；停止时只是站起来，不回中间。 */
  private setRead(on: boolean, book?: string, minutes?: number, owner = 'http'): void {
    const wasTv = this.state.tv
    const wasRead = this.state.read
    const bk = String(book ?? '').trim()
    const mins = Number(minutes)
    if (on) {
      this.state = {
        slot: 'read',
        activity: '看书',
        pose: 'read',
        since: Date.now(),
        until: Number.isFinite(mins) && mins > 0 ? Date.now() + mins * 60_000 : 0,
        owner,
        tv: false,
        app: '',
        read: true,
        book: bk,
      }
    } else {
      this.state = {
        slot: 'floor',
        activity: '发呆',
        pose: 'idle',
        since: Date.now(),
        until: 0,
        owner: '',
        tv: false,
        app: '',
        read: false,
        book: '',
      }
    }
    // 书只飞一次：开始看书那一下锁定她的当前位置，之后她走动不跟着变
    this.bookX = on ? this.petXGuess() : undefined
    // 主动再读一次桌宠当前记住的位置，能读到就校准书的目标（读不到保持兜底值）
    if (on) this.refreshBookTarget()
    this.syncOverlay()
    // 看书和看电视互斥：开始看书前先把电视收掉（她站起来不回中间）
    if (on && wasTv) {
      this.bridgeTv(false, '发呆')
      this.syncTvRuntime(false)
    }
    // 状态没变就别重复喊话
    if (on !== wasRead) this.bridgeRead(on, on ? bk : '')
    // 看书期间定期续期检查；合书就停掉（同时重置心跳起点，避免刚开书就被判超时）
    this.syncReadRuntime(on)
  }

  /** 看书开始/停止时的事件：只陈述事实 + 插件提示，不要求她走动或坐下。
   *  书由房间自己飞过去（sceneJson 的 book），room 从不碰别的插件的实现。 */
  private bridgeRead(on: boolean, book: string): void {
    const host = this.host
    if (!host?.pushEvent) return

    const text = on
      ? `她在房间看书${book ? `（读的是《${book}》）` : ''}。请真的打开这本书读：有能看小说/读书/听书的插件就用它打开，或联网（浏览器、网页）查到内容来读；每读一段就调 room_read_tick 报个进度续期，读不到或不想读就调 room_read(on=false) 合上书关掉，不要保持「看书」的假状态装样子。`
      : '她在房间合上书，不看了'

    void host.pushEvent({
      type: 'room.read',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      text,
    }, { trigger: 'flush' })
  }

  /** 看书期间定期问她「还在读吗」，给她一个持续判断「该不该继续」的时机。
   *  她据此决定：继续读 → room_read_tick 续期；不想读/读不到 → room_read(on=false) 合书。 */
  private startReadPing(): void {
    if (this.readPingTimer) return
    this.readPingTimer = setInterval(() => {
      if (!this.state.read) return
      const host = this.host
      if (!host?.pushEvent) return
      void host.pushEvent({
        type: 'room.read',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        text: `你还在读${this.state.book ? `《${this.state.book}》` : '书'}吗？还在读就调 room_read_tick 报个进度续期；不想读、读不到内容，就调 room_read(on=false) 合上书。`,
      }, { trigger: 'flush' })
    }, READ_TICK_TIMEOUT_MS)
    this.readPingTimer.unref?.()
  }

  private stopReadPing(): void {
    if (this.readPingTimer) { clearInterval(this.readPingTimer); this.readPingTimer = undefined }
  }

  /** 进入/离开看书状态时的运行时联动：重置心跳起点、启停续期检查。
   *  所有能把 state.read 置 true/false 的路径（工具、HTTP、面板）都要走这里，
   *  否则 lastReadTick 还是旧值，刚开书就会被超时判定直接合上。 */
  private syncReadRuntime(on: boolean): void {
    if (on) {
      this.lastReadTick = Date.now()
      this.startReadPing()
    } else {
      this.stopReadPing()
    }
  }

  /** 看电视期间定期问她「还在看吗」，给她一个持续判断「该不该继续」的时机。
   *  她据此决定：继续看 → room_tv_tick 续期；不想看/看完了 → room_tv(on=false) 关掉。 */
  private startTvPing(): void {
    if (this.tvPingTimer) return
    this.tvPingTimer = setInterval(() => {
      if (!this.state.tv) return
      const host = this.host
      if (!host?.pushEvent) return
      void host.pushEvent({
        type: 'room.tv',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        text: `你还在${this.state.activity || '看电视'}吗？还在看就调 room_tv_tick 报一下续期；不想看、看完了，就调 room_tv(on=false) 关掉电视。`,
      }, { trigger: 'flush' })
    }, TV_TICK_TIMEOUT_MS)
    this.tvPingTimer.unref?.()
  }

  private stopTvPing(): void {
    if (this.tvPingTimer) { clearInterval(this.tvPingTimer); this.tvPingTimer = undefined }
  }

  /** 进入/离开看电视状态时的运行时联动：重置心跳起点、启停续期检查。
   *  所有能把 state.tv 置 true/false 的路径（工具、HTTP、面板）都要走这里，
   *  否则 lastTvTick 还是旧值，刚开电视就会被超时判定直接关掉。 */
  private syncTvRuntime(on: boolean): void {
    if (on) {
      this.lastTvTick = Date.now()
      this.startTvPing()
    } else {
      this.stopTvPing()
    }
  }

  // ── 状态同步 ──────────────────────────────────────────────
  // 场景宿主通过 SSE 订阅状态；这里只在状态变化时推送一次。
  // 心跳由 overlayTimer 负责，否则状态长时间不变时宿主会因租约超时退出。
  private syncOverlay(): void {
    // 只在状态变化时推场景。不要在这里发 roam off：每 4 秒一次会把桌宠的走路打断
    this.broadcastScene()
  }

  // ── 桌面场景层进程 ────────────────────────────────────────
  // World 跑在 Core 的 Node 环境里，拿不到 BrowserWindow，所以桌面层只能是
  // 另一个 electron 进程。electron 本体放在 data/overlay-runtime/（所有 World 共用），
  // 场景宿主在 data/room/scene-host/，通过 SSE 订阅本 World 的场景流。
  private sceneHostDir(): string {
    return join(MODULE_DIR, '..', 'scene-host')
  }

  /** electron 可执行文件：配置 > 环境变量 > 宿主共享运行时 > 包内 node_modules > require('electron')。
   *  前三条覆盖「宿主提供」和「自己装」两种情况；都没有时桌面层不启动，网页与接口照常。 */
  private resolveElectron(): string {
    const custom = String(this.opts.cfg.overlayElectron ?? '').trim()
    if (custom) return existsSync(custom) ? custom : ''

    const fromEnv = String(process.env.CORTICO_ELECTRON ?? '').trim()
    if (fromEnv && existsSync(fromEnv)) return fromEnv

    const exe = process.platform === 'win32' ? 'electron.exe' : 'electron'
    // 宿主提供的共享运行时：从 dataDir 向上找，兼容 <data>/overlay-runtime 与更深的部署布局
    const shared = findSharedElectron(this.opts.dataDir, exe) || findSharedElectron(MODULE_DIR, exe, 8)
    if (shared) return shared
    // 开发者本地装了 electron
    const local = join(MODULE_DIR, '..', 'node_modules', 'electron', 'dist', exe)
    if (existsSync(local)) return local

    // 用户自己装了 electron：require('electron') 返回可执行文件路径（mac 也走这条）
    try {
      const resolved = createRequire(import.meta.url)('electron') as unknown
      if (typeof resolved === 'string' && existsSync(resolved)) return resolved
    } catch { /* 没装就是没装 */ }
    return ''
  }

  /** 电视铺在哪块屏：-1 主屏，0..n 按横向排序的显示器索引。 */
  private displayIndex(): number {
    const raw = Number(this.opts.cfg.displayIndex)
    return Number.isFinite(raw) ? Math.round(raw) : -1
  }

  private startOverlay(): void {
    if (!this.opts.cfg.overlayAuto) return
    const running = this.overlayProc
    if (running && running.exitCode === null && !running.killed) return

    const exe = this.resolveElectron()
    if (!exe) {
      this.host?.log.info?.('桌面层没启动：找不到 electron，可设 worlds.room.overlayElectron 指定路径')
      return
    }

    const mainJs = join(this.sceneHostDir(), 'main.js')
    if (!existsSync(mainJs)) {
      this.host?.log.error?.(`桌面层没启动：找不到场景宿主 ${mainJs}`)
      return
    }

    // 有的启动器会带 ELECTRON_RUN_AS_NODE=1，那样 electron 退化成纯 node，
    // require('electron') 拿到的是 exe 路径字符串而不是 app 对象，一上来就崩。
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    // 用环境变量传屏号：--display-index 会被 Chromium 当内部开关消费，实测会让进程秒崩
    env.SCENE_DISPLAY_INDEX = String(this.displayIndex())

    try {
      const proc = spawn(exe, [
        mainJs,
        '--scene-url', `http://127.0.0.1:${this.port}/api/scene/stream`,
      ], { stdio: 'ignore', windowsHide: true, env })

      proc.on('exit', (code) => {
        this.host?.log.info?.(`桌面层退出了（code ${code}）`)
        if (this.overlayProc === proc) this.overlayProc = undefined
        // 挂久了 scene-host 会因 SSE 断流租约到期、崩溃等原因自己退出，
        // 不重启的话电视就永远冻在原地拖不动。延迟拉起（World 停用时除外）。
        if (!this.stopping) {
          if (this.overlayRestartTimer) clearTimeout(this.overlayRestartTimer)
          this.overlayRestartTimer = setTimeout(() => {
            this.overlayRestartTimer = undefined
            if (!this.stopping) this.startOverlay()
          }, 2000)
          this.overlayRestartTimer.unref?.()
        }
      })
      proc.on('error', (err) => {
        this.host?.log.error?.(`桌面层启动失败：${err.message}`)
        if (this.overlayProc === proc) this.overlayProc = undefined
      })

      this.overlayProc = proc
      this.host?.log.info?.(`桌面层已启动（pid ${proc.pid}）`)
    } catch (err) {
      this.host?.log.error?.(`桌面层启动失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private stopOverlay(): void {
    const proc = this.overlayProc
    this.overlayProc = undefined
    if (!proc || proc.exitCode !== null || proc.killed) return
    try {
      proc.kill()
      this.host?.log.info?.('桌面层已关闭')
    } catch {
      /* 已经没了就算了 */
    }
  }

  // ── 场景流 ────────────────────────────────────────────────
  // 把当前房间状态序列化成桌面场景宿主能画的数据结构。
  // 目前只放电视；床/书桌/沙发还是白底图，等转成透明精灵再接进来。

  /** 家具横向位置：按能力表声明的配置键取值，越界夹回 0~1；没配就用排布表默认值。 */
  private furnX(f: FurnitureSpec): number {
    const raw = Number((this.opts.cfg as unknown as Record<string, unknown>)[f.keys.x])
    const def = OVERLAY_LAYOUT.find((o) => o.id === f.id)?.x ?? 0.5
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : def
  }

  /** 家具整体宽度（vw）：夹回 4~20。 */
  private furnWidth(f: FurnitureSpec): number {
    const raw = Number((this.opts.cfg as unknown as Record<string, unknown>)[f.keys.width])
    const def = OVERLAY_LAYOUT.find((o) => o.id === f.id)?.width ?? 8
    return Number.isFinite(raw) ? Math.max(4, Math.min(20, raw)) : def
  }

  /** 家具的隐藏 / 镜像开关。 */
  private furnFlag(f: FurnitureSpec, key: 'hidden' | 'flip'): boolean {
    return (this.opts.cfg as unknown as Record<string, unknown>)[f.keys[key]] === true
  }

  /** 家具此刻是不是「开着」：电视亮屏 / 书架灯亮。 */
  private furnOn(f: FurnitureSpec): boolean {
    if (f.id === 'tv') return this.state.tv
    if (f.id === 'read') return this.state.read
    return false
  }

  // 常用家具的取值快捷方式（bridgeTv / bridgeRead 等老代码用）
  private tvX(): number { return this.furnX(furnitureById('tv')) }
  private tvWidth(): number { return this.furnWidth(furnitureById('tv')) }
  private tvFlip(): boolean { return this.furnFlag(furnitureById('tv'), 'flip') }
  private readX(): number { return this.furnX(furnitureById('read')) }
  private readWidth(): number { return this.furnWidth(furnitureById('read')) }

  // ── 家具写操作（WebUI 面板 / HTTP 共用）───────────────────────
  /** 写横向位置：写配置 + 广播场景 + 让桌宠跟上。写配置失败不能挡住广播，否则会被心跳弹回原位。 */
  private applyFurnitureX(f: FurnitureSpec, x: unknown): number {
    const value = Number(x)
    if (!Number.isFinite(value)) throw new Error('bad x')
    const clamped = Math.max(0, Math.min(1, value))
    try { this.opts.persist?.({ [f.keys.x]: clamped } as Partial<RoomConfig>) } catch { /* 仅放弃持久化 */ }
    this.syncOverlay()
    this.followPet(f)
    return clamped
  }

  /** 写整体宽度（vw，4~20）：家具放大缩小后桌宠贴边要跟着重算。 */
  private applyFurnitureSize(f: FurnitureSpec, w: unknown): number {
    const value = Number(w)
    if (!Number.isFinite(value)) throw new Error('bad width')
    const clamped = Math.max(4, Math.min(20, value))
    try { this.opts.persist?.({ [f.keys.width]: clamped } as Partial<RoomConfig>) } catch { /* 同上 */ }
    this.syncOverlay()
    this.followPet(f)
    return clamped
  }

  /** 隐藏/显示：只是不画，不动开/关状态，也不动桌宠。 */
  private applyFurnitureHidden(f: FurnitureSpec, hidden: boolean): boolean {
    try { this.opts.persist?.({ [f.keys.hidden]: hidden } as Partial<RoomConfig>) } catch { /* 同上 */ }
    this.syncOverlay()
    return hidden
  }

  /** 朝向：只镜图；电视开着时按原逻辑重新贴到正确一侧，书架不动她。 */
  private applyFurnitureFlip(f: FurnitureSpec, flip: boolean): boolean {
    try { this.opts.persist?.({ [f.keys.flip]: flip } as Partial<RoomConfig>) } catch { /* 同上 */ }
    this.syncOverlay()
    if (f.id === 'tv') this.followPet(f)
    return flip
  }

  /** 家具动了之后让桌宠跟上：只有电视会让她换位置；
   *  书架不动她——书会自己飞到她那边（book.to 用 petXGuess()）。 */
  private followPet(f: FurnitureSpec): void {
    if (f.id === 'tv' && this.state.tv) this.bridgeTv(true, this.state.activity, this.state.app || undefined)
  }

  /** 书架坐点：家具左边一个身位，家具缩放后按半宽差补偿。 */
  private readPetX(): number {
    const readX = this.readX()
    const rawOffset = Number(this.opts.cfg.petOffset)
    const offset = Number.isFinite(rawOffset) ? rawOffset : -0.09
    // 基准宽度取排布表里书架的默认宽度，别再写死 0.08
    const baseReadWidth = (OVERLAY_LAYOUT.find((o) => o.id === 'read')?.width ?? 8) / 100
    const widthShift = (this.readWidth() / 100 - baseReadWidth) / 2
    return Math.max(0, Math.min(1, readX + offset - widthShift))
  }

  /** 只让桌宠走过去：桌宠原生 POST /api/move（确定性，不喊 AI）。 */
  private movePet(petX: number): void {
    const target = Math.max(0, Math.min(1, petX))
    this.lastPetX = target
    const petBase = `http://127.0.0.1:${this.opts.cfg.petPort || 7797}`
    postJson(`${petBase}/api/move`, { to: target, run: true })
  }

  /** 她此刻大概在哪：room 记的最后位置；不知道就退回书架旁边。
   *  桌宠只暴露 /api/state（配置）和 POST /api/move，没有实时坐标，所以只能这样估。 */
  private petXGuess(): number {
    return this.lastPetX !== undefined ? this.lastPetX : this.readPetX()
  }

  /** 读一次桌宠记住的位置（startX）。它没有实时坐标接口，但这个值会随她移动更新；
   *  变了就推场景，书跟着她挪（每 2 秒轮一次）。 */
  private probePetX(): void {
    const url = `http://127.0.0.1:${this.opts.cfg.petPort || 7797}/api/state`
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try {
          const j = JSON.parse(data) as { startX?: number }
          const x = Number(j.startX)
          if (!Number.isFinite(x) || x < 0 || x > 1) return
          const changed = this.lastPetX === undefined || Math.abs(x - this.lastPetX) > 0.002
          if (!changed) return
          this.lastPetX = x
          this.syncOverlay()
        } catch { /* 忽略 */ }
      })
    })
    req.on('error', () => { /* 桌宠没起就算了 */ })
    req.end()
  }

  /** 开书时主动读一次桌宠记住的位置（startX），让书第一次就飞到贴近她的地方。
   *  桌宠没有实时坐标，startX 是最接近可得的值；读不到就保持 bookX 的兜底值不变。 */
  private refreshBookTarget(): void {
    const url = `http://127.0.0.1:${this.opts.cfg.petPort || 7797}/api/state`
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try {
          const j = JSON.parse(data) as { startX?: number }
          const x = Number(j.startX)
          if (!Number.isFinite(x) || x < 0 || x > 1) return
          this.lastPetX = x
          this.bookX = x
          this.syncOverlay()
        } catch { /* 忽略 */ }
      })
    })
    req.on('error', () => { /* 桌宠没起就算了 */ })
    req.end()
  }

  /** 视频平台映射：配置里的 JSON 优先，否则用内置默认；换插件不用改代码。 */
  private videoApps(): Record<string, { label: string; hint: string }> {
    const raw = String(this.opts.cfg.videoApps ?? '').trim()
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, { label?: string; hint?: string }>
        const out: Record<string, { label: string; hint: string }> = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v === 'object') out[k] = { label: String(v.label ?? k), hint: String(v.hint ?? '') }
        }
        if (Object.keys(out).length) return out
      } catch { /* 解析失败就用默认 */ }
    }
    return VIDEO_APPS
  }

  private sceneJson() {
    // pathToFileURL：Windows 之外拼 'file:///' + 路径 会多出斜杠，跨平台不可靠
    const img = (name: string) => pathToFileURL(join(MODULE_DIR, 'img', name)).href
    // 家具全部按能力表派生：加新家具不用改这里
    const sprites: Record<string, string> = {}
    const objects = FURNITURE.map((f) => {
      sprites[`${f.id}-off`] = img(f.sprites.off)
      sprites[`${f.id}-on`] = img(f.sprites.on)
      return {
        id: f.id,
        sprite: `${f.id}-${this.furnOn(f) ? 'on' : 'off'}`,
        x: this.furnX(f),
        bottom: 0,
        width: this.furnWidth(f),
        layer: f.layer,
        hidden: this.furnFlag(f, 'hidden'),
        flip: this.furnFlag(f, 'flip'),
      }
    })
    // 书：桌面层做「从书架飞出、摊在她面前」的动画用
    sprites['book-off'] = img(BOOK_CLOSED_IMAGE)
    sprites['book-on'] = img(BOOK_OPEN_IMAGE)
    const book = {
      on: this.state.read,
      /** 书架位置（飞的起点） */
      from: this.readX(),
      /** 她看书时书停在哪：开始看书时锁定的位置（bookX），拿不到才退回书架旁 */
      to: this.bookX ?? this.petXGuess(),
      /** 书宽（vw）：约桌宠身高的 2/3，视觉上像捧在手里 */
      width: 6,
    }
    return { updatedAt: Date.now(), sprites, objects, book }
  }

  private pushScene(res: ServerResponse): void {
    const data = JSON.stringify(this.sceneJson())
    try { res.write(`data: ${data}\n\n`) } catch { /* 连接已断 */ }
  }

  private broadcastScene(): void {
    for (const res of this.sseClients) this.pushScene(res)
  }

  private slotLabel(id: Slot): string {
    return SLOTS.find((s) => s.id === id)?.label ?? id
  }

  // ── HTTP ──────────────────────────────────────────────────
  private async listen(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => this.route(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, '127.0.0.1', () => resolve())
    })
    this.server = server
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    const path = url.pathname

    // 页面
    if (path === '/room' || path === '/room/' || path === '/') {
      return this.send(res, 200, 'text/html; charset=utf-8', this.renderHtml())
    }

    // 状态（前端轮询）
    if (path === '/api/state') {
      return this.send(res, 200, 'application/json', JSON.stringify(this.stateJson()))
    }

    // 场景流（SSE）：桌面场景宿主订阅这个端点，替代文件轮询
    if (path === '/api/scene/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      res.write('retry: 3000\n\n')
      this.sseClients.add(res)
      this.pushScene(res)
      req.on('close', () => { this.sseClients.delete(res) })
      return
    }

    // ── 电视开关：给别的 World / 外部脚本对接 ──
    //   GET  /api/tv                 查电视状态
    //   POST /api/tv        {on,activity,minutes,source,app}
    //   POST /api/tv/on     {activity,minutes,source,app}
    //   POST /api/tv/off
    //   app 对接市场视频插件：bilibili(看B站) / douyin(看抖音)；不填表示普通看电视
    if (path === '/api/tv' || path === '/api/tv/on' || path === '/api/tv/off') {
      if (req.method === 'GET') {
        return this.send(res, 200, 'application/json', JSON.stringify({
          tv: this.state.tv,
          slot: this.state.slot,
          activity: this.state.activity,
          app: this.state.app || '',
          since: this.state.since,
          until: this.state.until,
        }))
      }
      if (req.method !== 'POST') {
        return this.send(res, 405, 'application/json', '{"error":"method not allowed"}')
      }
      const forced = path.endsWith('/on') ? true : path.endsWith('/off') ? false : undefined
      let tvBody = ''
      req.on('data', (c) => { tvBody += c })
      req.on('end', () => {
        try {
          const j = tvBody.trim() ? JSON.parse(tvBody) : {}
          const on = forced !== undefined ? forced : j.on === true || j.on === 'true'
          this.setTv(on, j.activity, Number(j.minutes), String(j.source ?? 'http'), String(j.app ?? ''))
          this.send(res, 200, 'application/json', JSON.stringify({
            ok: true,
            tv: this.state.tv,
            slot: this.state.slot,
            activity: this.state.activity,
          }))
        } catch {
          this.send(res, 400, 'application/json', '{"error":"bad json"}')
        }
      })
      return
    }

    // ── 书架（看书）：给别的 World / 外部脚本对接，链路同电视 ──
    //   GET  /api/read                 查看书状态
    //   POST /api/read        {on,book,minutes,source}
    //   POST /api/read/on     {book,minutes,source}
    //   POST /api/read/off
    if (path === '/api/read' || path === '/api/read/on' || path === '/api/read/off') {
      if (req.method === 'GET') {
        return this.send(res, 200, 'application/json', JSON.stringify({
          read: this.state.read,
          slot: this.state.slot,
          book: this.state.book,
          since: this.state.since,
          until: this.state.until,
        }))
      }
      if (req.method !== 'POST') {
        return this.send(res, 405, 'application/json', '{"error":"method not allowed"}')
      }
      const forced = path.endsWith('/on') ? true : path.endsWith('/off') ? false : undefined
      let readBody = ''
      req.on('data', (c) => { readBody += c })
      req.on('end', () => {
        try {
          const j = readBody.trim() ? JSON.parse(readBody) : {}
          const on = forced !== undefined ? forced : j.on === true || j.on === 'true'
          this.setRead(on, String(j.book ?? ''), Number(j.minutes), String(j.source ?? 'http'))
          this.send(res, 200, 'application/json', JSON.stringify({
            ok: true,
            read: this.state.read,
            slot: this.state.slot,
            book: this.state.book,
          }))
        } catch {
          this.send(res, 400, 'application/json', '{"error":"bad json"}')
        }
      })
      return
    }

    // 家具位置通用接口：POST { id, x }（面板以外的地方用；旧的 /api/tv/position 保留）
    if (path === '/api/furniture/position') {
      if (req.method !== 'POST') return this.send(res, 405, 'application/json', '{"error":"method not allowed"}')
      let posBody = ''
      req.on('data', (c) => { posBody += c })
      req.on('end', () => {
        try {
          const j = JSON.parse(posBody || '{}')
          const spec = furnitureById(j.id)
          const x = this.applyFurnitureX(spec, j.x)
          this.send(res, 200, 'application/json', JSON.stringify({ ok: true, id: spec.id, x }))
        } catch (err) {
          this.send(res, 400, 'application/json', JSON.stringify({ error: err instanceof Error ? err.message : 'bad request' }))
        }
      })
      return
    }

    // 电视位置：网页拖动时 POST { x }，写回配置并刷新场景
    if (path === '/api/tv/position') {
      if (req.method === 'GET') return this.send(res, 200, 'application/json', JSON.stringify({ x: this.tvX() }))
      if (req.method !== 'POST') return this.send(res, 405, 'application/json', '{"error":"method not allowed"}')
      let posBody = ''
      req.on('data', (c) => { posBody += c })
      req.on('end', () => {
        try {
          const j = JSON.parse(posBody || '{}')
          const x = Number(j.x)
          if (!Number.isFinite(x)) return this.send(res, 400, 'application/json', '{"error":"bad x"}')
          const clamped = Math.max(0, Math.min(1, x))
          // persist 写失败也照常广播新位置，避免 4 秒后心跳把电视弹回原位
          try { this.opts.persist?.({ tvX: clamped }) } catch { /* 配置写失败仅放弃持久化 */ }
          this.syncOverlay()
          // 电视开着时拖动位置：让她跟着走到新位置
          if (this.state.tv) this.bridgeTv(true, this.state.activity, this.state.app || undefined)
          this.send(res, 200, 'application/json', JSON.stringify({ ok: true, x: clamped }))
        } catch {
          this.send(res, 400, 'application/json', '{"error":"bad json"}')
        }
      })
      return
    }

    // 电视换屏：GET 查当前；POST { index } 指定（-1 主屏）；POST /api/tv/display/next 切到下一块
    if (path === '/api/tv/display' || path === '/api/tv/display/next') {
      if (path === '/api/tv/display' && req.method === 'GET') {
        return this.send(res, 200, 'application/json', JSON.stringify({ index: this.displayIndex() }))
      }
      if (req.method !== 'POST') return this.send(res, 405, 'application/json', '{"error":"method not allowed"}')
      let dispBody = ''
      req.on('data', (c) => { dispBody += c })
      req.on('end', () => {
        try {
          const j = dispBody.trim() ? JSON.parse(dispBody) : {}
          // scene-host 换屏时会顺带把显示器数量报上来，用来 clamp 换屏上限，避免越界
          if (typeof j.count === 'number' && Number.isFinite(j.count) && j.count > 0) {
            this.maxDisplay = Math.round(j.count) - 1
          }
          const want = path.endsWith('/next') ? this.displayIndex() + 1 : Number(j.index)
          let idx = Number.isFinite(want) ? Math.max(-1, Math.round(want)) : -1
          if (this.maxDisplay >= 0) idx = Math.max(-1, Math.min(this.maxDisplay, idx))
          this.opts.persist?.({ displayIndex: idx })
          // 不重启桌面层：scene-host 会轮询 /api/tv/display 自己 setBounds 换屏，避免单例锁崩溃
          this.send(res, 200, 'application/json', JSON.stringify({ ok: true, index: idx }))
        } catch {
          this.send(res, 400, 'application/json', '{"error":"bad json"}')
        }
      })
      return
    }

    // 前端也能改：别人（比如另一个 World 的网页）可以直接推送
    if (path === '/api/occupy' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}')
          const slot = String(j.slot ?? '') as Slot
          const def = SLOTS.find((s) => s.id === slot)
          if (!def) return this.send(res, 400, 'application/json', '{"error":"bad slot"}')
          const activity = String(j.activity ?? '发呆')
          const minutes = Number(j.minutes)
          const wasRead = this.state.read
          const wasTv = this.state.tv
          this.state = {
            slot,
            activity,
            pose: POSES[activity] ?? 'idle',
            since: Date.now(),
            until: Number.isFinite(minutes) && minutes > 0 ? Date.now() + minutes * 60_000 : 0,
            owner: String(j.owner ?? 'http'),
            // 推到电视前就等于开电视，推到书架就开始看书
            tv: slot === 'tv',
            app: slot === 'tv' ? (detectApp(activity) ?? '') : '',
            read: slot === 'read',
            book: '',
          }
          this.syncOverlay()
          if (slot === 'tv') {
            if (wasRead) this.bridgeRead(false, '')
            this.bridgeTv(true, activity, detectApp(activity))
          } else if (slot === 'read') {
            if (wasTv) this.bridgeTv(false, '发呆')
            this.bridgeRead(true, '')
          } else if (wasRead) {
            this.bridgeRead(false, '')
          }
          // 心跳/续期检查跟着看书、看电视状态走，避免刚推过去就被超时判定收掉
          this.syncReadRuntime(slot === 'read')
          this.syncTvRuntime(slot === 'tv')
          this.send(res, 200, 'application/json', JSON.stringify({ ok: true, state: this.state }))
        } catch {
          this.send(res, 400, 'application/json', '{"error":"bad json"}')
        }
      })
      return
    }

    // 包内图片素材（家具图等，原图直接用，不做任何处理）
    if (path.startsWith('/bg/')) {
      const name = decodeURIComponent(path.slice(4))
      if (!/^[a-z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(name)) return this.send(res, 404, 'text/plain', 'bad')
      const file = join(MODULE_DIR, 'img', name)
      if (!existsSync(file)) return this.send(res, 404, 'text/plain', 'not found')
      const low = name.toLowerCase()
      const mime = low.endsWith('.png') ? 'image/png' : low.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
      return this.send(res, 200, mime, readFileSync(file))
    }

    // 立绘素材：只放行 artDir 内部的图片，挡掉 ../ 与绝对路径
    if (path.startsWith('/art/')) {
      const dir = String(this.opts.cfg.artDir ?? '').trim()
      if (!dir) return this.send(res, 404, 'text/plain', 'not found')
      const name = decodeURIComponent(path.slice(5))
      const root = resolve(dir)
      const file = resolve(root, name)
      if (!file.startsWith(root + sep) || !/\.(png|jpe?g|webp)$/i.test(file)) {
        return this.send(res, 404, 'text/plain', 'not found')
      }
      if (!existsSync(file)) return this.send(res, 404, 'text/plain', 'not found')
      const lower = file.toLowerCase()
      const mime = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
      return this.send(res, 200, mime, readFileSync(file))
    }

    this.send(res, 404, 'text/plain', 'not found')
  }

  private stateJson() {
    return {
      ...this.state,
      // 家具统一列表：面板照着 caps 渲染控件，加新家具不用改面板
      furniture: FURNITURE.map((f) => ({
        id: f.id,
        label: f.label,
        caps: f.caps,
        powerLabels: f.powerLabels ?? null,
        status: f.status ?? null,
        x: this.furnX(f),
        width: this.furnWidth(f),
        hidden: this.furnFlag(f, 'hidden'),
        flip: this.furnFlag(f, 'flip'),
        on: this.furnOn(f),
      })),
      tvX: this.tvX(),
      tvWidth: this.tvWidth(),
      readX: this.readX(),
      readWidth: this.readWidth(),
      tvHidden: this.furnFlag(furnitureById('tv'), 'hidden'),
      tvFlip: this.tvFlip(),
      readHidden: this.furnFlag(furnitureById('read'), 'hidden'),
      readFlip: this.furnFlag(furnitureById('read'), 'flip'),
      displayIndex: this.displayIndex(),
      theme: this.opts.cfg.theme,
      idleSwitchSec: this.opts.cfg.idleSwitchSec,
      slots: SLOTS.map((s) => ({ ...s, furniture: SLOT_FURNITURE[s.id] ?? '' })),
    }
  }

  private send(res: ServerResponse, code: number, type: string, body: string | Buffer): void {
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      // 允许 Coopanion 的 WebUI（不同端口）加载房间图片素材
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    })
    res.end(body)
  }

  // ── 页面 ──────────────────────────────────────────────────
  private renderHtml(): string {
    const css = readFileSync(join(MODULE_DIR, 'room.css'), 'utf8')
    const js = readFileSync(join(MODULE_DIR, 'room.js'), 'utf8')
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>她的小房间</title>
<style>${css}</style>
</head>
<body>
<div id="stage">
  <img id="read" src="/bg/furn-read-off.png" alt="书架">
  <img id="tv" src="/bg/furn-tv-off.png" alt="电视">
</div>
<div class="hud" id="hud"><b>房间中间</b> · 发呆</div>
<div class="hint">按住电视拖动 · 松手自动保存<br>双击全屏</div>
<button class="screen-btn" id="screenBtn" type="button">主屏</button>
<script>${js}</script>
</body>
</html>`
  }
}

export const ROOM: WorldDefinition<RoomConfig> = {
  id: 'room',
  label: '小房间',
  defaults: () => ({ ...ROOM_DEFAULTS }),
  create: (ctx) => new RoomWorld({ cfg: ctx.cfg, dataDir: ctx.dataDir, timezone: ctx.timezone, persist: (p) => ctx.persist(p) }),
  describe: {
    tools: describeTools(ROOM_TOOL_DECLS, TOOL_SUMMARIES),
    events: ROOM_EVENTS,
  },
}

export default ROOM
