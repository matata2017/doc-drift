#!/usr/bin/env node
/**
 * doc-drift — 让需求、文档、代码长期对得上。
 *
 *   doc-drift init [--no-model]            认识项目：文档分类（StartLux）、业务域、文档↔代码映射；输出要问用户的问题
 *   doc-drift doctor [--scope spec|ai|all] [--no-model] [--max N] [--json]   体检（默认只查需求/SPEC↔代码），报告写到 .doc-drift/reports/日期.md
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
import { readFileSync, writeFileSync } from 'node:fs'
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
const VALUED = new Set(['--root', '--max', '--scope', '--except'])
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

const STATUS_ZH = { current: '现状文档（要跟代码一致）', historical: '历史记录（不要求同步）', archived: '已废弃' }
const HIST_NAME = /(^|\/)v\d|V\d+\.\d|迁移|清理|切流|改造|task-\d|result\.md|review|changes\//i

/**
 * 拿不准的文档按前两级目录归组，每组给出建议（模型多数意见；平票看名字像不像迭代记录），
 * 组内和建议不一致、模型又比较有把握的，列为例外单独处理。编号 Q1… 存进状态，accept 按编号执行。
 */
function groupQuestions(questions) {
  const groups = new Map()
  for (const q of questions) {
    const segs = q.doc.split('/')
    const dir = segs.length > 1 ? segs.slice(0, Math.min(2, segs.length - 1)).join('/') : q.doc
    ;(groups.get(dir) ?? groups.set(dir, []).get(dir)).push(q)
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length).map(([dir, list], i) => {
    const votes = {}
    for (const q of list) if (q.guess) votes[q.guess] = (votes[q.guess] ?? 0) + 1
    const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1])
    const tie = !ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])
    const recommend = tie ? (HIST_NAME.test(dir) ? 'historical' : 'current') : ranked[0][0]
    const exceptions = list.filter((q) => q.guess && q.guess !== recommend && (q.p ?? 0) >= 0.6).map((q) => ({ doc: q.doc, recommend: q.guess }))
    const reason = tie ? (HIST_NAME.test(dir) ? '名字像某次迭代/变更的记录' : '模型意见各半，按现状处理更稳妥（会继续检查）')
      : `模型倾向 ${ranked.map(([k, v]) => `${k} ${v} 篇`).join('、')}`
    return { id: `Q${i + 1}`, target: dir, docs: list.map((q) => q.doc), recommend, reason, exceptions }
  })
}

function printQuestions(groups) {
  const docs = groups.reduce((n, g) => n + g.docs.length, 0)
  console.log(`\n${docs} 篇文档拿不准是否还代表现状，归成 ${groups.length} 组。建议如下（全部同意：doc-drift accept；个别不同：doc-drift accept --except Q2,Q5 再单独 mark）：`)
  for (const g of groups) {
    console.log(`- ${g.id}「${g.target}」${g.docs.length > 1 ? `里的 ${g.docs.length} 篇` : ''} → 建议：${STATUS_ZH[g.recommend]}（${g.reason}）`)
    for (const e of g.exceptions) console.log(`    例外：${e.doc} → ${STATUS_ZH[e.recommend]}`)
  }
}

/** 定一批文档状态，并把对应的问题从清单里去掉 */
function applyMarks(root, marks, note) {
  const c = P.loadConfig(root)
  c.docStatus = { ...(c.docStatus ?? {}) }
  for (const [path, status] of marks) c.docStatus[path.replace(/\\/g, '/').replace(/\/+$/, '')] = status
  P.saveConfig(root, c)
  const state = P.loadState(root)
  const covered = (doc) => marks.some(([p]) => doc === p || doc.startsWith(p.replace(/\/+$/, '') + '/'))
  state.questions = (state.questions ?? []).filter((q) => !covered(q.doc))
  delete state.questionGroups
  P.saveState(root, state)
  P.appendAnswer(root, note, marks.map(([p, s]) => `\`${p}\` → ${STATUS_ZH[s]}`).join('；'))
}

