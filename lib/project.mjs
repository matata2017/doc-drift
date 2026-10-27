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

/**
 * 代码待改清单：用户确认"以文档为准、代码有问题"的条目。doc-drift 不改代码，只记下来交给用户的改代码流程。
 * 人能读的 Markdown，建议提交到 git。
 */
export function appendCodeTodo(root, findings, note = '') {
  const f = p(root, 'code-todo.md')
  if (!existsSync(f)) {
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, '# 代码待改（文档为准）\n\n以下是用户确认"文档是对的、代码需要改"的地方。doc-drift 不改代码，请按你们自己的改代码流程处理；改完后重跑 `doc-drift doctor`，对应条目会自动消失。\n')
  }
  const day = new Date().toISOString().slice(0, 10)
  const sig = (x) => `${x.kind}|${x.doc ?? ''}|${x.anchor?.value ?? ''}`
  const rows = findings.map((x) => `\n- [ ] **${x.doc ?? '（无文档）'}${x.line ? ':' + x.line : ''}** ${x.detail} <!-- sig: ${sig(x)} -->${note ? `\n  - 用户说明：${note}` : ''}${x.text ? `\n  - 文档原文：${x.text.replace(/\n/g, ' ').slice(0, 200)}` : ''}${x.files?.length ? `\n  - 相关代码：${x.files.slice(0, 5).join('、')}` : ''}\n  - 记录于 ${day}`)
  appendFileSync(f, rows.join(''))
}

/**
 * 对齐：重跑体检后，代码待改清单里"那处不一致已经不在了"的条目自动打勾（用户的代码改好了），
 * 从配置的 codeTodo 里移除；返回 { closed, open }
 */
export function syncCodeTodo(root, config, currentSignatures, consider = () => true) {
  const f = p(root, 'code-todo.md')
  if (!existsSync(f)) return { closed: [], open: [] }
  const now = new Date().toISOString().slice(0, 10)
  const closed = [], open = []
  const text = readFileSync(f, 'utf8').replace(/^- \[ \] (.*?)<!-- sig: (.+?) -->/gm, (line, body, sig) => {
    if (currentSignatures.has(sig) || !consider(sig.split('|')[1])) { open.push(sig); return line }   // 不在本次检查范围的不动
    closed.push(sig)
    return `- [x] ${body}<!-- sig: ${sig} -->（${now} 重跑体检已对齐）`
  })
  if (closed.length) {
    writeFileSync(f, text)
    config.codeTodo = (config.codeTodo ?? []).filter((s) => !closed.includes(s))
  }
  return { closed, open }
}
