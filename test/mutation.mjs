// test/mutation.mjs — 变异测试：把这次改动里每条关键规则改坏一次，确认自测真的会失败。
//
// 用法：node test/mutation.mjs
import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const H = join(root, 'lib', 'hook.mjs')
const BACK = join(root, '.mutation-backup.hook.mjs')

const MUTATIONS = [
  {
    name: '本会话第一次也报存量改动（一进项目就满屏候选）',
    from: 'if (!box.diffHashes && !freshOnFirstRun) {',
    to: 'if (false) {'
  },
  {
    name: 'turn-stopping 发现候选也不拦（用户永远看不到确认）',
    from: "    return { decision: 'block', reason: candidateLine(r.items, root, r.task) }",
    to: '    return null'
  },
  {
    name: '候选不留给 check（确认了也没东西可判）',
    from: 'state.candidates = items.map(({ patches, ...rest }) => rest)',
    to: 'state.candidates = []'
  },
  {
    name: '判出过时也不记待办',
    from: "if (r.key === 'outdated') addPending(",
    to: 'if (false) addPending('
  }
]

const run = () => {
  try {
    const out = execFileSync(process.execPath, ['test/selftest.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { failed: false, out }
  } catch (e) {
    return { failed: true, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

copyFileSync(H, BACK)
const results = []
try {
  const base = run()
  console.log(`基线（未变异）：${base.failed ? '✗ 居然没过' : '✓ 全部通过'}\n`)
  for (const mu of MUTATIONS) {
    const src = readFileSync(H, 'utf8')
    if (!src.includes(mu.from)) { results.push({ ...mu, caught: false, why: '没找到要变异的代码（实现已变）' }); continue }
    writeFileSync(H, src.replace(mu.from, mu.to))
    const r = run()
    copyFileSync(BACK, H)
    const line = (r.out.match(/AssertionError[^\n]*/) ?? [''])[0].slice(0, 90)
    results.push({ ...mu, caught: r.failed, why: r.failed ? (line || '自测失败') : '变异后自测仍然通过 —— 这条规则没有测试兜住' })
  }
} finally {
  copyFileSync(BACK, H)
  if (existsSync(BACK)) rmSync(BACK)
}

console.log('变异测试结果：')
let bad = 0
for (const r of results) {
  if (!r.caught) bad++
  console.log(`  ${r.caught ? '✓ 已捕获' : '✗ 没捕获'}  ${r.name}\n      ${r.why}`)
}
console.log(`\n${results.length - bad}/${results.length} 个变异被自测抓住`)
process.exit(bad ? 1 : 0)
