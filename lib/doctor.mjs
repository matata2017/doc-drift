/**
 * doctor.mjs — 全面体检。
 *   第一层：确定性检查（check.mjs）；按文档状态定级——历史记录、已归档的文档不要求跟代码同步，降为提示
 *   第二层：内容过时（D5）——耦合的代码在文档最后一次更新之后改过 → StartLux 判"是否已过时"
 *   第三层由 agent 按 SKILL.md 做：看报告、起草改动、问用户、改、记答复、再跑一遍
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { inventory, deterministicChecks, isAiConfig } from './check.mjs'
import { scanDocs } from './scan.mjs'
import { buildMap } from './init.mjs'
import * as G from './git.mjs'
import * as D from './decide.mjs'
import * as P from './project.mjs'
import { currentTask, latestSessionTask, taskForChanges, snapshot } from './trellis.mjs'

const PER_REQUEST = 8
const FIX_ZH = { doc: '改文档（代码是对的）', code: '改代码（文档写的是需求）', both: '两边都要改', unsure: '拿不准，问用户' }

/** 读代码现在的实现（不是 diff）：每文件最多 4000 字，最多 3 个文件。 */
function codeText(root, files) {
  const out = []
  for (const f of (files ?? []).slice(0, 3)) {
    try { out.push(`--- ${f} ---\n${readFileSync(join(root, f), 'utf8').slice(0, 4000)}`) } catch { out.push(`--- ${f} ---（读不到）`) }
  }
  return out.join('\n\n')
}
const sha1 = (s) => createHash('sha1').update(s).digest('hex')

export const signature = (f) => `${f.kind}|${f.doc ?? ''}|${f.anchor?.value ?? ''}`

