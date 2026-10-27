/**
 * check.mjs — doctor 第一层：确定性检查，不调模型、零误报优先。
 *   outdated     文档引用的代码元素现在找不到，而 git 历史里有过（删掉/改名了）——高把握过时（DOCER）
 *   unresolved   文档引用的东西现在找不到，历史里也没见过（可能根本不是代码引用）——只做提示
 *   resurrected  文档说"已删/下线"，代码里却还在
 *   broken-link  文档里的本地链接指向不存在的文件
 *   undocumented 有接口的 Controller，没有任何文档提到
 * AI 配置文件（AGENTS.md、CLAUDE.md…）每个会话都会被读，排最前（Context Rot）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, basename, relative, sep } from 'node:path'
import { walk, indexCode, scanDocs, resolveAnchor, linkExists } from './scan.mjs'
import * as G from './git.mjs'

const KIND_ZH = { file: '文件', dir: '目录', class: '类', method: '方法', endpoint: '接口路径', table: '表' }
const AI_CONFIG = /(^|\/)(AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.cursorrules|copilot-instructions\.md)$|(^|\/)\.cursor\/rules\//i
export const isAiConfig = (p) => AI_CONFIG.test(p)
const SEV_RANK = { error: 0, warn: 1, info: 2 }

export function inventory(root, config = {}) {
  const files = walk(root, { exclude: config.exclude })
  const docGlobs = config.docs?.length ? config.docs.map((d) => d.replace(/\/+$/, '')) : null
  const isDoc = (f) => /\.md$/i.test(f) && (!docGlobs || docGlobs.some((d) => f === d || f.startsWith(d + '/')))
    && !(config.ignoreDocs ?? []).some((d) => f === d || f.startsWith(d.replace(/\/+$/, '') + '/'))
  const codeFiles = config.code?.length ? files.filter((f) => config.code.some((c) => f.startsWith(c.replace(/\/+$/, '') + '/'))) : files
  const idx = indexCode(root, codeFiles)
  const docs = scanDocs(root, files, isDoc)
  for (const d of docs) { try { d.text = readFileSync(join(root, d.path), 'utf8') } catch { d.text = '' } }
  return { files, idx, docs }
}

/** 文件/目录类锚点：代码索引里没有，也可能是仓库里真实存在的非代码文件或工具目录 */
function onDisk(root, docPath, value) {
  const v = value.replace(/\/+$/, '')
  return [join(root, v), join(root, dirname(docPath), v)].some((p) => { try { return existsSync(p) } catch { return false } })
}

