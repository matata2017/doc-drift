# doc-drift

**让需求、文档、代码长期对得上，解决文档漂移和"熵增"。**

一个给编程智能体用的 Skill（`init` / `doctor` / `check`，加日常待办处理）和一个日常钩子（Codex / Claude Code / DSH）。范围跟着 Trellis 任务走：默认只查当前 SPEC。规则能查的不问模型；模型（默认 StartLux）只回答"是否过时""该改文档还是改代码"这类选择题；改文档由 agent 起草、人确认。设计细节见 [DESIGN.md](DESIGN.md)。

## 它查什么

| 种类 | 说明 | 怎么查 |
|---|---|---|
| 引用已过时 | 文档引用的类/文件/接口/表已不在代码里，而 git 历史里有过（删了或改名了） | 规则 + git 历史 |
| 找不到的引用 | 代码和历史里都没有（可能不是代码引用）——只提示 | 规则 |
| 说已删除但还在 | 文档说"已删/下线"，代码里还在 | 规则（按分句判断） |
| 断链 / 链接路径要改 | 链接指向不存在的文件；用了别人机器上的绝对路径或相对根目录写的路径（给出改法） | 规则 |
| 没有文档的接口 | 有接口的 Controller 没有任何文档提到——只提示 | 规则 |
| 文档和现在的代码对不上 | 文档这一节**现在的说法** vs 它映射到的代码**现在的实现**，StartLux 判"过时 / 准确 / 看不出"，不一致时给方向（改文档 / 改代码 / 两边 / 拿不准） | 文档↔代码映射 + StartLux（`check` 或 `doctor` 时才调） |
| 改了代码、文档没跟上 | 一轮结束时本地看这轮改到的代码 → 耦合的需求/设计文档小节（这次没一起改的） | 本地 diff + 映射，**不调模型**；先问你要不要核对 |

AGENTS.md、CLAUDE.md 等 AI 配置文件排最前：每个会话都会读，过时的危害最大。历史记录类文档（某次迭代、迁移、清理的记录）不要求跟代码同步，相关问题降为提示。

## 四个动作

- **init**：扫描文档与代码 → StartLux 给每篇文档分类（类型、是否代表现状）→ 从索引表提取业务域 → 生成文档↔代码映射 → 发现 Trellis 活跃任务、当前 SPEC，把它们的文档记进 `config.trellis` 和 `map.json` → 列出拿不准的文档交给 agent 问你。`--no-model` 只做本地部分。
- **doctor**：体检，报告写到 `.doc-drift/reports/日期.md`。**默认只查当前 Trellis 任务**（当前 SPEC）里的文档；会话没挂任务时按当前改动反查属于哪个任务（`taskForChanges`：任务登记的文件边界 > 代码→文档图谱 > 任务文档里提到的代码文件名，已完成的也算、会标出来），反查不出、并列或对不上就不猜，直接要你用 `--task` 指定。`doctor full` 也不是扫全仓库：只查所有**活跃 Trellis 任务**（in_progress / review，限当前分支、限本 worktree）的 SPEC 文档 + AI 规则文件（AGENTS.md/CLAUDE.md）。拿文档现在的说法和代码现在的实现逐节比，**不依赖 git diff**——提交了、diff 没了、过了很久都能重算。每条冲突都先问你以哪边为准（可能需求已经改了、文档没跟上）；报告结尾有「这次没查什么」，写明没映射到代码的文档、没判完的候选段、判了但把握不足的段。
- **check**：用户确认后跑，只对刚才那一轮钩子报出的候选调**一次**模型，判过时就记待办并给对齐方向。不确认就不花钱。
- **处理待办**：`doc-drift pending` 看日常钩子攒下的（改了代码但文档没改、新接口没文档），逐条改完 `doc-drift resolve`。

## 日常钩子

