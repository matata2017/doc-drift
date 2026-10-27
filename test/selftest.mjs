// selftest.mjs — 不需要密钥、不碰真实项目：临时 git 仓库 + 本地假决策接口，跑通 init / doctor / 钩子
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import assert from 'node:assert/strict'

const root = mkdtempSync(join(tmpdir(), 'doc-drift-test-'))
const w = (p, s) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s) }
const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' })

// ---------------------------------------------------------------- 假项目
const JAVA = (pkg, cls, body = '') => `package ${pkg};\npublic class ${cls} {\n${body}\n}\n`
w('src/main/java/demo/OrderController.java', `package demo;\n@RestController\n@RequestMapping("/order")\npublic class OrderController {\n  @PostMapping("/submit")\n  public String submit() { return "ok"; }\n}\n`)
w('src/main/java/demo/OrderService.java', JAVA('demo', 'OrderService', '  public int price(int n) { return n * 10; }'))
w('src/main/java/demo/OldRuleExecutor.java', JAVA('demo', 'OldRuleExecutor'))
w('src/main/java/demo/LegacyUtils.java', JAVA('demo', 'LegacyUtils'))
git('init', '-q'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
// 删掉 OldRuleExecutor：文档里还引用它 → 过时（以前有过）
unlinkSync(join(root, 'src/main/java/demo/OldRuleExecutor.java'))
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'remove old rules')

w('CLAUDE.md', '# 项目说明\n\n- 规则引擎：`OldRuleExecutor` 负责校验。\n- 下单入口：`OrderController`，接口 `POST /order/submit`。\n')
w('docs/order/design.md', '# 下单设计\n\n## 价格计算\n\n`OrderService` 按数量乘 10 计价。\n\n见 [需求](./requirements.md)、[旧文档](./gone.md)、[代码](E:/someone/' + root.split(/[\/]/).pop() + '/src/main/java/demo/OrderService.java)。\n')
w('docs/order/requirements.md', '# 下单需求\n\n用户可以提交订单。\n')
w('docs/cleanup/plan.md', '# v1.2 清理记录\n\n（本地 `LegacyUtils` 已删）\n删除了 `OldRuleExecutor`。\n')
w('docs/notes.md', '# 杂记\n\n`NeverExistedService` 是外部系统的类。\n')
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'docs')

// ---------------------------------------------------------------- 假决策接口
let calls = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d)).on('end', () => {
    calls++
    const { questions, state } = JSON.parse(body)
    const answers = {}
    for (const [id, q] of Object.entries(questions)) {
      const keys = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria)
      let pick = keys[0]
      if (id.startsWith('type_')) pick = keys.find((k) => k.startsWith(/requirements\.md/.test(q.instructions) ? 'requirements' : 'design'))
      if (id.startsWith('status_')) pick = keys.find((k) => k.startsWith(/cleanup/.test(q.instructions) ? 'historical' : /notes/.test(q.instructions) ? 'zzz' : 'current')) ?? keys[0]
      if (id.startsWith('status_') && /notes/.test(q.instructions)) { answers[id] = { probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])) }; continue }
      if (/^s\d+$/.test(id)) pick = keys.find((k) => k.startsWith(/\* 20/.test(state) ? 'outdated' : 'accurate'))
      if (id === 'req') pick = keys.find((k) => k.startsWith(/以后|要加/.test(state) ? 'new' : 'none'))
      if (id === 'doc') pick = keys.find((k) => /requirements/.test(k)) ?? keys.at(-1)
      answers[id] = { choice: pick, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 0.92 : 0.08 / (keys.length - 1)])) }
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ answers }))
  })
})
await new Promise((r) => server.listen(0, r))
process.env.DOC_DRIFT_ENDPOINT = `http://127.0.0.1:${server.address().port}/v1/decisions`
process.env.DOC_DRIFT_API_KEY = 'test'

const P = await import('../lib/project.mjs')
const I = await import('../lib/init.mjs')
const DR = await import('../lib/doctor.mjs')
const H = await import('../lib/hook.mjs')
const S = await import('../lib/scan.mjs')
let ok = 0
const t = async (name, fn) => { await fn(); ok++; console.log('✓ ' + name) }

