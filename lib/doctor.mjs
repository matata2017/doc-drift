/**
 * doctor.mjs — 全面体检。
 *   第一层：确定性检查（check.mjs）；按文档状态定级——历史记录、已归档的文档不要求跟代码同步，降为提示
 *   第二层：内容过时（D5）——耦合的代码在文档最后一次更新之后改过 → StartLux 判"是否已过时"
 *   第三层由 agent 按 SKILL.md 做：看报告、起草改动、问用户、改、记答复、再跑一遍
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inventory, deterministicChecks } from './check.mjs'
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

export async function runDoctor(root, { useModel = true, maxStale = 40, log = () => {} } = {}) {
  const config = P.loadConfig(root) ?? { docInfo: {}, docStatus: {} }
  const inv = inventory(root, config)
  const ignore = new Set(config.ignore ?? [])
  const status = (path) => P.docStatus(config, path) ?? config.docInfo?.[path]?.status ?? null

  // 第一层
  const findings = deterministicChecks(root, inv).filter((f) => !ignore.has(signature(f)))
  for (const f of findings) {
    const s = f.doc ? status(f.doc) : null
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
  return { findings, map, stats: { docs: inv.docs.length, candidates: candidates.length, judged, unclassified: inv.docs.filter((d) => !status(d.path)).length } }
}

// ---------------------------------------------------------------- 报告
const KIND_ZH = { outdated: '引用已过时', resurrected: '说已删除但还在', 'broken-link': '断链', 'absolute-link': '链接路径要改', 'external-link': '仓库外链接',
  unresolved: '找不到的引用', undocumented: '没有文档的接口', stale: '内容可能过时' }

export function renderReport(root, result, { infoLimit = 30 } = {}) {
  const { findings, stats } = result
  const main = findings.filter((f) => f.severity !== 'info'), info = findings.filter((f) => f.severity === 'info')
  const count = (list, k) => list.filter((f) => f.kind === k).length
  const L = [`# 文档漂移体检报告`, '', `项目：\`${root}\`　时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '',
    `文档 ${stats.docs} 篇；需要处理 **${main.length}** 项，提示 ${info.length} 项；内容过时候选 ${stats.candidates} 段，模型判断了 ${stats.judged} 段${stats.unclassified ? `；还有 ${stats.unclassified} 篇文档没定状态（跑 init）` : ''}。`, '',
    '| 类别 | 需要处理 | 提示 |', '|---|---|---|']
  for (const k of Object.keys(KIND_ZH)) { const a = count(main, k), b = count(info, k); if (a || b) L.push(`| ${KIND_ZH[k]} | ${a} | ${b} |`) }
  L.push('', '处理方式：逐组看下面的条目 → 起草改动 → 拿不准以谁为准的先问人 → 改完重跑 `doc-drift doctor` 确认消掉。不需要处理的：`doc-drift ignore <编号>`。', '')

  const byDoc = new Map()
  for (const f of main) (byDoc.get(f.doc ?? '（无文档）') ?? byDoc.set(f.doc ?? '（无文档）', []).get(f.doc ?? '（无文档）')).push(f)
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
  if (info.length) {
    L.push('## 提示（不一定要处理）', '')
    const groups = new Map()
    for (const f of info) (groups.get(f.kind) ?? groups.set(f.kind, []).get(f.kind)).push(f)
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
