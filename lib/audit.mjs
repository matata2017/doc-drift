/**
 * audit.mjs — 全面核对：先拆成清单，再逐条核，最后对账。
 *
 *   plan    把每篇需求 / 设计 / SPEC 文档拆成"说法"清单（每句、每行表格、每条验收标准、每个流程图），
 *           再从它关联的代码里抽出"代码事实"清单（接口、枚举值、公开方法、文档之后的提交）——
 *           两个方向都要核：文档写了但代码不是这样；代码有了但文档没写。
 *           每篇文档（太长就切块）生成一份任务单，主模型逐份逐条核对（实测便宜模型错判多，不派子代理）。
 *   verify  对账：每条都要有结论；"一致 / 不一致"必须给出真实存在的 文件:行号；缺的、证据不对的列出来退回重评。
 *   review  给主模型复核的清单：全部"不一致"、全部"文档没写"，外加按比例抽查的"一致"。
 *
 * 只管业务上的需求和代码；配置中心、数据库里的数据、外部系统这类，评价时标"不核对"即可。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { inventory } from './check.mjs'
import { inScope } from './doctor.mjs'
import { resolveAnchor } from './scan.mjs'
import { headings, sectionOf, anchorFiles } from './init.mjs'
import * as G from './git.mjs'
import * as P from './project.mjs'

export const CLAIM_VERDICTS = ['一致', '不一致', '不是事实', '不核对']
export const FACT_VERDICTS = ['已写', '没写', '不需要写']
const CHUNK = 60                 // 一份任务单最多多少条（说法 + 事实）
const MAX_FILES = 15             // 一篇文档最多关联多少个代码文件
const dir = (root, ...x) => join(root, P.DIR, 'audit', ...x)
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }

// ---------------------------------------------------------------- 文档 → 说法
/** 每句、每行表格、每条列表、每个代码块（整块算一条）；跳过标题、空行、分隔线、表头分隔行 */
export function splitClaims(text) {
  const lines = text.split(/\r?\n/), hs = headings(text), out = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], t = l.trim()
    if (/^```/.test(t)) {
      const start = i
      while (++i < lines.length && !/^```/.test(lines[i].trim()));
      const body = lines.slice(start, i + 1).join('\n')
      if (body.split('\n').length > 2) out.push({ line: start + 1, section: sectionOf(hs, start + 1)?.title ?? '(开头)', text: body.slice(0, 1500), block: true })
      continue
    }
    if (!t || /^#{1,6}\s/.test(t) || /^(-{3,}|\*{3,}|_{3,})$/.test(t) || /^\|?\s*:?-{2,}/.test(t)) continue
    if (/^\|/.test(t) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) continue   // 表头行
    if (/^>\s*(关联|配置侧|创建时间|作者|版本|所属模块|Spec|状态|更新)/.test(t)) continue                      // 文档元信息
    out.push({ line: i + 1, section: sectionOf(hs, i + 1)?.title ?? '(开头)', text: t.slice(0, 600) })
  }
  return out
}