/** 旧引用 → 新位置，保持原来的写法 */
export function movedReplacement(oldValue, to) {
  const old = oldValue.replace(/^(\.\.?\/)+/, '').replace(/\/+$/, '').split('/')
  const hasExt = /\.\w+$/.test(old.at(-1))
  const parts = to.split('/')
  if (!hasExt) parts[parts.length - 1] = parts.at(-1).replace(/\.\w+$/, '')
  if (old.length === 1) return parts.at(-1)                                   // 原来只写文件名：还是只写文件名
  const i = parts.indexOf(old[0])                                             // 原来从哪一级目录写起，就从那一级写起
  return (i >= 0 ? parts.slice(i) : parts.slice(-old.length)).join('/')
}

function fixMoved(root) {
  const items = DR.lastFindings(root).filter((f) => f.kind === 'moved' && f.to)
  if (!items.length) return console.log('最近一次体检里没有"引用的文件已移动"（先跑 doctor）。')
  const byDoc = new Map()
  for (const f of items) (byDoc.get(f.doc) ?? byDoc.set(f.doc, []).get(f.doc)).push(f)
  let n = 0
  for (const [doc, list] of byDoc) {
    const file = resolve(root, doc)
    let text = readFileSync(file, 'utf8')
    for (const f of list) {
      const rep = movedReplacement(f.anchor.value, f.to)
      for (const wrap of ['`', '**']) {
        const before = wrap + f.anchor.value + wrap
        if (text.includes(before)) { text = text.split(before).join(wrap + rep + wrap); n++; console.log(`  ${doc}：${f.anchor.value} → ${rep}`); break }
      }
    }
    if (!has('--dry')) writeFileSync(file, text)
  }
  console.log(`${has('--dry') ? '共将修改' : '共修改'} ${n} 处${has('--dry') ? '' : '；重跑 doctor 确认'}`)
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
    if (!has('--no-model') && !useModel) console.log(D.KEY_HELP + '\n本次跳过自动分类，文档状态需要按目录判断后 mark。')
    const { config, map, questions, stats } = await I.runInit(root, { useModel, existing, log: (s) => process.stderr.write(s + '\r') })
    P.saveConfig(root, config); P.saveMap(root, map); P.ensureGitignore(root)
    console.log(`\n已初始化 ${root}`)
    const sc = Object.entries(stats.statusCount).filter(([k]) => k !== 'unknown').map(([k, v]) => `${k} ${v}`).join('，')
    const unknown = stats.docs - Object.values(stats.statusCount).reduce((s, v) => s + v, 0) + (stats.statusCount.unknown ?? 0)
    console.log(`文档 ${stats.docs} 篇：${sc || '还没有定状态'}${unknown ? `；未定状态 ${unknown} 篇${useModel ? '' : '（没有 StartLux 密钥：请按目录判断后用 mark 记下）'}` : ''}`)
    console.log(`业务域 ${stats.domains} 个（来自索引表）；与代码耦合的文档 ${stats.mapped} 篇`)
    // 默认不问文档状态：一律以现状代码为准，体检时有不同再逐条问；需要区分历史记录时加 --ask-status
    const s2 = P.loadState(root)
    if (has('--ask-status') && questions.length) { const groups = groupQuestions(questions); s2.questions = questions; s2.questionGroups = groups; printQuestions(groups) } else { s2.questions = []; delete s2.questionGroups }
    P.saveState(root, s2)
    const specs = Object.entries(config.docInfo).filter(([p]) => DR.inScope(config, p, 'spec')).map(([p]) => p)
    console.log(`需求 / 设计 / SPEC 文档 ${specs.length} 篇（默认体检范围，以现状代码为准）：${[...new Set(specs.map((p) => p.split('/').slice(0, 2).join('/')))].slice(0, 12).join('、')}${specs.length > 12 ? ' 等' : ''}`)
    console.log('\n配置：.doc-drift/config.json　映射：.doc-drift/map.json　（建议提交到 git；state/ 已忽略）')
  },

  async doctor() {
    const root = rootOrDie()
    const useModel = !has('--no-model') && !!D.apiKey()
    if (!has('--no-model') && !useModel) console.log(D.KEY_HELP + '\n本次只做规则检查；"内容可能过时"一类只列候选，需要人或 agent 判断。')
    const scope = flag('--scope', 'spec')
    if (!['spec', 'ai', 'all'].includes(scope)) return console.error('--scope 只能是 spec（需求/SPEC，默认）、ai（AI 规则文件）、all（全部）')
    const result = await DR.runDoctor(root, { useModel, scope, maxStale: Number(flag('--max', 40)), log: (s) => process.stderr.write(s + '\r') })
    if (has('--json')) { console.log(JSON.stringify(result.findings, null, 1)); return }
    const md = DR.renderReport(root, result)
    const file = DR.saveReport(root, md, { findings: result.findings })
    const main = result.findings.filter((f) => f.severity !== 'info')
    console.log(`\n体检完成：需要处理 ${main.length} 项（其中 AI 配置文件 ${main.filter((f) => f.aiConfig).length} 项），提示 ${result.findings.length - main.length} 项`)
    if (result.stats.codeTodoClosed || result.stats.codeTodoOpen) console.log(`对齐：代码待改清单本次已对齐 ${result.stats.codeTodoClosed} 条（已打勾），仍待开发 ${result.stats.codeTodoOpen} 条（.doc-drift/code-todo.md）`)
    console.log(`报告：${file}`)
  },

  /** mark <路径> <状态>，或一次多个：mark 路径A=historical 路径B=current */
  mark() {
    const root = rootOrDie()
    const rest = pos.slice(1)
    const marks = rest.length === 2 && D.DOC_STATUS.includes(rest[1]) && !rest[0].includes('=') ? [[rest[0], rest[1]]]
      : rest.map((x) => { const i = x.lastIndexOf('='); return [x.slice(0, i), x.slice(i + 1)] })
    if (!marks.length || marks.some(([p, s]) => !p || !D.DOC_STATUS.includes(s))) return console.error('用法：doc-drift mark <文档或目录> <current|historical|archived>，或 mark 路径A=historical 路径B=current')
    applyMarks(root, marks, '文档状态')
    for (const [p, s] of marks) console.log(`已记下：${p} → ${STATUS_ZH[s]}`)
  },

  /** 按建议标记全部问题组：accept [--except Q2,Q5] */
  accept() {
    const root = rootOrDie()
    const s = P.loadState(root)
    const groups = s.questionGroups ?? groupQuestions(s.questions ?? [])
    if (!groups.length) return console.log('没有待回答的问题。')
    const except = new Set((flag('--except', '') ?? '').split(/[,，\s]+/).filter(Boolean))
    const marks = []
    for (const g of groups) {
      if (except.has(g.id)) continue
      marks.push([g.target, g.recommend])
      for (const e of g.exceptions) marks.push([e.doc, e.recommend])       // 更具体的路径优先，覆盖目录
    }
    applyMarks(root, marks, '按建议标记文档状态')
    console.log(`已按建议标记 ${groups.length - except.size} 组（${marks.length} 条规则）${except.size ? `；留着没标的：${[...except].join('、')}` : ''}`)
  },

  /**
   * 机械性修复（--dry 只列出不改）：
   *   fix links —— "链接路径要改"按报告建议改成相对路径
   *   fix moved —— "引用的文件已移动"改成新位置（保持原来的写法：原来写几段路径就写几段，原来没扩展名就不带）
   */
  fix() {
    const root = rootOrDie()
    if (pos[1] === 'moved') return fixMoved(root)
    if (pos[1] !== 'links') return console.error('用法：doc-drift fix <links|moved> [--dry]')
    const items = DR.lastFindings(root).filter((f) => f.kind === 'absolute-link' && f.fix)
    if (!items.length) return console.log('最近一次体检里没有需要改路径的链接（先跑 doctor）。')
    const byDoc = new Map()
    for (const f of items) (byDoc.get(f.doc) ?? byDoc.set(f.doc, []).get(f.doc)).push(f)
    let n = 0
    for (const [doc, list] of byDoc) {
      const file = resolve(root, doc)
      let text = readFileSync(file, 'utf8')
      for (const f of list) {
        const target = f.anchor.value, anchorPart = target.includes('#') ? target.slice(target.indexOf('#')) : ''
        const before = `](${target})`
        if (!text.includes(before)) continue
        text = text.split(before).join(`](${f.fix}${anchorPart})`)
        n++
      }
      if (!has('--dry')) writeFileSync(file, text)
      console.log(`${has('--dry') ? '将修改' : '已修改'} ${doc}：${list.length} 处`)
    }
    console.log(`${has('--dry') ? '共将修改' : '共修改'} ${n} 处链接${has('--dry') ? '' : '；重跑 doctor 确认'}`)
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

  /**
   * 用户判断"文档才是对的，代码有问题"：doc-drift 不改代码，只把这些条目记进 .doc-drift/code-todo.md，
   * 交给用户自己的改代码流程；以后体检不再拿去问，报告里单列"代码待改"。
   *   code-todo <F编号...> [--note "说明"]
   */
  'code-todo'() {
    const root = rootOrDie()
    const ids = new Set(pos.slice(1))
    const found = DR.lastFindings(root).filter((f) => ids.has(f.id))
    if (!found.length) return console.error('用法：doc-drift code-todo <F编号...> [--note "说明"]（编号来自最近一次 doctor 报告）')
    const note = flag('--note', '')
    const c = P.loadConfig(root)
    c.codeTodo = [...new Set([...(c.codeTodo ?? []), ...found.map(DR.signature)])]
    P.saveConfig(root, c)
    P.appendCodeTodo(root, found, note)
    console.log(`已记入 .doc-drift/code-todo.md：${found.map((f) => f.id).join(' ')}（不改代码，交给你的改代码流程）`)
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

  /** resolve P1 P2 … <done|skip> */
  resolve() {
    const root = rootOrDie()
    const how = pos.at(-1), ids = pos.slice(1, -1)
    if (!['done', 'skip'].includes(how) || !ids.length) return console.error('用法：doc-drift resolve <P编号...> <done|skip>')
    const s = P.loadState(root)
    for (const id of ids) {
      const p = s.pending.find((x) => x.id === id)
      if (!p) { console.error(`没有 ${id}`); continue }
      p.resolved = how; p.resolvedAt = new Date().toISOString()
      P.log(root, { event: 'resolve', id, how })
      console.log(`${id} → ${how}`)
    }
    P.saveState(root, s)
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

  /** 还没回答的问题（--json 给 agent 做成选择题） */
  questions() {
    const root = rootOrDie()
    const s = P.loadState(root)
    const q = s.questions ?? []
    if (!q.length) return console.log(has('--json') ? '[]' : '没有待回答的问题。')
    const groups = groupQuestions(q)
    s.questionGroups = groups; P.saveState(root, s)
    if (has('--json')) return console.log(JSON.stringify(groups, null, 1))
    printQuestions(groups)
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
    console.log(`StartLux 密钥 ${D.apiKey() ? '已配置' : '未配置\n  ' + D.KEY_HELP}`)
    if (D.apiKey()) {
      try { await D.ask('ping', { ok: { type: 'choice', instructions: 'Is this a test?', criteria: ['yes', 'no'] } }, { timeoutMs: 15000 }); console.log('接口 OK') }
      catch (e) { console.log('接口失败：' + e.message) }
    }
  },
}

const run = cmds[args[0]]
if (!run) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 18).map((l) => l.replace(/^ \* ?/, '')).join('\n')); process.exit(args[0] ? 1 : 0) }
Promise.resolve(run()).catch((e) => { if (args[0] !== 'hook' || process.env.DOC_DRIFT_DEBUG) { console.error(e); process.exitCode = 1 } })
