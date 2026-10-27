// project.mjs — 项目里的 .doc-drift/：配置（提交）、映射（提交）、答复（提交）、状态（不提交）
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

export const DIR = '.doc-drift'

/** 从 cwd 往上找带 .doc-drift/config.json 的目录；找不到返回 null（钩子据此跳过没初始化的项目） */
export function findRoot(cwd = process.cwd()) {
  let d = resolve(cwd)
  for (;;) {
    if (existsSync(join(d, DIR, 'config.json'))) return d
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

const p = (root, ...xs) => join(root, DIR, ...xs)
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return fallback } }
const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2) + '\n') }

export const loadConfig = (root) => readJson(p(root, 'config.json'), null)
export const saveConfig = (root, c) => writeJson(p(root, 'config.json'), c)
export const loadMap = (root) => readJson(p(root, 'map.json'), { docs: [] })
export const saveMap = (root, m) => writeJson(p(root, 'map.json'), m)

/** 状态（.gitignore 掉）：待办、每个文件的 diff 哈希、冷却 */
export const loadState = (root) => readJson(p(root, 'state', 'state.json'), { pending: [], diffHashes: {}, lastRemindTurn: 0, turn: 0, seq: 0 })
export const saveState = (root, s) => writeJson(p(root, 'state', 'state.json'), s)

export function log(root, row) {
  try {
    mkdirSync(p(root, 'state'), { recursive: true })
    appendFileSync(p(root, 'state', 'decisions.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n')
  } catch {}
}

/** 你回答过的问题：人能读、能改的 Markdown；agent 下次先读这里再问 */
export function appendAnswer(root, question, answer) {
  const f = p(root, 'answers.md')
  if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, '# doc-drift 答复记录\n\n以下是你确认过的结论。doc-drift 和 agent 在提问前先查这里，不重复问。\n') }
  appendFileSync(f, `\n- **${question.replace(/\n/g, ' ')}**\n  ${answer.replace(/\n/g, '\n  ')}（${new Date().toISOString().slice(0, 10)}）\n`)
}
export const readAnswers = (root) => { try { return readFileSync(p(root, 'answers.md'), 'utf8') } catch { return '' } }

export function ensureGitignore(root) {
  const f = p(root, '.gitignore')
  if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, 'state/\n') }
}

/** 文档的状态：配置里逐篇或按目录设置；越具体的规则优先 */
export function docStatus(config, path) {
  const rules = Object.entries(config?.docStatus ?? {}).filter(([k]) => path === k || path.startsWith(k.replace(/\/+$/, '') + '/'))
  rules.sort((a, b) => b[0].length - a[0].length)
  return rules[0]?.[1] ?? null
}
export const docMeta = (config, path) => config?.docInfo?.[path] ?? null
