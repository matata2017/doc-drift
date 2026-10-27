// install-skill.mjs — SKILL.md 是唯一来源：生成 WorkBuddy 版，并把"技能 + 工具代码"装到各宿主的技能目录
//   node scripts/install-skill.mjs            装到 ~/.codex ~/.claude ~/.dsh ~/.workbuddy 下已有的 skills/
//   node scripts/install-skill.mjs <目录…>    装到指定的技能目录（例如测试用的临时目录）
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const skill = readFileSync(join(ROOT, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

// WorkBuddy 版：多一条"没有 node 时用 WorkBuddy 自带的"
const NODE_LINE = '- 需要 Node ≥ 18.17 和 git。所有命令都由你运行，**用户不敲命令**。'
if (!skill.includes(NODE_LINE)) throw new Error('SKILL.md 里找不到 Node 那一行，WorkBuddy 版没法生成')
const wb = skill.replace(NODE_LINE, NODE_LINE + '\n- 先运行 `node -v`。没有 node 时用 WorkBuddy 自带的：Glob 搜 `~/.workbuddy/binaries/node/versions/*/node.exe`（Windows）或 `*/bin/node`（macOS/Linux），取版本最高的那个。')
writeFileSync(join(ROOT, 'workbuddy', 'skill', 'SKILL.md'), wb)

const targets = process.argv.slice(2).length ? process.argv.slice(2)
  : ['.codex', '.claude', '.dsh', '.workbuddy'].map((h) => join(homedir(), h, 'skills', 'doc-drift')).filter((d) => existsSync(dirname(d)))
for (const dir of targets) {
  const isWb = dir.replace(/\\/g, '/').includes('/.workbuddy/')
  rmSync(join(dir, 'scripts'), { recursive: true, force: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), isWb ? wb : skill)
  cpSync(join(ROOT, 'bin'), join(dir, 'scripts', 'bin'), { recursive: true })
  cpSync(join(ROOT, 'lib'), join(dir, 'scripts', 'lib'), { recursive: true })
  cpSync(join(ROOT, 'LICENSE'), join(dir, 'scripts', 'LICENSE'))
  writeFileSync(join(dir, 'scripts', 'package.json'), JSON.stringify({ type: 'module', name: 'doc-drift', version, license: 'MIT' }, null, 2) + '\n')
  execFileSync(process.execPath, [join(dir, 'scripts', 'bin', 'doc-drift.mjs')], { stdio: 'ignore', windowsHide: true })   // 装好的能跑
  console.log('已装：' + dir)
}
