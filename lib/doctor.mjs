/**
 * doctor.mjs — 全面体检。
 *   第一层：确定性检查（check.mjs）；按文档状态定级——历史记录、已归档的文档不要求跟代码同步，降为提示
 *   第二层：内容过时（D5）——耦合的代码在文档最后一次更新之后改过 → StartLux 判"是否已过时"
 *   第三层由 agent 按 SKILL.md 做：看报告、起草改动、问用户、改、记答复、再跑一遍
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inventory, deterministicChecks, isAiConfig } from './check.mjs'
import { buildMap } from './init.mjs'
import * as G from './git.mjs'
import * as D from './decide.mjs'
import * as P from './project.mjs'

const PER_REQUEST = 8

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

export async function runDoctor(root, { useModel = true, maxStale = 40, scope = 'spec', log = () => {} } = {}) {
  const config = P.loadConfig(root) ?? { docInfo: {}, docStatus: {} }
  const inv = inventory(root, config)
  inv.docs = inv.docs.filter((d) => inScope(config, d.path, scope))       // 只看范围内的文档（代码索引照旧是全量）
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
      const commits = G.commitsSince(root, s.files, since + 1000)
      if (!commits.length) continue
      candidates.push({ doc: d.path, section: s.heading, line: s.line, files: s.files, commits, aiConfig: /AGENTS\.md|CLAUDE\.md/i.test(d.path) })
    }
  }
  candidates.sort((a, b) => Number(b.aiConfig) - Number(a.aiConfig) || b.commits.length - a.commits.length)
  const picked = candidates.slice(0, maxStale)
  let judged = 0
  if (useModel && picked.length) {
    for (let i = 0; i < picked.length; i += PER_REQUEST) {
      const batch = picked.slice(i, i + PER_REQUEST).map((c) => ({
        ...c, docText: sectionText(texts.get(c.doc) ?? '', c.line),
        change: c.commits.map((x) => `${x.date} ${x.subject}`).join('\n') + '\n\n' + G.changesSince(root, c.files, docTime.get(c.doc) + 1000, 1500),
      }))
      try {
        const qs = Object.fromEntries(batch.map((_, k) => [`s${k}`, D.staleQuestion(k)]))
        const a = await D.ask(D.staleState(batch), qs, { timeoutMs: 60000 })
        batch.forEach((c, k) => {
          const r = D.pick(a[`s${k}`], D.STALE)
          judged++
          // 只报倾向"过时"的：≥ 0.8 要处理，0.5–0.8 提示；倾向"准确"或"看不出"的不报（不制造噪声）
          if (r.guess !== 'outdated' || r.p < 0.5) return
          const sev = r.key === 'outdated' ? 'warn' : 'info'
          findings.push({ kind: 'stale', severity: sev, doc: c.doc, line: c.line, aiConfig: c.aiConfig, anchor: { kind: 'section', value: c.section },
            detail: `「${c.section}」之后，它描述的代码又改了 ${c.commits.length} 次（${c.commits.slice(0, 3).map((x) => x.subject).join('；').slice(0, 120)}），` +
              (r.key === 'outdated' ? `StartLux 判断描述已过时（把握 ${r.p.toFixed(2)}）` : `StartLux 倾向已过时（把握 ${r.p.toFixed(2)}，不够高），需要人看一眼`),
            files: c.files, commits: c.commits.slice(0, 5), text: '' })
        })
      } catch (e) { log(`第二层判断失败：${e.message}`) }
      log(`内容过时判断 ${Math.min(i + PER_REQUEST, picked.length)}/${picked.length}`)
    }
  } else if (picked.length) {
    for (const c of picked) findings.push({ kind: 'stale', severity: 'info', doc: c.doc, line: c.line, aiConfig: c.aiConfig, anchor: { kind: 'section', value: c.section },
      detail: `「${c.section}」之后，它描述的代码又改了 ${c.commits.length} 次（未调用模型判断）`, files: c.files, commits: c.commits.slice(0, 5), text: '' })
  }

  const SEV = { error: 0, warn: 1, info: 2 }
  findings.sort((x, y) => Number(y.aiConfig) - Number(x.aiConfig) || SEV[x.severity] - SEV[y.severity] || String(x.doc).localeCompare(String(y.doc)) || (x.line ?? 0) - (y.line ?? 0))
  findings.forEach((f, i) => { f.id = `F${String(i + 1).padStart(3, '0')}` })

  // 对齐：代码待改清单里，那处不一致已经消失的（用户的代码改好了）自动打勾
  const scopeDocs = new Set(inv.docs.map((d) => d.path))
  const aligned = P.syncCodeTodo(root, config, new Set(findings.map(signature)), (doc) => !doc || scopeDocs.has(doc))
  if (aligned.closed.length) P.saveConfig(root, config)
  return { findings, map, stats: { docs: inv.docs.length, scope, candidates: candidates.length, judged, codeTodoClosed: aligned.closed.length, codeTodoOpen: aligned.open.length } }
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
    `范围：${SCOPE_ZH[stats.scope] ?? stats.scope}（${stats.docs} 篇），以现状代码为准。需要处理 **${main.length}** 项，提示 ${info.length} 项；内容过时候选 ${stats.candidates} 段，模型判断了 ${stats.judged} 段。`, '',
    '| 类别 | 需要处理 | 提示 |', '|---|---|---|']
  for (const k of Object.keys(KIND_ZH)) { const a = count(main, k), b = count(info, k); if (a || b) L.push(`| ${KIND_ZH[k]} | ${a} | ${b} |`) }
  L.push('', '流程：以当前代码为准找出不同 → 拿不准的问用户 → 以代码为准的，改 SPEC / 文档；代码有问题的，记进代码待改清单交给用户开发（这里不改代码）→ 都改完重跑体检，对齐。不需要处理的：`doc-drift ignore <编号>`。', '')
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
  return L.join('\n')
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
