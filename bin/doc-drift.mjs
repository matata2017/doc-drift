#!/usr/bin/env node
/**
 * doc-drift — 让需求、文档、代码长期对得上。
 *
 *   doc-drift init [--no-model]            认识项目：文档分类（StartLux）、业务域、文档↔代码映射；输出要问用户的问题
 *   doc-drift doctor [--no-model] [--max N] [--json]   全面体检，报告写到 .doc-drift/reports/日期.md
 *   doc-drift mark <文档或目录> <current|historical|archived>   定文档状态（历史记录不要求跟代码同步）
 *   doc-drift answer "<问题>" "<结论>"     记下用户的结论（之后不再重复问）
 *   doc-drift ignore <F编号...>            这些体检项不需要处理，以后不再报
 *   doc-drift pending                      日常钩子攒下的待办
 *   doc-drift resolve <P编号> <done|skip>  处理完/跳过一条待办
 *   doc-drift label <P编号> <right|wrong>  标注提醒对不对（用来调阈值）
 *   doc-drift mode <observe|remind>        钩子模式：只记录 / 对话里一行提醒
 *   doc-drift status                       概况
 *   doc-drift hook                         作为钩子运行（Codex / Claude Code / DSH 通用）
 *   doc-drift doctor-check                 检查环境（Node、git、StartLux 密钥）
 * 通用参数：--root <项目目录>（默认从当前目录往上找 .doc-drift/）
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as P from '../lib/project.mjs'
import * as I from '../lib/init.mjs'
import * as DR from '../lib/doctor.mjs'
import * as H from '../lib/hook.mjs'
import * as D from '../lib/decide.mjs'
import * as G from '../lib/git.mjs'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const has = (n) => args.includes(n)
const VALUED = new Set(['--root', '--max'])
const pos = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]))

function rootOrDie({ allowNew = false } = {}) {
  const given = flag('--root')
  if (given) return resolve(given)
  const r = P.findRoot()
  if (r) return r
  if (allowNew) return process.cwd()
  console.error('这里还没有初始化（找不到 .doc-drift/config.json）。先在项目根目录跑：doc-drift init')
  process.exit(1)
}

/** 拿不准的文档按目录归组：同一目录一起问，一次 mark 整个目录 */
function printQuestions(questions) {
  const groups = new Map()
  // 取前两级目录归组（mdfile/v1.7/financial-report → mdfile/v1.7），问题少一半
  for (const q of questions) { const segs = q.doc.split('/'); const dir = segs.length > 1 ? segs.slice(0, Math.min(2, segs.length - 1)).join('/') : '（根目录）'; (groups.get(dir) ?? groups.set(dir, []).get(dir)).push(q) }
  console.log(`\n需要问用户：${questions.length} 篇文档拿不准是否还代表现状，按目录归成 ${groups.size} 个问题：`)
  for (const [dir, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const votes = {}
    for (const q of list) votes[q.guess ?? '?'] = (votes[q.guess ?? '?'] ?? 0) + 1
    const lean = Object.entries(votes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('、')
    const names = list.map((q) => q.doc.split('/').pop()).join('、')
    console.log(`- 「${dir}/」里的 ${list.length} 篇（${names.slice(0, 120)}）还代表现状吗？模型倾向：${lean}`)
    console.log(`  整个目录：doc-drift mark "${dir === '（根目录）' ? list[0].doc : dir}" <current|historical|archived>${list.length > 1 ? '；个别不同的再单独 mark 文件' : ''}`)
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let s = ''
  process.stdin.setEncoding('utf8')
  for await (const c of process.stdin) s += c
  return s
}

const cmds = {
  async init() {
    const root = rootOrDie({ allowNew: true })
    const existing = P.loadConfig(root)
    const useModel = !has('--no-model') && !!D.apiKey()
    if (!has('--no-model') && !useModel) console.log('没有 StartLux 密钥（DOC_DRIFT_API_KEY / BAMBOO_API_KEY），跳过自动分类；文档状态需要手动 mark。')
    const { config, map, questions, stats } = await I.runInit(root, { useModel, existing, log: (s) => process.stderr.write(s + '\r') })
    P.saveConfig(root, config); P.saveMap(root, map); P.ensureGitignore(root)
    const state = P.loadState(root); state.questions = questions; P.saveState(root, state)
    console.log(`\n已初始化 ${root}`)
    console.log(`文档 ${stats.docs} 篇（本次分类 ${stats.classified} 篇）：${Object.entries(stats.statusCount).map(([k, v]) => `${k} ${v}`).join('，')}`)
    console.log(`业务域 ${stats.domains} 个（来自索引表）；与代码耦合的文档 ${stats.mapped} 篇`)
    if (questions.length) printQuestions(questions)
    console.log('\n配置：.doc-drift/config.json　映射：.doc-drift/map.json　（建议提交到 git；state/ 已忽略）')
  },

  async doctor() {
    const root = rootOrDie()
    const useModel = !has('--no-model') && !!D.apiKey()
    const result = await DR.runDoctor(root, { useModel, maxStale: Number(flag('--max', 40)), log: (s) => process.stderr.write(s + '\r') })
    if (has('--json')) { console.log(JSON.stringify(result.findings, null, 1)); return }
    const md = DR.renderReport(root, result)
    const file = DR.saveReport(root, md, { findings: result.findings })
    const main = result.findings.filter((f) => f.severity !== 'info')
    console.log(`\n体检完成：需要处理 ${main.length} 项（其中 AI 配置文件 ${main.filter((f) => f.aiConfig).length} 项），提示 ${result.findings.length - main.length} 项`)
    console.log(`报告：${file}`)
  },

  mark() {
    const root = rootOrDie()
    const [, path, status] = pos
    if (!path || !D.DOC_STATUS.includes(status)) return console.error('用法：doc-drift mark <文档或目录> <current|historical|archived>')
    const c = P.loadConfig(root)
    c.docStatus = { ...(c.docStatus ?? {}), [path.replace(/\\/g, '/')]: status }
    P.saveConfig(root, c)
    P.appendAnswer(root, `「${path}」的状态`, status === 'current' ? '代表现状，要跟代码保持一致' : status === 'historical' ? '历史记录，不要求跟代码同步' : '已归档')
    const state = P.loadState(root); state.questions = (state.questions ?? []).filter((q) => q.doc !== path && !q.doc?.startsWith(path.replace(/\/+$/, '') + '/')); P.saveState(root, state)
    console.log(`已记下：${path} → ${status}`)
  },

  answer() {
    const root = rootOrDie()
    const [, q, a] = pos
    if (!q || !a) return console.error('用法：doc-drift answer "<问题>" "<结论>"')
    P.appendAnswer(root, q, a)
    console.log('已记入 .doc-drift/answers.md')
  },

  ignore() {
    const root = rootOrDie()
    const ids = new Set(pos.slice(1))
    const found = DR.lastFindings(root).filter((f) => ids.has(f.id))
    if (!found.length) return console.error('没找到这些编号（编号来自最近一次 doctor 报告）')
    const c = P.loadConfig(root)
    c.ignore = [...new Set([...(c.ignore ?? []), ...found.map(DR.signature)])]
    P.saveConfig(root, c)
    console.log(`以后不再报：${found.map((f) => f.id).join(' ')}`)
  },

  pending() {
    const root = rootOrDie()
    const list = H.openPending(P.loadState(root))
    if (!list.length) return console.log('没有待办。')
    for (const p of list) {
      if (p.type === 'requirement') console.log(`${p.id} [需求${p.kind === 'new' ? '新增' : '变更'}] 「${p.prompt}」→ 应记入：${p.doc ?? '（未定，看业务域）'}`)
      else if (p.type === 'stale') console.log(`${p.id} [文档可能过时] ${p.doc} 第 ${p.line} 行「${p.section}」← 代码已改：${p.files.join('、')}（把握 ${p.p}）`)
      else console.log(`${p.id} [新接口没有文档] ${p.file}`)
    }
    console.log('\n处理完：doc-drift resolve <编号> done　跳过：doc-drift resolve <编号> skip')
  },

  resolve() {
    const root = rootOrDie()
    const [, id, how] = pos
    if (!['done', 'skip'].includes(how)) return console.error('用法：doc-drift resolve <P编号> <done|skip>')
    const s = P.loadState(root)
    const p = s.pending.find((x) => x.id === id)
    if (!p) return console.error('没有这个编号')
    p.resolved = how; p.resolvedAt = new Date().toISOString()
    P.saveState(root, s); P.log(root, { event: 'resolve', id, how })
    console.log(`${id} → ${how}`)
  },

  label() {
    const root = rootOrDie()
    const [, id, verdict] = pos
    if (!['right', 'wrong'].includes(verdict)) return console.error('用法：doc-drift label <P编号> <right|wrong>')
    P.log(root, { event: 'label', id, verdict })
    console.log('已记录')
  },

  mode() {
    const root = rootOrDie()
    const m = pos[1]
    if (!['observe', 'remind'].includes(m)) return console.error('用法：doc-drift mode <observe|remind>')
    const c = P.loadConfig(root); c.hook = { ...(c.hook ?? {}), mode: m }; P.saveConfig(root, c)
    console.log(`钩子模式：${m === 'observe' ? '只记录，不在对话里提醒' : '有待办时在对话里提醒一行'}`)
  },

  questions() {
    const root = rootOrDie()
    const q = P.loadState(root).questions ?? []
    if (!q.length) return console.log('没有待回答的问题。')
    printQuestions(q)
  },

  status() {
    const root = rootOrDie()
    const c = P.loadConfig(root), s = P.loadState(root)
    const st = {}
    for (const [path, v] of Object.entries(c.docInfo ?? {})) { const k = P.docStatus(c, path) ?? v.status ?? 'unknown'; st[k] = (st[k] ?? 0) + 1 }
    console.log(`项目：${root}\n文档状态：${Object.entries(st).map(([k, v]) => `${k} ${v}`).join('，')}\n钩子模式：${c.hook?.mode ?? 'observe'}\n待办：${H.openPending(s).length} 条（已处理 ${s.pending.length - H.openPending(s).length}）\n未回答的问题：${(s.questions ?? []).length} 个`)
  },

  async hook() {
    let payload
    try { payload = JSON.parse((await readStdin()) || 'null') } catch { return }
    if (!payload) return
    const out = await H.handleHook(payload)
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  },

  async 'scan-changes'() {
    const root = rootOrDie()
    const r = await H.scanChanges(root)
    if (!has('--quiet')) console.log(JSON.stringify(r))
  },

  async 'doctor-check'() {
    const [maj, min] = process.versions.node.split('.').map(Number)
    console.log(`node ${process.versions.node} ${maj > 18 || (maj === 18 && min >= 17) ? 'OK' : '需要 ≥ 18.17'}`)
    console.log(`git ${G.isRepo(process.cwd()) ? '当前目录是 git 仓库' : '当前目录不是 git 仓库（历史检查会跳过）'}`)
    console.log(`StartLux 密钥 ${D.apiKey() ? '已配置' : '未配置（DOC_DRIFT_API_KEY 或 BAMBOO_API_KEY）'}`)
    if (D.apiKey()) {
      try { await D.ask('ping', { ok: { type: 'choice', instructions: 'Is this a test?', criteria: ['yes', 'no'] } }, { timeoutMs: 15000 }); console.log('接口 OK') }
      catch (e) { console.log('接口失败：' + e.message) }
    }
  },
}

const run = cmds[args[0]]
if (!run) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 18).map((l) => l.replace(/^ \* ?/, '')).join('\n')); process.exit(args[0] ? 1 : 0) }
Promise.resolve(run()).catch((e) => { if (args[0] !== 'hook' || process.env.DOC_DRIFT_DEBUG) { console.error(e); process.exitCode = 1 } })
