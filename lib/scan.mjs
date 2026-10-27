/**
 * scan.mjs — 盘点项目：文档有哪些、代码里有哪些"可被文档引用的东西"（文件、类、方法、接口路径、表名），
 * 以及每篇文档里引用了哪些代码锚点。纯本地、只读、不调模型。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep, dirname, basename, extname } from 'node:path'

export const DEFAULT_EXCLUDE = ['.git', 'node_modules', 'target', 'dist', 'build', 'out', '.idea', '.vscode', '.gradle', '.mvn',
  '.doc-drift', '.agents', '.claude', '.codex', '.trellis', '.comet', '.workbuddy', '.codegraph', '.code-review-graph', '__pycache__']
export const CODE_EXT = new Set(['.java', '.kt', '.xml', '.sql', '.js', '.mjs', '.ts', '.tsx', '.vue', '.py', '.go', '.yml', '.yaml', '.properties'])
const MAX_FILE = 2_000_000

const posix = (p) => p.split(sep).join('/')

/** 遍历目录，返回相对路径（/ 分隔）；排除隐藏目录与构建产物 */
export function walk(root, { exclude = DEFAULT_EXCLUDE } = {}) {
  const out = []
  const ex = new Set(exclude)
  const go = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (ex.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) { if (!e.name.startsWith('.') || e.name === '.github') go(full) } else if (e.isFile()) out.push(posix(relative(root, full)))
    }
  }
  go(root)
  return out
}

const read = (root, rel) => {
  try { const p = join(root, rel); return statSync(p).size > MAX_FILE ? '' : readFileSync(p, 'utf8') } catch { return '' }
}