try {
  await t('识别代码引用：接口、类、分句级"已删"，排除文档/占位符/分支名', () => {
    assert.deepEqual(S.classify('POST /order/submit'), { kind: 'endpoint', value: '/order/submit' })
    assert.equal(S.classify('MILESTONES.md'), null)
    assert.equal(S.classify('application-{profile}.yml'), null)
    assert.equal(S.classify('origin/dev-2.0'), null)
    assert.equal(S.classify('GIVEN / WHEN / THEN'), null)
    const { anchors } = S.docAnchors('`third/decisionengine/`（本地 `pricingRule/` 已删）')
    assert.deepEqual(anchors.map((a) => [a.value, a.gone]), [['third/decisionengine/', false], ['pricingRule/', true]])
  })

  await t('init：AI 配置直接定、模型分类、拿不准的进问题清单；生成文档↔代码映射', async () => {
    const r = await I.runInit(root, { useModel: true })
    P.saveConfig(root, r.config); P.saveMap(root, r.map); P.ensureGitignore(root)
    assert.equal(r.config.docInfo['CLAUDE.md'].type, 'ai_config')
    assert.equal(r.config.docInfo['docs/cleanup/plan.md'].status, 'historical')
    assert.equal(r.config.docInfo['docs/order/requirements.md'].type, 'requirements')
    assert.ok(r.questions.some((q) => q.doc === 'docs/notes.md'))           // 拿不准 → 问用户
    const design = r.map.docs.find((d) => d.path === 'docs/order/design.md')
    assert.ok(design.sections.some((s) => s.files.includes('src/main/java/demo/OrderService.java')))
  })

  await t('doctor 第一层：过时（git 历史）排最前、用户标的历史文档降级、断链、别人机器的绝对路径给出改法', async () => {
    const c0 = P.loadConfig(root); c0.docStatus = { 'docs/cleanup': 'historical' }; P.saveConfig(root, c0)   // 只认用户自己标的
    const r = await DR.runDoctor(root, { useModel: false, scope: 'all' })
    const f = r.findings
    const top = f[0]
    assert.equal(top.doc, 'CLAUDE.md'); assert.equal(top.kind, 'outdated'); assert.equal(top.anchor.value, 'OldRuleExecutor')
    const cleanup = f.filter((x) => x.doc === 'docs/cleanup/plan.md')
    assert.ok(cleanup.every((x) => x.severity === 'info'))                     // 历史记录：不要求同步
    assert.ok(f.some((x) => x.kind === 'resurrected' && x.anchor.value === 'LegacyUtils'))
    assert.ok(f.some((x) => x.kind === 'broken-link' && x.anchor.value === './gone.md'))
    const abs = f.find((x) => x.kind === 'absolute-link')
    assert.equal(abs.fix, '../../src/main/java/demo/OrderService.java')
    assert.ok(f.some((x) => x.kind === 'unresolved' && x.anchor.value === 'NeverExistedService' && x.severity === 'info'))
    const md = DR.renderReport(root, r)
    assert.match(md, /CLAUDE\.md（AI 配置文件/)
  })

  await t('默认范围只看需求/SPEC 文档；框架类、字段名、"不删除"不误报', async () => {
    w('src/main/java/demo/Tenant.java', 'package demo;\npublic class Tenant extends TenantEntity {\n  private String tenant_id;\n}\n')
    w('docs/order/requirements.md', '# 下单需求\n\n用户可以提交订单。\n\n- 实体继承 `TenantEntity`，带 `tenant_id` 表字段。\n- `LegacyUtils` 不删除，继续保留。\n')
    const r = await DR.runDoctor(root, { useModel: false })
    assert.ok(r.findings.every((x) => x.doc !== 'CLAUDE.md'))   // AI 规则文件不在默认范围
    assert.ok(!r.findings.some((x) => x.kind === 'undocumented'))
    assert.ok(!r.findings.some((x) => ['TenantEntity', 'tenant_id'].includes(x.anchor?.value)))   // 代码里还在用
    assert.ok(!r.findings.some((x) => x.kind === 'resurrected' && x.doc === 'docs/order/requirements.md'))   // "不删除"
    assert.match(DR.renderReport(root, r), /范围：需求 \/ 设计 \/ SPEC 文档/)
  })

  await t('代码待改：用户确认文档为准 → 记进 code-todo.md、不改代码、以后不再问、报告单列', async () => {
    const before = await DR.runDoctor(root, { useModel: false, scope: 'all' })
    const target = before.findings.find((x) => x.kind === 'outdated' && x.anchor.value === 'OldRuleExecutor')
    const c = P.loadConfig(root); c.codeTodo = [DR.signature(target)]; P.saveConfig(root, c)
    P.appendCodeTodo(root, [target], '规则执行器应该恢复')
    const md = readFileSync(join(root, '.doc-drift', 'code-todo.md'), 'utf8')
    assert.match(md, /- \[ \] \*\*CLAUDE\.md:3\*\*.*OldRuleExecutor[\s\S]*用户说明：规则执行器应该恢复/)
    const after = await DR.runDoctor(root, { useModel: false, scope: 'all' })
    const same = after.findings.find((x) => DR.signature(x) === DR.signature(target))
    assert.equal(same.severity, 'info'); assert.ok(same.codeTodo)            // 不再算"需要处理"，不再问
    assert.match(DR.renderReport(root, after), /## 代码待改（用户已确认文档为准/)
    assert.ok(existsSync(join(root, 'src/main/java/demo/OrderService.java')))   // 代码没被动过
    c.codeTodo = []; P.saveConfig(root, c)
  })

  await t('标记文档状态：mark 后历史文档的问题降级、问题清单消掉', () => {
    const c = P.loadConfig(root)
    c.docStatus = { 'docs/notes.md': 'archived' }
    P.saveConfig(root, c)
    assert.equal(P.docStatus(c, 'docs/notes.md'), 'archived')
  })

  await t('钩子：新需求进待办并挑出需求文档；普通问题不进；observe 模式不提醒', async () => {
    const out = await H.handleHook({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: '以后下单要加一个校验：数量超过 100 的要人工审核' })
    assert.equal(out, null)
    await H.handleHook({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: '这个报错啥原因 NullPointerException' })
    const open = H.openPending(P.loadState(root))
    assert.equal(open.length, 1)
    assert.equal(open[0].type, 'requirement')
    assert.equal(open[0].doc, 'docs/order/requirements.md')
  })

  await t('钩子：改了代码、没改文档 → 一轮结束后判断耦合文档是否过时，记待办；同样的改动不重复判断', async () => {
    w('src/main/java/demo/OrderService.java', JAVA('demo', 'OrderService', '  public int price(int n) { return n * 20; }'))
    const before = calls
    const r = await H.scanChanges(root)
    assert.ok(r.fresh >= 1)
    const stale = H.openPending(P.loadState(root)).find((p) => p.type === 'stale')
    assert.equal(stale.doc, 'docs/order/design.md'); assert.equal(stale.section, '价格计算')
    const r2 = await H.scanChanges(root)
    assert.equal(r2.fresh, 0); assert.equal(calls, before + 1)              // 没有新改动：不再问
  })

  await t('钩子：新增 Controller → "没有文档"待办；一起改了文档的不判断', async () => {
    w('src/main/java/demo/PayController.java', `package demo;\n@RestController\npublic class PayController {\n  @GetMapping("/pay")\n  public String pay() { return "ok"; }\n}\n`)
    await H.scanChanges(root)
    assert.ok(H.openPending(P.loadState(root)).some((p) => p.type === 'undocumented' && p.file.endsWith('PayController.java')))
  })

  await t('remind 模式：有待办时注入一行；同一条只提醒一次；两次提醒至少隔 3 轮', async () => {
    const c = P.loadConfig(root); c.hook = { mode: 'remind' }; P.saveConfig(root, c)
    const s = P.loadState(root); s.lastRemindTurn = -10; P.saveState(root, s)
    const out = await H.handleHook({ hook_event_name: 'agent/pre-step', cwd: root, prompt: '继续' })
    assert.equal(out.hookSpecificOutput.hookEventName, 'agent/pre-step')
    assert.match(out.hookSpecificOutput.additionalContext, /^\[文档漂移 · doc-drift\] 待同步 \d+ 项/)
    assert.equal(out.hookSpecificOutput.additionalContext.split('\n').length, 1)
    const again = await H.handleHook({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: '继续' })
    assert.equal(again, null)
  })

  await t('没初始化的项目、子代理、Stop 续轮：钩子什么也不做', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'doc-drift-bare-'))
    try {
      assert.equal(await H.handleHook({ hook_event_name: 'UserPromptSubmit', cwd: bare, prompt: '以后要加个功能' }), null)
      assert.equal(await H.handleHook({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'x', agent_id: 'sub' }), null)
      assert.equal(await H.handleHook({ hook_event_name: 'Stop', cwd: root, stop_hook_active: true }), null)
    } finally { rmSync(bare, { recursive: true, force: true }) }
  })

  await t('决策接口失败：不进待办、不报错', async () => {
    const saved = process.env.DOC_DRIFT_ENDPOINT
    process.env.DOC_DRIFT_ENDPOINT = 'http://127.0.0.1:9/v1/decisions'
    try {
      const n = H.openPending(P.loadState(root)).length
      const s = P.loadState(root); s.lastRemindTurn = s.turn; P.saveState(root, s)
      assert.equal(await H.handleHook({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: '以后要加一个导出功能' }), null)
      assert.equal(H.openPending(P.loadState(root)).length, n)
    } finally { process.env.DOC_DRIFT_ENDPOINT = saved }
  })

  console.log(`\n${ok} 项全部通过（假接口被调用 ${calls} 次）`)
} finally {
  server.close()
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}