function sectionText(text, line) {
  const lines = text.split(/\r?\n/)
  const out = [lines[line - 1] ?? '']
  for (let i = line; i < lines.length && !/^#{1,4}\s/.test(lines[i]); i++) out.push(lines[i])
  return out.join('\n').trim()
}

/**
 * 检查范围：
 *   spec（默认）需求 / 设计 / SPEC 类文档 ↔ 代码——"需求和代码对不上"是主要矛盾
 *   ai          AGENTS.md、CLAUDE.md 等给 AI 助手看的规则文件
 *   all         全部文档，外加"没有文档的接口"
 */
export const SPEC_PATH = /requirement|spec|design|prd|需求|设计|规格|方案|规则说明/i
export function inScope(config, path, scope) {
  if (scope === 'all') return true
  if (scope === 'ai') return isAiConfig(path)
  const t = config.docInfo?.[path]?.type
  if (t === 'requirements' || t === 'design') return true
  if (t === 'index' || t === 'review' || t === 'ops' || t === 'ai_config') return false
  return SPEC_PATH.test(path)
}

export async function runDoctor(root, { useModel = true, maxStale = 40, scope = 'spec', full = false, task = null, sessionId = null, log = () => {} } = {}) {
  const config = P.loadConfig(root) ?? { docInfo: {}, docStatus: {} }
  const inv = inventory(root, config)
  const aiDocs = inv.docs.filter((d) => isAiConfig(d.path)).map((d) => d.path)
  // 默认只查当前 Trellis 任务（当前 SPEC）；doctor full 才查整个项目
  let current = task
  let taskFrom = task ? 'flag' : null
  if (!current && !full) {
    const sessionTask = sessionId ? currentTask(root, sessionId) : latestSessionTask(root)
    if (sessionTask && !sessionId) log(`没有会话标识，按最近更新的会话任务检查：${sessionTask.title}`)
    // 改的可能不是会话挂的那个任务（或者任务已经收口了）：按当前改动反查，反查出来就以改动为准
    const guessed = taskForChanges(root, G.workingChanges(root).map((c) => c.path))
    if (guessed) {
      current = guessed
      taskFrom = 'changes'
      log(`按当前改动推断任务：「${guessed.title}」（${guessed.status}，命中 ${guessed.hits.length} 个文件）`)
      if (sessionTask && sessionTask.dir !== guessed.dir) log(`注意：会话挂的任务是「${sessionTask.title}」，和改动对不上，按改动推断的检查`)
    } else if (sessionTask) { current = sessionTask; taskFrom = 'session' }
  }
  if (!full && !current) throw new Error('本会话没有进行中的 Trellis 任务，当前改动也看不出属于哪个任务；要查整个项目请用 doc-drift doctor full，或者用 --task 指定任务')
  const docFilter = current ? new Set(current.docs) : null
  inv.docs = inv.docs.filter((d) => (docFilter ? docFilter.has(d.path) : inScope(config, d.path, scope)))
  if (docFilter) {   // 任务目录在 .trellis 下，默认盘点会被排除，这里单独补进来
    const have = new Set(inv.docs.map((d) => d.path))
    const missing = [...docFilter].filter((p) => !have.has(p))
    for (const d of scanDocs(root, missing)) {
      try { d.text = readFileSync(join(root, d.path), 'utf8') } catch { d.text = '' }
      inv.docs.push(d)
    }
  }
  if (full) {   // 全项目也只查 Trellis 活跃任务的文档（当前 SPEC 们）+ AI 规则文件
    const snap = snapshot(root)
    if (snap.docs.length) {
      const keep = new Set([...snap.docs, ...aiDocs])
      inv.docs = inv.docs.filter((d) => keep.has(d.path))
      const have = new Set(inv.docs.map((d) => d.path))
      for (const d of scanDocs(root, [...keep].filter((p) => !have.has(p)))) {
        try { d.text = readFileSync(join(root, d.path), 'utf8') } catch { d.text = '' }
        inv.docs.push(d)
      }
      log(`doctor full 只查 Trellis 活跃任务的文档 + AI 规则文件：${snap.tasks.length} 个任务、${inv.docs.length} 篇文档`)
    }
  }
  const ignore = new Set(config.ignore ?? [])
  const status = (path) => P.docStatus(config, path)        // 只认用户自己标的（默认一律以现状代码为准）

  // 第一层
  const findings = deterministicChecks(root, inv).filter((f) => !ignore.has(signature(f)) && (scope === 'all' || f.kind !== 'undocumented'))
  const codeTodo = new Set(config.codeTodo ?? [])
  for (const f of findings) {
    const s = f.doc ? status(f.doc) : null
    if (codeTodo.has(signature(f))) { f.codeTodo = true; f.severity = 'info'; continue }   // 用户已确认文档为准：交给改代码流程，不再问
    if ((s === 'historical' || s === 'archived') && ['outdated', 'resurrected', 'unresolved'].includes(f.kind)) {
      f.severity = 'info'; f.historical = true
      f.detail += `（这篇是${s === 'historical' ? '历史记录' : '已归档'}文档，不要求跟代码同步）`
    }
  }

  // 第二层：内容过时
  const map = buildMap(root, inv, config)
  const texts = new Map(inv.docs.map((d) => [d.path, d.text]))
  const docTime = new Map()
  const candidates = []
  for (const d of map.docs) {
    if (!docTime.has(d.path)) docTime.set(d.path, G.lastChanged(root, d.path))
    const since = docTime.get(d.path)
    for (const s of d.sections) {
      if (!s.files?.length) continue
      // 当前 SPEC 模式：任务文档的每一节都拿现在的代码比；全量模式：只比"代码比文档新"的节，控制调用量
      const commits = docFilter ? [] : G.commitsSince(root, s.files, since + 1000)
      if (!docFilter && !commits.length) continue
      candidates.push({ doc: d.path, section: s.heading, line: s.line, files: s.files, commits, aiConfig: /AGENTS\.md|CLAUDE\.md/i.test(d.path), code: codeText(root, s.files) })
    }
  }
  candidates.sort((a, b) => Number(b.aiConfig) - Number(a.aiConfig) || b.commits.length - a.commits.length)

  // 分批：判过的记在缓存里（文档和相关代码都没再变就沿用），每次只判还没判的下一批 ≤ maxStale 段，
  // 候选再多，多跑几次 doctor 也能全部判完
  const cache = P.loadStaleCache(root)
  const keyOf = (c) => `${c.doc}#${c.section}`
  const fpOf = (c) => `${docTime.get(c.doc)}|${c.commits.map((x) => x.hash).join(',')}|${sha1(c.code ?? '')}`
  const fresh = {}
  const todo = []
  for (const c of candidates) {
    const hit = cache[keyOf(c)]
    if (hit && hit.fp === fpOf(c)) { fresh[keyOf(c)] = hit; c.verdict = hit } else todo.push(c)
  }
  const picked = useModel ? todo.slice(0, maxStale) : []
  let judged = 0
  for (let i = 0; i < picked.length; i += PER_REQUEST) {
    const batch = picked.slice(i, i + PER_REQUEST).map((c) => ({ ...c, docText: sectionText(texts.get(c.doc) ?? '', c.line) }))
    try {
      const qs = Object.fromEntries(batch.flatMap((_, k) => [[`s${k}`, D.staleQuestion(k)], [`a${k}`, D.alignQuestion(k)]]))
      const a = await D.ask(D.staleState(batch), qs, { timeoutMs: 60000 })
      batch.forEach((c, k) => {
        const r = D.pick(a[`s${k}`], D.STALE)
        const fx = D.pick(a[`a${k}`], D.ALIGN)
        judged++
        const v = { fp: fpOf(c), guess: r.guess, key: r.key, p: r.p, fix: fx.key, fixP: fx.p, at: new Date().toISOString().slice(0, 10) }
        picked[i + k].verdict = v
        fresh[keyOf(c)] = v
      })
    } catch (e) { log(`第二层判断失败：${e.message}`) }
    log(`内容过时判断 ${Math.min(i + PER_REQUEST, picked.length)}/${picked.length}`)
  }
  P.saveStaleCache(root, fresh)          // 只留当前还是候选的段，文档改好了的自然掉出去

  for (const c of candidates) {
    const r = c.verdict
    if (!r) {
      if (!useModel) findings.push({ kind: 'stale', severity: 'info', doc: c.doc, line: c.line, aiConfig: c.aiConfig, anchor: { kind: 'section', value: c.section },
        detail: `「${c.section}」之后，它描述的代码又改了 ${c.commits.length} 次（未调用模型判断）`, files: c.files, commits: c.commits.slice(0, 5), text: '' })
      continue
    }
    // 只报倾向"过时"的：≥ 0.8 要处理，0.5–0.8 提示；倾向"准确"或"看不出"的不报（不制造噪声）
    if (r.guess !== 'outdated' || r.p < 0.5) continue
    const why = c.commits.length
      ? `它描述的代码在文档更新后又改了 ${c.commits.length} 次（${c.commits.slice(0, 3).map((x) => x.subject).join('；').slice(0, 120)}）`
      : '它描述的代码和文档现在对不上'
    findings.push({ kind: 'stale', severity: r.key === 'outdated' ? 'warn' : 'info', doc: c.doc, line: c.line, aiConfig: c.aiConfig, anchor: { kind: 'section', value: c.section },
      detail: `「${c.section}」${why}，` +
        (r.key === 'outdated' ? `判断描述已过时（把握 ${r.p.toFixed(2)}）` : `倾向已过时（把握 ${r.p.toFixed(2)}，不够高），需要人看一眼`) +
        (r.fix && r.fix !== 'unsure' ? `；建议：${FIX_ZH[r.fix]}` : ''),
      files: c.files, commits: c.commits.slice(0, 5), text: '' })
  }
  const judgedTotal = candidates.filter((c) => c.verdict).length

  const SEV = { error: 0, warn: 1, info: 2 }
  findings.sort((x, y) => Number(y.aiConfig) - Number(x.aiConfig) || SEV[x.severity] - SEV[y.severity] || String(x.doc).localeCompare(String(y.doc)) || (x.line ?? 0) - (y.line ?? 0))
  findings.forEach((f, i) => { f.id = `F${String(i + 1).padStart(3, '0')}` })

  // 对齐：代码待改清单里，那处不一致已经消失的（用户的代码改好了）自动打勾
  const scopeDocs = new Set(inv.docs.map((d) => d.path))
  const aligned = P.syncCodeTodo(root, config, new Set(findings.map(signature)), (doc) => !doc || scopeDocs.has(doc))
  if (aligned.closed.length) P.saveConfig(root, config)
  return { findings, map, stats: { docs: inv.docs.length, scope, mode: full ? 'full' : 'task', task: current?.title ?? null, taskFrom, candidates: candidates.length, judged, judgedTotal, staleLeft: candidates.length - judgedTotal, codeTodoClosed: aligned.closed.length, codeTodoOpen: aligned.open.length,
    unmapped: inv.docs.filter((d) => !new Set(candidates.map((c) => c.doc)).has(d.path)).length,
    historyDocs: inv.docs.filter((d) => ['historical', 'archived'].includes(status(d.path))).length,
    weakJudged: candidates.filter((c) => c.verdict && (c.verdict.guess !== 'outdated' || c.verdict.p < 0.5)).length,
    conflicts: findings.filter((f) => f.kind === 'stale').length } }
}

// ---------------------------------------------------------------- 报告
const KIND_ZH = { outdated: '引用已过时', moved: '引用的文件已移动', resurrected: '说已删除但还在', 'broken-link': '断链', 'absolute-link': '链接路径要改', 'external-link': '仓库外链接',
  unresolved: '找不到的引用', undocumented: '没有文档的接口', stale: '内容可能过时' }

const SCOPE_ZH = { spec: '需求 / 设计 / SPEC 文档', ai: 'AI 规则文件（AGENTS.md、CLAUDE.md 等）', all: '全部文档' }

export function renderReport(root, result, { infoLimit = 30 } = {}) {
  const { findings, stats } = result
  const main = findings.filter((f) => f.severity !== 'info'), info = findings.filter((f) => f.severity === 'info')
  const count = (list, k) => list.filter((f) => f.kind === k).length
  const L = [`# 文档漂移体检报告`, '', `项目：\`${root}\`　时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '',
    `范围：${stats.mode === 'task' ? `当前 SPEC「${stats.task ?? '（未命名任务）'}」${stats.taskFrom === 'changes' ? '（按当前改动推断）' : ''}` : `整个项目 · ${SCOPE_ZH[stats.scope] ?? stats.scope}`}（${stats.docs} 篇），以现状代码为准；冲突项先问你确认哪边是对的（可能需求已经改了、文档没跟上）。需要处理 **${main.length}** 项${stats.conflicts ? `（其中冲突 ${stats.conflicts} 项待确认）` : ''}，提示 ${info.length} 项；内容过时候选 ${stats.candidates} 段，已判断 ${stats.judgedTotal ?? stats.judged} 段（本次新判 ${stats.judged} 段）。`, '',
    ...(stats.staleLeft ? [`**还剩 ${stats.staleLeft} 段没判断**（StartLux 每次判 40 段左右）——先处理下面这批，处理完再跑一次 doctor 接着判下一批，直到剩 0。`, ''] : []),
    '| 类别 | 需要处理 | 提示 |', '|---|---|---|']
  for (const k of Object.keys(KIND_ZH)) { const a = count(main, k), b = count(info, k); if (a || b) L.push(`| ${KIND_ZH[k]} | ${a} | ${b} |`) }
  L.push('', '流程：以当前代码为准找出不同 → **每一条冲突都先问用户：以代码为准（改文档），还是文档写的是需求（改代码）** → 用户确认以代码为准的，改 SPEC / 文档；代码有问题的，记进代码待改清单交给用户开发（这里不改代码）→ 都改完重跑体检，对齐。不需要处理的：`doc-drift ignore <编号>`。', '')
  if (stats.codeTodoClosed || stats.codeTodoOpen) L.push(`**对齐结果**：代码待改清单里，本次已对齐 ${stats.codeTodoClosed ?? 0} 条（已自动打勾），仍待开发 ${stats.codeTodoOpen ?? 0} 条（见 \`.doc-drift/code-todo.md\`）。`, '')

  const byDoc = new Map()
  for (const f of main) (byDoc.get(f.doc ?? '（无文档）') ?? byDoc.set(f.doc ?? '（无文档）', []).get(f.doc ?? '（无文档）')).push(f)
  // 按原因归组：同一个原因（某个目录整体删了、某批文件移动了）一题问完
  const causes = new Map()
  for (const f of main) if (f.cause) { const c = causes.get(f.cause) ?? causes.set(f.cause, { refs: 0, docs: new Set(), values: new Set(), kind: f.kind }).get(f.cause); c.refs++; c.docs.add(f.doc); c.values.add(f.anchor.value) }
  const big = [...causes].filter(([, c]) => c.refs >= 2).sort((a, b) => b[1].refs - a[1].refs)
  if (big.length) {
    L.push('## 按原因归组（一组问一次）', '', '| 原因 | 引用 | 文档 | 例子 |', '|---|---|---|---|')
    for (const [cause, c] of big.slice(0, 30)) L.push(`| ${c.kind === 'moved' ? '文件已移动/改名（有新位置，可批量改）' : '已删除：`' + cause + '`'} | ${c.refs} | ${c.docs.size} 篇 | ${[...c.values].slice(0, 4).map((v) => '`' + v + '`').join('、')} |`)
    L.push('')
  }
  if (main.length) L.push('## 需要处理', '')
  for (const [doc, list] of byDoc) {
    L.push(`### ${doc}${list[0].aiConfig ? '（AI 配置文件，每个会话都会读，优先）' : ''}`, '')
    for (const f of list) {
      L.push(`- **${f.id}** [${KIND_ZH[f.kind]}] ${f.line ? `第 ${f.line} 行：` : ''}${f.detail}`)
      if (f.fix) L.push(`  - 建议改为：\`${f.fix}\``)
      if (f.files?.length) L.push(`  - 相关代码：${f.files.slice(0, 5).map((x) => '`' + x + '`').join('、')}${f.files.length > 5 ? ` 等 ${f.files.length} 个` : ''}`)
      if (f.text) L.push(`  - 原文：${f.text.replace(/\|/g, '\\|').slice(0, 160)}`)
    }
    L.push('')
  }
  const todo = info.filter((f) => f.codeTodo)
  if (todo.length) {
    L.push('## 代码待改（用户已确认文档为准，交给改代码流程；doc-drift 不改代码）', '', '详见 `.doc-drift/code-todo.md`。代码改好后这里会自动消失。', '')
    for (const f of todo) L.push(`- ${f.id} \`${f.doc}\`${f.line ? ':' + f.line : ''} ${f.detail}`)
    L.push('')
  }
  const rest = info.filter((f) => !f.codeTodo)
  if (rest.length) {
    L.push('## 提示（不一定要处理）', '')
    const groups = new Map()
    for (const f of rest) (groups.get(f.kind) ?? groups.set(f.kind, []).get(f.kind)).push(f)
    for (const [k, list] of groups) {
      L.push(`### ${KIND_ZH[k]}（${list.length}）`, '')
      for (const f of list.slice(0, infoLimit)) L.push(`- ${f.id} ${f.doc ? `\`${f.doc}\`${f.line ? ':' + f.line : ''} ` : ''}${f.detail}`)
      if (list.length > infoLimit) L.push(`- ……还有 ${list.length - infoLimit} 项（\`doc-drift doctor --json\` 看全部）`)
      L.push('')
    }
  }
  const gaps = []
  if (stats.unmapped) gaps.push(`没有代码关联的文档 ${stats.unmapped} 篇：只做了引用检查，没做内容比对。`)
  if (stats.historyDocs) gaps.push(`历史 / 已归档文档 ${stats.historyDocs} 篇：不要求跟代码同步，只提示。`)
  if (stats.staleLeft) gaps.push(`内容过时候选还有 ${stats.staleLeft} 段没判断：下次 doctor 接着判。`)
  if (stats.weakJudged) gaps.push(`已判断但判为准确或把握不足（<0.5）的 ${stats.weakJudged} 段没有列出。`)
  gaps.push('代码里新增、任何文档都没提到的部分，只有 doctor full 的「没有文档的接口」会提示；其余不查。')
  L.push('## 这次没查什么', '', ...gaps.map((g) => `- ${g}`), '')
  return L.join('\n')
}

