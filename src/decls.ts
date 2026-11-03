/**
 * 工具与事件的静态声明。
 *
 * 与 world.ts 分开是为了让 tools/make-describe.mjs 能脱离框架单独 import 它生成
 * describe.json：这里只有数据，没有任何运行时依赖（`cortico/core/types.ts` 是纯类型
 * 引用，运行时会被擦除）。
 */
import type { EventDescribe, ToolSpec } from 'cortico/core/types.ts'

export const ROOM_TOOL_DECLS: ToolSpec[] = [
  {
    name: 'room_occupy',
    description:
      '告诉她去房间里某个位置做某件事。座位：desk(书桌) / sofa(沙发) / window(窗边) / bed(床) / floor(房间中间) / tv(电视前) / read(书架)。'
      + '她会自己走过去（desk/sofa/window/bed/floor 走位确定，姿势由她自己决定）。'
      + '去 tv 会自动把电视打开，去 read 会开始看书。做完了用 room_release 让她回中间发呆。',
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'string', enum: ['desk', 'sofa', 'window', 'bed', 'floor', 'tv', 'read'], description: '去哪' },
        activity: { type: 'string', description: '在那做什么，例：画图、看书、看视频、听课、发呆' },
        minutes: { type: 'number', description: '大概要多久（分钟），到点自动回中间发呆（可选）' },
      },
      required: ['slot', 'activity'],
      additionalProperties: false,
    },
    tags: ['act'],
  },
  {
    name: 'room_tv',
    description: '开/关房间里的电视。开的时候她会坐到电视前看；关掉她就回中间发呆。',
    parameters: {
      type: 'object',
      properties: {
        on: { type: 'boolean', description: 'true 打开，false 关掉' },
        activity: { type: 'string', description: '打开时在做什么，默认"看视频"（可选）' },
        minutes: { type: 'number', description: '看多久（分钟），到点自动关掉（可选）' },
        app: { type: 'string', enum: ['bilibili', 'douyin'], description: '对接的市场视频插件：bilibili(看B站) / douyin(看抖音)，不填表示普通看电视（可选）' },
      },
      required: ['on'],
      additionalProperties: false,
    },
    tags: ['act', 'x-hot'],
  },
  {
    name: 'room_tv_tick',
    description:
      '看电视时的心跳：她每看一会儿/每次还在继续看，就报一下当前在看什么。'
      + 'room 据此判定她是否还在看；超过 1 分钟没报就会自动关电视。',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '正在看的内容（可选）' },
      },
      additionalProperties: false,
    },
    tags: ['act'],
  },
  {
    name: 'room_read',
    description: '让她在书架看书（书会自己飞到她面前，她不用走动）。看完了用 room_read(on=false) 合上书。',
    parameters: {
      type: 'object',
      properties: {
        on: { type: 'boolean', description: 'true 开始看书，false 合上书' },
        book: { type: 'string', description: '看的书名/内容（可选）' },
        minutes: { type: 'number', description: '大概看多久（分钟），到点自动合上书（可选）' },
      },
      required: ['on'],
      additionalProperties: false,
    },
    tags: ['act', 'x-hot'],
  },
  {
    name: 'room_read_tick',
    description:
      '看书时的心跳：她每读一段/每次还在继续读，就报一次读到的内容或进度。'
      + 'room 据此判定她是否还在真读；超过 1 分钟没报就会自动合书。',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '读到的内容摘要或进度（可选）' },
      },
      additionalProperties: false,
    },
    tags: ['act'],
  },
  {
    name: 'room_release',
    description: '让她把手头的事放下，回房间中间发呆。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    tags: ['act'],
  },
  {
    name: 'room_state',
    description: '看看她现在在房间里做什么。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    tags: ['read'],
  },
]

/** 按名字取工具声明：不依赖数组下标顺序，避免插入新工具时 name/handler 错位。 */
export function toolDecl(name: string): ToolSpec {
  const found = ROOM_TOOL_DECLS.find((d) => d.name === name)
  if (!found) throw new Error(`missing tool decl: ${name}`)
  return found
}

export const TOOL_SUMMARIES = {
  room_occupy: '让她去房间某个位置做某件事。',
  room_tv: '开/关房间里的电视。',
  room_tv_tick: '看电视心跳：报一下正在看什么，续期避免电视被自动关掉。',
  room_read: '让她在书架看书/合上书。',
  room_read_tick: '看书心跳：报一次读到的内容/进度，续期避免自动合书。',
  room_release: '让她回中间发呆。',
  room_state: '看她在房间做什么。',
}

/** 本 World 会推出的事件，与 ROOM.describe.events 一一对应。 */
export const ROOM_EVENTS: EventDescribe[] = [
  { type: 'room.tv', description: '她在房间看电视；带视频平台时请调用可用的视频插件播放。', trigger: 'flush' },
  { type: 'room.read', description: '她在房间看书；有读书/听书插件时请打开对应书籍。', trigger: 'flush' },
  { type: 'room.move', description: '她正走去房间里的某个位置（书桌/沙发/窗边/床/中间），走位已确定，请补上坐下/站着的动作。', trigger: 'flush' },
]