// ---------------------------------------------------------------- 代码 → 事实
const MAPPING = /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*)?(?:\{\s*)?([^)]*?)\)/g
function codeFacts(root, file) {
  let text
  try { text = readFileSync(join(root, file), 'utf8') } catch { return [] }
  const lines = text.split(/\r?\n/), facts = []
  const at = (re, from = 0) => { for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i; return -1 }
  const enumDecl = /\benum\s+(\w+)/.exec(text)
  if (enumDecl) {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*([A-Z][A-Z0-9_]+)\s*(\(([^)]*)\))?\s*[,;]/.exec(lines[i])
      if (m) facts.push({ kind: '枚举值', text: `${enumDecl[1]}.${m[1]}${m[2] ?? ''}`, file, line: i + 1 })
    }
    return facts
  }
  const isController = /@(Rest)?Controller\b/.test(text)
  if (isController) {
    const cls = text.search(/\bclass\s+\w+/)
    const prefix = (/@RequestMapping\s*\(([^)]*)\)/.exec(text.slice(0, cls > 0 ? cls : text.length))?.[1] ?? '').replace(/value\s*=|[{}\s]/g, '')
    for (let i = 0; i < lines.length; i++) {
      const m = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(([^)]*)\)/.exec(lines[i]) ?? (/@RequestMapping\s*\(([^)]*)\)/.test(lines[i]) && i > at(/\bclass\s+\w+/) ? [null, 'Request', /@RequestMapping\s*\(([^)]*)\)/.exec(lines[i])[1]] : null)
      if (!m) continue
      const path = (m[2] ?? '').replace(/value\s*=|[{}\s]/g, '')
      const mi = at(/\b(public|private|protected)\s+[\w<>\[\],.? ]+\s+(\w+)\s*\(/, i + 1)
      const name = mi >= 0 ? /\b(\w+)\s*\(/.exec(lines[mi].replace(/^.*?\s(\w+)\s*\(/, ' $1('))?.[1] : '?'
      facts.push({ kind: '接口', text: `${m[1].toUpperCase()} ${prefix ? prefix + ' + ' : ''}${path} → ${name}()`, file, line: i + 1 })
    }
    return facts
  }
  // 服务 / 组件：公开方法（跳过 getter / setter / Object 方法）
  if (/\b(class|interface)\s+\w+/.test(text)) {
    const seen = new Set()
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(?:public\s+)?(?:static\s+)?(?:default\s+)?(?:<[^>]+>\s+)?[\w<>\[\],.? ]+\s+(\w+)\s*\([^)]*\)\s*(?:throws [\w., ]+)?\s*[{;]/.exec(lines[i])
      if (!m || !/\bpublic\b|^\s*[\w<>\[\],.? ]+\s+\w+\s*\([^)]*\)\s*;/.test(lines[i])) continue
      const n = m[1]
      if (/^(get|set|is)[A-Z]\w*$/.test(n) && lines[i].length < 90) continue
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'equals', 'hashCode', 'toString'].includes(n) || /^[A-Z]/.test(n) || seen.has(n)) continue   // 大写开头的是构造函数 / throw new Xxx(
      seen.add(n)
      facts.push({ kind: '方法', text: `${file.split('/').pop().replace(/\.\w+$/, '')}.${n}()`, file, line: i + 1 })
    }
  }
  return facts
}