/** 用户标了误报：清掉这段的缓存，下次 doctor 重新判；并记进 answers.md，避免反复误报。 */
export function labelFinding(root, id, verdict, note = '') {
  P.log(root, { event: 'label', id, verdict, note: note || undefined })
  if (verdict !== 'wrong') return { cleared: false }
  const f = lastFindings(root).find((x) => x.id === id)
  if (!f) return { cleared: false }
  const cache = P.loadStaleCache(root)
  const key = `${f.doc}#${f.anchor?.value ?? ''}`
  if (!cache[key]) return { cleared: false }
  delete cache[key]
  P.saveStaleCache(root, cache)
  P.appendAnswer(root, `体检结论 ${id} 是误报`, `${note || '判错了'}。已清掉这段的缓存，下次 doctor 重新判断；反复误报时先看这篇文档的分类和关联映射对不对。`)
  return { cleared: true }
}

export function saveReport(root, md, json) {
  const dir = join(root, P.DIR, 'reports')
  mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  writeFileSync(join(dir, `${day}.md`), md)
  mkdirSync(join(root, P.DIR, 'state'), { recursive: true })
  writeFileSync(join(root, P.DIR, 'state', 'last-doctor.json'), JSON.stringify(json))
  return join(dir, `${day}.md`)
}

export const lastFindings = (root) => { try { return JSON.parse(readFileSync(join(root, P.DIR, 'state', 'last-doctor.json'), 'utf8')).findings } catch { return [] } }
