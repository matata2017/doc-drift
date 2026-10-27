# doc-drift

**让需求、文档、代码长期对得上，解决文档漂移和"熵增"。**

一个给编程智能体用的 Skill（`init` / `doctor` / `sync`）加一个日常钩子（Codex / Claude Code / DSH）。规则能查的不问模型；模型（默认 StartLux）只回答"是否过时""是不是新需求"这类选择题；改文档由 agent 起草、人确认。设计细节见 [DESIGN.md](DESIGN.md)。

## 它查什么

| 种类 | 说明 | 怎么查 |
|---|---|---|
| 引用已过时 | 文档引用的类/文件/接口/表已不在代码里，而 git 历史里有过（删了或改名了） | 规则 + git 历史 |
| 找不到的引用 | 代码和历史里都没有（可能不是代码引用）——只提示 | 规则 |
| 说已删除但还在 | 文档说"已删/下线"，代码里还在 | 规则（按分句判断） |
| 断链 / 链接路径要改 | 链接指向不存在的文件；用了别人机器上的绝对路径或相对根目录写的路径（给出改法） | 规则 |
| 没有文档的接口 | 有接口的 Controller 没有任何文档提到——只提示 | 规则 |
| 内容可能过时 | 文档描述的代码在文档最后一次更新之后又改过，StartLux 判断描述是否还准确 | 文档↔代码映射 + git + StartLux |
| 需求变更没记 | 对话里提出了新需求/改了需求（日常钩子） | StartLux |

AGENTS.md、CLAUDE.md 等 AI 配置文件排最前：每个会话都会读，过时的危害最大。历史记录类文档（某次迭代、迁移、清理的记录）不要求跟代码同步，相关问题降为提示。

## 三个动作

- **init**：扫描文档与代码 → StartLux 给每篇文档分类（类型、是否代表现状）→ 从索引表提取业务域 → 生成文档↔代码映射 → 列出拿不准的文档（按目录归组）交给 agent 问你。
- **doctor**：全面体检，报告写到 `.doc-drift/reports/日期.md`；agent 按报告分组起草修改、问你拿不准的、你确认后改、记下结论、重跑确认。
- **sync**：处理日常钩子攒下的待办（新需求待记录、改了代码但文档没改、新接口没文档）。

## 日常钩子

| 时机 | Codex / Claude Code | DSH（dsh-hoos） | 做什么 |
|---|---|---|---|
| 你发消息时 | `UserPromptSubmit` | `agent/pre-step`（`firstStepOnly`） | StartLux 判断是否新需求/改需求，挑出应记入的需求文档 → 记待办；remind 模式下有待办时注入一行提醒 |
| 一轮结束时 | `Stop` | `agent/turn-stopping` | 后台：`git diff HEAD` + 未跟踪文件 → 改到的代码 → 耦合的文档小节（这次没一起改的）→ StartLux 判是否过时 → 记待办 |

- 不阻断、不改文件；失败或超时什么也不做；没初始化（没有 `.doc-drift/config.json`）的项目直接跳过。
- 默认 **observe**：只记录，不在对话里提醒；`doc-drift mode remind` 后有待办时提醒一行，同一条只提醒一次，两次提醒至少隔 3 轮。
- 不需要提交代码：看的是工作区相对 HEAD 的改动；只记每个文件 diff 的哈希避免重复判断，不存文件副本，切分支不会串。

## 安装

需要 Node ≥ 18.17、git；StartLux 密钥放环境变量 `DOC_DRIFT_API_KEY`（或 `BAMBOO_API_KEY`），或写进 `~/.doc-drift/.env`。

```sh
git clone <本仓库> doc-drift
node doc-drift/bin/doc-drift.mjs doctor-check     # 检查 Node、git、密钥、接口
node doc-drift/test/selftest.mjs                  # 自测（临时仓库 + 假接口，不需要密钥）
```

**Skill**：把 `SKILL.md` 复制到宿主的技能目录，并把里面的命令路径改成你的安装位置：