// ---------------------------------------------------------------- plan
export function planAudit(root, { docs: only = [], scope = 'spec' } = {}) {
  const config = P.loadConfig(root) ?? { docInfo: {}, docStatus: {} }
  const inv = inventory(root, config)
  const want = only.map((d) => d.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
  const docs = inv.docs.filter((d) => want.length ? want.some((w) => d.path === w || d.path.startsWith(w + '/'))
    : inScope(config, d.path, scope) && !['historical', 'archived'].includes(P.docStatus(config, d.path)))
  // 重新做计划：清掉上一轮的任务单和结果，免得旧结果被当成新交卷
  rmSync(dir(root, 'tasks'), { recursive: true, force: true }); rmSync(dir(root, 'results'), { recursive: true, force: true }); rmSync(dir(root, 'review.md'), { force: true })
  mkdirSync(dir(root, 'tasks'), { recursive: true }); mkdirSync(dir(root, 'results'), { recursive: true })
  const plan = { createdAt: new Date().toISOString(), docs: [], tasks: [] }
  docs.forEach((d, di) => {
    const claims = splitClaims(d.text).map((c, k) => ({ id: `D${di + 1}-C${k + 1}`, ...c }))
    // 关联代码：文档里还解析得到的引用对应的文件
    const files = new Set()
    for (const a of d.anchors) if (!a.gone && resolveAnchor(a, inv.idx)) for (const f of anchorFiles(a, inv.idx)) files.add(f)
    const related = [...files].filter((f) => /\.(java|kt|ts|js|py|go|xml)$/.test(f)).slice(0, MAX_FILES)
    const facts = related.flatMap((f) => codeFacts(root, f))
    const since = G.lastChanged(root, d.path)
    const commits = related.length ? G.commitsSince(root, related, since + 1000, 15) : []
    facts.push(...commits.map((c) => ({ kind: '提交', text: `${c.hash} ${c.date} ${c.subject}`, file: '', line: 0 })))
    const factItems = facts.map((f, k) => ({ id: `D${di + 1}-K${k + 1}`, ...f }))
    plan.docs.push({ n: di + 1, path: d.path, claims: claims.length, facts: factItems.length, related })
    // 切块：说法按原顺序切；事实放在最后一块（需要通读全文才能判断"文档写没写"）
    const chunks = []
    for (let i = 0; i < claims.length; i += CHUNK) chunks.push({ claims: claims.slice(i, i + CHUNK), facts: [] })
    if (!chunks.length) chunks.push({ claims: [], facts: [] })
    for (let i = 0; i < factItems.length; i += CHUNK) {
      if (i === 0) chunks[chunks.length - 1].facts = factItems.slice(0, CHUNK)
      else chunks.push({ claims: [], facts: factItems.slice(i, i + CHUNK) })
    }
    chunks.forEach((ch, ci) => {
      const id = `T${String(plan.tasks.length + 1).padStart(3, '0')}`
      plan.tasks.push({ id, doc: d.path, claims: ch.claims.map((c) => c.id), facts: ch.facts.map((f) => f.id) })
      writeFileSync(dir(root, 'tasks', `${id}.md`), taskText(root, id, d.path, ci + 1, chunks.length, related, ch.claims, ch.facts))
      writeFileSync(dir(root, 'tasks', `${id}.json`), JSON.stringify({ id, doc: d.path, claims: ch.claims, facts: ch.facts }))
    })
  })
  writeFileSync(dir(root, 'plan.json'), JSON.stringify(plan, null, 1))
  return plan
}

function taskText(root, id, doc, part, parts, related, claims, facts) {
  const esc = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ')
  return [`# 核对任务 ${id}：${doc}${parts > 1 ? `（第 ${part}/${parts} 块）` : ''}`, '',
    `项目根目录：\`${root.replace(/\\/g, '/')}\`。先通读整篇文档 \`${doc}\`，再逐条核对下面每一条。**只读，不改任何文件。**`, '',
    '以**当前代码**为准。每条都必须给结论，一条都不能空：', '',
    '- **说法**（文档写的）：`一致` / `不一致` / `不是事实`（背景、目标、愿景、操作建议，没有可核对的内容）/ `不核对`（配置中心、数据库里的数据、外部系统、前端页面——代码仓库里核不了的）。',
    '  `一致` 和 `不一致` 必须给证据：代码 `文件路径:行号`（相对项目根目录，真实存在的那一行）。`不一致` 还要写清代码现在是什么样、建议文档怎么改。',
    '  不要只看类名、方法名还在不在：要读方法体，核对文档写的**逻辑、条件、状态、顺序、返回值**是否和代码一致。',
    '- **代码事实**（代码里有的）：`已写`（文档哪一行写到了它，给行号）/ `没写`（业务上需要写进文档却没写——例如新接口、新状态、新分支、改了行为的提交）/ `不需要写`（内部实现细节，对业务读者没意义）。',
    '  `没写` 要写建议补什么。提交记录要看改了什么，判断文档是否需要跟着改。', '',
    related.length ? `关联代码文件（从文档里的引用找到的，不限于这些，需要时自己搜）：\n${related.map((f) => '- `' + f + '`').join('\n')}` : '文档里没有能解析到的代码引用：自己按业务名搜索相关代码。', '',
    '## 交卷格式', '',
    `把结果写成 JSON：\`${join(P.DIR, 'audit', 'results', id + '.json').replace(/\\/g, '/')}\`（相对项目根目录）：`, '',
    '```json',
    `{ "task": "${id}", "claims": [ { "id": "D1-C1", "verdict": "不一致", "evidence": "path/to/File.java:123", "code": "代码现在是…", "fix": "文档改为…" } ],`,
    '  "facts": [ { "id": "D1-K1", "verdict": "没写", "docLine": 0, "fix": "补充…" } ] }',
    '```', '',
    claims.length ? '## 说法' : '', '',
    claims.length ? '| 编号 | 行 | 小节 | 原文 |\n|---|---|---|---|\n' + claims.map((c) => `| ${c.id} | ${c.line} | ${esc(c.section).slice(0, 30)} | ${esc(c.text)} |`).join('\n') : '', '',
    facts.length ? '## 代码事实' : '', '',
    facts.length ? '| 编号 | 类型 | 事实 | 位置 |\n|---|---|---|---|\n' + facts.map((f) => `| ${f.id} | ${f.kind} | ${esc(f.text)} | ${f.file ? f.file + ':' + f.line : ''} |`).join('\n') : '',
  ].join('\n')
}

// ---------------------------------------------------------------- verify（对账）
export function verifyAudit(root) {
  const plan = readJson(dir(root, 'plan.json'), null)
  if (!plan) return { error: '还没有核对计划：先 audit plan' }
  const fileLines = new Map()
  const lineCount = (f) => {
    if (!fileLines.has(f)) { try { fileLines.set(f, readFileSync(join(root, f), 'utf8').split(/\r?\n/).length) } catch { fileLines.set(f, 0) } }
    return fileLines.get(f)
  }
  const tasks = plan.tasks.map((t) => {
    const r = readJson(dir(root, 'results', `${t.id}.json`), null)
    const problems = []
    if (!r) return { id: t.id, doc: t.doc, done: false, problems: ['还没交卷'] }
    const cs = new Map((r.claims ?? []).map((c) => [c.id, c])), fs = new Map((r.facts ?? []).map((f) => [f.id, f]))
    for (const id of t.claims) {
      const c = cs.get(id)
      if (!c) { problems.push(`${id} 没有结论`); continue }
      if (!CLAIM_VERDICTS.includes(c.verdict)) { problems.push(`${id} 结论"${c.verdict}"不在 ${CLAIM_VERDICTS.join('/')} 里`); continue }
      if (c.verdict === '一致' || c.verdict === '不一致') {
        const m = /^(.+?):(\d+)/.exec(String(c.evidence ?? '').replace(/\\/g, '/').replace(/^\.?\//, ''))
        if (!m) problems.push(`${id} 缺证据（要 文件:行号）`)
        else if (!lineCount(m[1])) problems.push(`${id} 证据文件不存在：${m[1]}`)
        else if (Number(m[2]) > lineCount(m[1])) problems.push(`${id} 证据行号超出文件：${c.evidence}`)
      }
      if (c.verdict === '不一致' && !c.fix) problems.push(`${id} 不一致但没写建议改法`)
    }
    for (const id of t.facts) {
      const f = fs.get(id)
      if (!f) { problems.push(`${id} 没有结论`); continue }
      if (!FACT_VERDICTS.includes(f.verdict)) problems.push(`${id} 结论"${f.verdict}"不在 ${FACT_VERDICTS.join('/')} 里`)
      if (f.verdict === '没写' && !f.fix) problems.push(`${id} 没写但没给建议补什么`)
    }
    return { id: t.id, doc: t.doc, done: problems.length === 0, problems }
  })
  const totalClaims = plan.tasks.reduce((s, t) => s + t.claims.length, 0), totalFacts = plan.tasks.reduce((s, t) => s + t.facts.length, 0)
  return { tasks, totalClaims, totalFacts, done: tasks.filter((t) => t.done).length, all: tasks.length }
}

// ---------------------------------------------------------------- review（给主模型复核）
export function reviewAudit(root, { sample = 0.2, minSample = 5 } = {}) {
  const plan = readJson(dir(root, 'plan.json'), null)
  if (!plan) return null
  const byDoc = new Map()
  for (const t of plan.tasks) {
    const task = readJson(dir(root, 'tasks', `${t.id}.json`), { claims: [], facts: [] })
    const r = readJson(dir(root, 'results', `${t.id}.json`), { claims: [], facts: [] })
    const e = byDoc.get(t.doc) ?? byDoc.set(t.doc, { mismatch: [], missing: [], ok: [], skipped: 0, total: 0 }).get(t.doc)
    const claimText = new Map(task.claims.map((c) => [c.id, c])), factText = new Map(task.facts.map((f) => [f.id, f]))
    for (const c of r.claims ?? []) {
      e.total++
      const src = claimText.get(c.id) ?? {}
      if (c.verdict === '不一致') e.mismatch.push({ ...c, line: src.line, text: src.text })
      else if (c.verdict === '一致') e.ok.push({ ...c, line: src.line, text: src.text })
      else e.skipped++
    }
    for (const f of r.facts ?? []) { e.total++; if (f.verdict === '没写') e.missing.push({ ...f, text: factText.get(f.id)?.text, where: factText.get(f.id)?.file ? `${factText.get(f.id).file}:${factText.get(f.id).line}` : '' }) }
  }
  const L = ['# 核对汇总', '', '下面是全部**不一致**和**代码有、文档没写**（逐条处理），以及抽出来的一部分**一致**（改文档前再看一眼，防止判错）。', '']
  let mismatch = 0, missing = 0
  for (const [doc, e] of byDoc) {
    mismatch += e.mismatch.length; missing += e.missing.length
    // 抽查：确定性抽样（按编号取等间隔），每篇至少 minSample 条
    const n = Math.min(e.ok.length, Math.max(minSample, Math.ceil(e.ok.length * sample)))
    const step = e.ok.length / Math.max(n, 1), picks = Array.from({ length: n }, (_, i) => e.ok[Math.floor(i * step)])
    L.push(`## ${doc}`, '', `共 ${e.total} 条：不一致 ${e.mismatch.length}，文档没写 ${e.missing.length}，一致 ${e.ok.length}（抽查 ${n}），不是事实 / 不核对 ${e.skipped}`, '')
    if (e.mismatch.length) { L.push('### 不一致（逐条复核）', ''); for (const c of e.mismatch) L.push(`- **${c.id}** 第 ${c.line} 行：${(c.text ?? '').slice(0, 160)}`, `  - 代码：${c.code ?? ''}（${c.evidence}）`, `  - 建议：${c.fix}`) ; L.push('') }
    if (e.missing.length) { L.push('### 代码有、文档没写（逐条复核）', ''); for (const f of e.missing) L.push(`- **${f.id}** ${f.text}${f.where ? `（${f.where}）` : ''}`, `  - 建议：${f.fix}`); L.push('') }
    if (picks.length) { L.push('### 抽查"一致"', ''); for (const c of picks) L.push(`- ${c.id} 第 ${c.line} 行：${(c.text ?? '').slice(0, 120)}（${c.evidence}）`); L.push('') }
  }
  writeFileSync(dir(root, 'review.md'), L.join('\n'))
  return { file: dir(root, 'review.md'), docs: byDoc.size, mismatch, missing }
}

export const auditStatus = (root) => {
  const plan = readJson(dir(root, 'plan.json'), null)
  if (!plan) return null
  const done = existsSync(dir(root, 'results')) ? readdirSync(dir(root, 'results')).filter((f) => f.endsWith('.json')).length : 0
  return { tasks: plan.tasks.length, submitted: done, docs: plan.docs.length }
}
