// git.mjs — 只读的 git 操作：历史里删除过哪些文件、历史版本里出现过哪些字符串、当前工作区改了什么
import { execFileSync, spawnSync } from 'node:child_process'
import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// windowsHide：后台进程没有控制台，不加的话每调一次 git，Windows 都会弹一个黑窗口（屏幕会闪）
const run = (root, args, opts = {}) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...opts })
  } catch (e) { return opts.allowFail ? (e.stdout ?? '') : null }
}

export const isRepo = (root) => run(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true'

/** 历史上被删除（或改名移走）的文件路径 */
export function deletedPaths(root) {
  return new Set(movedPaths(root).keys())
}

/** 历史上被删除或改名的文件：Map<旧路径, 新路径|null>（改名的给出最终落脚处；删除的为 null） */
export function movedPaths(root) {
  const out = run(root, ['log', '--all', '--diff-filter=DR', '-M', '--name-status', '--pretty=format:', '--reverse'])
  const map = new Map()
  for (const line of (out ?? '').split('\n')) {
    const parts = line.split('\t')
    if (/^D/.test(parts[0]) && parts[1]) map.set(parts[1], null)
    if (/^R/.test(parts[0]) && parts[1] && parts[2]) map.set(parts[1], parts[2])
  }
  // 连续改名：a→b→c，a 最终在 c
  for (const [k, v] of map) { let to = v, guard = 0; while (to && map.has(to) && guard++ < 20) to = map.get(to); map.set(k, to ?? null) }
  return map
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
    const r = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: list.slice(i, i + 400).join('\n') + '\n', maxBuffer: 512 * 1024 * 1024, windowsHide: true })
    if (r.status !== 0 || !r.stdout) continue
    const text = r.stdout.toString('utf8')
    for (const m of text.matchAll(/[A-Za-z_][\w]{2,}/g)) tokens.add(m[0])
    for (const m of text.matchAll(/"(\/[\w{}/:.-]+)"/g)) paths.add(m[1])
  }
  return { tokens, paths }
}

/**
 * 文件最后一次改动（毫秒）：已提交且工作区没改过的，用最后提交时间——
 * 刚克隆、刚切分支时所有文件的修改时间都是"刚才"，用它会误以为文档刚更新过；
 * 工作区里改过（或还没提交过）的，才用修改时间。
 */
export function lastChanged(root, path) {
  const c = Number(run(root, ['log', '-1', '--format=%ct', '--', path])?.trim()) * 1000 || 0
  const dirty = c === 0 || !!run(root, ['status', '--porcelain', '--', path])?.trim()
  if (!dirty) return c
  let m = 0
  try { m = statSync(join(root, path)).mtimeMs } catch {}
  return Math.max(c, m)
}

/**
 * 当前工作区相对 HEAD 的改动：[{ path, status: 'M'|'A'|'D'|'R'|'?', patch, hash }]
 * 未跟踪的新文件整份算新增；hash 用来判断"上次检查之后有没有新改动"。
 */
export function workingChanges(root, { maxPatch = 6000, keep = () => true } = {}) {
  const out = []
  const sha = (s) => createHash('sha1').update(s).digest('hex')
  // 已跟踪的：一次 git diff 拿全部，再按文件切开（不逐个文件调 git）
  const status = new Map()
  for (const line of (run(root, ['diff', 'HEAD', '--name-status', '-M']) ?? '').split('\n').filter(Boolean)) {
    const [st, a, b] = line.split('\t')
    status.set(b ?? a, st[0])
  }
  const all = run(root, ['diff', 'HEAD', '-M', '--unified=3']) ?? ''
  for (const chunk of all.split(/^(?=diff --git )/m).filter(Boolean)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk)
    if (!m) continue
    const path = m[2].trim()
    if (!keep(path)) continue
    out.push({ path, status: status.get(path) ?? 'M', patch: chunk.slice(0, maxPatch), hash: sha(chunk) })
  }
  // 未跟踪的：只看需要的（代码文件），直接读磁盘，整份算新增
  for (const path of (run(root, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean)) {
    if (!keep(path)) continue
    let text = ''
    try { text = readFileSync(join(root, path), 'utf8') } catch { continue }
    const patch = `新文件 ${path}\n` + text.split(/\r?\n/).map((l) => '+' + l).join('\n')
    out.push({ path, status: '?', patch: patch.slice(0, maxPatch), hash: sha(text) })
  }
  return out
}

/** 某时刻之后改过这些文件的提交：[{ hash, date, subject }]（新的在前） */
export function commitsSince(root, files, sinceMs, max = 20) {
  if (!files.length) return []
  const out = run(root, ['log', `--since=@${Math.floor(sinceMs / 1000)}`, `-${max}`, '--format=%h%x09%ad%x09%s', '--date=short', '--', ...files]) ?? ''
  return out.split('\n').filter(Boolean).map((l) => { const [hash, date, subject] = l.split('\t'); return { hash, date, subject } })
}

/** 某时刻之后这些文件的改动内容（提交的 + 工作区未提交的），截断到 max 字符 */
export function changesSince(root, files, sinceMs, max = 2000) {
  if (!files.length) return ''
  const committed = run(root, ['log', `--since=@${Math.floor(sinceMs / 1000)}`, '-p', '--format=commit %h %s', '--unified=2', '--', ...files]) ?? ''
  const working = run(root, ['diff', 'HEAD', '--unified=2', '--', ...files]) ?? ''
  return (working ? '【未提交的改动】\n' + working + '\n' : '') + committed
    .replace(/^(index |diff --git |--- |\+\+\+ ).*$/gm, '').replace(/\n{3,}/g, '\n\n').slice(0, max)
}
