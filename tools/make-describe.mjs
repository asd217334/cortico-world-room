/**
 * 从 src/decls.ts 生成 describe.json —— 扩展市场、索引仓 Action 与详情页都只读这个文件，
 * 不执行扩展代码。
 *
 * 不引入构建链的原因：decls.ts 里只有 4 处 TS 语法（一个 import type 和三个类型标注），
 * 去掉之后就是合法 JS，所以这里不需要 tsx / tsc。
 *
 * 用法：node tools/make-describe.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const source = readFileSync(join(root, 'src', 'decls.ts'), 'utf8')
  .replace(/^import type .*$/m, '')
  .replace(/export const (\w+): [A-Za-z]+\[\] =/g, 'export const $1 =')
  .replace(/export function toolDecl\(name: string\): ToolSpec \{/, 'export function toolDecl(name) {')

const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const file = {
  tools: mod.ROOM_TOOL_DECLS.map(({ name, description, parameters, tags }) => ({
    name,
    description,
    parameters,
    tags,
    summary: mod.TOOL_SUMMARIES[name],
  })),
  events: mod.ROOM_EVENTS,
  prompts: [
    {
      key: 'worlds.room.behavior',
      title: '小房间 · 行为',
      role: 'envPrompt',
      content: readFileSync(join(root, 'src', 'prompts', 'behavior.md'), 'utf8'),
    },
  ],
}

writeFileSync(join(root, 'describe.json'), JSON.stringify(file, null, 2) + '\n')
console.log(`describe.json: ${file.tools.length} tools / ${file.events.length} events / ${file.prompts.length} prompt`)
