/**
 * init.mjs — 认识项目：文档分类（StartLux）、业务域（索引表）、文档 ↔ 代码耦合映射。
 * 拿不准的不猜：生成问题清单，由 agent 问用户，再用 `doc-drift mark` / `doc-drift answer` 记下来。
 */
import { inventory, deterministicChecks, isAiConfig } from './check.mjs'
import { resolveAnchor } from './scan.mjs'
import * as G from './git.mjs'
import * as D from './decide.mjs'
import * as P from './project.mjs'

const BATCH = 12                                       // 一次请求 12 篇文档 × 2 题

function headings(text) {
  const out = []
  text.split(/\r?\n/).forEach((l, i) => { const m = /^(#{1,4})\s+(.+)$/.exec(l); if (m) out.push({ level: m[1].length, title: m[2].trim(), line: i + 1 }) })
  return out
}

/** 锚点落在哪个小节：它上方最近的标题 */
const sectionOf = (hs, line) => { let s = null; for (const h of hs) { if (h.line <= line) s = h; else break } return s }

/** 锚点 → 代码文件（耦合映射用） */
function anchorFiles(a, idx) {
  const v = a.value.replace(/\/+$/, '')
  if (a.kind === 'class') return idx.classFiles.get(v) ?? []
  if (a.kind === 'file') {
    if (v.includes('*')) { const re = new RegExp('(^|/)' + v.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$'); return idx.files.filter((f) => re.test(f)) }
    return idx.files.filter((f) => f === v || f.endsWith('/' + v))
  }
  if (a.kind === 'dir') { const fs = idx.files.filter((f) => f.includes('/' + v + '/') || f.startsWith(v + '/')); return fs.length <= 30 ? fs : [] }  // 太大的目录不算耦合
  if (a.kind === 'method' && a.cls) return idx.classFiles.get(a.cls) ?? []
  return []
}

/** 文档 ↔ 代码耦合：每篇文档的每个小节引用了哪些代码文件 */
export function buildMap(root, inv, config) {
  const docs = []
  for (const d of inv.docs) {
    const status = P.docStatus(config, d.path) ?? config.docInfo?.[d.path]?.status
    if (status === 'historical' || status === 'archived') continue          // 历史记录不要求跟代码同步
    const hs = headings(d.text)
    const bySection = new Map()
    for (const a of d.anchors) {
      if (a.gone || !resolveAnchor(a, inv.idx)) continue
      const files = anchorFiles(a, inv.idx)
      if (!files.length) continue
      const s = sectionOf(hs, a.line)
      const key = s ? `${s.line}` : '0'
      const e = bySection.get(key) ?? { heading: s?.title ?? '(开头)', line: s?.line ?? 1, files: new Set(), anchors: new Set() }
      files.forEach((f) => e.files.add(f)); e.anchors.add(a.value)
      bySection.set(key, e)
    }
    if (bySection.size) docs.push({ path: d.path, sections: [...bySection.values()].map((e) => ({ heading: e.heading, line: e.line, files: [...e.files].sort(), anchors: [...e.anchors] })) })
  }
  return { generatedAt: new Date().toISOString(), docs }
}

/** 反查：代码文件 → 耦合的文档小节 */
export function reverseMap(map) {
  const r = new Map()
  for (const d of map.docs ?? []) for (const s of d.sections) for (const f of s.files) (r.get(f) ?? r.set(f, []).get(f)).push({ doc: d.path, heading: s.heading, line: s.line })
  return r
}

/** 索引表（如 mdfile/README.md 的"主题域 → 文档入口 → 代码锚点"）→ 业务域 */
export function domainsFromIndex(inv) {
  const domains = []
  for (const d of inv.docs) {
    const rows = d.text.split(/\r?\n/).filter((l) => /^\|/.test(l) && /\]\(/.test(l))
    if (rows.length < 3) continue
    for (const row of rows) {
      const cells = row.split('|').slice(1, -1).map((c) => c.trim())
      const name = cells[0]?.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
      if (!name || name.length > 40) continue
      const docs = [...row.matchAll(/\]\(([^)\s#]+)/g)].map((m) => m[1]).filter((t) => /\.md$/i.test(t))
        .map((t) => normalize(d.path, t))
      const code = [...row.matchAll(/`([^`]+)`|\*\*([^*]+)\*\*/g)].map((m) => (m[1] ?? m[2]).trim()).filter((t) => /[A-Z][a-z]+[A-Z]|\/|\.java$/.test(t))
      if (docs.length) domains.push({ name, index: d.path, docs: [...new Set(docs)], code: [...new Set(code)].slice(0, 20) })
    }
  }
  return domains
}
const normalize = (from, t) => {
  const parts = from.split('/').slice(0, -1)
  for (const x of decodeURIComponent(t).split('/')) { if (x === '..') parts.pop(); else if (x && x !== '.') parts.push(x) }
  return parts.join('/')
}

/** 跑 init：分类（可跳过模型）、业务域、映射；返回 { config, map, questions, stats } */
export async function runInit(root, { useModel = true, log = () => {}, concurrency = 3, existing = null } = {}) {
  const config = existing ?? { version: 1, docs: [], code: [], exclude: undefined, docStatus: {}, docInfo: {}, domains: [] }
  const inv = inventory(root, config)
  const findings = deterministicChecks(root, inv)
  const outdatedBy = new Map(), aliveBy = new Map()
  for (const f of findings) if (f.kind === 'outdated') outdatedBy.set(f.doc, (outdatedBy.get(f.doc) ?? 0) + 1)
  for (const d of inv.docs) aliveBy.set(d.path, d.anchors.length - (outdatedBy.get(d.path) ?? 0))

  // 已经分类过的、手动定过状态的不再问；AI 配置文件直接定
  const todo = []
  for (const d of inv.docs) {
    if (config.docInfo[d.path]?.type) continue
    if (isAiConfig(d.path)) { config.docInfo[d.path] = { type: 'ai_config', status: 'current', by: 'rule' }; continue }
    todo.push({ path: d.path, title: d.title, headings: headings(d.text).map((h) => h.title), head: d.text.replace(/^#.*$/m, '').slice(0, 800),
      changed: new Date(G.lastChanged(root, d.path) || 0).toISOString().slice(0, 10), outdated: outdatedBy.get(d.path) ?? 0, alive: aliveBy.get(d.path) ?? 0 })
  }
  const questions = []
  if (useModel && todo.length) {
    const batches = []
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH))
    let done = 0
    const work = async (batch) => {
      try {
        const a = await D.ask(D.classifyState(batch), D.classifyQuestions(batch), { timeoutMs: 60000 })
        batch.forEach((d, i) => {
          const t = D.pick(a[`type_${i}`], D.DOC_TYPES, 0.6), s = D.pick(a[`status_${i}`], D.DOC_STATUS, 0.7)
          config.docInfo[d.path] = { type: t.key ?? t.guess, status: s.key, statusGuess: s.guess, pStatus: +s.p.toFixed(2), title: d.title, by: 'model' }
          if (!s.key) questions.push({ doc: d.path, question: `「${d.path}」还代表系统现状吗？`, guess: s.guess, p: +s.p.toFixed(2),
            options: ['current（现状，要跟代码保持一致）', 'historical（某次变更/迭代的记录）', 'archived（已废弃）'] })
        })
      } catch (e) { batch.forEach((d) => questions.push({ doc: d.path, question: `「${d.path}」还代表系统现状吗？（自动分类失败：${e.message}）`, options: ['current', 'historical', 'archived'] })) }
      done += batch.length
      log(`分类 ${done}/${todo.length}`)
    }
    const queue = [...batches]
    await Promise.all(Array.from({ length: concurrency }, async () => { while (queue.length) await work(queue.shift()) }))
  }
  config.domains = domainsFromIndex(inv)
  config.updatedAt = new Date().toISOString()
  const map = buildMap(root, inv, config)
  const statusCount = {}
  for (const v of Object.values(config.docInfo)) { const k = v.status ?? 'unknown'; statusCount[k] = (statusCount[k] ?? 0) + 1 }
  return { config, map, questions, stats: { docs: inv.docs.length, classified: todo.length, statusCount, domains: config.domains.length, mapped: map.docs.length } }
}

