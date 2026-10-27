// git.mjs — 只读的 git 操作：历史里删除过哪些文件、历史版本里出现过哪些字符串、当前工作区改了什么
import { execFileSync, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const run = (root, args, opts = {}) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], ...opts })
  } catch (e) { return opts.allowFail ? (e.stdout ?? '') : null }
}

export const isRepo = (root) => run(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true'

/** 历史上被删除（或改名移走）的文件路径 */
export function deletedPaths(root) {
  const out = run(root, ['log', '--all', '--diff-filter=DR', '-M', '--name-status', '--pretty=format:'])
  const set = new Set()
  for (const line of (out ?? '').split('\n')) {
    const parts = line.split('\t')
    if (/^D/.test(parts[0]) && parts[1]) set.add(parts[1])
    if (/^R/.test(parts[0]) && parts[1]) set.add(parts[1])                 // 改名：旧名字算"没了"
  }
  return set
}

/** 均匀抽 n 个历史提交（含最早和最近），用来查"以前的代码里有没有过这个名字" */
export function sampleRevs(root, n = 12) {
  const all = (run(root, ['rev-list', '--all', '--date-order']) ?? '').split('\n').filter(Boolean)
  if (all.length <= n) return all
  const picked = new Set()
  for (let i = 0; i < n; i++) picked.add(all[Math.round((i * (all.length - 1)) / (n - 1))])
  return [...picked]
}

const CODE = /\.(java|kt|xml|sql|js|mjs|ts|vue|py|go)$/i

/**
 * 抽样历史版本里代码出现过的"词"：标识符（类名、方法名、表名）与以 / 开头的字符串（接口路径）。
 * 各版本里内容相同的文件只读一次（按 blob 去重），一次 cat-file 批量读出。
 */
export function historicalTokens(root, revs) {
  const blobs = new Set()
  for (const rev of revs) {
    for (const line of (run(root, ['ls-tree', '-r', rev]) ?? '').split('\n')) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line)
      if (m && CODE.test(m[2])) blobs.add(m[1])
    }
  }
  const tokens = new Set(), paths = new Set()
  if (!blobs.size) return { tokens, paths }
  // 分批读，每批几百个 blob，避免一次输出过大
  const list = [...blobs]
  for (let i = 0; i < list.length; i += 400) {
    const r = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: list.slice(i, i + 400).join('\n') + '\n', maxBuffer: 512 * 1024 * 1024 })
    if (r.status !== 0 || !r.stdout) continue
    const text = r.stdout.toString('utf8')
    for (const m of text.matchAll(/[A-Za-z_][\w]{2,}/g)) tokens.add(m[0])
    for (const m of text.matchAll(/"(\/[\w{}/:.-]+)"/g)) paths.add(m[1])
  }
  return { tokens, paths }
}

/** 文件最后一次改动：最后提交时间与修改时间中较晚者（毫秒） */
export function lastChanged(root, path) {
  const c = Number(run(root, ['log', '-1', '--format=%ct', '--', path])?.trim()) * 1000 || 0
  let m = 0
  try { m = statSync(join(root, path)).mtimeMs } catch {}
  return Math.max(c, m)
}

/**
 * 当前工作区相对 HEAD 的改动：[{ path, status: 'M'|'A'|'D'|'R'|'?', patch, hash }]
 * 未跟踪的新文件整份算新增；hash 用来判断"上次检查之后有没有新改动"。
 */
export function workingChanges(root, { maxPatch = 6000 } = {}) {
  const out = []
  const names = run(root, ['diff', 'HEAD', '--name-status', '-M']) ?? ''
  for (const line of names.split('\n').filter(Boolean)) {
    const [st, a, b] = line.split('\t')
    const path = b ?? a
    const patch = (run(root, ['diff', 'HEAD', '-M', '--', ...(b ? [a, b] : [a])]) ?? '').slice(0, maxPatch)
    out.push({ path, status: st[0], patch, hash: createHash('sha1').update(patch).digest('hex') })
  }
  const untracked = run(root, ['ls-files', '--others', '--exclude-standard']) ?? ''
  for (const path of untracked.split('\n').filter(Boolean)) {
    const patch = run(root, ['diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', path], { allowFail: true }) ?? ''
    out.push({ path, status: '?', patch: patch.slice(0, maxPatch), hash: createHash('sha1').update(patch).digest('hex') })
  }
  return out
}
