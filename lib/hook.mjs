/**
 * hook.mjs — 日常钩子。原则：不阻断、不改文件、失败不出声、对话里最多一行。
 *   你发消息时：这句话有没有新需求/改需求（StartLux）→ 记待办；有待办且过了冷却 → 注入一行提醒（remind 模式）
 *   一轮结束时：后台看 git diff → 改到的代码 → 耦合的文档小节（这次没一起改的）→ StartLux 判"是否被弄过时"→ 记待办
 */
import { spawn } from 'node:child_process'
import { readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as P from './project.mjs'
import * as D from './decide.mjs'
import * as G from './git.mjs'
import { reverseMap } from './init.mjs'
import { CODE_EXT } from './scan.mjs'

const CLI = fileURLToPath(new URL('../bin/doc-drift.mjs', import.meta.url))
export const REMIND_EVERY = 3                         // 两次提醒至少隔 3 轮
const REQ_SURE = 0.85, DOC_SURE = 0.5

// ---------------------------------------------------------------- 待办
export function addPending(state, item) {
  const key = item.key
  if (state.pending.some((p) => p.key === key && !p.resolved)) return false
  state.seq = (state.seq ?? 0) + 1
  state.pending.push({ id: `P${state.seq}`, at: new Date().toISOString(), reminded: false, resolved: null, ...item })
  return true
}
export const openPending = (state) => state.pending.filter((p) => !p.resolved)

export function reminderLine(items) {
  const parts = items.slice(0, 2).map((p) => p.type === 'requirement'
    ? `需求变更「${p.prompt.slice(0, 30)}」待记入 ${p.doc ?? '需求文档'}`
    : p.type === 'stale' ? `${p.doc}「${p.section}」（${p.files.slice(0, 2).map((f) => f.split('/').pop()).join('、')} 已改）`
    : `${p.file?.split('/').pop()} 新增接口，还没有文档`)
  return `[文档漂移 · doc-drift] 待同步 ${items.length} 项：${parts.join('；')}${items.length > 2 ? ' 等' : ''}。完成当前请求后，问用户要不要现在处理（doc-drift pending）。`
}

// ---------------------------------------------------------------- 需求变更识别
function grams(s) {
  const t = String(s).toLowerCase(), out = new Set(t.match(/[a-z0-9_]{3,}/g) ?? [])
  for (const seg of t.replace(/[^一-鿿]+/g, ' ').split(' ')) for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2))
  return out
}
function requirementDocs(config, prompt, max = D.MAX_OPTIONS) {
  const q = grams(prompt)
  return Object.entries(config.docInfo ?? {})
    .filter(([path, v]) => v.type === 'requirements' && (P.docStatus(config, path) ?? v.status) !== 'archived')
    .map(([path, v]) => { const g = grams(path + ' ' + (v.title ?? '')); let n = 0; for (const x of q) if (g.has(x)) n++; return { path, title: v.title ?? '', score: n } })
    .filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, max)
}

export async function onPrompt(root, prompt, { timeoutMs = 6000 } = {}) {
  const config = P.loadConfig(root)
  const state = P.loadState(root)
  state.turn = (state.turn ?? 0) + 1
  const text = String(prompt ?? '').trim()
  const row = { event: 'prompt', turn: state.turn }
  if (text.length >= 6 && D.apiKey()) {
    const cands = requirementDocs(config, text)
    try {
      const a = await D.ask(`【消息】${text.slice(0, 600)}`, D.requirementQuestions(cands), { timeoutMs, retries: 1 })
      const r = D.pick(a.req, D.REQ, REQ_SURE)
      row.req = { key: r.key, guess: r.guess, p: +r.p.toFixed(2) }
      if (r.key === 'new' || r.key === 'changed') {
        let doc = null
        if (a.doc) {
          const probs = a.doc.probabilities ?? {}
          const best = Object.entries(probs).sort((x, y) => y[1] - x[1])[0]
          const m = best && /^D(\d+)｜/.exec(best[0])
          if (m && best[1] >= DOC_SURE) doc = cands[Number(m[1]) - 1]?.path ?? null
        }
        const added = addPending(state, { type: 'requirement', key: `req|${D.redact(text).slice(0, 80)}`, kind: r.key, prompt: D.redact(text).slice(0, 200), doc })
        row.pending = added
      }
    } catch (e) { row.error = e.name === 'AbortError' ? 'timeout' : e.message }
  }
  // 提醒：只在 remind 模式；同一条只提醒一次；两次提醒至少隔几轮
  let context = ''
  const mode = config.hook?.mode ?? 'observe'
  const fresh = openPending(state).filter((p) => !p.reminded && !p.snoozed)
  if (mode === 'remind' && fresh.length && state.turn - (state.lastRemindTurn ?? 0) >= REMIND_EVERY) {
    context = reminderLine(fresh)
    fresh.forEach((p) => { p.reminded = true })
    state.lastRemindTurn = state.turn
    row.reminded = fresh.map((p) => p.id)
  }
  P.saveState(root, state)
  P.log(root, row)
  return context
}