| 时机 | Codex / Claude Code | DSH（dsh-hoos） | 做什么 |
|---|---|---|---|
| 你发消息时 | `UserPromptSubmit` | `agent/pre-step`（`firstStepOnly`） | 只做本地记账（记基线、remind 模式下有待办时注入一行提醒），**不调模型** |
| 一轮结束时 | `Stop` | `agent/turn-stopping` | 本地 `git diff HEAD` → 改到的代码 → 耦合的**需求/设计**文档小节（这次没一起改的）；有候选就让模型先问用户要不要核对，**不调模型** |
| 用户确认后 | `doc-drift check` | 同左 | 只对刚才那批候选调一次模型判断是否过时 → 记待办 |

- 不阻断、不改文件；失败或超时什么也不做；没初始化（没有 `.doc-drift/config.json`）的项目直接跳过。
- 每个会话各自记一份 diff 基线：第一次见这个会话只记基线、不报存量改动；之后只报这个会话这轮改到的代码。多个会话共用同一仓库时互不干扰。
- 体检不放在日常钩子里：当前任务收口时跑 `doc-drift doctor`；要覆盖所有活跃任务，手动跑 `doc-drift doctor full`。
- 任务完成了、没开新任务又改了代码：钩子按 `.doc-drift/map.json` 的文档↔代码映射判断，命中了才提醒；用户说"先记下来"只记一笔（`doc-drift defer`），不重复打扰，下次体检用现在的代码重算差异。
- 默认 **observe**：只记录，不在对话里提醒；`doc-drift mode remind` 后有待办时提醒一行，同一条只提醒一次，两次提醒至少隔 3 轮。
- 不需要提交代码：看的是工作区相对 HEAD 的改动；只记每个文件 diff 的哈希避免重复判断，不存文件副本，切分支不会串。

## 安装

