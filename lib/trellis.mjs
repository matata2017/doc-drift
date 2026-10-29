/**
 * trellis.mjs — 只读 Trellis 的任务元数据。拿不到就返回 null / 空数组，不猜。
 *   任务文档集 = relatedFiles 里的 .md + 任务目录自带的 .md + implement/check 指向的 .md
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as P from './project.mjs'

export const TASKS = '.trellis/tasks'
const mdFile = (p) => /\.md$/i.test(p)
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const posix = (p) => String(p).replace(/\\/g, '/')

export function taskDocs(root, dir) {
  const t = readJson(join(root, dir, 'task.json'))
  if (!t) return null
  const docs = new Set((t.relatedFiles ?? []).filter(mdFile).map(posix))
  let names = []
  try { names = readdirSync(join(root, dir)) } catch {}
  // 任务目录里只认 SPEC 类文档；MILESTONES / tester-report 是日志，不参与漂移校验
  for (const f of names) if (mdFile(f) && /^(prd|design|require|spec)/i.test(f)) docs.add(posix(join(dir, f)))
  for (const f of ['implement.jsonl', 'check.jsonl']) {
    let lines = []
    try { lines = readFileSync(join(root, dir, f), 'utf8').split('\n') } catch {}
    for (const l of lines) {
      if (!l.trim()) continue
      try { const j = JSON.parse(l); if (j.file && mdFile(j.file)) docs.add(posix(j.file)) } catch {}
    }
  }
  return { ...t, dir: posix(dir), docs: [...docs].filter((d) => existsSync(join(root, d))) }
}

export function listTasks(root) {
  const out = []
  const walk = (rel) => {
    let entries = []
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = `${rel}/${e.name}`
      if (existsSync(join(root, p, 'task.json'))) { const t = taskDocs(root, p); if (t) out.push(t) }
      walk(p)
    }
  }
  walk(TASKS)
  return out
}

/** 当前会话指向的任务；文件名以 _<sessionId> 结尾，多条取 last_seen_at 最新的。 */
export function currentTask(root, sessionId) {
  if (!sessionId) return null
  const dir = join(root, '.trellis', '.runtime', 'sessions')
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return null }
  const mine = files.filter((f) => f.slice(0, -5).endsWith(`_${sessionId}`))
  if (!mine.length) return null
  let best = null
  for (const f of mine) {
    const s = readJson(join(dir, f))
    if (s && (!best || String(s.last_seen_at ?? '') > String(best.last_seen_at ?? ''))) best = s
  }
  if (!best?.current_task) return null
  return taskDocs(root, posix(best.current_task))
}

const jsonlFiles = (root, dir) => {
  const out = []
  for (const f of ['implement.jsonl', 'check.jsonl']) {
    let lines = []
    try { lines = readFileSync(join(root, dir, f), 'utf8').split('\n') } catch {}
    for (const l of lines) {
      if (!l.trim()) continue
      try { const j = JSON.parse(l); if (j.file) out.push(posix(j.file)) } catch {}
    }
  }
  return out
}

const taskText = (root, t) => {
  const parts = [JSON.stringify(t)]
  let names = []
  try { names = readdirSync(join(root, t.dir)) } catch {}
  for (const f of names) {
    if (!/\.(md|jsonl)$/i.test(f)) continue
    try { parts.push(readFileSync(join(root, t.dir, f), 'utf8')) } catch {}
  }
  return parts.join('\n')
}

/**
 * 按改动文件反查任务：任务登记的文件边界（relatedFiles / implement.jsonl）优先，
 * 其次是任务文档里提到的路径。最高分并列、或分数太低，就返回 null——不猜。
 * 已完成任务也参与：改完的东西可能属于一个已经收口的任务。
 */
const NOISE = /^(\.trellis|\.dsh|\.codex|\.claude|\.agents|\.doc-drift)\//i

export function taskForChanges(root, files = []) {
  // Harness 配置目录常年整片未跟踪，拿它们反查任务会一直命中"改配置"那个任务
  const paths = files.map(posix).filter((p) => !NOISE.test(p))
  if (!paths.length) return null
  // 代码 → 文档（init 生成的图谱）→ 任务：间接但比文字匹配准
  const docsOf = new Map()
  for (const d of P.loadMap(root)?.docs ?? []) {
    for (const s of d.sections ?? []) for (const f of s.files ?? []) {
      const list = docsOf.get(f) ?? []
      list.push(d.path)
      docsOf.set(f, list)
    }
  }
  const scored = []
  for (const t of listTasks(root)) {
    if (t.status === 'archived') continue
    const declared = [...(t.relatedFiles ?? []).map(posix), ...jsonlFiles(root, t.dir)]
    const blob = taskText(root, t)
    let score = 0
    const hits = new Set()
    for (const p of paths) {
      const dir = p.replace(/\/[^/]*$/, '')
      const base = p.split('/').pop()
      if (declared.some((d) => p === d || p === d.replace(/\/$/, '') || dir === d.replace(/\/$/, '') || p.startsWith(d.replace(/\/$/, '') + '/'))) { score += 5; hits.add(p); continue }
      if ((docsOf.get(p) ?? []).some((doc) => t.docs.includes(doc))) { score += 3; hits.add(p); continue }
      // 只认完整路径或代码文件名；design.md / prd.md 这种通用名会命中所有任务
      if (blob.includes(p) || (base.length >= 8 && /\.(java|kt|py|js|mjs|ts|vue|xml|ya?ml|sql)$/i.test(base) && blob.includes(base))) { score += 1; hits.add(p) }
    }
    if (score) scored.push({ task: t, score, hits: [...hits] })
  }
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best || best.score < 2) return null
  const top = scored.filter((s) => s.score === best.score)
  if (top.length > 1) {                  // 并列：只有一个 in_progress 就选它，否则不猜
    const live = top.filter((s) => s.task.status === 'in_progress')
    return live.length === 1 ? { ...live[0].task, score: live[0].score, hits: live[0].hits } : null
  }
  return { ...best.task, score: best.score, hits: best.hits }
}

const gitBranch = (root) => {
  try { return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch { return null }
}

/** 当前还在做的任务（in_progress / review）以及它们的文档——doctor full 的范围。 */
export function snapshot(root) {
  const branch = gitBranch(root)
  const here = posix(root).toLowerCase()
  const tasks = listTasks(root)
    .filter((t) => t.status === 'in_progress' || t.status === 'review')
    .filter((t) => !branch || !t.branch || t.branch === branch)       // 别的分支的任务不在这儿查
    .filter((t) => !t.worktree_path || posix(t.worktree_path).toLowerCase() === here)
    .map((t) => ({ dir: t.dir, title: t.title, status: t.status, docs: t.docs }))
  const docs = [...new Set(tasks.flatMap((t) => t.docs))]
  let current = latestSessionTask(root)
  if (!current && tasks.length === 1) current = tasks[0]
  return { at: new Date().toISOString(), current: current ? { dir: current.dir, title: current.title } : null, tasks, docs }
}

/** 没有给 session 时，取最近更新过的会话文件（doctor 是用户显式跑的，选最新一条更省事）。 */
export function latestSessionTask(root) {
  const dir = join(root, '.trellis', '.runtime', 'sessions')
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return null }
  let best = null
  for (const f of files) {
    const s = readJson(join(dir, f))
    if (!s?.current_task) continue
    if (!best || String(s.last_seen_at ?? '') > String(best.last_seen_at ?? '')) best = s
  }
  return best?.current_task ? taskDocs(root, posix(best.current_task)) : null
}