// ---------------------------------------------------------------- 一轮结束：后台检查改动
export function spawnScan(root) {
  const lock = join(root, P.DIR, 'state', 'scan.lock')
  try { if (Date.now() - statSync(lock).mtimeMs < 120000) return } catch {}
  try {
    spawn(process.execPath, [CLI, 'scan-changes', '--root', root], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref()
  } catch {}
}

export async function scanChanges(root, { maxItems = 8, timeoutMs = 60000 } = {}) {
  const lock = join(root, P.DIR, 'state', 'scan.lock')
  mkdirSync(join(root, P.DIR, 'state'), { recursive: true })
  writeFileSync(lock, String(process.pid))
  try {
    const state = P.loadState(root)
    const isCode = (p) => CODE_EXT.has(extname(p).toLowerCase()) && !p.startsWith(P.DIR + '/')
    const isDoc = (p) => /\.md$/i.test(p) && !p.startsWith(P.DIR + '/')
    const changes = G.workingChanges(root, { keep: (p) => isCode(p) || isDoc(p) })   // 只看代码和文档，其它不读
    const changedDocs = new Set(changes.filter((c) => isDoc(c.path)).map((c) => c.path))
    const fresh = changes.filter((c) => isCode(c.path) && state.diffHashes[c.path] !== c.hash)
    const nextHashes = {}
    for (const c of changes) if (isCode(c.path)) nextHashes[c.path] = c.hash   // 已提交/已还原的文件自然消失：切分支也不会串
    state.diffHashes = nextHashes
    const row = { event: 'scan', changed: changes.length, fresh: fresh.length }
    if (!fresh.length) { P.saveState(root, state); P.log(root, row); return row }

    // 新增的 Controller：还没有文档
    for (const c of fresh) if ((c.status === '?' || c.status === 'A') && /Controller\.(java|kt)$/.test(c.path) && /@(Request|Get|Post|Put|Delete)Mapping/.test(c.patch))
      addPending(state, { type: 'undocumented', key: `undoc|${c.path}`, file: c.path })

    // 耦合的文档小节（这次没一起改文档的）
    const rev = reverseMap(P.loadMap(root))
    const groups = new Map()
    for (const c of fresh) for (const s of rev.get(c.path) ?? []) {
      if (changedDocs.has(s.doc)) continue
      const k = `${s.doc}|${s.line}`
      const g = groups.get(k) ?? { doc: s.doc, section: s.heading, line: s.line, files: [], patches: [] }
      g.files.push(c.path); g.patches.push(c.patch)
      groups.set(k, g)
    }
    const items = [...groups.values()].slice(0, maxItems)
    row.coupled = groups.size
    if (items.length && D.apiKey()) {
      const batch = items.map((g) => {
        let text = ''
        try { const lines = readFileSync(join(root, g.doc), 'utf8').split(/\r?\n/); const out = [lines[g.line - 1] ?? '']; for (let i = g.line; i < lines.length && !/^#{1,4}\s/.test(lines[i]); i++) out.push(lines[i]); text = out.join('\n') } catch {}
        return { ...g, docText: text, change: g.patches.join('\n').slice(0, 1800) }
      })
      try {
        const qs = Object.fromEntries(batch.map((_, k) => [`s${k}`, D.staleQuestion(k)]))
        const a = await D.ask(D.staleState(batch), qs, { timeoutMs })
        row.judged = batch.map((g, k) => {
          const r = D.pick(a[`s${k}`], D.STALE)
          if (r.key === 'outdated') addPending(state, { type: 'stale', key: `stale|${g.doc}|${g.line}|${g.files.join(',')}`, doc: g.doc, section: g.section, line: g.line, files: g.files, p: +r.p.toFixed(2) })
          return { doc: g.doc, section: g.section, verdict: r.key ?? `unsure:${r.guess}`, p: +r.p.toFixed(2) }
        })
      } catch (e) { row.error = e.name === 'AbortError' ? 'timeout' : e.message }
    }
    P.saveState(root, state)
    P.log(root, row)
    return row
  } finally { try { unlinkSync(lock) } catch {} }
}

// ---------------------------------------------------------------- 宿主适配：Codex / Claude Code / DSH（dsh-hoos）
export async function handleHook(payload) {
  const ev = payload?.hook_event_name
  const root = P.findRoot(payload?.cwd || process.cwd())
  if (!root) return null                                     // 没初始化的项目：什么也不做
  if (ev === 'UserPromptSubmit' || ev === 'agent/pre-step') {
    // Codex / Claude Code 只给子代理带 agent_id；DSH 主代理也带 agent_id，所以只在前两者里据此跳过子代理
    if (ev === 'UserPromptSubmit' && (payload.agent_id || payload.parent_agent_id)) return null
    const prompt = payload.prompt
    if (!prompt) return null                                            // DSH：只有每轮第一步带消息
    const context = await onPrompt(root, prompt)
    return context ? { hookSpecificOutput: { hookEventName: ev, additionalContext: context } } : null
  }
  if (ev === 'Stop' || ev === 'agent/turn-stopping') {
    if (payload.stop_hook_active || (ev === 'Stop' && payload.agent_id)) return null
    spawnScan(root)
    return null
  }
  return null
}