// ---------------------------------------------------------------- 代码索引
// 也认 @RequestMapping(CommonConstant.APPLICATION_NAME + "/financialReport") 这种"常量 + 字符串"的写法
const MAPPING = /@(Request|Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*(?:[\w.]+\s*\+\s*)?"([^"]*)"/g
const METHOD = /(?:public|protected|private|static|default)\s+(?:[\w<>[\],.?\s]+?\s+)?(\w+)\s*\([^;{}]*\)\s*(?:throws [\w.,\s]+)?\{/g
const TABLE = /\b(?:from|join|into|update|table(?:\s+if\s+(?:not\s+)?exists)?)\s+[`"]?([a-zA-Z][\w]*_[\w]+)[`"]?/gi
const JS_FN = /(?:function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(|^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{)/gm

export function indexCode(root, files) {
  const idx = { files: [], basenames: new Set(), stems: new Set(), classes: new Set(), methods: new Set(), endpoints: new Set(), tables: new Set(), dirs: new Set(), controllers: new Map(), classFiles: new Map(), tokens: new Set() }
  for (const f of files) {
    const ext = extname(f).toLowerCase()
    if (!CODE_EXT.has(ext)) continue
    idx.files.push(f)
    const base = basename(f)
    idx.basenames.add(base)
    idx.stems.add(base.slice(0, base.length - ext.length))
    for (let d = dirname(f); d && d !== '.'; d = dirname(d)) { if (idx.dirs.has(d)) break; idx.dirs.add(d) }
    if (!['.java', '.kt', '.xml', '.sql', '.js', '.mjs', '.ts', '.py', '.go'].includes(ext)) continue
    const text = read(root, f)
    if (ext === '.java' || ext === '.kt') {
      const stem = base.slice(0, -ext.length)
      idx.classes.add(stem)
      ;(idx.classFiles.get(stem) ?? idx.classFiles.set(stem, []).get(stem)).push(f)
      for (const m of text.matchAll(/\b(?:class|interface|enum|record)\s+([A-Z]\w*)/g)) idx.classes.add(m[1])
      for (const m of text.matchAll(METHOD)) if (!['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'new'].includes(m[1])) idx.methods.add(m[1])
      // 接口路径：类上的前缀 + 方法上的路径
      const maps = [...text.matchAll(MAPPING)]
      if (maps.length) {
        const classAt = text.search(/\b(?:class|interface)\s+[A-Z]/)
        const prefix = maps.filter((m) => m.index < classAt && m[1] === 'Request').map((m) => m[2])[0] ?? ''
        for (const m of maps) {
          if (m.index < classAt && m[1] === 'Request') continue
          const full = ('/' + [prefix, m[2]].filter(Boolean).join('/')).replace(/\/+/g, '/')
          idx.endpoints.add(full)
          idx.endpoints.add(('/' + m[2]).replace(/\/+/g, '/'))
        }
        if (/Controller$/.test(stem)) idx.controllers.set(stem, { file: f, endpoints: maps.length, prefix })
      } else if (/Controller$/.test(stem)) idx.controllers.set(stem, { file: f, endpoints: 0, prefix: '' })
    } else if (['.js', '.mjs', '.ts', '.py', '.go'].includes(ext)) {
      for (const m of text.matchAll(JS_FN)) { const n = m[1] ?? m[2] ?? m[3]; if (n && n.length > 2) idx.methods.add(n) }
      for (const m of text.matchAll(/\b(?:def|func)\s+(\w+)/g)) idx.methods.add(m[1])
      for (const m of text.matchAll(/\bclass\s+([A-Z]\w*)/g)) idx.classes.add(m[1])
    }
    if (ext === '.xml' || ext === '.sql' || ext === '.java') for (const m of text.matchAll(TABLE)) idx.tables.add(m[1].toLowerCase())
    for (const m of text.matchAll(/[A-Za-z_]\w{2,}/g)) idx.tokens.add(m[0])
  }
  return idx
}

// ---------------------------------------------------------------- 文档里的锚点
// 一行里说"已删/下线/历史"的，引用的东西本来就该不在代码里
export const GONE = /已删|删除|删掉|下线|移除|废弃|不再|已停用|停用|deprecated|removed|deleted|历史快照|已迁出|已拆除/i
// "不删除""保留""未删除""不要下线"——说的是留着
const KEPT = /(不|未|没|没有|无需|无须|不用|不要|不能|不可|不得|不应|无法|别|勿|禁止|暂不)\s*[整个文件]{0,3}\s*(删|删除|删掉|下线|移除|废弃|停用)|保留|仍保留|继续使用/
export const isGone = (clause) => GONE.test(clause) && !KEPT.test(clause)
const CLASS_SUFFIX = /(Controller|Service|ServiceImpl|Impl|Mapper|Enum|Util|Utils|Handler|Listener|Config|Configuration|Adapter|Task|Job|Executor|Entity|VO|DTO|Wrapper|Factory|Client|Api|Filter|Interceptor|Aspect|Constant|Constants|Properties|Starter|Application|Test)$/
const CODE_FILE = /\.(java|kt|xml|sql|js|mjs|ts|tsx|vue|py|go|yml|yaml|properties)$/i

/** 把一个行内代码/加粗片段归类成锚点；不像代码引用的返回 null */
const FILE_EXT = /\.(md|txt|json|jar|toml|ini|cmd|sh|bat|ps1|png|jpg|svg|pdf|docx?|xlsx?|csv|log|env|lock|html?|css|zip|gz)$/i

export function classify(token) {
  let t = token.trim().replace(/^[`*]+|[`*]+$/g, '').trim()
  // "POST /applyInfomation"、"GET /job/x" → 接口路径
  const verb = /^(GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)$/i.exec(t)
  if (verb) t = verb[2]
  if (!t || t.length > 200 || /\s\/\s/.test(t) || /\s/.test(t.replace(/\s*\/\s*/g, '/'))) return null   // "GIVEN / WHEN / THEN"
  if (/^(origin|upstream|refs)\//.test(t) || /^[0-9a-f]{7,40}(\/[0-9a-f]{7,40})*$/i.test(t)) return null  // 分支名、提交号
  if (/^https?:|^classpath:|^file:|^[a-z]:[\\/]/i.test(t)) return null
  if (/[{}$<>]/.test(t) && !/^\/[\w{}/:-]+$/.test(t)) return null             // 占位符：application-{profile}.yml、${x}
  if (FILE_EXT.test(t)) return null                                          // 文档、配置、产物，不是代码元素
  if (/^[\w.-]+\.\w+\(\)$/.test(t) || /^[a-z]\w*\(\)$/.test(t)) return { kind: 'method', value: t.replace(/\(\)$/, '').split('.').pop() }
  if (/^[A-Z]\w*\.[a-z]\w*(\(\))?$/.test(t) && !CODE_FILE.test(t)) return { kind: 'method', value: t.replace(/\(\)$/, '').split('.')[1], cls: t.split('.')[0] }
  if (CODE_FILE.test(t) || (t.includes('/') && !t.startsWith('/') && /[A-Za-z]/.test(t) && !/^\.?\.?\/?$/.test(t))) {
    if (/\.md$/i.test(t)) return null
    return { kind: t.endsWith('/') ? 'dir' : CODE_FILE.test(t) || /\*/.test(t) ? 'file' : 'dir', value: t.replace(/^(\.\.?\/)+/, '') }
  }
  if (/^\/[\w{}/:-]+$/.test(t) && t.length > 2) return { kind: 'endpoint', value: t }
  if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(t) && CLASS_SUFFIX.test(t)) return { kind: 'class', value: t }
  if (/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(t)) return { kind: 'table', value: t }
  return null
}

/**
 * 锚点所在的分句："`third/decisionengine/`（本地 `pricingRule/` 已删）"里，"已删"只管括号里那个。
 * 顿号不断句："度小满、聚瑞 已删"是一起删的。
 */
export function clauseAt(line, index) {
  const SEP = /[，,；;。|（）()：:—]/
  let a = index, z = index
  while (a > 0 && !SEP.test(line[a - 1])) a--
  while (z < line.length && !SEP.test(line[z])) z++
  return line.slice(a, z)
}

// 长的写法放前面，"已删除"整个匹配，不会只吃到"已删"
const GONE_AT = /已删除|已删掉|已删|删除|删掉|已下线|下线|已移除|移除|已废弃|废弃|不再|已停用|停用|deprecated|removed|deleted|历史快照|已迁出|已拆除|拆除/gi
const CJK = /[一-鿿]/
// 行内代码换成等长空格：`is_deleted` 这种字段名不算"删除"，位置不变
const blankCode = (s) => s.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))

/**
 * 一段话里的"删除"说的是不是位置 at 上的这个引用：
 * - "删除 `X`"：删除在前 → 是
 * - "`X` 已删除。""`X` 删除后……"：删除在后、后面没跟自己的宾语 → 是
 * - "复制 `X` 后删除代理商逻辑""`X`：物理删除旧记录"：删除后面跟着自己的宾语 → 不是
 * - "删除旧影像后写入 `X`"：删除和引用之间隔着别的宾语 → 不是
 * - "删除 `X` 对应项""删除 `X` 对续办服务的依赖""`X` 中的 Job 已移除"：X 只是修饰语/位置 → 不是
 * - "不删除""不可整文件删除""保留"→ 不是
 */
const GONE_ONE = new RegExp(GONE_AT.source, 'i')
function saysGone(text, at) {
  const t = blankCode(text)
  if (KEPT.test(t)) return false
  let end = text.startsWith('**', at) ? text.indexOf('**', at + 2) + 2 : text.indexOf('`', at + 1) + 1
  if (end <= at) end = at
  // 引用后面紧跟的中文（跳过并列的其它引用、"+ Service"这类）：是"对应项""对…的依赖"就说明它只是修饰语
  const tail = t.slice(end).replace(/^[\s、+/,，A-Za-z0-9_.*]*/, '')
  const modifier = CJK.test(tail[0] ?? '') && !/^(等|类|及|和|与|整|文件|全部)/.test(tail) && !GONE_ONE.test(tail.replace(/^[已均都也被现]+/, '').slice(0, 3))
  for (const g of t.matchAll(GONE_AT)) {
    if (g.index < at) {
      // 删除在前：中间只能是空白、顿号、并列的引用，且引用本身不是修饰语
      if (/^[\s、,，+/及和与]*$/.test(t.slice(g.index + g[0].length, at)) && !modifier) return true
      continue
    }
    if (g[0] === '不再') return true
    // 删除在后：中间出现"中/里/的/对应/相关"，删的是 X 里的东西
    if (/[中里内的下]|对应|相关/.test(t.slice(end, g.index))) continue
    const next = t.slice(g.index + g[0].length).replace(/^\s+/, '')[0] ?? ''
    if (!CJK.test(next) || /[了掉后的]/.test(next)) return true
  }
  return false
}

function clauseStart(line, index) {
  const SEP = /[，,；;。|（）()：:—]/
  let a = index
  while (a > 0 && !SEP.test(line[a - 1])) a--
  return a
}
const clauseGone = (text, index) => saysGone(clauseAt(text, index), index - clauseStart(text, index))

const STATUS_CELL = /^(已)?(删除|删掉|移除|下线|废弃|停用|拆除|deleted|removed|deprecated)$/i

/**
 * 这个引用是不是被说成"已删除"：
 * - 表格行：看它自己那一格；或它后面某一格开头就是"删除"二字（"| `X.java` | 删除 |"、"| `X` | 删除；先迁… |"）。
 *   别的格里的"删除 Y 逻辑""物理删除旧记录"说的是别的东西，不算；它前面的"| 删除 | 接口 | `X` |"是操作名，也不算
 * - 在括号里：括号里的内容 + 括号后紧跟的半句（"本地执行器（`RuleExecutor` …）已删除"）
 * - 其它：所在分句（"`third/decisionengine/`（本地 `pricingRule/` 已删）"里前者不算删）
 */
export function goneAt(line, index) {
  if (/^\s*\|/.test(line)) {
    const cells = []
    for (let s = line.indexOf('|'), e; s >= 0 && s < line.length - 1; s = e) {
      e = line.indexOf('|', s + 1); if (e < 0) e = line.length
      cells.push({ s: s + 1, text: line.slice(s + 1, e) })
    }
    const k = cells.findIndex((c) => index >= c.s && index < c.s + c.text.length)
    if (k < 0) return false
    const own = cells[k]
    if (clauseGone(own.text, index - own.s)) return true
    return cells.slice(k + 1).some((c) => STATUS_CELL.test(c.text.replace(/[`*]/g, '').split(/[，,；;。（(：:]/)[0].trim()))
  }
  const open = Math.max(line.lastIndexOf('（', index), line.lastIndexOf('(', index))
  const closeBefore = Math.max(line.lastIndexOf('）', index), line.lastIndexOf(')', index))
  if (open > closeBefore) {
    let close = line.slice(index).search(/[）)]/)
    close = close < 0 ? line.length : index + close
    const after = line.slice(close + 1).split(/[，,；;。|（(]/)[0]
    return saysGone(line.slice(open + 1, close) + ' ' + after, index - open - 1)
  }
  return clauseGone(line, index)
}

/** 一篇文档的锚点：[{ kind, value, line, gone, text }]，以及本地链接 */
export function docAnchors(text) {
  const anchors = [], links = []
  let inFence = false
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { inFence = !inFence; return }
    if (inFence) return
    const line = raw
    const tableCtx = /表|table|sql|字段/i.test(line)
    for (const m of line.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g)) {
      const a = classify(m[1] ?? m[2])
      if (!a) continue
      if (a.kind === 'table' && !tableCtx) continue                         // 下划线名字只在讲"表"的行里才当表名
      anchors.push({ ...a, line: i + 1, gone: goneAt(line, m.index), text: line.trim().slice(0, 200) })
    }
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]
      if (/^(https?:|mailto:|#)/i.test(target)) continue
      links.push({ target, line: i + 1, text: line.trim().slice(0, 200) })
    }
  })
  return { anchors, links }
}

export function scanDocs(root, files, isDoc = (f) => /\.md$/i.test(f)) {
  return files.filter(isDoc).map((path) => {
    const text = read(root, path)
    const { anchors, links } = docAnchors(text)
    const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? basename(path)).trim()
    return { path, title, size: text.length, anchors, links }
  })
}

// ---------------------------------------------------------------- 锚点能不能在代码里找到
const globRe = (s) => new RegExp('(^|/)' + s.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')

export function resolveAnchor(a, idx) {
  const v = a.value
  switch (a.kind) {
    case 'file': {
      if (v.includes('*')) { const re = globRe(v); return idx.files.some((f) => re.test(f)) }
      if (!v.includes('/')) return idx.basenames.has(v)
      return idx.files.some((f) => f === v || f.endsWith('/' + v))
    }
    case 'dir': {
      const d = v.replace(/\/+$/, '')
      if (d.includes('*')) { const re = globRe(d); return [...idx.dirs].some((x) => re.test(x)) || idx.files.some((f) => re.test(f)) }
      if ([...idx.dirs].some((x) => x === d || x.endsWith('/' + d))) return true
      // third/mortgage/CarUnicomUtils：省略了扩展名的文件，也算找到
      return idx.files.some((f) => f === d || f.endsWith('/' + d) || f.replace(/\.\w+$/, '').endsWith('/' + d)) || idx.stems.has(d)
    }
    case 'class': return idx.classes.has(v)
    case 'method': return idx.methods.has(v)
    case 'endpoint': {
      // 文档常带网关/应用前缀（/blade-api/team），代码里没有：也试去掉第一段；文档写到控制器一级（/financialReport）也算
      const norm = (s) => s.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '')
      const p = norm(v), tries = [p, p.replace(/^\/[^/]+(?=\/)/, '')].filter((x) => x.length > 2)
      for (const e of idx.endpoints) {
        const q = norm(e)
        for (const c of tries) if (q === c || q.endsWith(c) || q.startsWith(c + '/') || (c.endsWith(q) && q.length > 3)) return true
      }
      return false
    }
    case 'table': return idx.tables.size === 0 ? null : idx.tables.has(v.toLowerCase())
    default: return null
  }
}

export function linkExists(root, docPath, target, allFiles) {
  let clean
  try { clean = decodeURIComponent(target.split('#')[0]) } catch { clean = target.split('#')[0] }
  clean = clean.replace(/:\d+(:\d+)?$/, '')                                  // 编辑器风格的行号：application.yml:236
  if (!clean) return true
  // 本机绝对路径（E:/x、/E:/x）：直接看文件在不在；不在的多半是别人机器上的路径
  const abs = /^\/?([a-z]:[\\/].*)$/i.exec(clean)
  if (abs) { try { statSync(abs[1]); return true } catch { return false } }
  const joined = posix(join(dirname(docPath), clean)).replace(/^\.\//, '')
  const norm = joined.split('/').reduce((acc, part) => { if (part === '..') acc.pop(); else if (part && part !== '.') acc.push(part); return acc }, []).join('/')
  if (allFiles.has(norm)) return true
  try { statSync(join(root, norm)); return true } catch { return false }
}
