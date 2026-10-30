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
const D = await import('../lib/decide.mjs')
const H = await import('../lib/hook.mjs')
const S = await import('../lib/scan.mjs')
const A = await import('../lib/audit.mjs')
const T = await import('../lib/trellis.mjs')
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

  await t('"已删除"按主语判断：真实项目里出过的误报不再出现', () => {
    // [这一行, 引用, 应不应该算"说它已删除"]
    const CASES = [
      ['| `EndAuditListenerServiceTask` | 删除已注释的 `synchronizeApplyPayInformation` 引用 |', 'EndAuditListenerServiceTask', false],
      ['| `YonBipController` + `yonbip/util/*`（除 Base64Util） | 删除；**先将** `Base64Util` **迁至** `common/utils` |', 'YonBipController', true],
      ['| `YonBipController` + `yonbip/util/*`（除 Base64Util） | 删除；**先将** `Base64Util` **迁至** `common/utils` |', 'Base64Util', false],
      ['4. 删除 `TestRiskControlRulesController` + Service + ServiceImpl；**保留** `TestController`、`FinanceJobController`', 'TestRiskControlRulesController', true],
      ['4. 删除 `TestRiskControlRulesController` + Service + ServiceImpl；**保留** `TestController`、`FinanceJobController`', 'FinanceJobController', false],
      ['| `Che300GeneratorRecordServiceImpl` | 回调主事务：幂等校验 → 物理删除旧记录 → 落库 |', 'Che300GeneratorRecordServiceImpl', false],
      ['若需独立拆分渠道商代码，可复制 `TeamController` / `TeamServiceImpl` 后删除代理商特有逻辑', 'TeamServiceImpl', false],
      ['`InformationMapper.xml` 的 AI 统计过滤 `ti.is_deleted`；', 'InformationMapper.xml', false],
      ['| 删除 | `POST /api/product/removeProduct` | `ProductDTO` |', 'ProductDTO', false],
      ['| `controller/ApplyPay*.java` | 删除 |', 'controller/ApplyPay*.java', true],
      ['> 本地规则执行器（`RuleExecutor` 接口及 `business/rule/impl/*RuleExecutor.java` 各规则类）已删除。', 'RuleExecutor', true],
      ['`LegacyUtils` 不删除，继续保留。', 'LegacyUtils', false],
      ['`OrderController` 已下线', 'OrderController', true],
      ['度小满、`DxmService` 已删', 'DxmService', true],
      ['- 删除 `FlowNodeEnum.BINDING_DEGREE_XIAOMAN`、`FlowNodeMiniEnum` 对应项', 'FlowNodeMiniEnum', false],
      ['`AsynchronousThreadService` **不可整文件删除**——仍承担 yourongpost、SP 重试等', 'AsynchronousThreadService', false],
      ['- **AC-CLEAN-03.2**：`FinanceJobController` 中 partner/archives 相关 Job 已移除；**客户 push Job 保留**。', 'FinanceJobController', false],
      ['- `doHtmlToPdf`：Base64 HTML 上传 OSS，删除旧影像后写入 `PictureEntity`（征信报告 HTML）。', 'PictureEntity', false],
      ['2. 删除 `H5IntakeContextServiceImpl` 对续办服务的依赖和 `triggerRecoveryRetry` 调用，恢复上下文纯查询职责。', 'H5IntakeContextServiceImpl', false],
      ['| `TestRiskControlRulesController` + Service + ServiceImpl | 删除 |', 'TestRiskControlRulesController', true],
      ['- 依赖：`ControlRules`、远程决策引擎（`DecisionRiskControlAdapter`；本地 RuleExecutor 实现类已删除）、系统参数', 'DecisionRiskControlAdapter', false],
    ]
    const wrong = CASES.filter(([line, value, want]) => {
      const a = S.docAnchors(line).anchors.find((x) => x.value === value || x.value.endsWith(value))
      return !a || a.gone !== want
    })
    assert.deepEqual(wrong.map((c) => c[0]), [])
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
    const r = await DR.runDoctor(root, { useModel: false, scope: 'all', full: true })
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
    const r = await DR.runDoctor(root, { useModel: false, full: true })
    assert.ok(r.findings.every((x) => x.doc !== 'CLAUDE.md'))   // AI 规则文件不在默认范围
    assert.ok(!r.findings.some((x) => x.kind === 'undocumented'))
    assert.ok(!r.findings.some((x) => ['TenantEntity', 'tenant_id'].includes(x.anchor?.value)))   // 代码里还在用
    assert.ok(!r.findings.some((x) => x.kind === 'resurrected' && x.doc === 'docs/order/requirements.md'))   // "不删除"
    assert.match(DR.renderReport(root, r), /范围：整个项目 · 需求 \/ 设计 \/ SPEC 文档/)
  })

  await t('代码待改：文档为准 → 记进 code-todo.md、不改代码、不再问；用户改好代码后重跑 → 自动对齐打勾', async () => {
    const before = await DR.runDoctor(root, { useModel: false, scope: 'all', full: true })
    const target = before.findings.find((x) => x.kind === 'outdated' && x.anchor.value === 'OldRuleExecutor')
    const c = P.loadConfig(root); c.codeTodo = [DR.signature(target)]; P.saveConfig(root, c)
    P.appendCodeTodo(root, [target], '规则执行器应该恢复')
    const md = readFileSync(join(root, '.doc-drift', 'code-todo.md'), 'utf8')
    assert.match(md, /- \[ \] \*\*CLAUDE\.md:3\*\*.*OldRuleExecutor[\s\S]*用户说明：规则执行器应该恢复/)
    const after = await DR.runDoctor(root, { useModel: false, scope: 'all', full: true })
    const same = after.findings.find((x) => DR.signature(x) === DR.signature(target))
    assert.equal(same.severity, 'info'); assert.ok(same.codeTodo)            // 不再算"需要处理"，不再问
    assert.match(DR.renderReport(root, after), /## 代码待改（用户已确认文档为准/)
    assert.ok(existsSync(join(root, 'src/main/java/demo/OrderService.java')))   // 代码没被动过
    assert.equal(after.stats.codeTodoOpen, 1)

    // 用户按自己的开发流程把代码改好（这里模拟：把规则执行器加回来）→ 重跑体检 → 自动对齐、打勾
    w('src/main/java/demo/OldRuleExecutor.java', JAVA('demo', 'OldRuleExecutor'))
    const done = await DR.runDoctor(root, { useModel: false, scope: 'all', full: true })
    assert.equal(done.stats.codeTodoClosed, 1); assert.equal(done.stats.codeTodoOpen, 0)
    assert.match(readFileSync(join(root, '.doc-drift', 'code-todo.md'), 'utf8'), /- \[x\] \*\*CLAUDE\.md:3\*\*[\s\S]*重跑体检已对齐/)
    assert.deepEqual(P.loadConfig(root).codeTodo, [])
    assert.match(DR.renderReport(root, done), /本次已对齐 1 条/)
    unlinkSync(join(root, 'src/main/java/demo/OldRuleExecutor.java'))          // 还原，后面的用例照旧
  })

  await t('标记文档状态：mark 后历史文档的问题降级、问题清单消掉', () => {
    const c = P.loadConfig(root)
    c.docStatus = { 'docs/notes.md': 'archived' }
    P.saveConfig(root, c)
    assert.equal(P.docStatus(c, 'docs/notes.md'), 'archived')
  })

  await t('钩子：发消息只做本地记账——不调模型、不产生需求待办', async () => {
    const before = calls
    const out = await H.handleHook({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: '以后下单要加一个校验：数量超过 100 的要人工审核' })
    assert.equal(out, null)
    await H.handleHook({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: '这个报错啥原因 NullPointerException' })
    assert.equal(calls, before)                                      // 一个模型请求都不发
    assert.equal(H.openPending(P.loadState(root)).filter((p) => p.type === 'requirement').length, 0)
  })

  await t('钩子：一轮结束本地找候选 → 让模型先问用户，不调模型；第一次只记基线', async () => {
    w('src/main/java/demo/OrderService.java', JAVA('demo', 'OrderService', '  public int price(int n) { return n * 30; }'))
    assert.equal(await H.handleHook({ hook_event_name: 'agent/turn-stopping', cwd: root, session_id: 's-hook' }), null)   // 第一次：只记基线，存量改动不报
    w('src/main/java/demo/OrderService.java', JAVA('demo', 'OrderService', '  public int price(int n) { return n * 20; }'))
    const before = calls
    const out = await H.handleHook({ hook_event_name: 'agent/turn-stopping', cwd: root, session_id: 's-hook' })
    assert.equal(out.decision, 'block')
    assert.match(out.reason, /^\[文档漂移 · doc-drift\]/)
    assert.ok(out.reason.includes('docs/order/design.md') && out.reason.includes('价格计算'))
    assert.equal(calls, before)                                      // 本地判断不调模型
  })

  await t('用户确认后 check：只判这批候选，才调一次模型', async () => {
    const before = calls
    const r = await H.checkCandidates(root)
    assert.ok(r.candidates >= 1); assert.equal(calls, before + 1)
    assert.ok(H.openPending(P.loadState(root)).some((p) => p.type === 'stale' && p.doc === 'docs/order/design.md' && p.section === '价格计算'))
  })

  await t('用户说先记下来：只记一笔，不调模型；同一条更新不重复', async () => {
    const before = calls
    const r = H.defer(root, { doc: 'docs/order/design.md', section: '价格计算', note: '等定价上线一起调' })
    assert.equal(calls, before)
    assert.equal(r.total, 1)
    H.defer(root, { doc: 'docs/order/design.md', section: '价格计算', note: '改主意了再调' })
    const list = P.loadState(root).deferred
    assert.equal(list.length, 1); assert.equal(list[0].note, '改主意了再调')
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

  await t('全面核对：拆成说法和代码事实清单 → 没交卷、缺证据、编造的证据都对不上账 → 补齐后覆盖 100% → 复核清单', async () => {
    const plan = A.planAudit(root, { docs: ['docs/order/design.md'] })
    assert.equal(plan.docs.length, 1); assert.ok(plan.docs[0].claims >= 2)
    const task = JSON.parse(readFileSync(join(root, '.doc-drift/audit/tasks/T001.json'), 'utf8'))
    assert.ok(task.claims.some((c) => /乘 10/.test(c.text)))                                         // 文档方向：每句一条
    assert.ok(task.facts.some((f) => f.kind === '方法' && /OrderService\.price/.test(f.text)))        // 代码方向：关联代码的公开方法
    assert.equal(A.verifyAudit(root).done, 0)                                                         // 没交卷
    const write = (r) => writeFileSync(join(root, '.doc-drift/audit/results/T001.json'), JSON.stringify({ task: 'T001', ...r }))
    const facts = task.facts.map((f) => ({ id: f.id, verdict: '不需要写' }))
    write({ claims: task.claims.map((c) => ({ id: c.id, verdict: '一致', evidence: 'src/main/java/demo/Nope.java:3' })), facts })
    assert.match(A.verifyAudit(root).tasks[0].problems.join(), /证据文件不存在/)                       // 编造的证据
    write({ claims: task.claims.slice(1).map((c) => ({ id: c.id, verdict: '不是事实' })), facts })
    assert.match(A.verifyAudit(root).tasks[0].problems.join(), /没有结论/)                             // 漏了一条
    const [first, ...rest] = task.claims
    write({ claims: [{ id: first.id, verdict: '不一致', evidence: 'src/main/java/demo/OrderService.java:3', code: '乘 20', fix: '改成乘 20' }, ...rest.map((c) => ({ id: c.id, verdict: '不是事实' }))], facts })
    const v = A.verifyAudit(root)
    assert.equal(v.done, v.all)
    const r = A.reviewAudit(root)
    assert.equal(r.mismatch, 1)
    assert.match(readFileSync(r.file, 'utf8'), /不一致（逐条复核）[\s\S]*改成乘 20/)
  })

  await t('doctor 分批：每次只判下一批，判过的记住；全判完后再跑不再调用模型', async () => {
    const later = new Date(Date.now() + 10000).toISOString()          // 文档之后又提交了代码改动 → 内容过时候选
    w('src/main/java/demo/OrderController.java', readFileSync(join(root, 'src/main/java/demo/OrderController.java'), 'utf8') + '// v2\n')
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'price x20'], { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: later, GIT_AUTHOR_DATE: later } })
    const one = await DR.runDoctor(root, { useModel: true, scope: 'all', full: true, maxStale: 1 })
    assert.ok(one.stats.candidates >= 1); assert.equal(one.stats.judged, 1)
    assert.equal(one.stats.staleLeft, one.stats.candidates - one.stats.judgedTotal)
    const all = await DR.runDoctor(root, { useModel: true, scope: 'all', full: true, maxStale: 100 })
    assert.equal(all.stats.judged, one.stats.candidates - 1); assert.equal(all.stats.staleLeft, 0)   // 接着判剩下的，不重判
    const before = calls
    const again = await DR.runDoctor(root, { useModel: true, scope: 'all', full: true })
    assert.equal(again.stats.judged, 0); assert.equal(calls, before)
    assert.equal(again.findings.filter((x) => x.kind === 'stale').length, all.findings.filter((x) => x.kind === 'stale').length)   // 缓存的判断照样出报告
  })

  await t('判断时送整节文档，不只前 1200 字', () => {
    const st = D.staleState([{ doc: 'x.md', section: 's', docText: 'a'.repeat(3000) + 'TAIL', files: ['a.java'], code: 'c' }])
    assert.ok(st.includes('TAIL'))
  })

  await t('报告写明这次没查什么；标了误报清缓存并记进答复', async () => {
    const r = await DR.runDoctor(root, { useModel: true, scope: 'all', full: true, maxStale: 100 })
    const md = DR.renderReport(root, r)
    assert.match(md, /## 这次没查什么/)
    assert.match(md, /没有代码关联的文档|历史 \/ 已归档文档|已判断但判为准确或把握不足/)
    assert.equal(typeof r.stats.unmapped, 'number')
    assert.equal(r.stats.conflicts, r.findings.filter((f) => f.kind === 'stale').length)
    DR.saveReport(root, md, r)
    const f = r.findings.find((x) => x.kind === 'stale' && x.anchor?.kind === 'section')
    assert.ok(f)
    const key = `${f.doc}#${f.anchor.value}`
    assert.ok(P.loadStaleCache(root)[key])
    assert.equal(DR.labelFinding(root, f.id, 'wrong', '文档改过了，是误报').cleared, true)
    assert.ok(!P.loadStaleCache(root)[key])
    assert.match(P.readAnswers(root), /是误报/)
  })

  await t('doctor（当前 SPEC）：不看 diff，直接拿文档和现在的代码比', async () => {
    // 关键：代码先提交，文档后提交（文档比代码新）→ 旧的"代码在文档之后改过"判据会漏，新判据照样能比出不一致
    w('src/main/java/demo/OrderService.java', JAVA('demo', 'OrderService', '  public int price(int n) { return n * 20; }   // spec-check'))
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'code n20')
    w('docs/order/design.md', '# 下单设计\n\n## 价格计算\n\n`OrderService` 按数量乘 10 计价。\n\n见 [需求](./requirements.md)。\n')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'doc touched after code')
    const task = { id: 't-doc', title: '定价任务', status: 'in_progress', docs: ['docs/order/design.md'] }
    const r = await DR.runDoctor(root, { useModel: true, task, maxStale: 10 })
    assert.equal(r.stats.mode, 'task'); assert.equal(r.stats.task, '定价任务')
    const stale = r.findings.find((f) => f.kind === 'stale' && f.doc === 'docs/order/design.md')
    assert.ok(stale)                                                          // 没靠 diff/commit 时间也判出来了
    assert.match(stale.detail, /建议：改文档/)
    assert.match(DR.renderReport(root, r), /范围：当前 SPEC「定价任务」/)
  })

  await t('钩子：新增 Controller 不算需求漂移（只报需求/设计文档对不上）', async () => {
    H.localCandidates(root, { sessionId: 'undoc-probe' })                    // 第一次只记基线
    w('src/main/java/demo/PayController.java', `package demo;\n@RestController\npublic class PayController {\n  @GetMapping("/pay")\n  public String pay() { return "ok"; }\n}\n`)
    const r = H.localCandidates(root, { sessionId: 'undoc-probe' })
    assert.equal(r.fresh, 1)
    assert.ok(!r.items.some((p) => (p.file ?? '').endsWith('PayController.java')))
    assert.ok(H.openPending(P.loadState(root)).every((p) => p.type !== 'undocumented'))
  })

  await t('Trellis 任务：有活动任务时只报该任务引用到的需求/设计文档', async () => {
    w('.trellis/tasks/t-req/task.json', JSON.stringify({ name: 't-req', title: '任务t-req', relatedFiles: ['docs/order/requirements.md'] }))
    w('.trellis/.runtime/sessions/dsh_sess-req.json', JSON.stringify({ platform: 'dsh', last_seen_at: '2026-10-29T00:00:00Z', current_task: '.trellis/tasks/t-req' }))
    const task = H.currentTask(root, 'sess-req')
    assert.equal(task?.title, '任务t-req')
    assert.deepEqual(task.docs, ['docs/order/requirements.md'])
    assert.equal(H.currentTask(root, 'sess-nobody'), null)

    H.localCandidates(root, { sessionId: 'sess-req' })                        // 第一次只记基线
    w('src/main/java/demo/OrderService.java', readFileSync(join(root, 'src/main/java/demo/OrderService.java'), 'utf8') + '// scope probe\n')
    const r = H.localCandidates(root, { sessionId: 'sess-req' })
    assert.ok(r.fresh >= 1)
    assert.equal(r.task?.title, '任务t-req')
    assert.ok(!r.items.some((p) => p.doc === 'docs/order/design.md'))         // design 不在这个任务范围
  })

  await t('按改动反查任务：登记的边界优先，并列或对不上就不猜', async () => {
    w('.trellis/tasks/t-a/task.json', JSON.stringify({ name: 't-a', title: '任务A', status: 'in_progress', relatedFiles: ['src/main/java/demo/'] }))
    const a = H.taskForChanges(root, ['src/main/java/demo/OrderService.java'])
    assert.equal(a?.title, '任务A')
    assert.equal(a.status, 'in_progress')

    w('.trellis/tasks/t-c/task.json', JSON.stringify({ name: 't-c', title: '任务C', status: 'in_progress', relatedFiles: ['lib/'] }))
    w('.trellis/tasks/t-d/task.json', JSON.stringify({ name: 't-d', title: '任务D', status: 'in_progress', relatedFiles: ['lib/'] }))
    assert.equal(H.taskForChanges(root, ['lib/foo.js']), null)                 // 两个 in_progress 都声明了 lib/，并列
    assert.equal(H.taskForChanges(root, ['nothing/here.txt']), null)           // 谁也对不上

    w('.trellis/tasks/t-e/task.json', JSON.stringify({ name: 't-e', title: '任务E', status: 'completed', relatedFiles: ['lib2/'] }))
    w('.trellis/tasks/t-f/task.json', JSON.stringify({ name: 't-f', title: '任务F', status: 'in_progress', relatedFiles: ['lib2/'] }))
    assert.equal(H.taskForChanges(root, ['lib2/x.js'])?.title, '任务F')        // 并列时 in_progress 优先
    assert.equal(H.taskForChanges(root, ['.trellis/scripts/task.py']), null)   // Harness 目录整片未跟踪，不当成改动
  })

  await t('init 记录 Trellis 活跃任务和当前 SPEC；别的分支/已完成的不算；doctor full 只查这些 + AI 规则文件', async () => {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    w('.trellis/tasks/t-spec/task.json', JSON.stringify({ name: 't-spec', title: '定价任务', status: 'in_progress', branch, relatedFiles: ['docs/order/requirements.md'] }))
    w('.trellis/tasks/t-other/task.json', JSON.stringify({ name: 't-other', title: '别的分支任务', status: 'in_progress', branch: 'feature-nope', relatedFiles: ['docs/order/design.md'] }))
    w('.trellis/tasks/t-old/task.json', JSON.stringify({ name: 't-old', title: '老任务', status: 'completed', branch, relatedFiles: ['docs/order/requirements.md'] }))
    const snap = T.snapshot(root)
    assert.ok(snap.tasks.some((x) => x.title === '定价任务'))
    assert.ok(!snap.tasks.some((x) => x.title === '别的分支任务'))     // 别的分支
    assert.ok(!snap.tasks.some((x) => x.title === '老任务'))           // 已完成
    const { config } = await I.runInit(root, { useModel: false, existing: P.loadConfig(root) })
    assert.ok(config.trellis.docs.includes('docs/order/requirements.md'))
    assert.ok(!config.trellis.docs.includes('docs/order/design.md'))

    const r = await DR.runDoctor(root, { full: true, useModel: false })
    assert.equal(r.stats.mode, 'full')
    assert.equal(r.stats.docs, 2)                                      // CLAUDE.md + requirements
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
