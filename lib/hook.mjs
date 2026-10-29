/**
 * hook.mjs — 日常钩子。原则：不阻断、不改文件、失败不出声、对话里最多一行。
 *   你发消息时：只做本地记账（不调模型）
 *   一轮结束时：本地看 git diff → 改到的代码 → 耦合的文档小节（这次没一起改的）→ 有候选才让模型问用户
 *   用户确认后：doc-drift check 只判这批候选
 */
import { statSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as P from './project.mjs'
import * as D from './decide.mjs'
import * as G from './git.mjs'
import { reverseMap } from './init.mjs'
import { CODE_EXT } from './scan.mjs'
import { currentTask, taskForChanges } from './trellis.mjs'

export { currentTask, taskForChanges }

const CLI = fileURLToPath(new URL('../bin/doc-drift.mjs', import.meta.url))
export const REMIND_EVERY = 3                         // 两次提醒至少隔 3 轮

/** 读代码现在的实现（不是 diff）：每文件最多 4000 字，最多 3 个文件。 */
function codeText(root, files) {
  const out = []
  for (const f of (files ?? []).slice(0, 3)) {
    try { out.push(`--- ${f} ---\n${readFileSync(join(root, f), 'utf8').slice(0, 4000)}`) } catch {}
  }
  return out.join('\n\n')
}

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

// ---------------------------------------------------------------- 你发消息：只做本地记账
export function onPrompt(root, prompt, { sessionId = null } = {}) {
  const config = P.loadConfig(root)
  const state = P.loadState(root)
  state.turn = (state.turn ?? 0) + 1
  const row = { event: 'prompt', turn: state.turn }
  // 本会话第一次见面：先记基线，这样这一轮改了什么才算得出来
  const { box } = sessionHashes(state, sessionId)
  if (!box.diffHashes) {
    const changes = G.workingChanges(root, { keep: (p) => isCode(p) || isDoc(p) })
    const hashes = {}
    for (const c of changes) if (isCode(c.path)) hashes[c.path] = c.hash
    box.diffHashes = hashes
    row.baseline = true
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

// ---------------------------------------------------------------- 一轮结束：本地找候选
// Harness 配置目录整片未跟踪，不当成"这轮改的业务代码"
const HARNESS = /^(\.trellis|\.dsh|\.codex|\.claude|\.agents)\//i
const isCode = (p) => CODE_EXT.has(extname(p).toLowerCase()) && !p.startsWith(P.DIR + '/') && !HARNESS.test(p)
const isDoc = (p) => /\.md$/i.test(p) && !p.startsWith(P.DIR + '/') && !HARNESS.test(p)

/** 每个会话各自一份 diffHashes：只报本会话这轮改到的代码，不把别人的改动算进来。 */
function sessionHashes(state, sessionId) {
  state.sessions = state.sessions ?? {}
  const key = sessionId || 'default'
  const box = (state.sessions[key] = state.sessions[key] ?? { diffHashes: null })
  const keys = Object.keys(state.sessions)
  for (const k of keys.slice(0, Math.max(0, keys.length - 30))) if (k !== key) delete state.sessions[k]   // 只留最近 30 个会话
  return { key, box }
}

/**
 * 本地候选判断（不调模型）：本会话这轮改到的代码 → 耦合的需求/设计文档小节（这次没一起改的）。
 * 只看"需求和对应的代码"这一类漂移；新增接口没文档不算（那是接口清单的事，doctor 管）。
 * 按这一轮改的文件反查任务（查不到再用会话挂的任务）；有任务时只报该任务引用到的文档，都没有就报全部需求/设计文档。
 * 第一次见这个会话只记基线、不报，避免把存量改动当成"这轮改的"。
 */
export function localCandidates(root, { sessionId = null, maxItems = 8, freshOnFirstRun = false } = {}) {
  const state = P.loadState(root)
  const { key, box } = sessionHashes(state, sessionId)
  const task = currentTask(root, sessionId)
  const changes = G.workingChanges(root, { keep: (p) => isCode(p) || isDoc(p) })
  const nextHashes = {}
  for (const c of changes) if (isCode(c.path)) nextHashes[c.path] = c.hash
  const row = { event: 'turn-stop', session: key, changed: changes.length }
  if (task) row.task = task.title
  if (!box.diffHashes && !freshOnFirstRun) {    // 本会话第一次：只记基线
    box.diffHashes = nextHashes
    row.baseline = true
    P.saveState(root, state); P.log(root, row)
    return { items: [], fresh: 0, task }
  }
  const prev = box.diffHashes ?? {}
  const changedDocs = new Set(changes.filter((c) => isDoc(c.path)).map((c) => c.path))
  const fresh = changes.filter((c) => isCode(c.path) && prev[c.path] !== c.hash)
  box.diffHashes = nextHashes
  row.fresh = fresh.length
  if (!fresh.length) { state.candidates = []; P.saveState(root, state); P.log(root, row); return { items: [], fresh: 0, task } }

  // 会话没挂任务时，按这一轮改的文件反查任务（改的可能不是当前任务的活）
  const owner = taskForChanges(root, fresh.map((c) => c.path)) ?? task
  if (owner) row.task = owner.title

  // 耦合的需求/设计文档小节（这次没一起改文档的）
  const info = P.loadConfig(root).docInfo ?? {}
  const isReqDoc = (doc) => ['requirements', 'design'].includes(info[doc]?.type)
    && (!owner?.docs.length || owner.docs.includes(doc))
  const rev = reverseMap(P.loadMap(root))
  const groups = new Map()
  for (const c of fresh) for (const s of rev.get(c.path) ?? []) {
    if (!isReqDoc(s.doc)) continue
    if (changedDocs.has(s.doc)) continue
    const k = `${s.doc}|${s.line}`
    const g = groups.get(k) ?? { type: 'stale', doc: s.doc, section: s.heading, line: s.line, files: [], patches: [] }
    g.files.push(c.path); g.patches.push(c.patch)
    groups.set(k, g)
  }
  row.coupled = groups.size
  const items = []
  for (const g of groups.values()) if (items.length < maxItems) items.push(g)
  state.candidates = items.map(({ patches, ...rest }) => rest)   // 留给 check 判
  P.saveState(root, state)
  P.log(root, row)
  return { items, fresh: fresh.length, changed: row.changed, coupled: row.coupled, task: owner }
}

/** 把本地候选转成一句给模型看的话（模型据此用 ask_user 问用户）。 */
export function candidateLine(items, root, task = null) {
  const parts = items.slice(0, 3).map((p) =>
    `${p.doc}「${p.section}」（${p.files.slice(0, 2).map((f) => f.split('/').pop()).join('、')} 已改）`)
  const who = task?.title ? `当前任务「${task.title}」` : '这轮'
  return `[文档漂移 · doc-drift] ${who}可能弄过时了 ${items.length} 处文档：${parts.join('；')}${items.length > 3 ? ' 等' : ''}。`
    + `先用 ask_user 问用户要不要现在核对这几处（不要不问就查）；用户同意就运行：node "${CLI}" check --root "${root}"；`
    + `用户说先记下来，就运行：node "${CLI}" defer "<文档>" --section "<小节>" --note "<用户备注>" --root "${root}"（只记一笔，不查）。`
}

// ---------------------------------------------------------------- 用户确认后才判：只判这批候选
export async function checkCandidates(root, { timeoutMs = 60000 } = {}) {
  const lock = join(root, P.DIR, 'state', 'scan.lock')
  mkdirSync(join(root, P.DIR, 'state'), { recursive: true })
  try { if (Date.now() - statSync(lock).mtimeMs < 120000) return { event: 'check', skipped: 'locked' } } catch {}
  writeFileSync(lock, String(process.pid))
  try {
    const state = P.loadState(root)
    const items = state.candidates ?? []
    const row = { event: 'check', candidates: items.length }
    if (!items.length) { P.log(root, row); return row }
    const stale = items.filter((c) => c.type === 'stale')
    if (stale.length && D.apiKey()) {
      const batch = stale.map((g) => {
        let text = ''
        try { const lines = readFileSync(join(root, g.doc), 'utf8').split(/\r?\n/); const out = [lines[g.line - 1] ?? '']; for (let i = g.line; i < lines.length && !/^#{1,4}\s/.test(lines[i]); i++) out.push(lines[i]); text = out.join('\n') } catch {}
        return { ...g, docText: text, code: codeText(root, g.files) }
      })
      try {
        const qs = Object.fromEntries(batch.flatMap((_, k) => [[`s${k}`, D.staleQuestion(k)], [`a${k}`, D.alignQuestion(k)]]))
        const a = await D.ask(D.staleState(batch), qs, { timeoutMs })
        row.judged = batch.map((g, k) => {
          const r = D.pick(a[`s${k}`], D.STALE)
          const fx = D.pick(a[`a${k}`], D.ALIGN)
          if (r.key === 'outdated') addPending(state, { type: 'stale', key: `stale|${g.doc}|${g.line}|${g.files.join(',')}`, doc: g.doc, section: g.section, line: g.line, files: g.files, p: +r.p.toFixed(2), fix: fx.key })
          return { doc: g.doc, section: g.section, verdict: r.key ?? `unsure:${r.guess}`, p: +r.p.toFixed(2), fix: fx.key }
        })
      } catch (e) { row.error = e.name === 'AbortError' ? 'timeout' : e.message }
    }
    state.candidates = []
    P.saveState(root, state)
    P.log(root, row)
    return row
  } finally { try { unlinkSync(lock) } catch {} }
}

/** 用户选择"先记下来"：只记指针和备注，证据由 doctor 随时用现在的代码重算。 */
export function defer(root, { doc, section = '', note = '' } = {}) {
  if (!doc) throw new Error('defer 需要文档路径')
  const state = P.loadState(root)
  const key = `defer|${doc}|${section}`
  const list = state.deferred ?? []
  const at = new Date().toISOString().slice(0, 10)
  const hit = list.find((d) => d.key === key)
  if (hit) { hit.at = at; if (note) hit.note = note } else list.push({ key, doc, section, note, at })
  state.deferred = list
  P.saveState(root, state)
  P.log(root, { event: 'defer', doc, section, note })
  return { doc, section, note, at, total: list.length }
}

// ---------------------------------------------------------------- 手动全量：scan-changes
export async function scanChanges(root, { maxItems = 8, timeoutMs = 60000 } = {}) {
  const local = localCandidates(root, { sessionId: 'manual', maxItems, freshOnFirstRun: true })
  const judged = await checkCandidates(root, { timeoutMs })
  return { ...local, ...judged }
}

// ---------------------------------------------------------------- 宿主适配：Codex / Claude Code / DSH（dsh-hoos）
export async function handleHook(payload) {
  const ev = payload?.hook_event_name
  const root = P.findRoot(payload?.cwd || process.cwd())
  if (!root) return null                                     // 没初始化的项目：什么也不做
  if (ev === 'UserPromptSubmit' || ev === 'agent/pre-step') {
    // Codex / Claude Code 只给子代理带 agent_id；DSH 主代理也带 agent_id，所以只在前两者里据此跳过子代理
    if (ev === 'UserPromptSubmit' && (payload.agent_id || payload.parent_agent_id)) return null
    const context = onPrompt(root, payload.prompt, { sessionId: payload.session_id })
    return context ? { hookSpecificOutput: { hookEventName: ev, additionalContext: context } } : null
  }
  if (ev === 'Stop' || ev === 'agent/turn-stopping') {
    if (payload.stop_hook_active || (ev === 'Stop' && payload.agent_id)) return null
    const r = localCandidates(root, { sessionId: payload.session_id })
    if (!r.items.length) return null
    return { decision: 'block', reason: candidateLine(r.items, root, r.task) }   // 不结束这一轮：让模型先问用户
  }
  return null
}