需要 Node ≥ 18.17、git。StartLux 密钥：到 [bamboonode.dev](https://bamboonode.dev/) **免费注册**领取，放环境变量 `DOC_DRIFT_API_KEY`（或 `BAMBOO_API_KEY`），或写进 `~/.doc-drift/.env`；没有密钥也能用（`--no-model`：规则检查照常，判断交给 agent）。

```sh
git clone <本仓库> doc-drift
node doc-drift/bin/doc-drift.mjs doctor-check     # 检查 Node、git、密钥、接口
node doc-drift/test/selftest.mjs                  # 自测（临时仓库 + 假接口，不需要密钥）
```

**Skill**：`node scripts/install-skill.mjs`。它把 `SKILL.md` 连同工具代码（放在技能目录的 `scripts/` 下）装到本机已有的技能目录，技能里不用写死路径：

- Codex：`~/.codex/skills/doc-drift/`
- Claude Code：`~/.claude/skills/doc-drift/`
- DSH：`~/.dsh/skills/doc-drift/`
- WorkBuddy：`~/.workbuddy/skills/doc-drift/`（多一条"没有 node 时用 WorkBuddy 自带的"）

`SKILL.md` 是唯一来源，WorkBuddy 版 `workbuddy/skill/SKILL.md` 由这个脚本生成，不要手改。

**钩子**（`<路径>` 换成 `bin/doc-drift.mjs` 的绝对路径）：

Codex（项目 `.codex/hooks.json` 或 `~/.codex/hooks.json`；之后在 `/hooks` 里信任）：

```json
{ "hooks": {
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "node <路径> hook", "timeout": 15 } ] } ],
  "Stop": [ { "hooks": [ { "type": "command", "command": "node <路径> hook", "timeout": 15 } ] } ]
} }
```

Claude Code（`.claude/settings.json`）：同上结构。

DSH（`~/.dsh/hooks.json`，需要 dsh-hoos；之后在 DSH 钩子审查里信任）：

```json
{ "version": 1, "hooks": {
  "agent/pre-step": [ { "command": "node <路径> hook", "timeout": 12, "firstStepOnly": true, "statusMessage": "doc-drift: 本地记账" } ],
  "agent/turn-stopping": [ { "command": "node <路径> hook", "timeout": 10, "statusMessage": "doc-drift: 检查文档漂移" } ]
} }
```

然后在项目里：`doc-drift init`。

## 命令

```
doc-drift init [--no-model] [--ask-status]       认识项目，记下活跃任务和当前 SPEC
doc-drift questions                              还没回答的问题
doc-drift mark <文档或目录> <current|historical|archived>
doc-drift answer "<问题>" "<结论>"                记下结论，之后不再问
doc-drift doctor [full] [--task <id>] [--no-model] [--max N] [--json]
                                                体检：默认当前 SPEC；full 查所有活跃任务
doc-drift tasks                                  列出 Trellis 任务和它们引用的文档（标出当前 SPEC）
doc-drift check                                  用户确认后：只核对上一轮改动涉及的文档小节
doc-drift defer <文档> [--section] [--note]      用户说"先记下来"：只记一笔，不查、不打扰
doc-drift deferred                               看记下来的待核对项
doc-drift pending / resolve <P编号> <done|skip> / label <编号> <right|wrong> [--note 原因]
doc-drift ignore <F编号...>                       这些体检项不用处理
doc-drift mode <observe|remind>
doc-drift status
```

## 项目里的文件

| 文件 | 提交 | 内容 |
|---|---|---|
| `.doc-drift/config.json` | 是 | 文档分类与状态、业务域、忽略项、钩子模式、`trellis`（活跃任务 / 当前 SPEC / 它们的文档） |
| `.doc-drift/map.json` | 是 | 文档小节 ↔ 代码文件（含 Trellis 任务文档） |
| `.doc-drift/answers.md` | 是 | 你确认过的结论 |
| `.doc-drift/reports/` | 可选 | 体检报告 |
| `.doc-drift/state/` | 否 | 待办、每会话 diff 基线、候选、deferred、判断日志 |

## 发给 StartLux 的内容

- init：每篇文档的路径、标题、小标题、开头约 800 字。
- doctor / check：被判断的文档整节（≤4000 字）与它映射到的代码（每文件 ≤4000 字、每次最多 3 个文件）。
- 钩子本身不发请求；只有用户确认后的 `check` 和手动 `doctor` 才发。
- 发出前脱敏：`sk-…`、≥32 位随机串、`password=…`/`token: …` 这类写法替换为 `<已脱敏>`。不能覆盖所有密钥格式，敏感项目请评估。

## 实测

- **init --no-model**：秒级；自动建立代码映射、发现活跃 Trellis 任务和 SPEC 文档；还没分类状态的要带模型跑 `init`，或用 `mark` 手动定。
- **doctor full --no-model**：2.4 秒，只查活跃任务的 SPEC 文档和 AI 规则文件。
- **钩子**：pre-step 218 ms、turn-stopping 205 ms（含 node 启动）；没有候选时完全不说话。
- **steer 链路**：turn-stopping 有候选时拦下这一轮，实测模型先收到注入消息再问用户（DSH）。
- 旧版"每轮判需求"的实测：97 次模型请求里 93 次什么也没产出（96% 浪费），所以改成"用户确认后才查"。

## 局限

- 代码索引是正则做的（Java/Spring 最完整：类、方法、`@RequestMapping` 路径、Mapper/SQL 表名；JS/TS/Python/Go 只有类和函数名）。
- "文档和代码对不上"每次最多判断 40 段（`--max` 可调），优先 AI 配置文件和改动最多的；是抽样，不是逐条覆盖。
- 需求条目逐条对实现（DESIGN.md 的 D6/D7）没有单独的检测器：`doctor` 会把需求文档也当作"文档说法"和代码对照，只能覆盖文档里写到的部分。
- `map.json` 是纯 JSON（千篇以内解析只要几毫秒）。文档上千篇后要换 `node:sqlite` + `file` 索引，设计见 DESIGN.md §10。

## 致谢

DOCER（Tan, Wagner, Treude）、Context Rot（Treude, Baltes）、Deep JIT Inconsistency Detection（Panthaplackel 等）、RepoAgent、Swimm、OpenSpec、Spec Growth Engine。

## License

MIT