/** e:/workFile/pinrong-online/a/b.java:12 → 相对本文档的 ../../a/b.java（项目里真有这个文件时） */
function relativizeForeign(root, docPath, target) {
  const clean = target.split('#')[0].replace(/:\d+(:\d+)?$/, '').replace(/\\/g, '/')
  if (!/^\/?[a-z]:\//i.test(clean)) return null
  const name = basename(root.replace(/[\\/]+$/, ''))
  const i = clean.toLowerCase().lastIndexOf('/' + name.toLowerCase() + '/')
  if (i < 0) return null
  const inProject = clean.slice(i + name.length + 2)
  if (!existsSync(join(root, inProject))) return null
  return relative(dirname(join(root, docPath)), join(root, inProject)).split(sep).join('/')
}

/** "以前有过"：删除过的文件里有它；或抽样的历史版本代码里出现过这个名字 */
function historyEvidence(root, missing) {
  if (!G.isRepo(root)) return () => null
  const moved = G.movedPaths(root)                                      // 旧路径 → 新路径（改名/移动）或 null（删除）
  const deleted = [...moved.keys()]
  const byName = new Map()
  for (const p of deleted) for (const n of [basename(p), basename(p).replace(/\.\w+$/, '')]) (byName.get(n) ?? byName.set(n, []).get(n)).push(p)
  const needTokens = missing.some((a) => ['class', 'method', 'endpoint', 'table'].includes(a.kind))
  const { tokens, paths } = needTokens ? G.historicalTokens(root, G.sampleRevs(root)) : { tokens: new Set(), paths: new Set() }
  const pathHit = (v) => { for (const p of paths) if (p === v || p.endsWith(v) || v.endsWith(p) && p.length > 3) return true; return false }
  // 删除的东西按所在目录归组（business/rule/impl 删了 → 一题问完），移动的给出新位置
  const verdict = (p) => {
    const to = moved.get(p)
    if (to && existsSync(join(root, to))) return { how: 'moved', from: p, to }
    return { how: 'deleted', from: p, cause: dirname(p).split('/').slice(-3).join('/') }
  }
  return (a) => {
    const v = a.value.replace(/\/+$/, '')
    if (a.kind === 'file' || a.kind === 'dir') {
      let hit
      if (v.includes('*')) {                                               // controller/ApplyPay*.java
        const re = new RegExp('(^|/)' + v.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '($|/)')
        hit = deleted.find((p) => re.test(p))
      } else hit = deleted.find((p) => p === v || p.endsWith('/' + v)) ?? deleted.find((p) => p.includes('/' + v + '/') || p.startsWith(v + '/'))
      hit ??= byName.get(basename(v))?.[0]
      if (!hit) return null
      const r = verdict(hit)
      if (a.kind === 'dir' && r.how === 'deleted') r.cause = v.split('/').slice(-3).join('/')   // 整个目录删了：以目录本身为原因
      return r
    }
    if (a.kind === 'class' && byName.has(v)) return verdict(byName.get(v)[0])
    if (a.kind === 'endpoint') return pathHit(v) ? { how: 'history', cause: '接口路径 ' + v.split('/').slice(0, 3).join('/') } : null
    return tokens.has(v) ? { how: 'history', cause: v } : null
  }
}

export function deterministicChecks(root, inv) {
  const { files, idx, docs } = inv
  const all = new Set(files)
  const raw = []
  for (const d of docs) {
    const seen = new Set()
    for (const a of d.anchors) {
      const key = `${a.kind}:${a.value}:${a.gone}`
      if (seen.has(key)) continue
      seen.add(key)
      let found = resolveAnchor(a, idx)
      if (found === null) continue                                        // 无从判断（例如项目里没有表结构）
      if (!found && (a.kind === 'file' || a.kind === 'dir') && onDisk(root, d.path, a.value)) found = true
      // 现状代码里还在用的名字（框架里的类如 TenantEntity、字段名如 tenant_id）：不是过时
      if (!found && ['class', 'method', 'table'].includes(a.kind) && idx.tokens.has(a.value)) found = true
      if (!a.gone && !found) raw.push({ type: 'missing', d, a })
      if (a.gone && found && ['class', 'file', 'dir'].includes(a.kind)) raw.push({ type: 'resurrected', d, a })
    }
    for (const l of d.links) if (!linkExists(root, d.path, l.target, all)) raw.push({ type: 'broken-link', d, l })
  }
  const evidence = historyEvidence(root, raw.filter((r) => r.type === 'missing').map((r) => r.a))

  const findings = []
  const add = (f) => findings.push(f)
  for (const r of raw) {
    const ai = isAiConfig(r.d.path)
    if (r.type === 'missing') {
      const ev = evidence(r.a)
      if (ev?.how === 'moved') add({ kind: 'moved', severity: 'warn', doc: r.d.path, line: r.a.line, aiConfig: ai, anchor: r.a, cause: '文件移动/改名', to: ev.to,
        detail: `文档引用的${KIND_ZH[r.a.kind]} \`${r.a.value}\` 已移动到 \`${ev.to}\``, fix: ev.to, text: r.a.text })
      else if (ev) add({ kind: 'outdated', severity: ['file', 'dir', 'class'].includes(r.a.kind) ? 'error' : 'warn', doc: r.d.path, line: r.a.line, aiConfig: ai, anchor: r.a, cause: ev.cause,
        detail: `文档引用的${KIND_ZH[r.a.kind]} \`${r.a.value}\` 已不在代码里（${ev.how === 'deleted' ? `git 历史里已删除：${ev.from}` : '以前的版本里有'}）`, text: r.a.text })
      else add({ kind: 'unresolved', severity: 'info', doc: r.d.path, line: r.a.line, aiConfig: ai, anchor: r.a,
        detail: `\`${r.a.value}\` 在代码和 git 历史里都找不到（可能不是代码引用，或从未提交）`, text: r.a.text })
    } else if (r.type === 'resurrected') {
      add({ kind: 'resurrected', severity: 'warn', doc: r.d.path, line: r.a.line, aiConfig: ai, anchor: r.a,
        detail: `文档说 \`${r.a.value}\` 已删除/下线，但代码里还在`, text: r.a.text })
    } else {
      // 别人机器上的绝对路径（e:/workFile/<项目名>/x）：项目里有 x 就建议改成相对路径
      const fixed = relativizeForeign(root, r.d.path, r.l.target)
      const fromRoot = !fixed && existsSync(join(root, r.l.target.split('#')[0].replace(/:\d+(:\d+)?$/, '')))
        ? relative(dirname(join(root, r.d.path)), join(root, r.l.target.split('#')[0].replace(/:\d+(:\d+)?$/, ''))).split(sep).join('/') : null
      const outside = !fixed && !fromRoot && /^(\.\.\/)+/.test(r.l.target) && !existsSync(dirname(join(root, dirname(r.d.path), r.l.target.split('#')[0])))
      if (fixed) add({ kind: 'absolute-link', severity: 'warn', doc: r.d.path, line: r.l.line, aiConfig: ai, anchor: { kind: 'link', value: r.l.target },
        detail: `链接用了别的机器上的绝对路径，改成相对路径 \`${fixed}\` 即可`, fix: fixed, text: r.l.text })
      else if (fromRoot) add({ kind: 'absolute-link', severity: 'warn', doc: r.d.path, line: r.l.line, aiConfig: ai, anchor: { kind: 'link', value: r.l.target },
        detail: `链接是相对仓库根目录写的，从本文件打开会断；改成 \`${fromRoot}\` 即可`, fix: fromRoot, text: r.l.text })
      else if (outside) add({ kind: 'external-link', severity: 'info', doc: r.d.path, line: r.l.line, aiConfig: ai, anchor: { kind: 'link', value: r.l.target },
        detail: `链接指向仓库外（\`${r.l.target}\`），无法检查`, text: r.l.text })
      else add({ kind: 'broken-link', severity: 'error', doc: r.d.path, line: r.l.line, aiConfig: ai, anchor: { kind: 'link', value: r.l.target },
        detail: `链接 \`${r.l.target}\` 指向的文件不存在`, text: r.l.text })
    }
  }
  // 有接口却没有任何文档提到的 Controller
  const corpus = docs.map((d) => d.text).join('\n')
  for (const [name, c] of idx.controllers) {
    if (!c.endpoints || corpus.includes(name) || (c.prefix && corpus.includes(c.prefix))) continue
    add({ kind: 'undocumented', severity: 'info', doc: null, line: null, aiConfig: false, anchor: { kind: 'class', value: name },
      detail: `\`${name}\`（${c.endpoints} 个接口，${c.file}）没有任何文档提到`, text: '' })
  }
  findings.sort((x, y) => Number(y.aiConfig) - Number(x.aiConfig) || SEV_RANK[x.severity] - SEV_RANK[y.severity]
    || String(x.doc).localeCompare(String(y.doc)) || (x.line ?? 0) - (y.line ?? 0))
  findings.forEach((f, i) => { f.id = `D${String(i + 1).padStart(3, '0')}` })
  return findings
}

export function summarize(findings) {
  const by = (k) => findings.filter((f) => f.kind === k).length
  return { total: findings.length, outdated: by('outdated'), moved: by('moved'), unresolved: by('unresolved'), resurrected: by('resurrected'),
    brokenLinks: by('broken-link'), absoluteLinks: by('absolute-link'), undocumented: by('undocumented'), aiConfig: findings.filter((f) => f.aiConfig && f.severity !== 'info').length }
}
