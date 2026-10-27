// build-workbuddy.mjs — 组装 WorkBuddy 专家包（开放平台规范）、校验、打 zip：dist/doc-drift-expert-<版本>.zip
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'workbuddy')
const plugin = JSON.parse(readFileSync(join(SRC, 'plugin.json'), 'utf8'))
const OUT = join(ROOT, 'dist', plugin.name)
const errors = []
const check = (ok, msg) => { if (!ok) errors.push(msg) }

// ---------------------------------------------------------------- 校验 plugin.json（open.workbuddy.cn/docs/expert）
for (const k of ['name', 'expertType', 'version', 'description', 'author', 'agents', 'agentName', 'displayName', 'profession', 'displayDescription', 'avatar', 'categoryId', 'defaultInitPrompt', 'plugin', 'tags', 'quickPrompts'])
  check(plugin[k] !== undefined, `plugin.json 缺少 ${k}`)
check(/^[a-z][a-z0-9-]*$/.test(plugin.name), 'name 只能是小写字母、数字、连字符')
check(plugin.plugin === plugin.name, 'plugin 必须等于 name')
check(['agent', 'team'].includes(plugin.expertType), 'expertType 只能是 agent / team')
check(/^\d+\.\d+\.\d+$/.test(plugin.version), 'version 要是语义化版本')
const zhLen = [...plugin.displayDescription.zh].length
check(zhLen >= 40 && zhLen <= 50, `displayDescription.zh 要 40–50 字，现在 ${zhLen} 字`)
check(plugin.tags.length === 3 && plugin.tags.every((t) => t.en && t.zh), 'tags 必须正好 3 个 {en, zh}')
check(plugin.quickPrompts.length === 3 && plugin.quickPrompts.every((t) => t.en && t.zh), 'quickPrompts 必须正好 3 个 {en, zh}')
check(plugin.defaultInitPrompt.zh === plugin.quickPrompts[0].zh && plugin.defaultInitPrompt.en === plugin.quickPrompts[0].en, 'defaultInitPrompt 必须等于第一个 quickPrompt')
const CATS = ['01-ProductDesign', '02-Engineering', '03-GameSpatial', '04-DataAI', '05-MarketingGrowth', '06-ContentCreative', '07-SalesCommerce', '08-FinanceInvestment',
  '09-OperationsHR', '10-ProjectQuality', '11-SecurityCompliance', '12-IndustryConsultant', '13-TencentZone', '14-WorldWise', '15-Education']
check(CATS.includes(plugin.categoryId), `categoryId 不在允许列表里：${plugin.categoryId}`)

// agent 文件与 frontmatter
const agentFile = join(SRC, 'agents', `${plugin.agentName}.md`)
check(existsSync(agentFile), `缺少 agents/${plugin.agentName}.md`)
if (existsSync(agentFile)) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(agentFile, 'utf8').replace(/\r\n/g, '\n'))?.[1] ?? ''
  check(new RegExp(`^name: ${plugin.agentName}$`, 'm').test(fm), 'agent frontmatter 的 name 要等于 agentName（文件名）')
  for (const k of ['description', 'displayName', 'profession']) check(new RegExp(`^${k}:`, 'm').test(fm), `agent frontmatter 缺少 ${k}`)
  check(/^skills:\s*\n\s+- doc-drift$/m.test(fm), 'agent frontmatter 要预载技能 doc-drift')
}
const avatar = join(SRC, plugin.avatar)
check(existsSync(avatar), `缺少头像 ${plugin.avatar}`)
if (existsSync(avatar)) check(statSync(avatar).size <= 500 * 1024, '头像要 ≤ 500KB')
if (errors.length) { console.error('校验没通过：\n- ' + errors.join('\n- ')); process.exit(1) }

// ---------------------------------------------------------------- 组装
rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, '.codebuddy-plugin'), { recursive: true })
writeFileSync(join(OUT, '.codebuddy-plugin', 'plugin.json'), JSON.stringify(plugin, null, 2) + '\n')
cpSync(join(SRC, 'avatars'), join(OUT, 'avatars'), { recursive: true })
cpSync(join(SRC, 'agents'), join(OUT, 'agents'), { recursive: true })
cpSync(join(SRC, 'README.md'), join(OUT, 'README.md'))
const skill = join(OUT, 'skills', 'doc-drift')
mkdirSync(join(skill, 'scripts'), { recursive: true })
cpSync(join(SRC, 'skill', 'SKILL.md'), join(skill, 'SKILL.md'))
cpSync(join(ROOT, 'bin'), join(skill, 'scripts', 'bin'), { recursive: true })
cpSync(join(ROOT, 'lib'), join(skill, 'scripts', 'lib'), { recursive: true })
cpSync(join(ROOT, 'LICENSE'), join(skill, 'scripts', 'LICENSE'))
writeFileSync(join(skill, 'scripts', 'package.json'), JSON.stringify({ type: 'module', name: 'doc-drift', version: plugin.version, license: 'MIT' }, null, 2) + '\n')

// 打包后的脚本能跑起来
execFileSync(process.execPath, [join(skill, 'scripts', 'bin', 'doc-drift.mjs')], { stdio: 'ignore' })

// ---------------------------------------------------------------- zip（Windows 自带 bsdtar 写 zip，路径用 /）
const zip = join(ROOT, 'dist', `${plugin.name}-${plugin.version}.zip`)
rmSync(zip, { force: true })
const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'zip'
if (process.platform === 'win32') execFileSync(tar, ['-a', '-c', '-f', zip, plugin.name], { cwd: join(ROOT, 'dist') })
else execFileSync('zip', ['-qr', zip, plugin.name], { cwd: join(ROOT, 'dist') })
const count = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(d, e.name)) : 1), 0)
console.log(`校验通过；${count(OUT)} 个文件 → ${zip}（${Math.round(statSync(zip).size / 1024)}KB）`)