- Codex：`~/.codex/skills/doc-drift/SKILL.md`
- Claude Code：`~/.claude/skills/doc-drift/SKILL.md`
- DSH：`~/.dsh/skills/doc-drift/SKILL.md`

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
  "agent/pre-step": [ { "command": "node <路径> hook", "timeout": 12, "firstStepOnly": true, "statusMessage": "doc-drift: 需求变更识别" } ],
  "agent/turn-stopping": [ { "command": "node <路径> hook", "timeout": 10, "statusMessage": "doc-drift: 检查文档漂移" } ]
} }
```

然后在项目里：`doc-drift init`。

## 命令

```
doc-drift init [--no-model]                     认识项目，列出要问你的问题
doc-drift questions                             还没回答的问题
doc-drift mark <文档或目录> <current|historical|archived>
doc-drift answer "<问题>" "<结论>"               记下结论，之后不再问
doc-drift doctor [--no-model] [--max N] [--json] 全面体检
doc-drift ignore <F编号...>                      这些体检项不用处理
doc-drift pending / resolve <P编号> <done|skip> / label <P编号> <right|wrong>
doc-drift mode <observe|remind>
doc-drift status
```

## 项目里的文件

| 文件 | 提交 | 内容 |
|---|---|---|
| `.doc-drift/config.json` | 是 | 文档分类与状态、业务域、忽略项、钩子模式 |
| `.doc-drift/map.json` | 是 | 文档小节 ↔ 代码文件 |
| `.doc-drift/answers.md` | 是 | 你确认过的结论 |
| `.doc-drift/reports/` | 可选 | 体检报告 |
| `.doc-drift/state/` | 否 | 待办、diff 哈希、判断日志 |

## 发给 StartLux 的内容

- init：每篇文档的路径、标题、小标题、开头约 500 字。
- doctor / 钩子：被判断的文档小节（≤1200 字）与相关代码改动（≤1800 字）；你发的消息（≤600 字）与候选需求文档的路径和标题。
- 发出前脱敏：`sk-…`、≥32 位随机串、`password=…`/`token: …` 这类写法替换为 `<已脱敏>`。不能覆盖所有密钥格式，敏感项目请评估。

## 实测（pinrong-online，Java 后端，1668 个 Java 文件、186 篇文档）

- **确定性检查**：全量不到 2 秒。CLAUDE.md 里 10 处过时引用全部属实（本地定价引擎、规则执行器、度小满、YonBIP、测试类都已删除）；28 处链接给出了相对路径改法；只剩 2 处真正的断链。
- **init**：186 篇文档分类 28 秒；134 篇代表现状、5 篇历史记录、47 篇拿不准（按目录归成 16 个问题）。
- **doctor**：含 StartLux 判断约 1 分钟。
- **需求识别**：「以后进件第一步申报的时候要加个校验：车龄超过10年的直接拒单」→ 新需求（0.94），并选中 `mdfile/进件流程/第一步-进件申报/requirements.md`；「帮我看下这个报错」→ 不是需求（0.99）。约 3 秒。

样本小，阈值（把握 ≥ 0.8 才算确定、需求识别 ≥ 0.85）是看着这些例子定的；钩子默认只记录，攒够 `label` 标注再决定是否打开提醒。

## 局限

- 代码索引是正则做的（Java/Spring 最完整：类、方法、`@RequestMapping` 路径、Mapper/SQL 表名；JS/TS/Python/Go 只有类和函数名）。
- "内容可能过时"每次最多判断 40 段（`--max` 可调），优先 AI 配置文件和改动最多的。
- 需求与实现是否一致（需求条目逐条对代码）还没做，见 DESIGN.md 的 D6/D7。

## 致谢

DOCER（Tan, Wagner, Treude）、Context Rot（Treude, Baltes）、Deep JIT Inconsistency Detection（Panthaplackel 等）、RepoAgent、Swimm、OpenSpec、Spec Growth Engine。

## License

MIT
